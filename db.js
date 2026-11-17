// Stockage cloud : GitHub (dépôt privé de données) sur Orkestr.
// Repli PostgreSQL si DATABASE_URL, puis JSON local pour le dev.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const SAVES_FILE = path.join(DATA, 'cloud-saves.json');
const NZ_FILE = path.join(DATA, 'cloud-nuzlocke.json');
const IDEAS_FILE = path.join(DATA, 'cloud-ideas.json');
const PROGRESS_FILE = path.join(DATA, 'cloud-progress.json');

const DATABASE_URL = process.env.DATABASE_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_DATA_REPO || '';
const GITHUB_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);
let pool = null;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 1), 'utf8'); } catch (e) {}
}

let memSaves = readJson(SAVES_FILE, []);
let memNz = readJson(NZ_FILE, readJson(path.join(DATA, 'nuzlocke.json'), {}));
let memIdeas = readJson(IDEAS_FILE, []);
let memProgress = readJson(PROGRESS_FILE, {});
if (!Array.isArray(memSaves)) memSaves = [];
if (!memNz || typeof memNz !== 'object' || Array.isArray(memNz)) memNz = {};
if (!Array.isArray(memIdeas)) memIdeas = [];
if (!memProgress || typeof memProgress !== 'object' || Array.isArray(memProgress)) memProgress = {};

function defaultProgress() {
  return {
    badges: 0,
    routes: {},
    rules: { dupes: true, levelCap: true, shiny: true, items: false, heal: true },
    updatedAt: new Date().toISOString(),
  };
}
function progressKey(profile, player) {
  return String(profile || 'marco') + '|' + Number(player || 1);
}
function cleanProgress(p) {
  return {
    badges: Math.max(0, Math.min(8, Number(p && p.badges) || 0)),
    routes: p && p.routes && typeof p.routes === 'object' ? p.routes : {},
    rules: p && p.rules && typeof p.rules === 'object' ? p.rules : defaultProgress().rules,
    updatedAt: new Date().toISOString(),
  };
}

// ---- GitHub contents API (dépôt privé) ----
const ghCache = new Map();
const GH_TTL = 3000;
const GH_API = 'https://api.github.com';

async function ghRequest(pathname, opts = {}) {
  const r = await fetch(GH_API + pathname, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'quetzal-coach',
      ...(opts.headers || {}),
    },
  });
  return r;
}

async function ghGet(file, { force = false } = {}) {
  const cached = ghCache.get(file);
  if (!force && cached && Date.now() - cached.at < GH_TTL) return cached;
  const r = await ghRequest(`/repos/${GITHUB_REPO}/contents/${encodeURIComponent(file)}`);
  if (r.status === 404) {
    const miss = { data: null, sha: null, at: Date.now() };
    ghCache.set(file, miss);
    return miss;
  }
  if (!r.ok) throw new Error('GitHub GET ' + r.status);
  const j = await r.json();
  const text = Buffer.from(String(j.content || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  const entry = { data: text ? JSON.parse(text) : null, sha: j.sha, at: Date.now() };
  ghCache.set(file, entry);
  return entry;
}

async function ghPut(file, data, sha, message) {
  const body = {
    message: message || ('update ' + file),
    content: Buffer.from(JSON.stringify(data, null, 1), 'utf8').toString('base64'),
  };
  if (sha) body.sha = sha;
  const r = await ghRequest(`/repos/${GITHUB_REPO}/contents/${encodeURIComponent(file)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('GitHub PUT ' + r.status + ' ' + t.slice(0, 120));
  }
  const j = await r.json();
  ghCache.set(file, { data, sha: j.content && j.content.sha, at: Date.now() });
  return j.content && j.content.sha;
}

// ---- init ----
async function init() {
  if (GITHUB_ENABLED) {
    const nz = await ghGet('nuzlocke.json', { force: true });
    if (!nz.data) {
      const seed = readJson(path.join(DATA, 'nuzlocke.json'), {});
      await ghPut('nuzlocke.json', seed, null, 'init nuzlocke');
    }
    console.log('DB: GitHub ' + GITHUB_REPO);
    return;
  }
  if (!DATABASE_URL) {
    console.log('DB: mode JSON local (pas de DATABASE_URL/GitHub)');
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /sslmode=require|neon\.tech|supabase\.co/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves (
      profile text NOT NULL,
      player integer NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile, player)
    );
    CREATE TABLE IF NOT EXISTS nuzlocke (
      key text PRIMARY KEY,
      dead boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id text PRIMARY KEY,
      text text NOT NULL,
      kind text NOT NULL,
      done boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS progress (
      key text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const nzCount = await pool.query('SELECT count(*)::int AS n FROM nuzlocke');
  if (nzCount.rows[0].n === 0) {
    const seed = readJson(path.join(DATA, 'nuzlocke.json'), {});
    for (const [key, dead] of Object.entries(seed)) {
      if (dead) await pool.query('INSERT INTO nuzlocke(key, dead) VALUES($1,true) ON CONFLICT (key) DO NOTHING', [key]);
    }
  }
  console.log('DB: PostgreSQL connecté');
}

function storageMode() {
  if (GITHUB_ENABLED) return 'github';
  if (pool) return 'postgres';
  return 'json';
}

// ---- sauvegardes ----
async function listSaves() {
  if (GITHUB_ENABLED) {
    const r = await ghGet('saves.json');
    return Array.isArray(r.data) ? r.data : [];
  }
  if (!pool) return memSaves.slice();
  const r = await pool.query('SELECT data FROM saves ORDER BY profile, player');
  return r.rows.map(x => x.data);
}

async function upsertSaves(saves) {
  const list = (saves || []).filter(s => s && s.profile && s.player);
  if (GITHUB_ENABLED) {
    const r = await ghGet('saves.json', { force: true });
    const current = Array.isArray(r.data) ? r.data.slice() : [];
    for (const s of list) {
      const i = current.findIndex(x => x.profile === s.profile && x.player === s.player);
      if (i >= 0) current[i] = s; else current.push(s);
    }
    await ghPut('saves.json', current, r.sha, 'sync saves');
    return list.length;
  }
  if (!pool) {
    for (const s of list) {
      const i = memSaves.findIndex(x => x.profile === s.profile && x.player === s.player);
      if (i >= 0) memSaves[i] = s; else memSaves.push(s);
    }
    writeJson(SAVES_FILE, memSaves);
    return list.length;
  }
  for (const s of list) {
    await pool.query(
      `INSERT INTO saves(profile, player, data, updated_at) VALUES($1,$2,$3::jsonb,now())
       ON CONFLICT (profile, player) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [String(s.profile), Number(s.player), JSON.stringify(s)]
    );
  }
  return list.length;
}

// ---- nuzlocke ----
async function getNuzlocke() {
  if (GITHUB_ENABLED) {
    const r = await ghGet('nuzlocke.json');
    return r.data && typeof r.data === 'object' ? r.data : {};
  }
  if (!pool) return { ...memNz };
  const r = await pool.query('SELECT key FROM nuzlocke WHERE dead = true');
  const out = {};
  for (const row of r.rows) out[row.key] = true;
  return out;
}

async function setNuzlocke(key, dead) {
  if (GITHUB_ENABLED) {
    const r = await ghGet('nuzlocke.json', { force: true });
    const data = r.data && typeof r.data === 'object' ? { ...r.data } : {};
    if (dead) data[key] = true; else delete data[key];
    await ghPut('nuzlocke.json', data, r.sha, 'nuzlocke ' + (dead ? 'dead' : 'alive'));
    return data;
  }
  if (!pool) {
    if (dead) memNz[key] = true; else delete memNz[key];
    writeJson(NZ_FILE, memNz);
    return { ...memNz };
  }
  if (dead) {
    await pool.query('INSERT INTO nuzlocke(key, dead) VALUES($1,true) ON CONFLICT (key) DO UPDATE SET dead=true, updated_at=now()', [key]);
  } else {
    await pool.query('DELETE FROM nuzlocke WHERE key=$1', [key]);
  }
  return getNuzlocke();
}

// ---- idées ----
async function listIdeas() {
  if (GITHUB_ENABLED) {
    const r = await ghGet('ideas.json');
    return Array.isArray(r.data) ? r.data : [];
  }
  if (!pool) return memIdeas.slice();
  const r = await pool.query('SELECT id, text, kind, done, created_at FROM ideas ORDER BY created_at DESC');
  return r.rows.map(x => ({ id: x.id, text: x.text, kind: x.kind, done: x.done, createdAt: x.created_at }));
}

async function addIdea(idea) {
  if (GITHUB_ENABLED) {
    const r = await ghGet('ideas.json', { force: true });
    const data = Array.isArray(r.data) ? r.data.slice() : [];
    data.push(idea);
    await ghPut('ideas.json', data, r.sha, 'add idea');
    return idea;
  }
  if (!pool) { memIdeas.push(idea); writeJson(IDEAS_FILE, memIdeas); return idea; }
  await pool.query('INSERT INTO ideas(id, text, kind, done, created_at) VALUES($1,$2,$3,$4,$5)', [idea.id, idea.text, idea.kind, false, idea.createdAt]);
  return idea;
}

async function patchIdea(id, done) {
  if (GITHUB_ENABLED) {
    const r = await ghGet('ideas.json', { force: true });
    const data = Array.isArray(r.data) ? r.data.slice() : [];
    const x = data.find(i => i.id === id);
    if (!x) return null;
    x.done = done;
    await ghPut('ideas.json', data, r.sha, 'update idea');
    return x;
  }
  if (!pool) {
    const x = memIdeas.find(i => i.id === id);
    if (x) x.done = done;
    writeJson(IDEAS_FILE, memIdeas);
    return x;
  }
  const r = await pool.query('UPDATE ideas SET done=$2 WHERE id=$1 RETURNING id, text, kind, done, created_at', [id, done]);
  const x = r.rows[0];
  return x ? { id: x.id, text: x.text, kind: x.kind, done: x.done, createdAt: x.created_at } : null;
}

async function deleteIdea(id) {
  if (GITHUB_ENABLED) {
    const r = await ghGet('ideas.json', { force: true });
    const data = Array.isArray(r.data) ? r.data.filter(i => i.id !== id) : [];
    await ghPut('ideas.json', data, r.sha, 'delete idea');
    return;
  }
  if (!pool) {
    const i = memIdeas.findIndex(x => x.id === id);
    if (i >= 0) memIdeas.splice(i, 1);
    writeJson(IDEAS_FILE, memIdeas);
    return;
  }
  await pool.query('DELETE FROM ideas WHERE id=$1', [id]);
}

// ---- progression Nuzlocke (badges, routes, règles) ----
async function getProgress(profile, player) {
  const key = progressKey(profile, player);
  if (GITHUB_ENABLED) {
    const r = await ghGet('progress.json');
    const all = r.data && typeof r.data === 'object' ? r.data : {};
    return all[key] || defaultProgress();
  }
  if (!pool) return memProgress[key] || defaultProgress();
  const r = await pool.query('SELECT data FROM progress WHERE key=$1', [key]);
  return r.rows[0] ? r.rows[0].data : defaultProgress();
}

async function setProgress(profile, player, p) {
  const key = progressKey(profile, player);
  const clean = cleanProgress(p);
  if (GITHUB_ENABLED) {
    const r = await ghGet('progress.json', { force: true });
    const all = r.data && typeof r.data === 'object' ? { ...r.data } : {};
    all[key] = clean;
    await ghPut('progress.json', all, r.sha, 'nuzlocke progress');
    return clean;
  }
  if (!pool) {
    memProgress[key] = clean;
    writeJson(PROGRESS_FILE, memProgress);
    return clean;
  }
  await pool.query(
    `INSERT INTO progress(key, data, updated_at) VALUES($1,$2::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
    [key, JSON.stringify(clean)]
  );
  return clean;
}

module.exports = {
  init,
  storageMode,
  listSaves,
  upsertSaves,
  getNuzlocke,
  setNuzlocke,
  listIdeas,
  addIdea,
  patchIdea,
  deleteIdea,
  getProgress,
  setProgress,
};

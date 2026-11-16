// Stockage cloud : PostgreSQL sur Orkestr, avec repli JSON pour le dev local.
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const SAVES_FILE = path.join(DATA, 'cloud-saves.json');
const NZ_FILE = path.join(DATA, 'cloud-nuzlocke.json');
const IDEAS_FILE = path.join(DATA, 'cloud-ideas.json');

const DATABASE_URL = process.env.DATABASE_URL || '';
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
if (!Array.isArray(memSaves)) memSaves = [];
if (!memNz || typeof memNz !== 'object' || Array.isArray(memNz)) memNz = {};
if (!Array.isArray(memIdeas)) memIdeas = [];

async function init() {
  if (!DATABASE_URL) {
    console.log('DB: mode JSON local (pas de DATABASE_URL)');
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

async function listSaves() {
  if (!pool) return memSaves.slice();
  const r = await pool.query('SELECT data FROM saves ORDER BY profile, player');
  return r.rows.map(x => x.data);
}

async function upsertSaves(saves) {
  const list = (saves || []).filter(s => s && s.profile && s.player);
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

async function getNuzlocke() {
  if (!pool) return { ...memNz };
  const r = await pool.query('SELECT key FROM nuzlocke WHERE dead = true');
  const out = {};
  for (const row of r.rows) out[row.key] = true;
  return out;
}

async function setNuzlocke(key, dead) {
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

async function listIdeas() {
  if (!pool) return memIdeas.slice();
  const r = await pool.query('SELECT id, text, kind, done, created_at FROM ideas ORDER BY created_at DESC');
  return r.rows.map(x => ({ id: x.id, text: x.text, kind: x.kind, done: x.done, createdAt: x.created_at }));
}

async function addIdea(idea) {
  if (!pool) { memIdeas.push(idea); writeJson(IDEAS_FILE, memIdeas); return idea; }
  await pool.query('INSERT INTO ideas(id, text, kind, done, created_at) VALUES($1,$2,$3,$4,$5)', [idea.id, idea.text, idea.kind, false, idea.createdAt]);
  return idea;
}

async function patchIdea(id, done) {
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
  if (!pool) {
    const i = memIdeas.findIndex(x => x.id === id);
    if (i >= 0) memIdeas.splice(i, 1);
    writeJson(IDEAS_FILE, memIdeas);
    return;
  }
  await pool.query('DELETE FROM ideas WHERE id=$1', [id]);
}

module.exports = {
  init,
  listSaves,
  upsertSaves,
  getNuzlocke,
  setNuzlocke,
  listIdeas,
  addIdea,
  patchIdea,
  deleteIdea,
};

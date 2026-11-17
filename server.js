const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Generations, Pokemon, Move, calculate } = require('@smogon/calc');
const { SPECIES } = require('@smogon/calc/dist/data/species');
const { MOVES } = require('@smogon/calc/dist/data/moves');
const { ABILITIES } = require('@smogon/calc/dist/data/abilities');
const { Dex } = require('@pkmn/dex');
const db = require('./db');
const { searchGuide } = require('./guide-search');

const app = express();
const PORT = process.env.PORT || 3100;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const gen = Generations.get(9);
const trainers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'trainers.json'), 'utf8'));
const trainerById = new Map(trainers.map(t => [t.id, t]));

// Table des types d'attaques : generee une seule fois par build-move-types.js.
const MOVE_TYPES_FILE = path.join(__dirname, 'data', 'move-types.json');
let moveTypes = {};
try { moveTypes = JSON.parse(fs.readFileSync(MOVE_TYPES_FILE, 'utf8')); } catch (e) { moveTypes = {}; }
if (!moveTypes || typeof moveTypes !== 'object' || Array.isArray(moveTypes)) moveTypes = {};

// Guide Nuzlocke (caps, arenes, routes) issu du guide communautaire.
const GUIDE_FILE = path.join(__dirname, 'data', 'guide.json');
let guide = {};
try { guide = JSON.parse(fs.readFileSync(GUIDE_FILE, 'utf8')); } catch (e) { guide = {}; }

// Nuzlocke et sauvegardes : stockes en base (PostgreSQL sur Orkestr).
// Les donnees arrivent par /api/sync depuis le PC qui lit les .sav.

// ---- Calculs / dresseurs ----
const NATURES = ['Hardy','Lonely','Brave','Adamant','Naughty','Bold','Docile','Relaxed','Impish','Lax','Timid','Hasty','Serious','Jolly','Naive','Modest','Mild','Quiet','Bashful','Rash','Calm','Gentle','Sassy','Careful','Quirky'];
const dex = Dex.forGen(9);
const moveByNum = new Map();
for (const m of dex.moves.all()) {
  if (m.num > 0 && !moveByNum.has(m.num)) moveByNum.set(m.num, m);
}

function abilityFor(speciesName, slot) {
  const data = SPECIES[9][speciesName];
  if (!data || !data.abilities) return '';
  const map = data.abilities;
  return map[String(slot)] || map['0'] || Object.values(map).filter(Boolean)[0] || '';
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function lanIp() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}
const IP = lanIp();

function toID(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findSpecies(name) {
  if (!name) return null;
  let s = gen.species.get(toID(name));
  if (!s) {
    const base = name.split(/[-(\s]/)[0];
    if (base && base !== name) s = gen.species.get(toID(base));
  }
  return s ? s.name : null;
}

function findMove(name) {
  if (!name) return null;
  const m = gen.moves.get(toID(name));
  return m ? m.name : null;
}

function findAbility(name) {
  if (!name) return null;
  const a = gen.abilities.get(toID(name));
  return a ? a.name : null;
}

function findItem(name) {
  if (!name || name === '-') return null;
  const i = gen.items.get(toID(name));
  return i ? i.name : null;
}

function findNature(name) {
  if (!name) return 'Serious';
  const n = gen.natures.get(toID(name));
  return n ? n.name : 'Serious';
}

const ZERO_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const MAX_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function buildPokemon({ species, level, nature, evs, ivs, ability, item, moves }) {
  const sp = findSpecies(species);
  if (!sp) return null;
  const opts = {
    level: Math.min(100, Math.max(1, parseInt(level, 10) || 50)),
    nature: findNature(nature),
    evs: { ...ZERO_EVS, ...(evs || {}) },
    ivs: { ...MAX_IVS, ...(ivs || {}) },
    moves: (moves || []).map(findMove).filter(Boolean),
  };
  const ab = findAbility(ability);
  if (ab) opts.ability = ab;
  const it = findItem(item);
  if (it) opts.item = it;
  try { return new Pokemon(gen, sp, opts); } catch (e) { return null; }
}

const TYPE_FALLBACK = {
  Normal: ['Tackle'],
  Fire: ['Ember'],
  Water: ['Water Gun'],
  Electric: ['Thunder Shock'],
  Grass: ['Vine Whip'],
  Ice: ['Icy Wind'],
  Fighting: ['Karate Chop'],
  Poison: ['Poison Sting'],
  Ground: ['Mud-Slap'],
  Flying: ['Wing Attack'],
  Psychic: ['Confusion'],
  Bug: ['Struggle Bug'],
  Rock: ['Rock Throw'],
  Ghost: ['Lick'],
  Dragon: ['Dragon Rage'],
  Dark: ['Bite'],
  Steel: ['Metal Claw'],
  Fairy: ['Fairy Wind'],
};

function isDamagingMove(name) {
  const m = gen.moves.get(toID(name));
  return !!m && m.category !== 'Status' && m.basePower > 0;
}

function damagingMoveNames(names) {
  return (names || []).filter(isDamagingMove);
}

// Quand le guide ne donne aucune attaque pour un Pokémon adverse, on estime
// ses meilleures attaques offensives d'après son espèce et son niveau.
function inferBestMoves(speciesName, level) {
  const sp = dex.species.get(toID(speciesName));
  const types = sp && sp.exists ? sp.types : [];
  const atk = sp && sp.exists ? sp.baseStats.atk : 60;
  const spa = sp && sp.exists ? sp.baseStats.spa : 60;
  const candidates = [];

  if (sp && sp.exists) {
    const ls = dex.learnsets.get(sp.id);
    if (ls && ls.learnset) {
      for (const [moveId, sources] of Object.entries(ls.learnset)) {
        let lvl = null;
        for (const src of sources) {
          const m = /^(\d+)L(\d+)$/.exec(src);
          if (m) lvl = Math.min(lvl === null ? 999 : lvl, Number(m[2]));
        }
        if (lvl === null || lvl > level) continue;
        const mv = dex.moves.get(moveId);
        if (!mv || !mv.exists || mv.category === 'Status' || !mv.basePower) continue;
        const acc = mv.accuracy === true ? 100 : (mv.accuracy || 100);
        candidates.push({ name: mv.name, bp: mv.basePower, type: mv.type, category: mv.category, acc });
      }
    }
  }

  if (!candidates.length) {
    for (const t of types) {
      const list = TYPE_FALLBACK[t];
      if (!list) continue;
      for (const name of list) {
        const mv = gen.moves.get(toID(name));
        if (!mv || mv.category === 'Status' || !mv.basePower) continue;
        candidates.push({ name: mv.name, bp: mv.basePower, type: mv.type, category: mv.category, acc: 100 });
      }
    }
  }

  if (!candidates.length) return [];
  const scored = candidates.map(m => {
    const stab = types.includes(m.type) ? 1.5 : 1;
    const fit = m.category === 'Physical' ? atk : spa;
    return { ...m, score: m.bp * stab * (m.acc / 100) * (0.7 + fit / 200) };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map(m => m.name);
}

function bestHit(attacker, defender, moveNames) {  let best = null;
  for (const name of moveNames || []) {
    const mv = findMove(name);
    if (!mv) continue;
    try {
      const move = new Move(gen, mv);
      if (move.category === 'Status') continue;
      const res = calculate(gen, attacker, defender, move);
      const dmg = Array.isArray(res.damage) ? Math.max(...res.damage) : res.damage;
      if (!dmg || dmg <= 0) continue;
      const maxhp = defender.stats.hp;
      const pct = maxhp ? (dmg / maxhp) * 100 : 0;
      if (!best || pct > best.pct) {
        let ko = null;
        try { ko = res.kochance().text; } catch (e) {}
        best = {
          move: move.name,
          type: move.type,
          category: move.category,
          pct: Math.round(pct * 10) / 10,
          damage: dmg,
          maxhp,
          ko,
        };
      }
    } catch (e) {}
  }
  return best;
}

let publicUrlCache = { url: null, at: 0 };
async function getPublicUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (Date.now() - publicUrlCache.at < 5000) return publicUrlCache.url;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const list = j.tunnels || [];
    const t2 = list.find(x => String((x.config && x.config.addr) || '').includes(':' + PORT)) || list[0];
    publicUrlCache = { url: t2 && t2.public_url ? t2.public_url.replace(/\/$/, '') : null, at: Date.now() };
  } catch (e) {
    publicUrlCache = { url: null, at: Date.now() };
  }
  return publicUrlCache.url;
}

function publicUrlFor(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String((req.headers['x-forwarded-host'] || '').split(',')[0]).trim();
  const proto = String((req.headers['x-forwarded-proto'] || 'https').split(',')[0]).trim();
  if (host) return proto + '://' + host;
  return null;
}

app.get('/api/network', async (req, res) => {
  const local = `http://${IP}:${PORT}`;
  res.json({ ip: IP, url: local, localUrl: local, publicUrl: publicUrlFor(req) || await getPublicUrl() });
});

app.get('/api/public-url', async (req, res) => {
  res.json({ url: publicUrlFor(req) || await getPublicUrl() });
});

app.get('/api/qr', async (req, res) => {
  const text = req.query.text || PUBLIC_URL || `http://${IP}:${PORT}`;
  try {
    const buf = await QRCode.toBuffer(String(text), { width: 320, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } });
    res.type('png').send(buf);
  } catch (e) { res.status(500).end(); }
});

// ---- Sprites Pokémon (cache local) ----
const SPRITE_DIR = path.join(__dirname, 'public', 'sprites');
try { fs.mkdirSync(SPRITE_DIR, { recursive: true }); } catch (e) {}
const FORM_CACHE_FILE = path.join(__dirname, 'data', 'sprite-forms.json');
let formCache = {};
try { formCache = JSON.parse(fs.readFileSync(FORM_CACHE_FILE, 'utf8')); } catch (e) { formCache = {}; }
const saveFormCache = () => { try { fs.writeFileSync(FORM_CACHE_FILE, JSON.stringify(formCache, null, 1)); } catch (e) {} };

function spriteSlug(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\(([^)]+)\)/g, '-$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function formSpriteId(name) {
  if (!/[-(]/.test(name)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://pokeapi.co/api/v2/pokemon/' + spriteSlug(name), { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.id ? j.id : null;
  } catch (e) {
    return null;
  }
}

function dexNumFor(name) {
  if (!name) return null;
  const variants = [name, name.split(/[-(]/)[0], name.replace(/\s*\(.*\)\s*/g, '')];
  for (const v of variants) {
    const s = dex.species.get(toID(v));
    if (s && s.exists && s.num) return s.num;
  }
  return null;
}

app.get('/api/sprite/:name', async (req, res) => {
  const name = String(req.params.name || '');
  let key = formCache[name];
  if (!key) {
    const formId = await formSpriteId(name);
    if (formId) {
      key = formId;
      formCache[name] = formId;
      saveFormCache();
    }
  }
  if (!key) key = dexNumFor(name);
  if (!key) return res.status(404).end();
  const file = path.join(SPRITE_DIR, key + '.png');
  if (fs.existsSync(file)) {
    res.set('Cache-Control', 'public, max-age=604800');
    return res.sendFile(file);
  }
  try {
    const r = await fetch(`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${key}.png`);
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(file, buf);
    res.set('Cache-Control', 'public, max-age=604800');
    res.type('png').send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

app.get('/api/trainers', (req, res) => {
  res.json(trainers.map(t => ({
    id: t.id,
    name: t.name,
    class: t.class,
    location: t.location,
    boss: t.boss,
    teamCount: t.team.length,
    team: t.team.map(p => ({ species: p.species, level: p.level })),
  })));
});

app.get('/api/trainer/:id', (req, res) => {
  const t = trainerById.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const team = t.team.map(p => {
    const sp = findSpecies(p.speciesCalc || p.species);
    const data = sp ? gen.species.get(toID(sp)) : null;
    const moveDetails = (p.moves || []).map(name => {
      const info = moveTypes[name] || {};
      return {
        name,
        type: info.type || null,
        category: info.category || null,
        bp: info.bp || 0,
        acc: info.acc == null ? null : info.acc,
        pp: info.pp || 0,
      };
    });
    return { ...p, types: data ? data.types : [], moveDetails };
  });
  res.json({ ...t, team });
});

app.get('/api/move-types', (req, res) => {
  res.json(moveTypes);
});

app.get('/api/guide', (req, res) => {
  res.json(guide);
});

app.post('/api/ask', (req, res) => {
  const body = req.body || {};
  const q = String(body.q || '').trim().slice(0, 300);
  const progress = body.progress && typeof body.progress === 'object' ? body.progress : {};
  try { res.json(searchGuide(q, progress)); }
  catch (e) { res.status(500).json({ error: 'recherche impossible' }); }
});

app.get('/api/progress', async (req, res) => {
  try { res.json(await db.getProgress(req.query.profile, Number(req.query.player))); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/progress', async (req, res) => {
  const body = req.body || {};
  const p = body.progress && typeof body.progress === 'object' ? body.progress : null;
  if (!p) return res.status(400).json({ error: 'progress manquant' });
  try { res.json(await db.setProgress(body.profile, Number(body.player), p)); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.get('/api/nuzlocke', async (req, res) => {
  try { res.json(await db.getNuzlocke()); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/nuzlocke', async (req, res) => {
  const body = req.body || {};
  const key = String(body.key || '').slice(0, 160);
  if (!key) return res.status(400).json({ error: 'key vide' });
  try { res.json(await db.setNuzlocke(key, !!body.dead)); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.get('/api/species', (req, res) => {
  const list = Object.entries(SPECIES[9])
    .filter(([name, s]) => s && !s.isNonstandard && name !== 'N/A' && !/^Missingno/i.test(name))
    .map(([name, s]) => {
      const sp = dex.species.get(toID(name));
      const family = sp && sp.exists ? (sp.baseSpecies || sp.name) : name;
      return { name, types: s.types, baseStats: s.bs, abilities: s.abilities, family };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
});

app.get('/api/moves', (req, res) => {
  const list = Object.entries(MOVES[9])
    .filter(([name, m]) => m && !m.isNonstandard && name !== '(No Move)')
    .map(([name, m]) => ({ name, type: m.type, category: m.category, bp: m.bp }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
});

app.get('/api/abilities', (req, res) => {
  const list = Object.values(ABILITIES[9])
    .filter(a => typeof a === 'string')
    .sort((a, b) => a.localeCompare(b));
  res.json(list);
});

// ---- Idées / améliorations / buts ----
const IDEA_KINDS = ['idee', 'amelioration', 'bug', 'but'];

app.get('/api/ideas', async (req, res) => {
  try { res.json(await db.listIdeas()); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/ideas', async (req, res) => {
  const body = req.body || {};
  const text = String(body.text || '').trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: 'texte vide' });
  const kind = IDEA_KINDS.includes(body.kind) ? body.kind : 'idee';
  const idea = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    kind,
    done: false,
    createdAt: new Date().toISOString(),
  };
  try { await db.addIdea(idea); res.status(201).json(idea); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.patch('/api/ideas/:id', async (req, res) => {
  const done = !!(req.body || {}).done;
  try {
    const idea = await db.patchIdea(req.params.id, done);
    if (!idea) return res.status(404).json({ error: 'not found' });
    res.json(idea);
  } catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/ideas/:id', async (req, res) => {
  try { await db.deleteIdea(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'db error' }); }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'quetzal-coach', storage: db.storageMode() });
});

// ---- Synchronisation depuis le PC (lecture des .sav) ----
app.post('/api/sync', async (req, res) => {
  if (!SYNC_TOKEN) return res.status(503).json({ error: 'SYNC_TOKEN non configuré' });
  const token = String(req.headers['x-sync-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'token invalide' });
  const saves = (req.body || {}).saves;
  if (!Array.isArray(saves)) return res.status(400).json({ error: 'saves manquant' });
  try {
    const count = await db.upsertSaves(saves);
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

// ---- Sauvegardes (lues depuis la base, poussées par /api/sync) ----
app.get('/api/saves', async (req, res) => {
  try {
    const saves = await db.listSaves();
    res.json({ saves });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

app.get('/api/saves/:profile/:player', async (req, res) => {
  try {
    const saves = await db.listSaves();
    const s = saves.find(x => x.profile === req.params.profile && Number(x.player) === Number(req.params.player));
    if (!s) return res.status(404).json({ error: 'sauvegarde introuvable' });
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

// L'interface ne propose plus de profil manuel : on renvoie une liste vide.
app.get('/api/players', (req, res) => {
  res.json([]);
});

app.post('/api/matchup', (req, res) => {
  const { trainerId, myTeam, trainerLevel } = req.body || {};
  const trainer = trainerById.get(trainerId);
  if (!trainer) return res.status(404).json({ error: 'trainer not found' });
  if (!Array.isArray(myTeam) || !myTeam.length) return res.status(400).json({ error: 'empty team' });

  const scaleLevel = Number(trainerLevel) > 0 ? Math.min(100, Math.max(1, Number(trainerLevel))) : null;
  const mine = myTeam.slice(0, 6).map(p => ({ raw: p, poke: buildPokemon(p) }));
  const rows = [];

  for (const me of mine) {
    if (!me.poke) { rows.push({ mine: { species: me.raw.species, level: me.raw.level }, error: 'species inconnue', cells: [] }); continue; }
    const cells = [];
    for (const tp of trainer.team) {
      const level = scaleLevel || tp.level || 50;
      const opp = buildPokemon({ species: tp.speciesCalc || tp.species, level, ability: tp.ability, item: tp.item, moves: tp.moves });
      if (!opp) { cells.push({ opp: { species: tp.species, level }, error: 'espece non reconnue' }); continue; }
      const myBest = bestHit(me.poke, opp, me.raw.moves);
      let enemyMoves = tp.moves || [];
      let estimated = false;
      if (!damagingMoveNames(enemyMoves).length) {
        const guess = inferBestMoves(tp.speciesCalc || tp.species, level);
        if (guess.length) {
          enemyMoves = guess;
          estimated = true;
        }
      }
      const theirBest = bestHit(opp, me.poke, enemyMoves);
      const mySpe = me.poke.stats.spe;
      const theirSpe = opp.stats.spe;
      let verdict = 'risky';
      let note = null;
      if (!myBest) note = 'aucun move offensif de ton cote';
      else if (estimated) note = 'attaque adverse estimée : moves non renseignés dans le guide';
      else if (!theirBest) note = 'moveset adverse incomplet dans le guide';
      if (myBest && theirBest) {
        if (myBest.pct >= 100) verdict = 'win';
        else if (theirBest.pct >= 100) verdict = 'lose';
        else if (myBest.pct >= 50 && theirBest.pct < 50) verdict = 'win';
        else if (theirBest.pct >= 50 && myBest.pct < 50) verdict = 'lose';
        else if (mySpe > theirSpe && myBest.pct >= theirBest.pct) verdict = 'win';
      }
      cells.push({
        opp: { species: tp.species, level, types: opp.types, ability: tp.ability, item: tp.item, moves: tp.moves },
        myBest, theirBest, mySpe, theirSpe, verdict, note,
        theirBestEstimated: estimated,
      });
    }
    rows.push({ mine: { species: me.raw.species, level: me.raw.level }, cells });
  }

  res.json({
    trainer: { id: trainer.id, name: trainer.name, class: trainer.class, location: trainer.location },
    trainerLevel: scaleLevel,
    rows,
  });
});

async function start() {
  try { await db.init(); }
  catch (e) { console.error('DB init:', e.message); }
  app.listen(PORT, '0.0.0.0', () => {
    console.log('Quetzal Coach (cloud):');
    console.log('  Port    : ' + PORT);
    console.log('  Public  : ' + (PUBLIC_URL || 'non défini'));
    console.log('  Storage : ' + db.storageMode());
  });
}
start();

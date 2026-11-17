const TYPE_COLORS = {
  Normal: '#a8a77a', Fire: '#ee8130', Water: '#6390f0', Electric: '#f7d02c',
  Grass: '#7ac74c', Ice: '#96d9d6', Fighting: '#c22e28', Poison: '#a33ea1',
  Ground: '#e2bf65', Flying: '#a98ff3', Psychic: '#f95587', Bug: '#a6b91a',
  Rock: '#b6a136', Ghost: '#735797', Dragon: '#6f35fc', Dark: '#705746',
  Steel: '#b7b7ce', Fairy: '#d685ad',
};

const TYPE_FR = {
  Normal: 'Normal', Fire: 'Feu', Water: 'Eau', Electric: 'Électrik', Grass: 'Plante',
  Ice: 'Glace', Fighting: 'Combat', Poison: 'Poison', Ground: 'Sol', Flying: 'Vol',
  Psychic: 'Psy', Bug: 'Insecte', Rock: 'Roche', Ghost: 'Spectre', Dragon: 'Dragon',
  Dark: 'Ténèbres', Steel: 'Acier', Fairy: 'Fée',
};

const NATURES = ['Hardy','Lonely','Brave','Adamant','Naughty','Bold','Docile','Relaxed','Impish','Lax','Timid','Hasty','Serious','Jolly','Naive','Modest','Mild','Quiet','Bashful','Rash','Calm','Gentle','Sassy','Careful','Quirky'];

const EV_PRESETS = {
  '0': { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
  phys: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
  spec: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
  bulk: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
};

const BOSS_ORDER = ['Roxanne','Brawly','Wattson','Flannery','Norman','Winona','Tate & Liza','Juan','Sidney','Phoebe','Glacia','Drake','Wallace'];

const state = {
  trainers: [],
  species: [],
  speciesMap: new Map(),
  moves: [],
  abilities: [],
  team: [],
  players: [],
  player: null,
  source: null,
  gameSlot: null,
  game: { detected: false, players: [], updatedAt: null },
  saves: [],
  saveSlot: null,
  saveTab: null,
  nuzlocke: {},
  guide: null,
  speciesFamily: new Map(),
  progress: null,
  progressCtx: null,
  progressTimer: null,
  runFilter: '',
  ideas: [],
  gameTimer: null,
  gateTimer: null,
  saveRefreshTimer: null,
  rev: 0,
  lastSave: 0,
  saveTimer: null,
  pollTimer: null,
  selectedTrainer: null,
  filter: 'boss',
  search: '',
  view: 'trainers',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function json(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const err = new Error((data && data.error) || text || r.statusText);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

const PLAYER_KEY = 'quetzal-player';
const WHO_KEY = 'quetzal-who';
const SAVE_TAB_KEY = 'quetzal-save-tab';
const teamCacheKey = (id) => 'quetzal-team-' + id;

// ---- Sauvegardes (lecture seule) ----
async function loadSaves(force) {
  try {
    const data = await json('/api/saves' + (force ? '?refresh=1' : ''));
    state.saves = Array.isArray(data.saves) ? data.saves : [];
  } catch (e) {
    state.saves = [];
  }
  if (state.saves.length) {
    const raw = localStorage.getItem(SAVE_TAB_KEY);
    let found = null;
    if (raw) {
      const [profile, player] = raw.split(':');
      found = state.saves.find(s => s.profile === profile && s.player === Number(player));
    }
    if (!found) {
      // priorite au joueur deja choisi, sinon le joueur 1
      const current = state.saveSlot && state.saves.find(s => s.profile === state.saveSlot.profile && s.player === state.saveSlot.player);
      found = current || state.saves.find(s => s.player === 1) || state.saves[0];
    }
    state.saveTab = { profile: found.profile, player: found.player };
  } else {
    state.saveTab = null;
  }
  return state.saves;
}

function saveByKey(profile, player) {
  return state.saves.find(s => s.profile === profile && s.player === Number(player)) || null;
}

function selectedSave() {
  if (!state.saveTab) return state.saves[0] || null;
  return saveByKey(state.saveTab.profile, state.saveTab.player) || state.saves[0] || null;
}

function saveToClientTeam(save) {
  return (save.party || []).map(m => ({
    species: m.species,
    level: m.level,
    nature: m.nature,
    ability: m.ability || '',
    item: '',
    evs: m.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: m.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: (m.moves || []).map(x => x.name),
    moveDetails: m.moves || [],
    stats: m.stats,
    maxHp: (m.stats || {}).hp,
    nickname: m.nickname || '',
    natureFr: m.natureFr,
    types: m.types || [],
    shiny: !!m.shiny,
    fromSave: true,
    source: m.source,
  }));
}

function saveDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ---- Nuzlocke : Pokémon marqués morts (partagé, stocké côté serveur) ----
async function loadNuzlocke() {
  try { state.nuzlocke = await json('/api/nuzlocke'); } catch (e) { state.nuzlocke = {}; }
  if (!state.nuzlocke || typeof state.nuzlocke !== 'object') state.nuzlocke = {};
}

function nzKey(profile, player, m) {
  return [profile, player, m.species, m.nickname || ''].join('|');
}

function isDead(ctx, m) {
  if (!ctx || !ctx.profile || !ctx.player) return false;
  return !!state.nuzlocke[nzKey(ctx.profile, ctx.player, m)];
}

function deadCountFor(profile, player) {
  const prefix = profile + '|' + player + '|';
  return Object.keys(state.nuzlocke || {}).filter(k => k.startsWith(prefix)).length;
}

async function setDead(key, dead) {
  try {
    state.nuzlocke = await json('/api/nuzlocke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, dead }),
    });
  } catch (e) { return; }
  if (state.view === 'boxes') renderBoxes();
  else if (state.view === 'team') renderTeam();
}

function bindDeadToggles(root) {
  if (!root) return;
  root.querySelectorAll('[data-nz-key]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setDead(b.dataset.nzKey, b.dataset.nzDead !== '1');
    });
  });
}

// ---- Run Nuzlocke : guide, level caps, routes ----
function defaultProgress() {
  return {
    badges: 0,
    routes: {},
    rules: { dupes: true, levelCap: true, shiny: true, items: false, heal: true },
  };
}

async function loadGuide() {
  try { state.guide = await json('/api/guide'); }
  catch (e) { state.guide = { gyms: [], routes: [], eliteFour: {} }; }
  return state.guide;
}

async function loadProgress(profile, player) {
  try {
    state.progress = await json('/api/progress?profile=' + encodeURIComponent(profile) + '&player=' + Number(player));
  } catch (e) {
    state.progress = defaultProgress();
  }
  if (!state.progress || typeof state.progress !== 'object') state.progress = defaultProgress();
  if (!state.progress.routes) state.progress.routes = {};
  if (!state.progress.rules) state.progress.rules = defaultProgress().rules;
  state.progressCtx = { profile, player: Number(player) };
  return state.progress;
}

function setRunSync(text, cls) {
  const el = $('#runSync');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sync-line' + (cls ? ' ' + cls : '');
}

function saveProgress() {
  if (!state.progress || !state.progressCtx) return;
  clearTimeout(state.progressTimer);
  state.progressTimer = setTimeout(async () => {
    try {
      const p = await json('/api/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: state.progressCtx.profile,
          player: state.progressCtx.player,
          progress: state.progress,
        }),
      });
      state.progress = p;
      setRunSync('Enregistré · ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), 'ok');
    } catch (e) {
      setRunSync('Hors ligne — progression non enregistrée', 'err');
    }
  }, 450);
}

function familyOf(name) {
  return (state.speciesFamily && state.speciesFamily.get(name)) || name;
}

function ownedFamilyCounts(save) {
  const counts = new Map();
  for (const m of [...(save.party || []), ...(save.boxes || [])]) {
    const f = familyOf(m.species);
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return counts;
}

function isDuplicateSpecies(species, save) {
  if (!species) return false;
  const f = familyOf(species);
  return (ownedFamilyCounts(save).get(f) || 0) > 1;
}

function currentCap(p) {
  const g = state.guide && state.guide.gyms;
  if (!g || !g.length) return 15;
  if (p.badges >= 8) return (state.guide.eliteFour && state.guide.eliteFour.levelCap) || 58;
  return (g[p.badges] && g[p.badges].levelCap) || 15;
}

function nextRunTarget(p) {
  const g = state.guide && state.guide.gyms;
  if (!g || !g.length) return null;
  if (p.badges >= 8) return state.guide.eliteFour || null;
  return g[p.badges] || null;
}

function runCtx() {
  const save = selectedSave();
  if (!save) return null;
  return { save, profile: save.profile, player: save.player };
}

function renderRun() {
  const box = $('#runDashboard');
  if (!box) return;
  if (!state.guide) { loadGuide().then(() => { if (state.view === 'run') renderRun(); }); return; }
  const ctx = runCtx();
  if (!ctx) {
    box.innerHTML = '<div class="empty">Aucune sauvegarde trouvée.</div>';
    return;
  }
  const save = ctx.save;
  if (!state.progress || !state.progressCtx || state.progressCtx.profile !== save.profile || state.progressCtx.player !== save.player) {
    loadProgress(save.profile, save.player).then(() => { if (state.view === 'run') renderRun(); });
    return;
  }
  const p = state.progress;
  const guide = state.guide;
  const cap = currentCap(p);
  const next = nextRunTarget(p);
  const deadCtx = { profile: save.profile, player: save.player };
  const dead = Object.keys(state.nuzlocke || {}).filter(k => k.startsWith(save.profile + '|' + save.player + '|')).length;
  const alive = (save.party || []).filter(m => !isDead(deadCtx, m)).length;
  const caught = Object.values(p.routes || {}).filter(r => r && r.status === 'caught').length;
  const totalRoutes = (guide.routes || []).length;

  const players = $('#runPlayers');
  players.innerHTML = state.saves.map(x => `
    <button class="chip ${x.profile === save.profile && x.player === save.player ? 'active' : ''}"
      data-run-profile="${esc(x.profile)}" data-run-player="${x.player}">
      ${esc(x.trainerName || x.label)}
      <small>J${x.player} · ${x.partyCount + x.boxCount} Pokémon</small>
    </button>`).join('');

  box.innerHTML = `
    <div class="pill">Badges : <b>${p.badges}/8</b></div>
    <div class="pill">Cap : <b>${cap}</b></div>
    <div class="pill">Prochaine : <b>${esc(next ? next.name : 'Ligue')}</b></div>
    <div class="pill">☠ <b>${dead}</b></div>
    <div class="pill">Captures : <b>${caught}/${totalRoutes}</b></div>
    <div class="pill">Équipe : <b>${alive}/${(save.party || []).length}</b></div>`;

  let nextHtml = '<div class="badge-track">';
  for (let i = 0; i <= 8; i++) nextHtml += `<button data-badge="${i}" class="${i === p.badges ? 'active' : ''}">${i}</button>`;
  nextHtml += '</div>';
  if (next) {
    const warnings = (save.party || []).filter(m => Number(m.level) > Number(next.levelCap || 999));
    nextHtml += `<article class="card gym-card">
      <div class="gym-head"><h3>${esc(next.name)}</h3><span class="badge">${esc(next.type || 'Ligue')}</span></div>
      <div class="gym-meta">${esc(next.location || '')}${next.levelCap ? ' · Cap ' + next.levelCap : ''}</div>
      ${next.team && next.team.length ? `<div class="gym-team">${next.team.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${next.tips && next.tips.length ? `<ul class="tip-list">${next.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        ${next.trainerId ? `<button class="chip" data-run-trainer="${esc(next.trainerId)}">Fiche dresseur</button>` : ''}
        ${next.trainerId ? `<button class="chip" data-run-matchup="${esc(next.trainerId)}">Matchup</button>` : ''}
      </div>
      ${warnings.length
        ? `<div class="cap-warning">Au-dessus du cap ${next.levelCap} : ${warnings.map(m => esc(m.nickname || m.species) + ' Nv.' + m.level).join(' · ')}</div>`
        : '<div class="cap-ok">Toute l’équipe est sous le cap.</div>'}
    </article>`;
  }
  $('#runNext').innerHTML = nextHtml;

  const rules = p.rules || {};
  $('#runRules').innerHTML = `
    <label class="rule-toggle"><input type="checkbox" data-rule="dupes" ${rules.dupes ? 'checked' : ''}> Dupes clause</label>
    <label class="rule-toggle"><input type="checkbox" data-rule="levelCap" ${rules.levelCap ? 'checked' : ''}> Level cap</label>
    <label class="rule-toggle"><input type="checkbox" data-rule="shiny" ${rules.shiny ? 'checked' : ''}> Shiny clause</label>
    <label class="rule-toggle"><input type="checkbox" data-rule="items" ${rules.items ? 'checked' : ''}> Objets autorisés</label>
    <label class="rule-toggle"><input type="checkbox" data-rule="heal" ${rules.heal ? 'checked' : ''}> Soins autorisés</label>`;

  const q = (state.runFilter || '').toLowerCase();
  const routes = (guide.routes || []).filter(r => !q || r.name.toLowerCase().includes(q) || String((p.routes[r.name] || {}).species || '').toLowerCase().includes(q));
  const eras = [['early', 'Début'], ['mid', 'Milieu'], ['late', 'Fin']];
  let routesHtml = '';
  for (const [era, label] of eras) {
    const list = routes.filter(r => (r.era || 'mid') === era);
    if (!list.length) continue;
    routesHtml += `<div class="route-era">${label}</div>`;
    for (const r of list) {
      const entry = p.routes[r.name] || {};
      const status = entry.status || 'todo';
      const species = entry.species || '';
      const dupe = status === 'caught' && isDuplicateSpecies(species, save);
      const page = r.guidePage ? `<a class="route-page" href="${esc(guide.calameo || guide.source)}?page=${r.guidePage}" target="_blank" rel="noopener">guide p${r.guidePage}</a>` : '';
      routesHtml += `<div class="route-row">
        <div class="route-name">${esc(r.name)} ${page}</div>
        <select class="route-status ${status}" data-route="${esc(r.name)}">
          <option value="todo" ${status === 'todo' ? 'selected' : ''}>À faire</option>
          <option value="caught" ${status === 'caught' ? 'selected' : ''}>Capturé</option>
          <option value="missed" ${status === 'missed' ? 'selected' : ''}>Raté</option>
          <option value="dupe" ${status === 'dupe' ? 'selected' : ''}>Doublon</option>
        </select>
        <input class="route-species" list="runSpeciesDatalist" data-route-species="${esc(r.name)}" value="${esc(species)}" placeholder="Espèce capturée…">
        ${dupe ? '<div class="dupe-flag">⚠ Doublon : cette famille est déjà dans l’équipe ou les boîtes.</div>' : ''}
      </div>`;
    }
  }
  $('#runRoutes').innerHTML = routesHtml || '<div class="empty">Aucune route ne correspond.</div>';
  $('#runSource').innerHTML = `Guide source : <a href="${esc(guide.source || '#')}" target="_blank" rel="noopener">Scribd</a> · <a href="${esc(guide.calameo || '#')}" target="_blank" rel="noopener">Calaméo</a>`;
  $('#runSync').className = 'sync-line';

  players.querySelectorAll('[data-run-profile]').forEach(b => b.addEventListener('click', async () => {
    const profile = b.dataset.runProfile;
    const player = Number(b.dataset.runPlayer);
    state.saveTab = { profile, player };
    localStorage.setItem(SAVE_TAB_KEY, profile + ':' + player);
    const x = saveByKey(profile, player);
    if (x && state.source === 'save') {
      state.saveSlot = { profile, player };
      state.team = saveToClientTeam(x);
      localStorage.setItem(WHO_KEY, 'save:' + profile + ':' + player);
      updateWhoButton();
    }
    await loadProgress(profile, player);
    renderRun();
  }));
  box.parentElement.querySelectorAll('[data-badge]').forEach(b => b.addEventListener('click', () => {
    p.badges = Number(b.dataset.badge);
    saveProgress();
    renderRun();
  }));
  box.parentElement.querySelectorAll('[data-rule]').forEach(cb => cb.addEventListener('change', () => {
    p.rules[cb.dataset.rule] = cb.checked;
    saveProgress();
  }));
  box.parentElement.querySelectorAll('[data-run-trainer]').forEach(b => b.addEventListener('click', () => {
    openTrainer(b.dataset.runTrainer);
  }));
  box.parentElement.querySelectorAll('[data-run-matchup]').forEach(b => b.addEventListener('click', () => {
    state.selectedTrainer = state.trainers.find(t => t.id === b.dataset.runMatchup) || null;
    setView('matchup');
    const sel = $('#trainerSelect');
    if (sel && state.selectedTrainer) sel.value = state.selectedTrainer.id;
    runMatchup();
  }));
  box.parentElement.querySelectorAll('[data-route]').forEach(sel => sel.addEventListener('change', () => {
    const name = sel.dataset.route;
    const e = p.routes[name] || {};
    e.status = sel.value;
    p.routes[name] = e;
    saveProgress();
    renderRun();
  }));
  box.parentElement.querySelectorAll('[data-route-species]').forEach(inp => inp.addEventListener('change', () => {
    const name = inp.dataset.routeSpecies;
    const e = p.routes[name] || {};
    e.species = inp.value.trim();
    p.routes[name] = e;
    saveProgress();
    renderRun();
  }));
}

function renderAskAnswer(r) {
  const box = $('#askAnswer');
  if (!box) return;
  let html = `<div class="card ask-answer">
    <div class="ask-q">${esc(r.question || '')}</div>
    <div class="ask-a">${esc(r.answer || '')}</div>`;
  if (r.gym) {
    html += `<div class="ask-card-team">${(r.gym.team || []).map(t => `<span>${esc(t)}</span>`).join('')}</div>`;
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      ${r.gym.trainerId ? `<button class="chip" data-ask-trainer="${esc(r.gym.trainerId)}">Fiche dresseur</button>` : ''}
      ${r.gym.trainerId ? `<button class="chip" data-ask-matchup="${esc(r.gym.trainerId)}">Matchup</button>` : ''}
    </div>`;
  }
  if (r.route) {
    const statusLabel = { todo: 'À faire', caught: 'Capturé', missed: 'Raté', dupe: 'Doublon' }[r.route.status] || r.route.status;
    html += `<div class="ask-card-team"><span>${esc(statusLabel)}</span>${r.route.species ? `<span>${esc(r.route.species)}</span>` : ''}</div>`;
  }
  if (r.sources && r.sources.length) {
    html += `<details class="ask-sources"><summary>Sources du guide (${r.sources.length})</summary>`;
    for (const s of r.sources) {
      html += `<div class="ask-source"><a href="${esc(s.url)}" target="_blank" rel="noopener">Guide p${s.page}</a><div class="ask-excerpt">${esc(s.excerpt)}</div></div>`;
    }
    html += `</details>`;
  }
  html += `</div>`;
  box.innerHTML = html;
  box.querySelectorAll('[data-ask-trainer]').forEach(b => b.addEventListener('click', () => openTrainer(b.dataset.askTrainer)));
  box.querySelectorAll('[data-ask-matchup]').forEach(b => b.addEventListener('click', () => {
    state.selectedTrainer = state.trainers.find(t => t.id === b.dataset.askMatchup) || null;
    setView('matchup');
    const sel = $('#trainerSelect');
    if (sel && state.selectedTrainer) sel.value = state.selectedTrainer.id;
    runMatchup();
  }));
}

async function askGuide() {
  const input = $('#askInput');
  const box = $('#askAnswer');
  if (!input || !box) return;
  const q = input.value.trim();
  if (!q) return;
  if (!state.progress) {
    const s = selectedSave();
    if (s) await loadProgress(s.profile, s.player);
  }
  box.innerHTML = '<div class="pill">Recherche dans le guide…</div>';
  try {
    const r = await json('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q, progress: state.progress || {} }),
    });
    renderAskAnswer(r);
  } catch (e) {
    box.innerHTML = `<div class="pill" style="color:var(--red)">Erreur : ${esc(e.message)}</div>`;
  }
}

// ---- Entrée vocale française (Web Speech API) ----
let askRecognition = null;
let askListening = false;

function setAskVoiceStatus(text) {
  const el = $('#askVoiceStatus');
  if (el) el.textContent = text || '';
}

function initVoiceAsk() {
  const btn = $('#askMic');
  if (!btn) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.classList.add('unsupported');
    btn.addEventListener('click', () => setAskVoiceStatus('La reconnaissance vocale n’est pas disponible sur ce navigateur. Utilise Chrome ou Edge.'));
    return;
  }
  askRecognition = new SR();
  askRecognition.lang = 'fr-FR';
  askRecognition.continuous = false;
  askRecognition.interimResults = true;
  askRecognition.maxAlternatives = 1;

  askRecognition.onstart = () => {
    askListening = true;
    btn.classList.add('listening');
    setAskVoiceStatus('🎤 Écoute… parle en français.');
  };
  askRecognition.onend = () => {
    askListening = false;
    btn.classList.remove('listening');
  };
  askRecognition.onerror = (e) => {
    askListening = false;
    btn.classList.remove('listening');
    const map = {
      'not-allowed': 'Micro refusé. Autorise le microphone dans le navigateur.',
      'service-not-allowed': 'Micro refusé. Autorise le microphone dans le navigateur.',
      'no-speech': 'Je n’ai rien entendu. Réessaie en parlant plus près du micro.',
      'audio-capture': 'Aucun microphone détecté.',
      network: 'Reconnaissance vocale indisponible (réseau).',
      aborted: '',
    };
    setAskVoiceStatus(map[e.error] || ('Erreur micro : ' + e.error));
  };
  askRecognition.onresult = (e) => {
    let text = '';
    let final = false;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
      if (e.results[i].isFinal) final = true;
    }
    const input = $('#askInput');
    if (input) input.value = text.trim();
    if (final) {
      setAskVoiceStatus('🎤 Question reconnue, recherche…');
      try { askRecognition.stop(); } catch (e) {}
      askGuide();
    }
  };

  btn.addEventListener('click', () => {
    if (askListening) {
      try { askRecognition.stop(); } catch (e) {}
      return;
    }
    setAskVoiceStatus('🎤 Demande l’accès au micro…');
    try { askRecognition.start(); }
    catch (e) {
      setAskVoiceStatus('Impossible de démarrer le micro. Réessaie.');
    }
  });
}





function statLabel(key) {
  return { atk: 'Atq', def: 'Déf', spa: 'Atq.Sp', spd: 'Déf.Sp', spe: 'Vit' }[key] || key;
}

function moveLineHtml(mv) {
  const typeFr = mv.typeFr || mv.type || '';
  const cat = mv.categoryFr || mv.category || '';
  const power = mv.category === 'Status' ? '' : ' · ' + (mv.bp ? 'Puiss. ' + mv.bp : 'Puiss. variable');
  const acc = mv.acc == null ? '—' : mv.acc + '%';
  const pp = mv.ppMax ? ' · PP ' + (mv.ppCurrent != null ? mv.ppCurrent : mv.ppMax) + '/' + mv.ppMax : '';
  const prio = mv.priority ? ' · Prio ' + (mv.priority > 0 ? '+' : '') + mv.priority : '';
  return `<div class="move-line">
    <span class="type mini" style="background:${TYPE_COLORS[mv.type] || '#666'}">${esc(typeFr)}</span>
    <span class="move-name">${esc(mv.name)}</span>
    <span class="move-meta">${esc(cat)}${power} · Préc. ${esc(acc)}${pp}${prio}</span>
  </div>`;
}

function renderSaveMonCard(m, ctx) {
  const stats = m.stats || {};
  const name = m.nickname || m.species;
  const species = m.nickname && m.nickname !== m.species ? `<span class="mon-species">${esc(m.species)}</span>` : '';
  const estimated = !!m.statsEstimated;
  const nature = !estimated && m.natureFr && m.natureFr !== '—' ? m.natureFr : '';
  const ability = !estimated && m.ability ? ' · ' + esc(m.ability) : '';
  const shiny = m.shiny ? ' · ✨' : '';
  const sub = `Nv. ${esc(m.level)}` + (estimated ? ' · stats estimées' : (nature ? ' · ' + esc(nature) : '') + ability) + shiny;
  const dead = isDead(ctx, m);
  const key = ctx ? nzKey(ctx.profile, ctx.player, m) : '';
  const statCells = ['atk', 'def', 'spa', 'spd', 'spe']
    .map(k => `<span><b>${esc(stats[k] ?? '—')}</b>${statLabel(k)}</span>`).join('');
  const moves = Array.isArray(m.moves) ? m.moves.filter(Boolean) : [];
  return `<article class="card mon-card ${dead ? 'dead' : ''}">
    <div class="mon-head">
      ${sprite(m.species, 'md')}
      <div class="mon-title">
        <div class="mon-name">${esc(name)} ${species}${dead ? ' <span class="dead-badge">☠ MORT</span>' : ''}</div>
        <div class="mon-sub">${sub}</div>
        ${typeBadges(m.types || [])}
        ${dead ? '<div class="dead-note">Tombé au combat — mémorial Nuzlocke</div>' : ''}
      </div>
      <div class="mon-hp"><b>${esc(stats.hp ?? '—')}</b>PV</div>
      ${ctx ? `<button class="nz-toggle ${dead ? 'is-dead' : ''}" data-nz-key="${esc(key)}" data-nz-dead="${dead ? 1 : 0}" title="${dead ? 'Marquer comme vivant' : 'Marquer comme mort'}" aria-label="${dead ? 'Marquer comme vivant' : 'Marquer comme mort'}">${dead ? '❤' : '☠'}</button>` : ''}
    </div>
    <div class="stat-grid">${statCells}</div>
    ${moves.length ? `<details class="mon-moves"><summary>${moves.length} attaque${moves.length > 1 ? 's' : ''}</summary>
      ${estimated ? '<div class="save-note" style="margin:6px 0 2px">EV et nature non stockés dans la boîte : stats calculées avec EV 0 et nature neutre.</div>' : ''}
      ${moves.map(moveLineHtml).join('')}</details>` : ''}
  </article>`;
}

function renderBoxes() {
  const box = $('#saveBoxes');
  const meta = $('#saveMeta');
  const players = $('#savePlayers');
  if (!box || !meta || !players) return;
  updateWhoButton();

  const s = selectedSave();
  if (!s) {
    players.innerHTML = '';
    meta.textContent = '';
    box.innerHTML = '<div class="empty">Aucune sauvegarde trouvée dans <b>quetzal-couch/saves</b>.</div>';
    return;
  }

  localStorage.setItem(SAVE_TAB_KEY, s.profile + ':' + s.player);
  players.innerHTML = state.saves.map(x => `
    <button class="chip ${x.profile === s.profile && x.player === s.player ? 'active' : ''}"
      data-save-profile="${esc(x.profile)}" data-save-player="${x.player}">
      ${esc(x.trainerName || x.label)}
      <small>J${x.player} · ${x.partyCount + x.boxCount} Pokémon</small>
    </button>`).join('');
  players.querySelectorAll('[data-save-profile]').forEach(b => b.addEventListener('click', () => {
    const profile = b.dataset.saveProfile;
    const player = Number(b.dataset.savePlayer);
    state.saveTab = { profile, player };
    const x = saveByKey(profile, player);
    if (x && state.source === 'save') {
      state.saveSlot = { profile, player };
      state.team = saveToClientTeam(x);
      localStorage.setItem(WHO_KEY, 'save:' + profile + ':' + player);
      if (state.view === 'team') renderTeam();
    }
    updateWhoButton();
    renderBoxes();
  }));

  const boxes = Array.isArray(s.boxes) ? s.boxes : [];
  const ctx = { profile: s.profile, player: s.player };
  const alive = boxes.filter(b => !isDead(ctx, b));
  const dead = boxes.filter(b => isDead(ctx, b));

  meta.innerHTML = `Dernière sauvegarde : <b>${esc(saveDate(s.updatedAt))}</b> · ${s.partyCount} en équipe · ${boxes.length} en boîte${dead.length ? ' · ' + dead.length + ' mort' + (dead.length > 1 ? 's' : '') : ''}`;
  meta.className = 'sync-line ok';

  let html = `<div class="save-section">Boîtes (${alive.length} vivant${alive.length > 1 ? 's' : ''})</div>`;
  if (alive.length) {
    html += `<div class="list">${alive.map(m => renderSaveMonCard(m, ctx)).join('')}</div>`;
  } else {
    html += '<div class="save-note">Aucun Pokémon vivant en boîte.</div>';
  }

  if (dead.length) {
    html += `<div class="save-section memorial-title">Mémorial Nuzlocke (${dead.length})</div>`;
    html += `<div class="list">${dead.map(m => renderSaveMonCard(m, ctx)).join('')}</div>`;
  }

  html += '<div class="save-note">Lecture seule — la sauvegarde n’est jamais modifiée. Le ☠ permet de marquer un Pokémon mort ou de le relever.</div>';
  box.innerHTML = html;
  bindDeadToggles(box);
}


function teamSignature(team) {
  return JSON.stringify((team || []).map(p => [p.species, p.level, (p.moves || []).join('|'), p.item || '', p.ability || '']));
}

function cacheTeam() {
  if (!state.player) return;
  try { localStorage.setItem(teamCacheKey(state.player.id), JSON.stringify(state.team)); } catch (e) {}
}

function loadCachedTeam(id) {
  try {
    const t = JSON.parse(localStorage.getItem(teamCacheKey(id)) || '[]');
    return Array.isArray(t) ? t : [];
  } catch (e) { return []; }
}

function saveTeam() {
  if (state.source !== 'manual') return;
  cacheTeam();
  state.lastSave = Date.now();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(pushTeam, 350);
  updateSyncLine('Enregistrement…', '');
}

async function pushTeam() {
  if (!state.player) return;
  try {
    const data = await json('/api/player/' + encodeURIComponent(state.player.id) + '/team', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ team: state.team, rev: state.rev }),
    });
    state.rev = data.rev;
    state.player.updatedAt = data.updatedAt;
    updateSyncLine('Enregistré · ' + timeLabel(data.updatedAt), 'ok');
    refreshPlayersQuiet();
  } catch (e) {
    if (e.status === 409 && e.data) {
      state.rev = e.data.rev;
      state.team = e.data.team || [];
      cacheTeam();
      renderTeam();
      updateSyncLine('Équipe mise à jour depuis l’autre téléphone', 'err');
      return;
    }
    updateSyncLine('Hors ligne — modification non enregistrée', 'err');
  }
}

function timeLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return Math.floor(diff / 60) + ' min';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h';
  return d.toLocaleDateString('fr-FR');
}

function updateSyncLine(text, cls) {
  const el = $('#teamSync');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sync-line' + (cls ? ' ' + cls : '');
}

function updateWhoButton() {
  let label = 'Joueur';
  let title = 'Mon équipe';
  if (state.source === 'game' && state.gameSlot !== null) {
    label = 'J' + (state.gameSlot + 1);
    title = 'Équipe de Joueur ' + (state.gameSlot + 1);
  } else if (state.source === 'save' && state.saveSlot) {
    const s = saveByKey(state.saveSlot.profile, state.saveSlot.player);
    label = (s && (s.trainerName || s.label)) || 'Sauvegarde';
    title = 'Équipe de ' + label;
  } else if (state.player) {
    label = state.player.name;
    title = 'Équipe de ' + state.player.name;
  } else if (state.saveTab) {
    const s = saveByKey(state.saveTab.profile, state.saveTab.player);
    label = (s && (s.trainerName || s.label)) || 'Joueur';
    title = state.view === 'boxes' ? 'Pokémon des sauvegardes' : 'Mon équipe';
  }
  $('#whoName').textContent = label;
  $('#teamTitle').textContent = title;
}

async function loadPlayersQuiet() {
  try { state.players = await json('/api/players'); } catch (e) {}
  return state.players;
}

async function refreshPlayersQuiet() {
  await loadPlayersQuiet();
  if (state.player && !state.players.some(p => p.id === state.player.id)) {
    state.player = null;
    localStorage.removeItem(PLAYER_KEY);
    openGate();
  }
}

async function openGate() {
  $('#playerGate').classList.remove('hidden');
  $('#saveChoices').innerHTML = '<div class="empty">Recherche des sauvegardes…</div>';
  await Promise.all([loadSaves(), loadNuzlocke()]);
  renderGate();
  startGateRefresh();
}

function startGateRefresh() {
  stopGateRefresh();
  const signature = () => JSON.stringify(state.saves.map(s => [s.profile, s.player, s.updatedAt, s.partyCount, s.boxCount])) + JSON.stringify(state.nuzlocke);
  state.gateTimer = setInterval(async () => {
    if ($('#playerGate').classList.contains('hidden')) { stopGateRefresh(); return; }
    const before = signature();
    await loadSaves();
    await loadNuzlocke();
    if (signature() !== before) renderGate();
  }, 5000);
}

function gameSignature() {
  const g = state.game || {};
  return JSON.stringify({
    d: !!g.detected,
    p: (g.players || []).map(p => [p.index, !!p.present, p.trainerName || '', teamSignature(p.team)]),
  });
}

function stopGateRefresh() {
  clearInterval(state.gateTimer);
  state.gateTimer = null;
}

async function loadGameQuiet() {
  try {
    const data = await json('/api/game/parties');
    const changed = !state.game || teamSignature((state.game.players || []).flatMap(p => p.team || [])) !== teamSignature((data.players || []).flatMap(p => p.team || []));
    state.game = data;
    return changed;
  } catch (e) {
    state.game = { detected: false, players: [], error: 'serveur injoignable' };
    return false;
  }
}

function gamePlayer(slot) {
  return (state.game.players || []).find(p => p.index === slot) || null;
}

function toClientTeam(team) {
  return (team || []).map(m => ({
    species: m.species,
    level: m.level,
    nature: m.nature,
    ability: m.ability || '',
    item: m.item || '',
    evs: m.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: m.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: [0, 1, 2, 3].map(i => (m.moves || [])[i] || ''),
    hp: m.hp,
    maxHp: m.maxHp,
    fromGame: true,
  }));
}

function teamPreview(team) {
  if (!team || !team.length) return 'Aucun Pokémon pour l’instant — joue, ça se remplit tout seul';
  return team.map(p => p.species + ' Nv.' + p.level).join(' · ');
}

function renderGate() {
  const who = localStorage.getItem(WHO_KEY);

  const saveBox = $('#saveChoices');
  if (saveBox) {
    if (!state.saves.length) {
      saveBox.innerHTML = '<div class="empty">Aucune sauvegarde trouvée.</div>';
    } else {
      saveBox.innerHTML = state.saves.map(s => {
        const key = 'save:' + s.profile + ':' + s.player;
        const selected = who === key;
        return `
        <button class="card player-choice ${selected ? 'current' : ''}" data-save-profile="${esc(s.profile)}" data-save-player="${s.player}">
          <div class="avatar">${esc((s.trainerName || '?').slice(0, 2).toUpperCase())}</div>
          <div class="meta">
            <div class="name">${esc(s.trainerName || s.label)} <span class="badge green">Sauvegarde</span></div>
            <div class="sprite-row">${(s.party || []).map(m => sprite(m.species, 'sm')).join('')}</div>
            <div class="sub">${s.partyCount} en équipe · ${s.boxCount} en boîte${deadCountFor(s.profile, s.player) ? ' · ☠ ' + deadCountFor(s.profile, s.player) : ''} · ${esc(saveDate(s.updatedAt))}</div>
          </div>
          ${selected ? '<span class="badge">Dernier</span>' : ''}
        </button>`;
      }).join('');
      saveBox.querySelectorAll('[data-save-profile]').forEach(b => {
        b.addEventListener('click', () => chooseSave(b.dataset.saveProfile, Number(b.dataset.savePlayer)));
      });
    }
  }

  const logout = $('#logoutBtn');
  if (logout) {
    logout.classList.toggle('hidden', !who);
    if (who) {
      let label = 'sauvegarde';
      if (who.startsWith('save:')) {
        const [, profile, player] = who.split(':');
        const s = saveByKey(profile, Number(player));
        label = (s && (s.trainerName || s.label)) || 'sauvegarde';
      } else if (who.startsWith('game:')) {
        label = 'Joueur ' + (Number(who.slice(5)) + 1);
      }
      logout.textContent = 'Se déconnecter (' + label + ')';
    }
  }
}

async function resumeOrGate() {
  const who = localStorage.getItem(WHO_KEY);
  if (who && who.startsWith('save:')) {
    const [, profile, player] = who.split(':');
    await loadSaves();
    if (saveByKey(profile, Number(player))) { await chooseSave(profile, Number(player)); return; }
    localStorage.removeItem(WHO_KEY);
  }
  // Anciennes sessions "jeu" ou "profil manuel" : on repart de la sauvegarde.
  if (who) localStorage.removeItem(WHO_KEY);
  await openGate();
}

async function chooseGame(slot) {
  const p = gamePlayer(slot);
  if (!p) return;
  enterFullscreen();
  state.source = 'game';
  state.gameSlot = slot;
  state.player = null;
  state.saveSlot = null;
  state.team = toClientTeam(p.team);
  localStorage.setItem(WHO_KEY, 'game:' + slot);
  $('#playerGate').classList.add('hidden');
  stopGateRefresh();
  clearInterval(state.pollTimer);
  clearInterval(state.gameTimer);
  clearInterval(state.saveRefreshTimer);
  state.gameTimer = setInterval(refreshGameTeam, 2500);
  updateWhoButton();
  setView('team');
  updateSyncLine('Équipe lue dans le jeu · ' + timeLabel(state.game.updatedAt), 'ok');
}

async function chooseSave(profile, player) {
  await loadSaves();
  await loadNuzlocke();
  await loadProgress(profile, player);
  const s = saveByKey(profile, player);
  if (!s) { await openGate(); return; }
  enterFullscreen();
  state.source = 'save';
  state.saveSlot = { profile: s.profile, player: s.player };
  state.saveTab = { profile: s.profile, player: s.player };
  state.gameSlot = null;
  state.player = null;
  state.team = saveToClientTeam(s);
  localStorage.setItem(WHO_KEY, 'save:' + s.profile + ':' + s.player);
  localStorage.setItem(SAVE_TAB_KEY, s.profile + ':' + s.player);
  $('#playerGate').classList.add('hidden');
  stopGateRefresh();
  clearInterval(state.pollTimer);
  clearInterval(state.gameTimer);
  clearInterval(state.saveRefreshTimer);
  state.saveRefreshTimer = setInterval(refreshSaveTeam, 30000);
  updateWhoButton();
  setView('team');
  updateSyncLine('Sauvegarde du ' + saveDate(s.updatedAt) + ' · ' + s.partyCount + ' Pokémon', 'ok');
}

async function refreshSaveTeam() {
  if (state.source !== 'save' || !state.saveSlot || document.hidden) return;
  await loadSaves(true);
  await loadNuzlocke();
  await loadProgress(state.saveSlot.profile, state.saveSlot.player);
  const s = saveByKey(state.saveSlot.profile, state.saveSlot.player);
  if (!s) return;
  const next = saveToClientTeam(s);
  if (teamSignature(next) !== teamSignature(state.team)) {
    state.team = next;
    if (state.view === 'team' || state.view === 'boxes') {
      renderTeam();
      renderBoxes();
    }
    if (state.view === 'run') renderRun();
    if (state.view === 'matchup') renderMatchup();
    updateSyncLine('Sauvegarde mise à jour · ' + saveDate(s.updatedAt), 'ok');
  }
}

async function choosePlayer(id) {
  try {
    enterFullscreen();
    const data = await json('/api/player/' + encodeURIComponent(id));
    state.source = 'manual';
    state.gameSlot = null;
    state.saveSlot = null;
    state.player = { id: data.id, name: data.name, updatedAt: data.updatedAt };
    state.rev = data.rev;
    const cached = loadCachedTeam(id);
    state.team = data.team && data.team.length ? data.team : cached;
    cacheTeam();
    localStorage.setItem(PLAYER_KEY, id);
    localStorage.setItem(WHO_KEY, 'player:' + id);
    clearInterval(state.gameTimer);
    clearInterval(state.saveRefreshTimer);
    state.gameTimer = null;
    stopGateRefresh();
    updateWhoButton();
    $('#playerGate').classList.add('hidden');
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refreshFromServer, 5000);
    setView('team');
    updateSyncLine('À jour · ' + timeLabel(data.updatedAt), 'ok');
  } catch (e) {
    alert('Impossible de charger le joueur : ' + e.message);
    openGate();
  }
}

async function refreshGameTeam() {
  if (state.source !== 'game' || state.gameSlot === null || document.hidden) return;
  await loadGameQuiet();
  const p = gamePlayer(state.gameSlot);
  if (!p) {
    updateSyncLine('Jeu non lisible (fermé ou en pause)', 'err');
    return;
  }
  const next = toClientTeam(p.team);
  if (teamSignature(next) !== teamSignature(state.team)) {
    state.team = next;
    if (state.view === 'team') renderTeam();
    if (state.view === 'matchup') renderMatchup();
    updateSyncLine('Équipe mise à jour depuis le jeu · ' + timeLabel(state.game.updatedAt), 'ok');
  } else {
    updateSyncLine('Équipe lue dans le jeu · ' + timeLabel(state.game.updatedAt), 'ok');
  }
}

async function createPlayer() {
  const input = $('#newPlayerName');
  const name = input.value.trim();
  if (!name) return;
  let legacy = [];
  if (!state.players.length) {
    try {
      const old = JSON.parse(localStorage.getItem('quetzal-team') || '[]');
      if (Array.isArray(old)) legacy = old;
    } catch (e) {}
  }
  try {
    const data = await json('/api/players', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, team: legacy }),
    });
    input.value = '';
    state.players = await json('/api/players');
    await choosePlayer(data.id);
  } catch (e) {
    alert('Création impossible : ' + e.message);
  }
}

async function refreshFromServer() {
  if (!state.player || document.hidden) return;
  if (Date.now() - state.lastSave < 4000) return;
  try {
    const data = await json('/api/player/' + encodeURIComponent(state.player.id));
    if (data.rev === state.rev) return;
    state.rev = data.rev;
    state.team = data.team || [];
    cacheTeam();
    if (state.view === 'team') renderTeam();
    if (state.view === 'matchup') renderMatchup();
    updateSyncLine('Mis à jour depuis le serveur · ' + timeLabel(data.updatedAt), 'ok');
  } catch (e) {}
}

function setView(name) {
  state.view = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'team') renderTeam();
  if (name === 'boxes') renderBoxes();
  if (name === 'run') renderRun();
  if (name === 'matchup') renderMatchup();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function typeBadges(types) {
  if (!types || !types.length) return '';
  return `<div class="types">${types.map(t => `<span class="type" style="background:${TYPE_COLORS[t] || '#666'}">${esc(TYPE_FR[t] || t)}</span>`).join('')}</div>`;
}

function typeChip(type) {
  if (!type) return '';
  return `<span class="type mini" style="background:${TYPE_COLORS[type] || '#666'}">${esc(TYPE_FR[type] || type)}</span>`;
}

function sprite(name, cls) {
  if (!name) return '';
  return `<img class="sprite ${cls || ''}" src="/api/sprite/${encodeURIComponent(name)}" alt="" decoding="async" onerror="this.style.display='none'">`;
}

function enterFullscreen() {
  try {
    if (!document.documentElement.requestFullscreen || document.fullscreenElement) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } catch (e) {}
}

function category(t) {
  if (/Elite Four/i.test(t.class)) return 'league';
  if (/Champion/i.test(t.class)) return 'league';
  if (/Leader/i.test(t.class) && !/Admin/i.test(t.class)) return 'gym';
  return 'other';
}

function categoryLabel(t) {
  const c = category(t);
  if (c === 'gym') return 'Arène';
  if (c === 'league') return 'Ligue';
  if (/Admin/i.test(t.class)) return 'Admin';
  if (/Leader/i.test(t.class)) return 'Chef';
  return t.class || 'Dresseur';
}

function renderTrainers() {
  const list = $('#trainerList');
  const q = state.search.toLowerCase();
  let items = state.trainers.filter(t => {
    if (state.filter === 'boss' && !t.boss) return false;
    if (state.filter === 'gym' && category(t) !== 'gym') return false;
    if (state.filter === 'league' && category(t) !== 'league') return false;
    if (!q) return true;
    return (t.name + ' ' + t.class + ' ' + t.location).toLowerCase().includes(q);
  });
  items = items.sort((a, b) => {
    const ia = BOSS_ORDER.indexOf(a.name), ib = BOSS_ORDER.indexOf(b.name);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.name.localeCompare(b.name);
  });
  if (!items.length) { list.innerHTML = '<div class="empty">Aucun dresseur trouvé.</div>'; return; }
  list.innerHTML = items.map(t => `
    <button class="card trainer-card" data-id="${esc(t.id)}">
      <div class="avatar">${esc((t.name || '?').slice(0, 2).toUpperCase())}</div>
      <div class="meta">
        <div class="name">${esc(t.name)}</div>
        <div class="sub">${esc(t.location || t.class || '')} · ${t.teamCount} Pokémon</div>
      </div>
      <span class="badge ${category(t) === 'league' ? 'gold' : category(t) === 'gym' ? 'green' : ''}">${esc(categoryLabel(t))}</span>
    </button>`).join('');
  list.querySelectorAll('[data-id]').forEach(btn => {
    btn.addEventListener('click', () => openTrainer(btn.dataset.id));
  });
}

async function openTrainer(id) {
  try {
    const t = await json('/api/trainer/' + encodeURIComponent(id));
    state.selectedTrainer = t;
    $('#trainerDetail').innerHTML = `
      <div class="detail-head">
        <h2>${esc(t.name)}</h2>
        <p>${esc(t.class || '')}${t.location ? ' · ' + esc(t.location) : ''}</p>
      </div>
      <button class="primary" id="analyseBtn" style="width:100%;margin-bottom:12px">Comparer avec mon équipe</button>
      <div class="list">
        ${t.team.map(p => `
          <div class="card team-card">
            <div class="row1">
              <span class="species">${sprite(p.species)}${esc(p.species)}</span>
              <span class="lvl">Nv. ${p.level ?? '?'}</span>
            </div>
            ${typeBadges(p.types)}
            ${p.ability || p.item ? `<div class="sub" style="font-size:12px;color:var(--muted);margin-top:4px">${esc([p.ability, p.item].filter(Boolean).join(' · '))}</div>` : ''}
            <div class="moves">${(p.moveDetails || (p.moves || []).map(name => ({ name }))).map(mv => {
              const type = mv.type;
              const badge = type ? `<span class="type mini" style="background:${TYPE_COLORS[type] || '#666'}">${esc(TYPE_FR[type] || type)}</span>` : '';
              const title = [mv.category, mv.bp ? 'Puiss. ' + mv.bp : '', mv.acc != null ? 'Préc. ' + mv.acc + '%' : ''].filter(Boolean).join(' · ');
              return `<span class="move-chip move-with-type" title="${esc(title)}">${badge}${esc(mv.name)}</span>`;
            }).join('')}</div>
          </div>`).join('')}
      </div>`;
    $('#analyseBtn').addEventListener('click', () => {
      state.selectedTrainer = t;
      setView('matchup');
      const sel = $('#trainerSelect');
      if (sel) sel.value = t.id;
      runMatchup();
    });
    setView('trainer');
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}

function renderTeam() {
  updateWhoButton();
  const list = $('#teamList');
  const isGame = state.source === 'game';
  const isSave = state.source === 'save';
  const addBtn = $('#addPokemon');
  if (addBtn) addBtn.style.display = isGame || isSave ? 'none' : '';
  const hint = $('#teamHint');
  if (hint) hint.textContent = isGame
    ? 'Équipe, niveaux, talents, objets et moves lus directement dans la partie en cours.'
    : isSave
      ? 'Équipe lue dans la dernière sauvegarde (lecture seule) : stats, nature, talent et attaques.'
      : 'Niveau + stats calculés automatiquement (IV 31, EVs selon le preset).';
  if (!state.team.length) {
    list.innerHTML = isGame
      ? `<div class="empty">Aucun Pokémon détecté pour le Joueur ${state.gameSlot !== null ? state.gameSlot + 1 : ''} pour le moment.<br>L’équipe se remplira toute seule dès que tu auras des Pokémon.</div>`
      : isSave
        ? '<div class="empty">Aucun Pokémon dans l’équipe de cette sauvegarde.</div>'
        : '<div class="empty">Ajoute jusqu’à 6 Pokémon pour analyser tes matchups.</div>';
    return;
  }
  if (isSave) {
    const s = state.saveSlot ? saveByKey(state.saveSlot.profile, state.saveSlot.player) : null;
    const ctx = state.saveSlot ? { profile: state.saveSlot.profile, player: state.saveSlot.player } : null;
    list.innerHTML = (s ? s.party : state.team).map(m => renderSaveMonCard(m, ctx)).join('');
    bindDeadToggles(list);
    return;
  }
  list.innerHTML = state.team.map((p, i) => {
    const sp = state.speciesMap.get(p.species);
    const info = [p.ability, p.item].filter(Boolean).join(' · ');
    const extra = isGame
      ? `<div class="sub" style="font-size:12px;color:var(--muted);margin-top:4px">${esc(p.nature || '')}${info ? ' · ' + esc(info) : ''}${p.maxHp ? ' · ' + p.hp + '/' + p.maxHp + ' PV' : ''}</div>`
      : '';
    const actions = isGame ? '' : `
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="chip" data-edit="${i}">Modifier</button>
          <button class="chip" data-del="${i}">Supprimer</button>
        </div>`;
    return `
      <div class="card team-card">
        <div class="row1">
          <span class="species">${sprite(p.species)}${esc(p.species)}</span>
          <span class="lvl">Nv. ${esc(p.level)}</span>
        </div>
        ${typeBadges(sp ? sp.types : [])}
        ${extra}
        <div class="moves">${(p.moves || []).filter(Boolean).map(m => `<span class="move-chip">${esc(m)}</span>`).join('') || '<span class="move-chip">Aucun move</span>'}</div>
        ${actions}
      </div>`;
  }).join('');
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditor(Number(b.dataset.edit))));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    state.team.splice(Number(b.dataset.del), 1);
    saveTeam();
    renderTeam();
  }));
}

function addPokemonDefaults(sp) {
  const abilities = Object.values(sp.abilities || {}).filter(Boolean);
  state.team.push({
    species: sp.name,
    level: 50,
    nature: 'Serious',
    evPreset: '0',
    ability: abilities[0] || '',
    item: '',
    moves: ['', '', '', ''],
  });
  if (state.team.length > 6) state.team = state.team.slice(0, 6);
  saveTeam();
}

function speciesPicker() {
  openModal('Choisir un Pokémon', `
    <div class="field"><input id="speciesSearch" placeholder="Rechercher…" autocomplete="off"></div>
    <div id="speciesResults"></div>`);
  const input = $('#speciesSearch');
  const results = $('#speciesResults');
  const draw = () => {
    const q = input.value.toLowerCase();
    const items = state.species.filter(s => !q || s.name.toLowerCase().includes(q)).slice(0, 120);
    results.innerHTML = items.length ? items.map(s => `
      <button class="species-item" data-name="${esc(s.name)}">
        <span>${esc(s.name)}</span>
        <span class="types">${(s.types || []).map(t => `<span class="type" style="background:${TYPE_COLORS[t] || '#666'}">${esc(t)}</span>`).join('')}</span>
      </button>`).join('') : '<div class="empty">Aucun résultat.</div>';
    results.querySelectorAll('[data-name]').forEach(b => b.addEventListener('click', () => {
      const sp = state.speciesMap.get(b.dataset.name);
      if (sp) addPokemonDefaults(sp);
      closeModal();
      renderTeam();
    }));
  };
  input.addEventListener('input', draw);
  draw();
  setTimeout(() => input.focus(), 100);
}

function openEditor(index) {
  const p = state.team[index];
  if (!p) return;
  const sp = state.speciesMap.get(p.species);
  const abilities = Object.values((sp && sp.abilities) || {}).filter(Boolean);
  openModal('Modifier ' + p.species, `
    <div class="grid2">
      <div class="field"><label>Niveau</label><input id="edLevel" type="number" min="1" max="100" value="${esc(p.level)}"></div>
      <div class="field"><label>Nature</label><select id="edNature">${NATURES.map(n => `<option ${n === p.nature ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>EVs</label><select id="edEvs">
      <option value="0">0 EV</option>
      <option value="phys" ${p.evPreset === 'phys' ? 'selected' : ''}>Physique (252 Atk / 252 Spe)</option>
      <option value="spec" ${p.evPreset === 'spec' ? 'selected' : ''}>Spécial (252 SpA / 252 Spe)</option>
      <option value="bulk" ${p.evPreset === 'bulk' ? 'selected' : ''}>Bulk (252 HP / 252 Def)</option>
    </select></div>
    <div class="field"><label>Talent</label><input id="edAbility" list="abilitiesDatalist" value="${esc(p.ability || '')}" placeholder="${esc(abilities.join(', '))}"></div>
    <div class="field"><label>Objet</label><input id="edItem" value="${esc(p.item || '')}" placeholder="ex. Life Orb"></div>
    ${[0,1,2,3].map(i => `<div class="field"><label>Move ${i+1}</label><input id="edMove${i}" list="movesDatalist" value="${esc(p.moves?.[i] || '')}"></div>`).join('')}
    <button class="primary" id="edSave" style="width:100%">Enregistrer</button>`);
  $('#edSave').addEventListener('click', () => {
    p.level = Math.min(100, Math.max(1, Number($('#edLevel').value) || 50));
    p.nature = $('#edNature').value;
    p.evPreset = $('#edEvs').value;
    p.evs = EV_PRESETS[p.evPreset] || EV_PRESETS['0'];
    p.ability = $('#edAbility').value.trim();
    p.item = $('#edItem').value.trim();
    p.moves = [0,1,2,3].map(i => $('#edMove' + i).value.trim());
    saveTeam();
    closeModal();
    renderTeam();
  });
}

function renderMatchup() {
  const sel = $('#trainerSelect');
  if (!sel) return;
  if (!sel.options.length) {
    const bosses = state.trainers.filter(t => t.boss).sort((a, b) => {
      const ia = BOSS_ORDER.indexOf(a.name), ib = BOSS_ORDER.indexOf(b.name);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.name.localeCompare(b.name);
    });
    sel.innerHTML = bosses.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.location ? ' — ' + esc(t.location) : ''}</option>`).join('');
    if (state.selectedTrainer) sel.value = state.selectedTrainer.id;
  }
  if (!state.team.length) {
    $('#matchupSummary').innerHTML = '<div class="empty">Ajoute d’abord des Pokémon dans l’onglet Équipe.</div>';
    $('#matchupGrid').innerHTML = '';
    return;
  }
  runMatchup();
}

async function runMatchup() {
  const sel = $('#trainerSelect');
  const id = (state.selectedTrainer && state.selectedTrainer.id) || (sel && sel.value);
  if (!id) return;
  const summary = $('#matchupSummary');
  const grid = $('#matchupGrid');
  summary.innerHTML = '<div class="pill">Calcul…</div>';
  grid.innerHTML = '';
  try {
    const myTeam = state.team.map(p => ({
      species: p.species,
      level: p.level,
      nature: p.nature,
      evs: p.evs || EV_PRESETS[p.evPreset] || EV_PRESETS['0'],
      ivs: p.ivs || undefined,
      ability: p.ability,
      item: p.item,
      moves: (p.moves || []).filter(Boolean),
    }));
    const auto = $('#autoLevel') ? $('#autoLevel').checked : true;
    const trainerLevel = auto ? Math.max(...myTeam.map(p => Number(p.level) || 50)) : null;
    const data = await json('/api/matchup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trainerId: id, myTeam, trainerLevel }),
    });
    const cells = data.rows.flatMap(r => r.cells || []);
    const win = cells.filter(c => c.verdict === 'win').length;
    const lose = cells.filter(c => c.verdict === 'lose').length;
    const risky = cells.filter(c => c.verdict === 'risky').length;
    let bestRow = null, bestScore = -999;
    for (const r of data.rows) {
      const score = (r.cells || []).reduce((s, c) => s + (c.verdict === 'win' ? 2 : c.verdict === 'lose' ? -1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestRow = r; }
    }
    summary.innerHTML = `
      <div class="pill"><b>${win}</b> favorables</div>
      <div class="pill"><b>${risky}</b> risqués</div>
      <div class="pill"><b>${lose}</b> défavorables</div>
      <div class="pill">Niveaux : <b>${auto ? 'auto ' + trainerLevel : 'fiche'}</b></div>
      ${bestRow ? `<div class="pill">Lead conseillé : <b>${esc(bestRow.mine.species)}</b></div>` : ''}`;

    const cols = data.rows[0] ? data.rows[0].cells.length : 0;
    let html = '<table class="grid-table"><thead><tr><th>Moi / Eux</th>';
    for (let i = 0; i < cols; i++) {
      const c = data.rows[0].cells[i];
      html += `<th>${c.opp ? sprite(c.opp.species, 'xs') : ''}<br>${esc(c.opp ? c.opp.species : '?')}<br><span style="font-weight:400">Nv.${esc(c.opp ? c.opp.level : '?')}</span></th>`;
    }
    html += '</tr></thead><tbody>';
    for (const r of data.rows) {
      html += `<tr><td>${sprite(r.mine.species, 'xs')}${esc(r.mine.species)}<br><span style="font-weight:400;color:var(--muted)">Nv.${esc(r.mine.level)}</span></td>`;
      for (const c of r.cells) {
        if (c.error) { html += '<td><div class="cell na">?</div></td>'; continue; }
        const label = c.verdict === 'win' ? 'W' : c.verdict === 'lose' ? 'L' : '?';
        html += `<td><button class="cell ${c.verdict}" data-cell="${esc(JSON.stringify({ mine: r.mine, cell: c }))}">${label}</button></td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    grid.innerHTML = html;
    grid.querySelectorAll('[data-cell]').forEach(b => b.addEventListener('click', () => {
      const obj = JSON.parse(b.dataset.cell);
      showCell(obj.mine, obj.cell);
    }));
  } catch (e) {
    summary.innerHTML = '<div class="pill" style="color:var(--red)">Erreur : ' + esc(e.message) + '</div>';
  }
}

function showCell(mine, c) {
  const verdictLabel = c.verdict === 'win' ? 'Favorable' : c.verdict === 'lose' ? 'Défavorable' : 'Risqué';
  openModal('Détail du matchup', `
    <div class="card" style="margin-bottom:10px">
      <div class="row1"><b class="species">${sprite(mine.species)}${esc(mine.species)}</b><span class="lvl">Nv.${esc(mine.level)}</span></div>
      <div class="sub" style="color:var(--muted);font-size:12px;margin-top:4px">vs ${esc(c.opp.species)} · Nv.${esc(c.opp.level)}</div>
      ${typeBadges(c.opp.types)}
      <div style="margin-top:10px;font-size:14px">
        <div>Mon meilleur : ${c.myBest ? typeChip(c.myBest.type) + ' ' : ''}<b>${c.myBest ? esc(c.myBest.move) : '—'}</b>${c.myBest ? ' — ' + (c.myBest.pct >= 100 ? 'KO' : c.myBest.pct + '%') : ''}</div>
        <div>Son meilleur${c.theirBestEstimated ? ' (estimé)' : ''} : ${c.theirBest ? typeChip(c.theirBest.type) + ' ' : ''}<b>${c.theirBest ? esc(c.theirBest.move) : '—'}</b>${c.theirBest ? ' — ' + (c.theirBest.pct >= 100 ? 'KO' : c.theirBest.pct + '%') : ''}</div>
        <div style="color:var(--muted);font-size:12px;margin-top:6px">Vitesse : ${c.mySpe} vs ${c.theirSpe}</div>
      </div>
      ${c.note ? `<div style="color:var(--orange);font-size:12px;margin-top:8px">⚠ ${esc(c.note)}</div>` : ''}
      <div class="badge ${c.verdict === 'win' ? 'green' : ''}" style="margin-top:10px;display:inline-block">${verdictLabel}</div>
    </div>`);
}

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

async function openShare() {
  const net = await json('/api/network');
  const pub = net.publicUrl;
  const primary = pub || net.localUrl || net.url;
  openModal('Partager l’app', `
    <div class="share-label">${pub ? 'Lien public (ngrok) — marche partout' : 'Wi‑Fi local'}</div>
    <div style="text-align:center">
      <img src="/api/qr?text=${encodeURIComponent(primary)}" alt="QR" style="width:240px;max-width:100%;border-radius:12px;background:#fff;padding:8px">
      <div class="share-url">${esc(primary)}</div>
      <button class="primary" id="copyUrl" style="margin-top:12px">Copier le lien</button>
      ${pub ? `<div class="hint" style="margin-top:8px">Sur le même Wi‑Fi : ${esc(net.url)}</div>` : ''}
      <button class="ghost" id="fsBtn" style="margin-top:8px">Plein écran (cacher la barre du navigateur)</button>
    </div>
    <p class="hint">${pub
      ? 'Première visite : ngrok affiche une page « Visit Site » → touche Visit Site. Ensuite tu peux ajouter l’app à l’écran d’accueil.'
      : 'Le ⚠ de la barre d’adresse vient du HTTP local. Ajoute l’app à l’écran d’accueil ou passe en plein écran.'}</p>`);
  $('#copyUrl').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(primary); $('#copyUrl').textContent = 'Copié !'; } catch (e) {}
  });
  $('#fsBtn').addEventListener('click', enterFullscreen);
}

// ---- Idées / améliorations ----
const KIND_LABEL = { idee: '💡 Idée', amelioration: '🔧 Amélioration', bug: '🐞 Bug', but: '🎯 But' };

async function loadIdeas() {
  try { state.ideas = await json('/api/ideas'); } catch (e) { state.ideas = []; }
  updateIdeaBadge();
  return state.ideas;
}

function updateIdeaBadge() {
  const open = (state.ideas || []).filter(i => !i.done).length;
  const b = $('#ideaBadge');
  if (!b) return;
  b.textContent = open > 99 ? '99+' : String(open);
  b.classList.toggle('hidden', open === 0);
}

async function openIdeas() {
  openModal('Idées & améliorations', `
    <div class="idea-form">
      <div class="row">
        <select id="ideaKind">
          ${Object.entries(KIND_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <textarea id="ideaText" placeholder="Une idée, une amélioration, un but…"></textarea>
      <button class="primary" id="ideaAdd">Ajouter</button>
    </div>
    <div id="ideaList" class="idea-list"><div class="empty">Chargement…</div></div>`);
  const input = $('#ideaText');
  $('#ideaAdd').addEventListener('click', addIdea);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addIdea();
  });
  await loadIdeas();
  renderIdeas();
  setTimeout(() => input.focus(), 150);
}

function renderIdeas() {
  const box = $('#ideaList');
  if (!box) return;
  if (!state.ideas.length) {
    box.innerHTML = '<div class="empty">Aucune note pour le moment.</div>';
    return;
  }
  box.innerHTML = state.ideas.map(i => `
    <div class="idea-item ${i.done ? 'done' : ''}">
      <button class="idea-check" data-toggle="${esc(i.id)}" aria-label="Marquer comme fait">${i.done ? '✓' : ''}</button>
      <div class="idea-main">
        <div class="idea-text">${esc(i.text)}</div>
        <div class="idea-meta">${esc(KIND_LABEL[i.kind] || i.kind)} · ${timeLabel(i.createdAt)}</div>
      </div>
      <button class="idea-del" data-del="${esc(i.id)}" aria-label="Supprimer">✕</button>
    </div>`).join('');
  box.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => toggleIdea(b.dataset.toggle)));
  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteIdea(b.dataset.del)));
}

async function addIdea() {
  const input = $('#ideaText');
  const text = input.value.trim();
  if (!text) return;
  const kind = $('#ideaKind').value;
  try {
    await json('/api/ideas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, kind }),
    });
    input.value = '';
    await loadIdeas();
    renderIdeas();
  } catch (e) {
    alert('Ajout impossible : ' + e.message);
  }
}

async function toggleIdea(id) {
  const idea = (state.ideas || []).find(i => i.id === id);
  if (!idea) return;
  try {
    await json('/api/ideas/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done: !idea.done }),
    });
    await loadIdeas();
    renderIdeas();
  } catch (e) {}
}

async function deleteIdea(id) {
  try {
    await json('/api/ideas/' + encodeURIComponent(id), { method: 'DELETE' });
    await loadIdeas();
    renderIdeas();
  } catch (e) {}
}

function fillDatalists() {
  $('#movesDatalist').innerHTML = state.moves.map(m => `<option value="${esc(m.name)}">${esc(m.type)}</option>`).join('');
  $('#abilitiesDatalist').innerHTML = state.abilities.map(a => `<option value="${esc(a)}">`).join('');
}

async function init() {
  const savedWho = localStorage.getItem(WHO_KEY);
  if (!savedWho) {
    $('#playerGate').classList.remove('hidden');
    $('#saveChoices').innerHTML = '<div class="empty">Recherche des sauvegardes…</div>';
  }
  try {
    const [trainers, species, moves, abilities, guide] = await Promise.all([
      json('/api/trainers'), json('/api/species'), json('/api/moves'), json('/api/abilities'), json('/api/guide'),
    ]);
    state.trainers = trainers;
    state.species = species;
    state.speciesMap = new Map(species.map(s => [s.name, s]));
    state.speciesFamily = new Map(species.map(s => [s.name, s.family || s.name]));
    state.moves = moves;
    state.abilities = abilities;
    state.guide = guide;
    fillDatalists();
    const runSpecies = $('#runSpeciesDatalist');
    if (runSpecies) runSpecies.innerHTML = species.map(s => `<option value="${esc(s.name)}">`).join('');
    renderTrainers();
  } catch (e) {
    $('#trainerList').innerHTML = '<div class="empty">Serveur indisponible : ' + esc(e.message) + '</div>';
  }

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderTrainers(); });
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.filter = b.dataset.filter;
    $$('#chips .chip').forEach(x => x.classList.toggle('active', x === b));
    renderTrainers();
  });
  $('#backTrainer').addEventListener('click', () => setView('trainers'));
  $('#addPokemon').addEventListener('click', speciesPicker);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#shareBtn').addEventListener('click', openShare);
  $('#whoBtn').addEventListener('click', openGate);
  $('#refreshSaves').addEventListener('click', async () => {
    await loadSaves(true);
    await loadNuzlocke();
    renderBoxes();
  });
  const runSearch = $('#runRouteSearch');
  if (runSearch) runSearch.addEventListener('input', (e) => {
    state.runFilter = e.target.value;
    renderRun();
  });
  initVoiceAsk();
  const askBtn = $('#askBtn');
  if (askBtn) askBtn.addEventListener('click', askGuide);
  const askJump = $('#askJump');
  if (askJump) askJump.addEventListener('click', () => {
    setView('run');
    setTimeout(() => { const el = $('#askInput'); if (el) el.focus(); }, 120);
  });
  const askInput = $('#askInput');
  if (askInput) askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') askGuide(); });
  const askSuggest = $('#askSuggest');
  if (askSuggest) askSuggest.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ask]');
    if (!b) return;
    if (askInput) askInput.value = b.dataset.ask;
    askGuide();
  });
  $('#ideaFab').addEventListener('click', openIdeas);
  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem(WHO_KEY);
    localStorage.removeItem(PLAYER_KEY);
    state.source = null;
    state.player = null;
    state.gameSlot = null;
    state.saveSlot = null;
    state.team = [];
    state.progress = null;
    state.progressCtx = null;
    clearInterval(state.gameTimer);
    clearInterval(state.pollTimer);
    clearInterval(state.saveRefreshTimer);
    updateWhoButton();
    updateSyncLine('');
    renderGate();
    renderBoxes();
    renderRun();
  });
  loadIdeas();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    document.addEventListener('pointerdown', function firstTap() {
      enterFullscreen();
    }, { once: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshFromServer();
      if (state.source === 'save') refreshSaveTeam();
    }
  });
  $('#trainerSelect').addEventListener('change', () => {
    state.selectedTrainer = state.trainers.find(t => t.id === $('#trainerSelect').value) || null;
    runMatchup();
  });
  $('#autoLevel').addEventListener('change', () => runMatchup());
  $$('.bottom-nav button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  try { state.players = await json('/api/players'); } catch (e) { state.players = []; }
  await loadSaves();
  await loadNuzlocke();
  await resumeOrGate();
}

init();

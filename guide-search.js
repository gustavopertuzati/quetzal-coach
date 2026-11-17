// Recherche intelligente dans le guide Quetzal (pages extraites du PDF)
// + donnees structurées (arenes, routes). Pas d'API externe : tout est local.
const fs = require('fs');
const path = require('path');

const GUIDE = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'guide.json'), 'utf8'));
const PAGES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'guide-pages.json'), 'utf8'));

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function words(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 3);
}

function pretty(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([.!?])([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'comment', 'quel', 'quelle', 'quels', 'quelles', 'est', 'sont', 'les', 'des', 'une', 'pour',
  'avec', 'dans', 'sur', 'que', 'qui', 'quoi', 'ou', 'où', 'the', 'and', 'for', 'with', 'how',
  'where', 'what', 'which', 'can', 'you', 'tell', 'me', 'about', 'pokemon', 'quetzal', 'guide',
  'donne', 'donner', 'info', 'infos', 'savoir', 'fait', 'faire', 'mon', 'ma', 'mes', 'ton', 'ta',
  'son', 'sa', 'ses', 'notre', 'votre', 'leur', 'ce', 'cet', 'cette', 'ces', 'au', 'aux', 'du',
  'de', 'la', 'le', 'un', 'et', 'en', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'trouver', 'trouve', 'obtenir', 'cherche', 'chercher',
]);

const SYNONYMS = {
  arene: ['gym'],
  arena: ['gym'],
  niveau: ['level', 'cap'],
  levels: ['level'],
  cap: ['levelcap', 'level'],
  attaque: ['move'],
  attaques: ['move'],
  faiblesse: ['weakness', 'counter'],
  equipe: ['team'],
};

const PAGE_LIST = Object.entries(PAGES)
  .map(([page, raw]) => ({ page: Number(page), raw: String(raw || ''), n: norm(raw) }))
  .filter(p => p.n.length > 20)
  .sort((a, b) => a.page - b.page);

function sourceFor(page, max = 700) {
  const raw = PAGES[page];
  if (!raw) return null;
  return {
    page,
    excerpt: pretty(raw).slice(0, max),
    url: (GUIDE.calameo || GUIDE.source || '') + '?page=' + page,
  };
}

function matchGym(question, progress) {
  const q = norm(question);
  let best = null;
  let bestLen = 0;
  const add = (label, g) => {
    const n = norm(label);
    if (n && q.includes(n) && n.length > bestLen) { best = g; bestLen = n.length; }
  };
  for (const g of GUIDE.gyms || []) {
    add(g.name, g);
    add(g.location, g);
    add(g.type, g);
    add('gym ' + g.order, g);
    add('arene ' + g.order, g);
    add('badge ' + g.order, g);
  }
  if (/ligue|elite|champion/.test(norm(question))) {
    return { elite: GUIDE.eliteFour };
  }
  if (best) return { gym: best };
  if (/prochaine|prochain|suivant|next|cap actuel|oujensuis/.test(norm(question))) {
    const badges = Math.max(0, Math.min(8, Number(progress && progress.badges) || 0));
    if (badges >= 8) return { elite: GUIDE.eliteFour };
    return { gym: (GUIDE.gyms || [])[badges] || null };
  }
  return {};
}

function matchRoute(question, progress) {
  const q = norm(question);
  let best = null;
  let bestLen = 0;
  for (const r of GUIDE.routes || []) {
    const n = norm(r.name);
    if (n && q.includes(n) && n.length > bestLen) { best = r; bestLen = n.length; }
  }
  const m = /route\s*(\d{1,3})/i.exec(question);
  if (!best && m) best = (GUIDE.routes || []).find(r => norm(r.name) === 'route' + m[1]) || null;
  if (!best) return null;
  const entry = (progress && progress.routes && progress.routes[best.name]) || {};
  return { ...best, status: entry.status || 'todo', species: entry.species || '' };
}

function answerGym(g) {
  const team = (g.team || []).join(', ');
  const tips = (g.tips || []).map(t => '• ' + t).join(' ');
  return `${g.name} (${g.type}) — ${g.location}. Level cap : ${g.levelCap}. Équipe : ${team}. ${tips}`;
}

function answerElite(e) {
  return `${e.name} — level cap : ${e.levelCap}. ${(e.tips || []).join(' ')}`;
}

function answerRoute(r) {
  const status = { todo: 'à faire', caught: 'capturé', missed: 'raté', dupe: 'doublon' }[r.status] || r.status;
  const species = r.species ? ` Espèce notée : ${r.species}.` : '';
  return `Route/zone : ${r.name}. Statut : ${status}.${species} Le guide détaille les rencontres à la page ${r.guidePage}.`;
}

function searchText(question) {
  const wordsList = words(question);
  const tokens = [];
  const push = (t) => { if (t && t.length >= 3 && !STOP.has(t) && !tokens.includes(t)) tokens.push(t); };
  for (const w of wordsList) {
    push(w);
    for (const syn of (SYNONYMS[w] || [])) push(norm(syn));
  }
  if (!tokens.length) return [];
  const N = PAGE_LIST.length;
  const scores = new Map();
  for (const tok of tokens) {
    let df = 0;
    for (const p of PAGE_LIST) if (p.n.includes(tok)) df++;
    if (!df) continue;
    const idf = Math.log((N + 1) / (df + 1)) + 1;
    for (const p of PAGE_LIST) {
      let count = 0;
      let i = 0;
      while ((i = p.n.indexOf(tok, i)) !== -1) { count++; i += tok.length; }
      if (count) scores.set(p.page, (scores.get(p.page) || 0) + count * idf);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([page]) => sourceFor(page))
    .filter(Boolean);
}

function searchGuide(question, progress) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) return { question: q, answer: 'Pose une question sur le guide.', sources: [] };
  const gymMatch = matchGym(q, progress);
  const route = matchRoute(q, progress);
  const sources = [];
  if (gymMatch.gym) {
    const g = gymMatch.gym;
    if (g.guidePage) { const s = sourceFor(g.guidePage); if (s) sources.push(s); }
    return {
      question: q,
      answer: answerGym(g),
      gym: g,
      route: null,
      sources: sources.slice(0, 2),
    };
  }
  if (gymMatch.elite) {
    const e = gymMatch.elite;
    if (e.guidePage) { const s = sourceFor(e.guidePage); if (s) sources.push(s); }
    return { question: q, answer: answerElite(e), gym: null, route: null, elite: e, sources };
  }
  if (route) {
    if (route.guidePage) { const s = sourceFor(route.guidePage); if (s) sources.push(s); }
    return {
      question: q,
      answer: answerRoute(route),
      gym: null,
      route,
      sources: sources.slice(0, 2),
    };
  }
  const found = searchText(q);
  if (found.length) {
    return {
      question: q,
      answer: 'Voici les passages du guide les plus proches de ta question.',
      gym: null,
      route: null,
      sources: found,
    };
  }
  return {
    question: q,
    answer: 'Je n’ai rien trouvé dans le guide. Essaie avec un nom d’arène (Wattson), une route (Route 101), un Pokémon (Dreepy) ou « prochaine arène ».',
    gym: null,
    route: null,
    sources: [],
  };
}

module.exports = { searchGuide };

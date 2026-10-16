// Dictionary lookup for the word bubble (v0.5.6). Free, key-less, CORS-enabled APIs are tried in turn and every result is cached in IndexedDB so a word
// looked up once is available offline:
//   1. dictionaryapi.dev  (api.dictionaryapi.dev/api/v2/entries/en/<word>)   — phonetics, parts of speech, definitions + examples
//   2. Wiktionary REST    (en.wiktionary.org/api/rest_v1/page/definition/<word>)   — definitions (HTML, stripped); `access-control-allow-origin: *`
//   3. Datamuse           (api.datamuse.com/words?sp=<word>&md=d)                  — short definitions; echoes the caller's Origin in its CORS header
// A source that fails (5xx / timeout / network) is skipped for 10 minutes so a dead service doesn't add a delay to every lookup.
import { DB } from './db.js';

export const SOURCES = [
  { id: 'dictionaryapi', name: 'dictionaryapi.dev', url: (w) => 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w), page: (w) => 'https://en.wiktionary.org/wiki/' + encodeURIComponent(w) },
  { id: 'wiktionary', name: 'Wiktionary', url: (w) => 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(w), page: (w) => 'https://en.wiktionary.org/wiki/' + encodeURIComponent(w) },
  { id: 'datamuse', name: 'Datamuse', url: (w) => 'https://api.datamuse.com/words?max=1&md=d&sp=' + encodeURIComponent(w), page: (w) => 'https://en.wiktionary.org/wiki/' + encodeURIComponent(w) },
];
export const tuning = { timeoutMs: 6000, downMs: 10 * 60 * 1000, cacheMax: 2000 };
const DOWN = 'folio.dict.down';
const downMap = () => { try { return JSON.parse(localStorage.getItem(DOWN) || '{}') || {}; } catch { return {}; } };
const markDown = (id) => { const m = downMap(); m[id] = Date.now(); try { localStorage.setItem(DOWN, JSON.stringify(m)); } catch { /* quota */ } };
const markUp = (id) => { const m = downMap(); if (m[id]) { delete m[id]; try { localStorage.setItem(DOWN, JSON.stringify(m)); } catch { /* quota */ } } };
const isDown = (id) => Date.now() - (downMap()[id] || 0) < tuning.downMs;

export const webUrl = (word) => 'https://www.google.com/search?q=' + encodeURIComponent('define ' + word);
export const normWord = (w) => String(w || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/^['\-]+|['\-]+$/g, '').replace(/'s$/, '').trim();

const strip = (html) => { try { const d = new DOMParser().parseFromString('<body>' + String(html || '') + '</body>', 'text/html'); return (d.body.textContent || '').replace(/\s+/g, ' ').trim(); } catch { return String(html || '').replace(/<[^>]+>/g, '').trim(); } };
const POS = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: '' };

/** Each parser returns { word, phonetic, meanings: [{ pos, defs: [{ d, ex }] }] } or null when the word is unknown. */
export const parsers = {
  dictionaryapi(j) {
    if (!Array.isArray(j) || !j.length) return null;
    const meanings = []; let phonetic = '';
    for (const e of j) {
      phonetic = phonetic || e.phonetic || (e.phonetics || []).map((p) => p.text).find(Boolean) || '';
      for (const m of e.meanings || []) { const defs = (m.definitions || []).map((d) => ({ d: d.definition, ex: d.example || '' })).filter((d) => d.d); if (defs.length) meanings.push({ pos: m.partOfSpeech || '', defs }); }
    }
    return meanings.length ? { word: j[0].word, phonetic, meanings } : null;
  },
  wiktionary(j) {
    if (!j || typeof j !== 'object') return null;
    const lang = j.en ? 'en' : Object.keys(j)[0]; const list = lang ? j[lang] : null; if (!Array.isArray(list) || !list.length) return null;
    const meanings = list.map((m) => ({ pos: (m.partOfSpeech || '').toLowerCase(), defs: (m.definitions || []).map((d) => ({ d: strip(d.definition), ex: strip((d.examples || [])[0] || '') })).filter((d) => d.d) })).filter((m) => m.defs.length);
    return meanings.length ? { word: '', phonetic: '', meanings } : null;
  },
  datamuse(j) {
    const w = Array.isArray(j) && j[0]; if (!w || !w.defs || !w.defs.length) return null;
    const by = new Map(); for (const line of w.defs) { const [p, ...rest] = String(line).split('\t'); const pos = POS[p] ?? p; const d = rest.join('\t').trim(); if (!d) continue; if (!by.has(pos)) by.set(pos, []); by.get(pos).push({ d, ex: '' }); }
    return by.size ? { word: w.word, phonetic: '', meanings: [...by].map(([pos, defs]) => ({ pos, defs })) } : null;
  },
};

async function fetchJson(url, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } }); return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null }; } finally { clearTimeout(t); }
}

/** Ask the sources in order. Resolves to { entry, src } | { missing: true } (every reachable source said "no such word") | { error: 'offline' | 'unreachable' }. */
async function ask(word) {
  let reached = false;
  const order = [...SOURCES.filter((s) => !isDown(s.id)), ...SOURCES.filter((s) => isDown(s.id))];   // sources that failed recently go last
  for (const s of order) {
    try {
      const r = await fetchJson(s.url(word), s === order[order.length - 1] || order.length === 1 ? tuning.timeoutMs : Math.min(tuning.timeoutMs, 4000));
      if (r.status === 404) { reached = true; markUp(s.id); continue; }
      if (r.status >= 500 || r.status === 429 || r.status === 0) { markDown(s.id); continue; }
      reached = true; markUp(s.id);
      const entry = r.json && parsers[s.id](r.json); if (entry) { entry.word = entry.word || word; return { entry, src: s.id }; }
    } catch { markDown(s.id); }
  }
  return reached ? { missing: true } : { error: navigator.onLine === false ? 'offline' : 'unreachable' };
}

const stems = (w) => { const out = []; const add = (x) => { if (x && x.length > 2 && x !== w && !out.includes(x)) out.push(x); };
  if (/ies$/.test(w)) add(w.slice(0, -3) + 'y'); if (/(es|ed)$/.test(w)) add(w.slice(0, -2)); if (/s$/.test(w)) add(w.slice(0, -1)); if (/ed$/.test(w)) add(w.slice(0, -1)); if (/ing$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); if (/(.)\1ing$/.test(w)) add(w.slice(0, -4)); } if (/ly$/.test(w)) add(w.slice(0, -2)); return out; };

export async function cached(word) { try { return await DB.get('dict', normWord(word)); } catch { return null; } }
async function remember(word, entry, src, asWord) {
  try {
    await DB.put('dict', { word, entry, src, at: Date.now(), asWord: asWord || word });
    const all = await DB.all('dict'); if (all.length > tuning.cacheMax) for (const x of all.sort((a, b) => a.at - b.at).slice(0, all.length - tuning.cacheMax)) await DB.del('dict', x.word);
  } catch { /* the cache is a nicety */ }
}
export async function cacheSize() { try { return (await DB.all('dict')).length; } catch { return 0; } }
export async function clearCache() { try { await DB.clear('dict'); } catch { /* ignore */ } }

/** Look a word up. Cached words answer instantly (and offline). Resolves to
 *  { status: 'ok', entry, src, cached, url } | { status: 'missing' } | { status: 'offline' | 'unreachable' } — never throws. */
export async function lookup(raw, { refresh = false } = {}) {
  const word = normWord(raw); if (!word) return { status: 'missing' };
  const hit = await cached(word);
  if (hit && !refresh) return { status: 'ok', entry: hit.entry, src: hit.src, cached: true, url: SOURCES.find((s) => s.id === hit.src)?.page(hit.asWord || word) || webUrl(word), asWord: hit.asWord };
  if (navigator.onLine === false) return hit ? { status: 'ok', entry: hit.entry, src: hit.src, cached: true, url: webUrl(word) } : { status: 'offline' };
  let r = await ask(word), used = word;
  if (r.missing) for (const st of stems(word)) { const c2 = await cached(st); if (c2) { r = { entry: c2.entry, src: c2.src }; used = st; break; } const r2 = await ask(st); if (r2.entry) { r = r2; used = st; break; } if (r2.error) { r = r2; break; } }
  if (r.entry) { await remember(word, r.entry, r.src, used); return { status: 'ok', entry: r.entry, src: r.src, cached: false, asWord: used, url: SOURCES.find((s) => s.id === r.src).page(used) }; }
  if (hit) return { status: 'ok', entry: hit.entry, src: hit.src, cached: true, url: webUrl(word) };
  return { status: r.missing ? 'missing' : r.error || 'unreachable' };
}

// "Fix missing info": finds books / audiobooks that lack a cover, author, description, series, year or language, looks them up in
// Open Library and Google Books (title + author fuzzy match, ISBN when known), and offers the matches on a review screen with a confidence
// score per match. Only missing fields are ever filled, fields the user set (or cleared) by hand are never touched, requests are rate
// limited, and nothing leaves the device except the title / author / ISBN of the item being looked up.
import { h, sheet, toast, $, put } from './util.js';
import { settings } from './settings.js';
import { fetchSmart, SiteError } from './net.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import { isbnFrom } from './metasync.js';

export const HIGH = 0.85, MEDIUM = 0.6;
const OL = 'https://openlibrary.org', GB = 'https://www.googleapis.com/books/v1/volumes';
export const FIELDS = ['cover', 'author', 'description', 'series', 'year', 'language'];
export const FIELD_LABEL = { cover: 'Cover', author: 'Author', description: 'Description', series: 'Series', year: 'Year', language: 'Language' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- rate limiting: a minimum gap between requests to the same host, and back-off on 429 ---------- */
const RATE = { gap: 450 }; const lastAt = new Map();
export const setRate = (ms) => { RATE.gap = ms; };
async function throttled(host) { const wait = (lastAt.get(host) || 0) + RATE.gap - Date.now(); lastAt.set(host, Math.max(Date.now(), (lastAt.get(host) || 0) + RATE.gap)); if (wait > 0) await sleep(wait); }
export async function getJson(url, { tries = 3 } = {}) {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    await throttled(host);
    try { return await (await fetchSmart(url, { timeout: 20000 })).json(); }
    catch (e) {
      if (e.http === 404) return null;
      if ((e.http === 429 || e.http === 503) && i < tries - 1) { await sleep(Math.max(RATE.gap * 3, 100) * (i + 1)); continue; }
      if (e.http === 429) { const er = new Error('rate-limited'); er.rate = true; throw er; }
      throw e;
    }
  }
  return null;
}

/* ---------- fuzzy matching ---------- */
const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const normTitle = (s) => fold(s).replace(/\(.*?\)|\[.*?\]/g, ' ').split(/[:\u2014\u2013]| - /)[0].replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/^(the|a|an) /, '').replace(/\s+/g, ' ').trim();
const lev = (a, b) => { const m = a.length, n = b.length; if (!m || !n) return 0; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return 1 - prev[n] / Math.max(m, n); };
export function titleSim(a, b) {
  const x = normTitle(a), y = normTitle(b); if (!x || !y) return 0; if (x === y) return 1;
  const tx = new Set(x.split(' ')), ty = new Set(y.split(' ')); const inter = [...tx].filter((t) => ty.has(t)).length; const jac = inter / (tx.size + ty.size - inter);
  const contain = (x.includes(y) || y.includes(x)) && Math.min(tx.size, ty.size) >= 2 ? 0.88 : 0;
  return Math.max(lev(x, y), jac, contain);
}
const nameTokens = (a) => { const s = fold(a).replace(/[^a-z, ;&]+/g, ' '); return new Set(s.split(/[ ,;&]+/).filter((t) => t.length > 1 && !['and', 'with', 'by', 'ed', 'edited', 'translated'].includes(t))); };
export function authorSim(book, cand) {
  const bt = nameTokens(book); const ct = new Set([...(cand || []).flatMap((a) => [...nameTokens(a)])]); if (!bt.size || !ct.size) return 0;
  return [...bt].filter((t) => ct.has(t)).length / bt.size;
}
export const hasAuthor = (a) => !!(a || '').trim() && !/^unknown( author)?$/i.test(a.trim());
/** Confidence 0..1 that a candidate is the same book. */
export function confidence(item, cand) {
  const isbn = (item.isbn || '').replace(/[^0-9Xx]/g, ''); if (isbn && cand.isbns?.some((i) => i.replace(/[^0-9Xx]/g, '') === isbn)) return 0.99;
  const ts = titleSim(item.title, cand.title); let c;
  if (hasAuthor(item.author)) c = 0.65 * ts + 0.35 * authorSim(item.author, cand.authors); else c = Math.min(0.7, 0.7 * ts);
  if (ts < 0.5) c *= 0.5; return Math.round(c * 100) / 100;
}
export const levelOf = (c) => (c >= HIGH ? 'high' : c >= MEDIUM ? 'medium' : 'low');

/* ---------- sources ---------- */
const LANG = { eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', lat: 'la', dut: 'nl', nld: 'nl', por: 'pt', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh', swe: 'sv', dan: 'da', nor: 'no', pol: 'pl', gre: 'el', ell: 'el' };
const lang2 = (l) => { l = (l || '').toLowerCase(); return l.length === 2 ? l : LANG[l.slice(0, 3)] || ''; };
const clean = (s) => (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;/g, '’').replace(/\n{3,}/g, '\n\n').trim();
const OL_FIELDS = 'key,title,author_name,first_publish_year,language,cover_i,isbn';
export function olCandidate(d) {
  return { source: 'Open Library', key: d.key, title: d.title || '', authors: d.author_name || [], year: d.first_publish_year || null, language: lang2((d.language || [])[0]), isbns: d.isbn || [], isbn: (d.isbn || []).find((i) => i.length === 13) || (d.isbn || [])[0] || '',
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '', thumb: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '', description: '', series: null };
}
export function gbCandidate(v) {
  const i = v.volumeInfo || {}; const ids = (i.industryIdentifiers || []).map((x) => x.identifier); const il = i.imageLinks || {};
  let cover = il.extraLarge || il.large || il.medium || il.small || il.thumbnail || il.smallThumbnail || ''; cover = cover.replace(/^http:/, 'https:').replace('&edge=curl', ''); if (/books\/content/.test(cover) && !il.large && !il.extraLarge) cover = cover.replace(/zoom=\d/, 'zoom=2');
  return { source: 'Google Books', key: v.id, title: [i.title, ''].join('').trim(), authors: i.authors || [], year: parseInt(i.publishedDate, 10) || null, language: lang2(i.language), isbns: ids, isbn: ids.find((x) => x.length === 13) || ids[0] || '',
    coverUrl: cover, thumb: (il.thumbnail || il.smallThumbnail || cover || '').replace(/^http:/, 'https:'), description: clean(i.description), series: null };
}
async function searchOL(item) {
  const isbn = (item.isbn || '').replace(/[^0-9Xx]/g, ''); const p = new URLSearchParams({ limit: '6', fields: OL_FIELDS });
  if (isbn) p.set('isbn', isbn); else { p.set('title', item.title); if (hasAuthor(item.author)) p.set('author', item.author.split(/,| and |&/)[0].trim()); }
  const d = await getJson(OL + '/search.json?' + p); return (d?.docs || []).map(olCandidate);
}
async function searchGB(item) {
  const isbn = (item.isbn || '').replace(/[^0-9Xx]/g, '');
  const q = isbn ? 'isbn:' + isbn : `intitle:${item.title}` + (hasAuthor(item.author) ? `+inauthor:${item.author.split(/,| and |&/)[0].trim()}` : '');
  const d = await getJson(GB + '?' + new URLSearchParams({ q, maxResults: '6', printType: 'books' }).toString().replace(/%2B/g, '+')); return (d?.items || []).map(gbCandidate);
}
/** Description + series live on the work / edition records. */
export async function olDetails(workKey) {
  const out = { description: '', series: null }; if (!workKey) return out;
  const w = await getJson(OL + workKey + '.json'); if (w) out.description = clean(typeof w.description === 'string' ? w.description : w.description?.value || '');
  const e = await getJson(OL + workKey + '/editions.json?limit=20');
  for (const ed of e?.entries || []) { const s = (ed.series || [])[0]; if (s) { out.series = parseSeries(s); if (out.series) break; } }
  return out;
}
export function parseSeries(s) {
  s = String(s || '').trim(); if (!s) return null;
  let m = /^(.*?)\s*[;,]\s*(?:#|no\.?|book|vol\.?|volume)?\s*(\d+(?:\.\d+)?)\s*$/i.exec(s) || /^(.*?)\s*\((?:book|vol\.?|volume|#)?\s*(\d+(?:\.\d+)?)\)\s*$/i.exec(s) || /^(.*?)\s+(?:book|vol\.?|volume|#)\s*(\d+(?:\.\d+)?)$/i.exec(s);
  return m ? { name: m[1].trim(), index: parseFloat(m[2]) } : { name: s, index: null };
}
const settle = async (fn) => { try { return await fn(); } catch (e) { return e; } };

/** Candidate covers for "Change cover → Search covers" (several editions from both sources). */
export async function findCoverCandidates(title, author, isbn) {
  const item = { title, author, isbn: isbn || '' }; const out = []; const seen = new Set();
  const [ol, gb] = await Promise.all([settle(() => searchOL({ ...item, isbn: '' })), settle(() => searchGB({ ...item, isbn: '' }))]);
  const cs = [...(Array.isArray(ol) ? ol : []), ...(Array.isArray(gb) ? gb : [])].map((c) => ({ ...c, conf: confidence(item, c) })).filter((c) => c.coverUrl && c.conf >= 0.35).sort((a, b) => b.conf - a.conf);
  for (const c of cs) { if (seen.has(c.coverUrl)) continue; seen.add(c.coverUrl); out.push({ source: c.source, label: c.source + ' · ' + Math.round(c.conf * 100) + '%', url: c.coverUrl, full: c.coverUrl, thumb: c.thumb || c.coverUrl }); }
  const cfg = window.FOLIO_CONFIG || {};
  if (cfg.googleCseKey && cfg.googleCseCx) {
    const d = await settle(() => getJson('https://www.googleapis.com/customsearch/v1?' + new URLSearchParams({ key: cfg.googleCseKey, cx: cfg.googleCseCx, searchType: 'image', num: '8', q: `${title} ${hasAuthor(author) ? author : ''} book cover` })));
    for (const x of (d && d.items) || []) if (x.link && !seen.has(x.link)) { seen.add(x.link); out.push({ source: 'Google Images', label: 'Google Images', url: x.link, full: x.link, thumb: x.image?.thumbnailLink || x.link }); }
  }
  if (!out.length && ol instanceof Error && gb instanceof Error) throw ol;
  return out.slice(0, 18);
}

/* ---------- scan ---------- */
const ADAPT = {
  book: { all: () => S.getBooks(), get: (id) => S.getBook(id), save: (b) => S.saveBook(b), fields: FIELDS, label: 'Books' },
  audio: { all: () => A.getAudiobooks(), get: (id) => A.getAudiobook(id), save: async (b) => { await A.saveAudiobook(b); S.emitChange(); }, fields: ['cover', 'author', 'description', 'year', 'language'], label: 'Audiobooks' },
};
export function missingFields(it, kind) {
  const m = [];
  for (const f of ADAPT[kind].fields) {
    if (it.userSet?.[f]) continue;   // user set (or deliberately cleared) it: leave it alone
    const miss = f === 'cover' ? !it.coverBlob : f === 'author' ? !hasAuthor(it.author) : f === 'description' ? !(it.description || '').trim() : f === 'series' ? !it.setId : f === 'year' ? !it.year : !it.language;
    if (miss) m.push(f);
  }
  return m;
}
const worth = (m) => m.some((f) => f !== 'series');   // series alone isn't a reason to look something up (most books have none)
export async function scanLibrary({ books = true, audio = true, retry = false } = {}) {
  const out = [];
  for (const kind of ['book', 'audio']) {
    if ((kind === 'book' && !books) || (kind === 'audio' && !audio)) continue;
    for (const it of await ADAPT[kind].all()) {
      const m = missingFields(it, kind); if (!m.length) continue;
      const tried = !retry && it.enrichTried && Date.now() - it.enrichTried < 30 * 864e5 && (it.enrichMissing || []).join() === m.join();
      out.push({ kind, id: it.id, title: it.title, author: it.author, missing: m, worth: worth(m), tried: !!tried });
    }
  }
  return out;
}

/* ---------- lookup ---------- */
/** Look one item up. Returns a proposal { kind, id, title, author, confidence, fields: {field: {value, source, conf}}, candidates } or null. */
export async function lookupItem(entry, { progress } = {}) {
  const a = ADAPT[entry.kind]; const it = await a.get(entry.id); if (!it) return null;
  const missing = missingFields(it, entry.kind); if (!missing.length) return null;
  const q = { title: it.title, author: it.author, isbn: it.isbn || isbnFrom(it.identifier) };
  const [ol, gb] = await Promise.all([settle(() => searchOL(q)), settle(() => searchGB(q))]);
  let rateLimited = gb instanceof Error && gb.rate;
  if (ol instanceof Error && gb instanceof Error && !rateLimited) throw ol;
  const cands = [...(Array.isArray(ol) ? ol : []), ...(Array.isArray(gb) ? gb : [])].map((c) => ({ ...c, conf: confidence(q, c) })).sort((x, y) => y.conf - x.conf);
  const usable = cands.filter((c) => c.conf >= MEDIUM);
  const prop = { kind: entry.kind, id: entry.id, title: it.title, author: it.author, missing, fields: {}, confidence: usable[0]?.conf || cands[0]?.conf || 0, candidates: cands.slice(0, 4).map(slim), rateLimited, curCover: null };
  if (!usable.length) return prop;
  const pick = (f, getv) => { for (const c of usable) { const v = getv(c); if (v) { prop.fields[f] = { value: v, source: c.source, conf: c.conf }; return true; } } return false; };
  for (const f of missing) {
    if (f === 'cover') pick('cover', (c) => c.coverUrl); else if (f === 'author') pick('author', (c) => (c.authors || []).join(', ')); else if (f === 'year') pick('year', (c) => c.year);
    else if (f === 'language') pick('language', (c) => c.language); else if (f === 'description') pick('description', (c) => c.description);
  }
  const bestOl = usable.find((c) => c.source === 'Open Library');
  if (bestOl && ((missing.includes('description') && !prop.fields.description) || (missing.includes('series') && entry.kind === 'book'))) {
    progress && progress('details');
    const d = await settle(() => olDetails(bestOl.key));
    if (!(d instanceof Error)) {
      if (missing.includes('description') && !prop.fields.description && d.description) prop.fields.description = { value: d.description, source: 'Open Library', conf: bestOl.conf };
      if (missing.includes('series') && d.series?.name) prop.fields.series = { value: d.series, source: 'Open Library', conf: bestOl.conf };
    }
  }
  const sub = Object.values(prop.fields); prop.confidence = sub.length ? Math.max(...sub.map((x) => x.conf)) : prop.confidence;
  return prop;
}
const slim = (c) => ({ source: c.source, title: c.title, authors: c.authors, year: c.year, conf: c.conf });
export { isbnFrom };

/** Runs lookups for a list of scan entries with progress + cancel. Resolves to proposals that found something. */
export async function runLookups(entries, { onProgress, signal = { cancelled: false } } = {}) {
  const out = []; let i = 0, errors = 0, limited = false;
  for (const e of entries) {
    if (signal.cancelled) break; i++; onProgress && onProgress({ i, n: entries.length, entry: e });
    try { const p = await lookupItem(e, {}); const it = await ADAPT[e.kind].get(e.id); if (it) { it.enrichTried = Date.now(); it.enrichMissing = missingFields(it, e.kind); await persistSilently(e.kind, it); } if (p) { limited = limited || p.rateLimited; out.push(p); } }
    catch (err) { errors++; if (errors >= 4 && errors === i) { throw new Error('Couldn’t reach Open Library or Google Books. Check your connection (or the proxy in Settings → Network).'); } }
  }
  return { proposals: out, errors, limited, cancelled: !!signal.cancelled };
}
async function persistSilently(kind, it) { const { DB } = await import('./db.js'); it._noTouch = true; await DB.put(kind === 'audio' ? 'audiobooks' : 'books', it); }   // bookkeeping only: doesn't count as an edit

/* ---------- apply ---------- */
/** Apply the accepted fields of a proposal. accepted: {field: true}; edits: {field: userTypedValue} (user typed → marked user-set). Returns the list of fields written. */
export async function applyProposal(p, accepted, edits = {}) {
  const a = ADAPT[p.kind]; const it = await a.get(p.id); if (!it) return [];
  const { resizeCover, fetchImage } = await import('./covers.js'); const wrote = []; it.userSet = it.userSet || {}; it.enriched = it.enriched || {}; it.metaAt = it.metaAt || {};
  const now = Date.now();
  for (const f of Object.keys({ ...accepted, ...edits })) {
    if (!accepted[f] && !(f in edits)) continue; if (it.userSet[f] && !(f in edits)) continue;   // never overwrite what the user set
    const typed = f in edits; const fld = p.fields[f]; const value = typed ? edits[f] : fld?.value; if (value == null || value === '') continue;
    if (f === 'cover') {
      if (it.coverBlob && !typed && it.userSet.cover) continue;
      try { const blob = typeof value === 'string' ? await fetchImage(value) : value; if (blob.size < 1500) continue; it.coverBlob = await resizeCover(blob); it.coverSource = typed ? 'user' : 'enrich'; it.coverId = null; if (typed) it.userSet.cover = true; } catch { continue; }
    } else if (f === 'author') it.author = String(value);
    else if (f === 'description') it.description = String(value).slice(0, 4000);
    else if (f === 'year') it.year = parseInt(value, 10) || null;
    else if (f === 'language') it.language = String(value);
    else if (f === 'series' && p.kind === 'book') {
      const name = typeof value === 'string' ? value : value.name; if (!name) continue; const set = await S.ensureSet(name, true); it.setId = set.id; it.seriesIndex = typeof value === 'object' && value.index != null ? value.index : (it.seriesIndex ?? null);
    } else continue;
    if (typed) it.userSet[f] = true; else it.enriched[f] = { src: fld?.source, conf: fld?.conf, at: now };
    it.metaAt[f] = now; wrote.push(f);
  }
  if (wrote.length) { if (it.enrichMissing) it.enrichMissing = missingFields(it, p.kind); await a.save(it); }
  return wrote;
}

/** Background enrichment for a freshly imported item: only high-confidence matches are applied. Never throws. */
export async function autoEnrichNew(it, kind) {
  if (!settings.get('autoEnrich')) return null;
  try {
    const entry = { kind, id: it.id }; if (!missingFields(it, kind).length) return null;
    const p = await lookupItem(entry); if (!p) return null;
    const accepted = {}; for (const [f, v] of Object.entries(p.fields)) if (v.conf >= HIGH) accepted[f] = true;
    if (!Object.keys(accepted).length) return null; const w = await applyProposal(p, accepted); return w;
  } catch { return null; }
}

/* ---------- UI: Fix missing info ---------- */
const pct = (c) => Math.round(c * 100) + '%';
export async function openFixMissing({ kind = null } = {}) {
  const scan = await scanLibrary({ books: kind !== 'audio', audio: kind !== 'book' });
  const counts = {}; for (const kd of ['book', 'audio']) { counts[kd] = {}; for (const e of scan.filter((x) => x.kind === kd)) for (const f of e.missing) counts[kd][f] = (counts[kd][f] || 0) + 1; }
  const todo = scan.filter((e) => e.worth && !e.tried); const skippedTried = scan.filter((e) => e.worth && e.tried).length;
  const w = sheet('Fix missing info', (close) => {
    const rows = [];
    for (const kd of ['book', 'audio']) {
      if (kind && kind !== kd) continue; const total = scan.filter((x) => x.kind === kd).length;
      rows.push(h('div', { class: 'sep' }, ADAPT[kd].label), total ? h('div', { class: 'fm-counts', id: 'fm-counts-' + kd }, ADAPT[kd].fields.map((f) => h('span', { class: 'fm-chip', 'data-field': f }, FIELD_LABEL[f] + ' ', h('b', null, String(counts[kd][f] || 0))))) : h('p', { class: 'muted small' }, 'Nothing missing.'));
    }
    return [h('p', { class: 'muted small' }, 'Folio looks up your items in Open Library and Google Books (only the title, author and ISBN are sent) and fills in what’s missing. You review every match first. Anything you edited yourself is never changed.'),
      ...rows, h('p', { class: 'muted small', id: 'fm-summary' }, todo.length ? `${todo.length} item${todo.length > 1 ? 's' : ''} to look up` + (skippedTried ? ` (${skippedTried} already checked recently)` : '') : (skippedTried ? `${skippedTried} item${skippedTried > 1 ? 's were' : ' was'} checked recently with no new matches.` : 'Your library is complete.')),
      h('div', { class: 'row-actions' }, skippedTried ? h('button', { class: 'btn', id: 'fm-retry', onclick: async () => { close(); await startLookup(scan.filter((e) => e.worth)); } }, 'Look up all again') : null,
        h('button', { class: 'btn primary', id: 'fm-start', disabled: !todo.length, onclick: async () => { close(); await startLookup(todo); } }, 'Start lookup'))];
  }, { tall: true });
  return w;
}
async function startLookup(entries) {
  const signal = { cancelled: false }; const bar = h('i', { id: 'fm-bar' }); const txt = h('div', { id: 'fm-progress-text', class: 'muted' }, 'Starting…');
  const w = sheet('Looking up…', (close) => [h('div', { class: 'bar fm-bar' }, bar), txt, h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'fm-cancel', onclick: () => { signal.cancelled = true; txt.textContent = 'Stopping…'; } }, 'Cancel'))], { closeLabel: '' });
  let res;
  try { res = await runLookups(entries, { signal, onProgress: ({ i, n, entry }) => { bar.style.width = Math.round(((i - 1) / n) * 100) + '%'; txt.textContent = `Looking up ${i} of ${n}: ${entry.title}`; } }); }
  catch (e) { w.close(); toast(e.message, 6000); return; }
  w.close();
  if (!res.proposals.some((p) => Object.keys(p.fields).length)) { toast(res.cancelled ? 'Lookup cancelled' : res.limited ? 'Google Books is busy right now; try again in a minute.' : 'No new matches found.', 5000); return; }
  reviewScreen(res);
}
function reviewScreen(res) {
  const props = res.proposals.filter((p) => Object.keys(p.fields).length);
  const st = new Map(props.map((p) => [p.kind + p.id, { state: p.confidence >= HIGH ? 'accept' : 'pending', edits: {}, off: {} }]));
  const list = h('div', { class: 'fm-list', id: 'fm-review' }); const apply = h('button', { class: 'btn primary', id: 'fm-apply' }); let w;
  const countAccepted = () => [...st.values()].filter((s) => s.state === 'accept').length;
  const refresh = () => { apply.textContent = `Apply ${countAccepted()} match${countAccepted() === 1 ? '' : 'es'}`; apply.disabled = !countAccepted(); };
  const card = (p) => {
    const s = st.get(p.kind + p.id); const lvl = levelOf(p.confidence);
    const el = h('div', { class: 'fm-card ' + s.state, dataset: { id: p.id, state: s.state, level: lvl } });
    const draw = () => {
      el.dataset.state = s.state; el.className = 'fm-card ' + s.state;
      const fields = Object.entries(p.fields).map(([f, v]) => {
        const val = f in s.edits ? s.edits[f] : v.value; const shown = f === 'cover' ? h('img', { class: 'fm-cover', src: typeof val === 'string' ? val : '', alt: '', onerror: (e) => { e.target.replaceWith(h('span', { class: 'muted' }, '(image)')); } }) : f === 'series' ? (typeof val === 'object' ? val.name + (val.index != null ? ' #' + val.index : '') : val) : String(val).slice(0, 140);
        return h('label', { class: 'fm-field', 'data-field': f }, h('input', { type: 'checkbox', checked: !s.off[f], onchange: (e) => { s.off[f] = !e.target.checked; } }), h('span', { class: 'fm-fl' }, FIELD_LABEL[f]), h('span', { class: 'fm-val' }, shown), h('small', { class: 'muted' }, v.source + ' ' + pct(v.conf)));
      });
      el.replaceChildren(h('div', { class: 'fm-head' }, h('div', { class: 'grow' }, h('strong', null, p.title), h('div', { class: 'muted small' }, (p.author || 'Unknown author') + ' · ' + (p.kind === 'audio' ? 'audiobook' : 'book'))), h('span', { class: 'fm-conf ' + lvl, 'data-level': lvl }, { high: 'High', medium: 'Medium', low: 'Low' }[lvl] + ' · ' + pct(p.confidence))),
        h('div', { class: 'fm-fields' }, fields),
        h('div', { class: 'row-actions fm-actions' }, h('button', { class: 'btn small' + (s.state === 'skip' ? ' on' : ''), 'data-act': 'skip', onclick: () => { s.state = s.state === 'skip' ? 'pending' : 'skip'; draw(); refresh(); } }, s.state === 'skip' ? 'Skipped' : 'Skip'),
          h('button', { class: 'btn small', 'data-act': 'edit', onclick: () => editMatch(p, s, draw) }, 'Edit'),
          h('button', { class: 'btn small' + (s.state === 'accept' ? ' primary' : ''), 'data-act': 'accept', onclick: () => { s.state = s.state === 'accept' ? 'pending' : 'accept'; draw(); refresh(); } }, s.state === 'accept' ? '✓ Accepted' : 'Accept')));
    };
    draw(); return el;
  };
  w = sheet(`Review ${props.length} match${props.length === 1 ? '' : 'es'}`, (close) => {
    props.sort((a, b) => b.confidence - a.confidence); props.forEach((p) => list.append(card(p)));
    apply.onclick = async () => {
      apply.disabled = true; apply.textContent = 'Applying…'; let n = 0, f = 0;
      for (const p of props) { const s = st.get(p.kind + p.id); if (s.state !== 'accept') continue; const accepted = {}; for (const k of Object.keys(p.fields)) if (!s.off[k]) accepted[k] = true; const edits = { ...s.edits }; for (const k of Object.keys(edits)) if (s.off[k]) delete edits[k];
        const wr = await applyProposal(p, accepted, edits); if (wr.length) { n++; f += wr.length; } }
      close(); toast(`Updated ${n} item${n === 1 ? '' : 's'} (${f} field${f === 1 ? '' : 's'})`, 4000);
    };
    return [h('p', { class: 'muted small' }, 'High-confidence matches are pre-accepted. Medium and low matches need your OK. Untick a field to leave it as it is.'),
      h('div', { class: 'row-actions wrap' }, h('button', { class: 'btn small', id: 'fm-all-high', onclick: () => { for (const p of props) if (p.confidence >= HIGH) st.get(p.kind + p.id).state = 'accept'; list.replaceChildren(...props.map(card)); refresh(); } }, 'Accept all high'),
        h('button', { class: 'btn small', id: 'fm-skip-all', onclick: () => { for (const s of st.values()) s.state = 'skip'; list.replaceChildren(...props.map(card)); refresh(); } }, 'Skip all')),
      res.limited ? h('p', { class: 'muted small' }, 'Google Books was rate-limiting requests, so some matches use Open Library only.') : null, list, h('div', { class: 'row-actions' }, apply)];
  }, { tall: true, onClose: () => {} });
  refresh();
}
function editMatch(p, s, redraw) {
  const get = (f) => (f in s.edits ? s.edits[f] : p.fields[f]?.value);
  const inputs = {}; const fieldsEl = [];
  for (const f of Object.keys(p.fields)) {
    if (f === 'cover') continue; const v = get(f);
    inputs[f] = f === 'description' ? h('textarea', { class: 'field', rows: 5, id: 'fm-edit-description' }, v || '') : h('input', { class: 'field', id: 'fm-edit-' + f, value: f === 'series' ? (typeof v === 'object' ? v.name : v || '') : v ?? '' });
    fieldsEl.push(h('label', null, FIELD_LABEL[f], inputs[f]));
    if (f === 'series') { inputs.seriesIndex = h('input', { class: 'field', id: 'fm-edit-seriesIndex', type: 'number', step: '0.5', placeholder: 'Volume #', value: typeof v === 'object' && v.index != null ? v.index : '' }); fieldsEl.push(h('label', null, 'Volume', inputs.seriesIndex)); }
  }
  const w = sheet('Edit match', (close) => [...fieldsEl, h('p', { class: 'muted small' }, 'What you type here counts as set by you, so automatic lookups won’t change it later.'),
    h('button', { class: 'btn primary block', id: 'fm-edit-save', onclick: () => {
      for (const f of Object.keys(inputs)) { if (f === 'seriesIndex') continue; const raw = inputs[f].value.trim(); if (f === 'series') { s.edits.series = raw ? { name: raw, index: inputs.seriesIndex.value !== '' ? parseFloat(inputs.seriesIndex.value) : null } : undefined; if (!raw) delete s.edits.series; }
        else if (raw !== String(p.fields[f].value ?? '')) s.edits[f] = raw; else delete s.edits[f]; }
      s.state = 'accept'; close(); redraw(); document.querySelector('#fm-apply') && (document.querySelector('#fm-apply').disabled = false); } }, 'Save and accept')], { tall: true });
  return w;
}

/* ---------- settings toggle ---------- */
export function enrichSettingsSection(openFix) {
  const on = !!settings.get('autoEnrich');
  return h('section', { class: 'pad card-sec', id: 'sec-metadata' }, h('h3', null, 'Missing info'),
    h('p', { class: 'muted small' }, 'Find missing covers, authors, descriptions, series, years and languages for your books and audiobooks (Open Library + Google Books). You review matches first, and anything you edited yourself is never overwritten.'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', id: 'auto-enrich', checked: on, onchange: (e) => settings.set({ autoEnrich: e.target.checked }) }), ' Automatically fill in missing info when I import (high-confidence matches only)'),
    h('p', { class: 'muted small' }, 'Off by default. When on, the title, author and ISBN of each newly imported item are sent to Open Library and Google Books.'),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'settings-fix-missing', onclick: () => openFix() }, 'Fix missing info…')));
}

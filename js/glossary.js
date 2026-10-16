// Per-book glossary + saved words (v0.5.6). One synced IndexedDB store, `glossary`, holds three kinds of record (all keyed by the book's sync key,
// so they follow the book to other devices and survive re-importing it):
//   kind 'term' – a glossary entry: { term, def, note, src: 'user' | 'auto' | 'import' }       (checked FIRST when a word is held)
//   kind 'word' – a saved dictionary word: { term, def (snapshot), pos, phonetic, ctx (sentence), cfi | page }
//   kind 'meta' – one per book: { shared } = share this book's glossary with the other books of its series
// Deleting leaves a small tombstone ({ del: true }) so the deletion syncs; tombstones are dropped after 90 days.
import { DB, uid } from './db.js';
import * as S from './store.js';

const GL = 'glossary';
export const TERM_MAX = 80, DEF_MAX = 1200;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
export const keyOf = (book) => S.bookSyncKey(book);
const lc = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").trim();
const live = (x) => x && !x.del;

let memo = null;
const invalidate = () => { memo = null; };
async function all() { if (!memo) memo = (await DB.all(GL)).filter(live); return memo; }
const changed = () => { invalidate(); try { S.emitChange(); } catch { /* ignore */ } window.dispatchEvent(new Event('folio-glossary')); };
export async function reload() { invalidate(); return all(); }

/** bookKey → setId for every book (used to find the other books of a series). */
async function setMap() { const m = new Map(); for (const b of await S.getBooks()) m.set(keyOf(b), b.setId || null); return m; }

export async function isShared(book) { const k = keyOf(book); return (await all()).some((x) => x.kind === 'meta' && x.bookKey === k && x.shared); }
export async function setShared(book, on) {
  const k = keyOf(book); const cur = (await DB.all(GL)).find((x) => x.kind === 'meta' && x.bookKey === k);
  await DB.put(GL, { ...(cur || { id: uid(), bookKey: k, kind: 'meta' }), shared: !!on, bookTitle: book.title }); changed();
}

/** Everything the book can see: its own records plus, for books in a series, the glossary entries of siblings that share theirs. */
export async function forBook(book) {
  const k = keyOf(book); const list = await all();
  const own = list.filter((x) => x.bookKey === k && x.kind !== 'meta');
  let shared = [];
  if (book.setId) {
    const sets = await setMap(); const sharing = new Set(list.filter((x) => x.kind === 'meta' && x.shared && x.bookKey !== k && sets.get(x.bookKey) === book.setId).map((x) => x.bookKey));
    if (sharing.size) shared = list.filter((x) => x.kind === 'term' && sharing.has(x.bookKey));
  }
  const terms = [...own.filter((x) => x.kind === 'term'), ...shared].sort((a, b) => lc(a.term).localeCompare(lc(b.term)));
  return { terms, own: own.filter((x) => x.kind === 'term'), shared, words: own.filter((x) => x.kind === 'word').sort((a, b) => (b.at || 0) - (a.at || 0)) };
}
export async function termCount(book) { const f = await forBook(book); return { terms: f.terms.length, words: f.words.length }; }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WB = (t) => new RegExp('(?<![\\p{L}\\p{N}])' + esc(t) + "(?:'s|’s|s)?(?![\\p{L}\\p{N}])", 'giu');
/** The glossary entry that covers the word at `offset` of `text` (multi-word terms included), else the entry whose term is that word. */
export function matchTerm(terms, word, text = '', offset = -1) {
  const w = lc(word); if (!w && offset < 0) return null;
  const byLen = [...terms].sort((a, b) => b.term.length - a.term.length);
  if (text && offset >= 0) for (const e of byLen) { const re = WB(e.term); let m; while ((m = re.exec(text))) { if (offset >= m.index && offset <= m.index + m[0].length) return e; if (m.index > offset) break; } }
  return byLen.find((e) => { const t = lc(e.term); return t === w || t + 's' === w || t + "'s" === w || (w.endsWith('s') && t === w.slice(0, -1)); }) || null;
}

export async function addTerm(book, { term, def, note = '', src = 'user' }) {
  term = clip(term, TERM_MAX); def = clip(def, DEF_MAX); if (!term) throw new Error('Enter the word or name first.');
  const k = keyOf(book); const dup = (await all()).find((x) => x.kind === 'term' && x.bookKey === k && lc(x.term) === lc(term));
  const rec = { ...(dup || { id: uid(), at: Date.now() }), bookKey: k, bookTitle: book.title, kind: 'term', term, def, note: clip(note, DEF_MAX), src: dup ? dup.src : src };
  await DB.put(GL, rec); changed(); return rec;
}
export async function updateTerm(id, patch) {
  const cur = await DB.get(GL, id); if (!cur || cur.del) return null;
  const rec = { ...cur, ...(patch.term != null ? { term: clip(patch.term, TERM_MAX) } : {}), ...(patch.def != null ? { def: clip(patch.def, DEF_MAX) } : {}), ...(patch.note != null ? { note: clip(patch.note, DEF_MAX) } : {}), src: cur.src === 'auto' || cur.src === 'import' ? 'user' : cur.src };
  if (!rec.term) return null; await DB.put(GL, rec); changed(); return rec;
}
export async function removeEntry(id) { const cur = await DB.get(GL, id); if (!cur) return; await DB.put(GL, { id, bookKey: cur.bookKey, kind: cur.kind, del: true }); changed(); }

export async function savedWord(book, word) { const k = keyOf(book), w = lc(word); return (await all()).find((x) => x.kind === 'word' && x.bookKey === k && lc(x.term) === w) || null; }
export async function saveWord(book, { term, def = '', pos = '', phonetic = '', ctx = '', cfi = '', page = 0 }) {
  term = clip(term, TERM_MAX); if (!term) return null; const dup = await savedWord(book, term);
  const rec = { ...(dup || { id: uid(), at: Date.now() }), bookKey: keyOf(book), bookTitle: book.title, kind: 'word', term, def: clip(def, DEF_MAX), pos, phonetic, ctx: clip(ctx, 300), ...(cfi ? { cfi } : {}), ...(page ? { page } : {}) };
  await DB.put(GL, rec); changed(); return rec;
}
export async function savedCounts() {   // for Settings: per book (key → { title, terms, words })
  const m = new Map(); for (const x of await all()) { if (x.kind === 'meta') continue; const r = m.get(x.bookKey) || { key: x.bookKey, title: x.bookTitle || x.bookKey, terms: 0, words: 0 }; r[x.kind === 'term' ? 'terms' : 'words']++; if (x.bookTitle) r.title = x.bookTitle; m.set(x.bookKey, r); }
  return [...m.values()].sort((a, b) => a.title.localeCompare(b.title));
}
export async function wordsOfKey(key) { return (await all()).filter((x) => x.bookKey === key && x.kind !== 'meta'); }
export async function clearBookWords(book) { const k = keyOf(book); for (const x of (await all()).filter((x) => x.bookKey === k && x.kind === 'word')) await DB.put(GL, { id: x.id, bookKey: k, kind: 'word', del: true }); changed(); }

/** Import reviewed candidates [{ term, def, note?, src }]. Existing terms are left as they are unless `overwrite`. */
export async function importTerms(book, list, { overwrite = false, src = 'import' } = {}) {
  const k = keyOf(book); const have = new Map((await all()).filter((x) => x.kind === 'term' && x.bookKey === k).map((x) => [lc(x.term), x]));
  let added = 0, updated = 0, skipped = 0;
  for (const c of list) {
    const term = clip(c.term, TERM_MAX); if (!term) continue; const cur = have.get(lc(term));
    if (cur && !overwrite) { skipped++; continue; }
    await DB.put(GL, { ...(cur || { id: uid(), at: Date.now() }), bookKey: k, bookTitle: book.title, kind: 'term', term, def: clip(c.def, DEF_MAX), note: clip(c.note || (cur && cur.note) || '', DEF_MAX), src: c.src || src });
    cur ? updated++ : added++; have.set(lc(term), { term });
  }
  changed(); return { added, updated, skipped };
}

/* ------------------------------------------------------------------ parsing: pasted text, CSV, selections */
function splitLine(line) {
  const t = line.trim(); if (!t) return null;
  const m = /^(["“]?)([^"“”:–—\t=]{1,80}?)\1?\s*(?:\s[-–—]\s|[:–—=]\s+|\t+|\s{3,})\s*(.+)$/.exec(t); if (m && m[3].trim().length >= 2) return { term: m[2].trim().replace(/[.,;:]+$/, ''), def: m[3].trim() };
  return null;
}
/** "term – definition" lines (also "term: definition", "term = definition", tab separated; a line without a separator continues the previous definition). */
export function parseText(text) {
  const out = []; let last = null;
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) { last = null; continue; }
    const p = splitLine(raw);
    if (p && p.term.split(/\s+/).length <= 8) { last = { term: p.term, def: p.def, src: 'import' }; out.push(last); }
    else if (last && /^\s/.test(raw)) last.def += ' ' + raw.trim();
    else if (last && !p) last.def += ' ' + raw.trim();
  }
  return dedupe(out);
}
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false; const s = String(text || '').replace(/^\uFEFF/, '');
  const delim = (s.split('\n')[0].match(/\t/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? '\t' : (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); if (row.some((x) => x.trim())) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  if (!rows.length) return [];
  let ti = 0, di = 1, ni = 2; const head = rows[0].map((x) => lc(x));
  if (head.some((x) => /^(term|word|name|entry)$/.test(x)) && head.some((x) => /^(definition|meaning|description|def|gloss)$/.test(x))) {
    ti = head.findIndex((x) => /^(term|word|name|entry)$/.test(x)); di = head.findIndex((x) => /^(definition|meaning|description|def|gloss)$/.test(x)); ni = head.findIndex((x) => /^(note|notes|comment)$/.test(x)); rows.shift();
  }
  return dedupe(rows.map((r) => ({ term: (r[ti] || '').trim(), def: (r[di] || '').trim(), note: ni >= 0 ? (r[ni] || '').trim() : '', src: 'import' })).filter((x) => x.term && (x.def || x.note)));
}
export function toCsv(terms) {
  const q = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
  return 'term,definition,note\n' + terms.map((t) => [q(t.term), q(t.def), q(t.note)].join(',')).join('\n') + '\n';
}
export function parseAny(text, name = '') { return /\.(csv|tsv)$/i.test(name) || (/^[^\n]*,[^\n]*\n/.test(text) && /^"?[^\n:–—]{1,60}"?,\s*"/.test(text)) ? parseCsv(text) : parseText(text); }
function dedupe(list) { const seen = new Set(); return list.filter((x) => { const k = lc(x.term); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }

/* ------------------------------------------------------------------ extraction from glossary / appendix pages */
const PAGE_RE = /\b(glossary|glossaries|appendix|appendices|dramatis personae|cast of characters|list of characters|characters|lexicon|vocabulary|terms|gazetteer|who'?s who|people and places|notes on (the )?(language|names|terms)|names and terms)\b/i;
export const looksLikeGlossaryTitle = (t) => PAGE_RE.test(String(t || ''));
const tag = (e) => (e.localName || e.tagName || '').toUpperCase();   // XHTML sections are XML documents: tag names keep their (lower) case
const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
const LEAD = 'b,strong,i,em,dfn,span,u,a';
function leadSplit(p) {
  const first = p.firstElementChild; const full = textOf(p);
  if (first && first.matches(LEAD)) {
    const ft = textOf(first); if (ft && ft.length <= 70 && full.startsWith(ft) && (!first.previousSibling || !String(first.previousSibling.textContent || '').trim())) {
      const rest = full.slice(ft.length).replace(/^\s*(?:[:–—.,;=-]|\u2014)\s*/, '').trim(); const rawRest = full.slice(ft.length);
      if (rest.length >= 3 && (/^\s*[:–—.,;=-]/.test(rawRest) || (first.matches('b,strong,dfn') && rawRest.startsWith(' ')))) return { term: ft.replace(/[.,;:–—-]+$/, '').trim(), def: rest };
    }
  }
  return splitLine(full);
}
/** Candidate entries found in a parsed document (or element): definition lists, two-column tables, and "Term – definition" paragraphs / list items. */
export function extractFromDoc(root) {
  const out = []; const scope = root.body || root; if (!scope || !scope.querySelectorAll) return out;
  for (const dl of scope.querySelectorAll('dl')) { let t = null; for (const n of dl.children) { if (tag(n) === 'DT') t = textOf(n); else if (tag(n) === 'DD' && t) { out.push({ term: t, def: textOf(n), src: 'auto' }); } } }
  for (const tr of scope.querySelectorAll('tr')) { const c = [...tr.children].filter((x) => /^T[DH]$/.test(tag(x))); if (c.length >= 2 && tr.querySelector('td')) { const t = textOf(c[0]), d = textOf(c[1]); if (t && d && t.length <= 80) out.push({ term: t, def: d, src: 'auto' }); } }
  for (const el of scope.querySelectorAll('p, li, div')) {
    if (el.closest('dl, table')) continue; if (tag(el) === 'DIV' && el.querySelector('p, li, div, table, dl')) continue; if (tag(el) === 'LI' && el.querySelector('li')) continue;
    if (el.querySelector('br') && el.children.length > 1) {   // several entries in one paragraph, separated by <br>
      const lines = el.innerHTML.split(/<br\b[^>]*>/i); let any = false;
      for (const ln of lines) { const d = document.createElement('div'); d.innerHTML = ln; const p = leadSplit(d); if (p) { out.push({ ...p, src: 'auto' }); any = true; } }
      if (any) continue;
    }
    const p = leadSplit(el); if (p) out.push({ ...p, src: 'auto' });
  }
  const clean = out.map((x) => ({ ...x, term: x.term.replace(/^[“"‘']|[”"’']$/g, '').trim(), def: x.def.trim() })).filter((x) => x.term && x.term.length <= 70 && x.term.split(/\s+/).length <= 7 && x.def.length >= 4 && !/^(chapter|page|part|book|contents?)\b/i.test(x.term));
  return dedupe(clean);
}
/** Sections of an EPUB that look like glossary / appendix pages (by their table-of-contents title or file name). */
export function glossaryPages(epub, toc) {
  const flat = []; const walk = (items) => { for (const it of items || []) { flat.push(it); walk(it.subitems); } }; walk(toc);
  const hits = flat.filter((it) => looksLikeGlossaryTitle(it.label)).map((it) => ({ label: (it.label || '').trim(), href: it.href }));
  try { for (const it of epub.spine.spineItems || epub.spine.items || []) if (/(glossar|appendix|dramatis|lexicon|vocab)/i.test(it.href || '') && !hits.some((h) => (h.href || '').split('#')[0] === it.href)) hits.push({ label: (it.href || '').split('/').pop(), href: it.href }); } catch { /* ignore */ }
  return hits;
}
/** Load a section by href and extract candidate entries. When the href points at an anchor, only the content from there to the next heading is used. */
export async function extractFromSection(epub, href) {
  const [file, frag] = String(href).split('#'); const sec = epub.spine.get(file) || epub.spine.get(href); if (!sec) return [];
  try {
    const el = await sec.load(epub.load.bind(epub)); const doc = el.ownerDocument || el; let root = doc;
    if (frag) { const a = doc.getElementById(frag); if (a) { const box = doc.createElement('div'); let n = a.closest('h1,h2,h3,h4,h5,h6,p,div,section') || a; const start = n; let node = start.nextElementSibling; box.append(start.cloneNode(true)); while (node && !/^H[1-3]$/.test(tag(node))) { box.append(node.cloneNode(true)); node = node.nextElementSibling; } root = box; } }
    return extractFromDoc(root);
  } finally { try { sec.unload(); } catch { /* ignore */ } }
}

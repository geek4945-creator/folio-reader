// KyBook 3 import (v0.5.20) — EXPERIMENTAL, honest about what is known.
// KyBook 3 (iOS) has no documented library export or backup file: its sync is a private cloud account, and the only published KyBook
// format (github.com/kolyvan/kybookfmt) is KyBook 2's per-book .kb/.kba tarball (_manifest.json + content). What a user can reliably
// take out of KyBook 3 is (a) the book FILES (Files app → "KyBook 3" folder, iCloud Drive, or KyBook's WiFi Content Server) and (b) any
// list they export themselves. So this importer is tolerant: it reads CSV/TSV, JSON, a .kb/.kba manifest, or a .zip containing those,
// maps common column / key names (title, author, status, tags/collections, progress, rating), previews the matches against the books
// already in Folio, and only then sets status and shelves on the matched books. It never creates books without files. Nothing here has
// been tested on a real KyBook 3 export (none is documented); an unreadable file offers "send the file details" (structure only).
import * as S from './store.js';
import { openZip } from './zip.js';

export class KyBookFormatError extends Error { constructor(msg, info) { super(msg); this.info = info; } }
const ALIASES = {
  title: ['title', 'book', 'book title', 'booktitle', 'name', 'book name', 'dc:title'],
  author: ['author', 'authors', 'creator', 'creators', 'writer', 'author name', 'book author', 'dc:creator'],
  status: ['status', 'state', 'read status', 'reading status', 'readstatus', 'shelf', 'exclusive shelf', 'read'],
  tags: ['tags', 'tag', 'collections', 'collection', 'bookshelves', 'bookshelf', 'shelves', 'labels', 'label', 'folder', 'category', 'categories', 'genre', 'genres'],
  progress: ['progress', 'percent', 'percentage', 'position', 'read %', 'read percent', 'progress %', 'readprogress', 'reading progress'],
  rating: ['rating', 'stars', 'my rating', 'score'],
  isbn: ['isbn', 'isbn13', 'isbn 13', 'isbn10'],
};
const norm = (k) => String(k || '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
export function fieldOf(key) { const n = norm(key); for (const [f, list] of Object.entries(ALIASES)) if (list.includes(n)) return f; return null; }

/* ---------- CSV ---------- */
export function parseDelimited(text) {
  text = text.replace(/^\uFEFF/, ''); const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row);
  return { delim, rows };
}
function fromTable(rows, info) {
  if (rows.length < 2) throw new KyBookFormatError('The file has no data rows.', info);
  const head = rows[0]; const map = head.map(fieldOf); info.columns = head.map((x) => String(x).slice(0, 40));
  if (!map.includes('title')) throw new KyBookFormatError('No “Title” column was found (columns: ' + info.columns.join(', ') + ').', info);
  return rows.slice(1).map((r) => { const o = {}; map.forEach((f, i) => { if (f && r[i] != null && String(r[i]).trim() && o[f] == null) o[f] = String(r[i]).trim(); }); return o; });
}
/* ---------- JSON ---------- */
function pickArray(j) {
  if (Array.isArray(j)) return j;
  for (const k of ['books', 'items', 'library', 'records', 'data', 'entries']) if (j && Array.isArray(j[k])) return j[k];
  if (j && typeof j === 'object') { const arr = Object.values(j).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object'); if (arr) return arr; }
  return null;
}
function fromObject(o) {
  const out = {}; const walk = (obj, depth) => { for (const [k, v] of Object.entries(obj || {})) { const f = fieldOf(k);
    if (f && out[f] == null && v != null && v !== '') out[f] = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? x.name || x.title || '' : x)).filter(Boolean).join(', ') : typeof v === 'object' ? (v.name || v.title || '') : String(v);
    else if (!f && v && typeof v === 'object' && !Array.isArray(v) && depth < 2) walk(v, depth + 1); } };
  walk(o, 0); return out;
}
/* ---------- KyBook 2 .kb / .kba (TAR with _manifest.json) ---------- */
export function readTar(buf) {
  const u = new Uint8Array(buf); const files = new Map(); let off = 0; const dec = new TextDecoder();
  while (off + 512 <= u.length) {
    const hdr = u.subarray(off, off + 512); if (hdr.every((b) => b === 0)) break;
    const name = dec.decode(hdr.subarray(0, 100)).replace(/\0.*$/s, ''); const size = parseInt(dec.decode(hdr.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8) || 0;
    const prefix = dec.decode(hdr.subarray(345, 500)).replace(/\0.*$/s, ''); const full = (prefix ? prefix + '/' : '') + name;
    files.set(full.replace(/^\.\//, ''), u.subarray(off + 512, off + 512 + size)); off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Read a file the user picked. Returns { kind, rows, info }; throws KyBookFormatError with .info (structure only) when it can't. */
export async function parseFile(file) {
  const name = file.name || 'file'; const info = { name, size: file.size, type: file.type || '', kind: '' };
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer()); const magic = new TextDecoder().decode(head);
  if (magic.startsWith('SQLite format 3')) { info.kind = 'sqlite'; throw new KyBookFormatError('This is a SQLite database (probably KyBook’s internal library file). Its layout isn’t documented, so Folio can’t read it safely yet.', info); }
  if (head[0] === 0x50 && head[1] === 0x4b) {   // zip: look for a list inside
    info.kind = 'zip'; const z = await openZip(file); info.entries = z.names().slice(0, 30);
    const pick = z.names().find((n) => /\.(csv|tsv)$/i.test(n)) || z.names().find((n) => /\.json$/i.test(n) && !/manifest\.json$/i.test(n)) || z.names().find((n) => /_manifest\.json$/i.test(n));
    if (!pick) throw new KyBookFormatError('The .zip has no CSV or JSON list inside.', info);
    const inner = new File([await z.blob(pick)], pick.split('/').pop()); const r = await parseFile(inner); r.info = { ...info, inner: r.info }; return r;
  }
  if (/\.kba?$/i.test(name) || new TextDecoder().decode(new Uint8Array(await file.slice(257, 262).arrayBuffer())) === 'ustar') {
    info.kind = 'kb'; const files = readTar(await file.arrayBuffer()); info.entries = [...files.keys()].slice(0, 30);
    const mf = [...files.keys()].find((k) => /(^|\/)_manifest\.json$/.test(k)); if (!mf) throw new KyBookFormatError('No _manifest.json in this KyBook file.', info);
    let j; try { j = JSON.parse(new TextDecoder().decode(files.get(mf))); } catch { throw new KyBookFormatError('The KyBook manifest is damaged.', info); }
    const row = fromObject(j); if (!row.title) throw new KyBookFormatError('The KyBook manifest has no title.', { ...info, keys: Object.keys(j).slice(0, 30) });
    return { kind: 'kb', rows: [row], info };
  }
  const text = await file.text();
  if (/^\s*[[{]/.test(text)) {
    info.kind = 'json'; let j; try { j = JSON.parse(text); } catch { throw new KyBookFormatError('The file looks like JSON but can’t be read.', info); }
    const arr = pickArray(j); info.keys = Object.keys((arr && arr[0]) || j || {}).slice(0, 30);
    if (!arr) { const one = fromObject(j); if (one.title) return { kind: 'json', rows: [one], info }; throw new KyBookFormatError('No list of books was found in the JSON.', info); }
    const rows = arr.filter((x) => x && typeof x === 'object').map(fromObject).filter((r) => r.title);
    if (!rows.length) throw new KyBookFormatError('No book titles were found in the JSON (keys: ' + info.keys.join(', ') + ').', info);
    return { kind: 'json', rows, info };
  }
  info.kind = 'csv'; const { rows } = parseDelimited(text); const out = fromTable(rows, info).filter((r) => r.title);
  if (!out.length) throw new KyBookFormatError('No book titles were found.', info);
  return { kind: 'csv', rows: out, info };
}

/* ---------- mapping ---------- */
export function mapStatus(s, progress) {
  const v = norm(s);
  if (/^(finished|read|done|completed?|1|yes|true)$/.test(v) || /\bfinished\b|\bcompleted?\b|^read$/.test(v)) return 'finished';
  if (/reading|current|started|in progress|opened/.test(v)) return 'reading';
  if (/want|to read|to-read|planned|plan|wish|later|queue|unread|new/.test(v)) return 'want';
  if (progress != null) { if (progress >= 0.995) return 'finished'; if (progress > 0.005) return 'reading'; }
  return null;
}
export function mapProgress(p) { if (p == null || p === '') return null; const n = parseFloat(String(p).replace('%', '').replace(',', '.')); if (!isFinite(n)) return null; const f = /%/.test(String(p)) || n > 1 ? n / 100 : n; return Math.max(0, Math.min(1, f)); }
export const splitTags = (t) => String(t || '').split(/[;,|/]+/).map((x) => x.trim()).filter((x) => x && x.length <= 60).slice(0, 12);
const tnorm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[:–—-].*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const anorm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w.length > 1);

/** Pair each row with a book already in Folio (same title; author must agree when both have one). */
export function matchRows(rows, books) {
  const byT = new Map(); for (const b of books) { const k = tnorm(b.title); if (!k) continue; (byT.get(k) || byT.set(k, []).get(k)).push(b); }
  return rows.map((r) => {
    const progress = mapProgress(r.progress); const cands = byT.get(tnorm(r.title)) || []; const aw = anorm(r.author);
    const book = cands.find((b) => !aw.length || !b.author || anorm(b.author).some((w) => aw.includes(w))) || null;
    return { row: r, book, status: mapStatus(r.status, progress), progress, tags: splitTags(r.tags) };
  });
}
/** Apply the chosen parts to the matched books. Returns a summary. */
export async function apply(matches, { status = true, shelves = true } = {}) {
  const sum = { matched: 0, notInLibrary: 0, statusSet: 0, shelvesCreated: [], shelfAdds: 0 };
  const shelfByName = new Map((await S.getShelves()).map((s) => [s.name.toLowerCase(), s]));
  for (const m of matches) {
    if (!m.book) { sum.notInLibrary++; continue; } sum.matched++;
    if (status && m.status && m.book.status !== m.status) { await S.setStatusMany([m.book.id], m.status); sum.statusSet++; }
    if (shelves) for (const t of m.tags) {
      let sh = shelfByName.get(t.toLowerCase()); if (!sh) { sh = await S.createShelf(t); shelfByName.set(t.toLowerCase(), sh); sum.shelvesCreated.push(t); }
      const b = await S.getBook(m.book.id); if (!(b.shelves || []).includes(sh.id)) { await S.addToShelfMany([b.id], sh.id); sum.shelfAdds++; }
    }
  }
  return sum;
}
/** What "send the file details" sends: structure only (name, size, type, column names / keys / archive entries) — never book content. */
export function sampleReport(info, err) {
  const i = info || {}; const parts = ['KyBook 3 import sample — the file could not be read.', 'Error: ' + (err || ''), 'File: ' + (i.name || '') + ' · ' + (i.size || 0) + ' bytes · ' + (i.type || 'no type') + ' · detected: ' + (i.kind || 'unknown')];
  if (i.columns) parts.push('Columns: ' + i.columns.join(', ')); if (i.keys) parts.push('Keys: ' + i.keys.join(', ')); if (i.entries) parts.push('Entries: ' + i.entries.join(', '));
  if (i.inner) parts.push('Inner: ' + JSON.stringify({ kind: i.inner.kind, columns: i.inner.columns, keys: i.inner.keys }).slice(0, 400));
  return parts.join('\n').slice(0, 1900);
}

/* ---------- UI (Settings → Backup → "Import from KyBook 3…") ---------- */
import { h, sheet, toast } from './util.js';
export function openKyBookImport() {
  const input = h('input', { type: 'file', id: 'kyb-file', accept: '.csv,.tsv,.txt,.json,.kb,.kba,.zip,.sqlite,.db', hidden: true, onchange: async () => { const f = input.files[0]; input.value = ''; if (f) { closeIt(); await handleFile(f); } } });
  let closeIt = () => {};
  sheet('Import from KyBook 3', (close) => { closeIt = close; return [
    h('p', { class: 'muted', id: 'kyb-note' }, 'Experimental — not yet tested with real KyBook 3 data. KyBook 3 has no documented export file, so Folio can’t copy your KyBook library directly. Here’s what works:'),
    h('ol', { class: 'kyb-steps' },
      h('li', null, h('b', null, 'Bring the books: '), 'on the iPhone open Files → On My iPhone (or iCloud Drive) → “KyBook 3”, select the books and Share → Save to Files / Drive. Then import them in Folio with ', h('i', null, 'Library → ＋ Add books'), ' (files or a whole Drive folder).'),
      h('li', null, h('b', null, 'Then bring statuses & collections (optional): '), 'if you have a list of your books as CSV or JSON (with columns like Title, Author, Status, Collections/Tags, Progress), or a KyBook 2 .kb/.kba file, choose it below. Folio shows a preview first and only changes books that are already in your library.')),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'kyb-choose', onclick: () => input.click() }, 'Choose list file…')),
    h('p', { class: 'muted small' }, 'If Folio can’t read your file, you can send us its structure (file type, column names — no book text) so we can add support.'),
    input,
  ]; });
}
export async function handleFile(file) {
  let res; try { res = await parseFile(file); } catch (e) { return unknownSheet(e.info || { name: file.name, size: file.size, type: file.type }, e.message || String(e)); }
  const matches = matchRows(res.rows, await S.getBooks());
  return previewSheet(res, matches);
}
function previewSheet(res, matches) {
  const hit = matches.filter((m) => m.book), miss = matches.length - hit.length;
  const opt = { status: true, shelves: true };
  const tags = new Set(hit.flatMap((m) => m.tags));
  const label = { finished: 'Finished', reading: 'Reading', want: 'Want to Read' };
  return sheet('KyBook import — preview', (close) => [
    h('p', { id: 'kyb-counts' }, `${matches.length} books in the file · `, h('b', { id: 'kyb-matched' }, String(hit.length)), ' match your library · ', h('span', { id: 'kyb-missing' }, String(miss)), ' not in Folio yet'),
    miss ? h('p', { class: 'muted small' }, 'Books that aren’t in Folio are skipped — import their files first, then run this again.') : null,
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'kyb-opt-status', checked: true, onchange: (e) => { opt.status = e.target.checked; } }), ' Set reading status'),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'kyb-opt-shelves', checked: true, onchange: (e) => { opt.shelves = e.target.checked; } }), ` Add to shelves from collections/tags (${tags.size})`),
    h('div', { class: 'kyb-list', id: 'kyb-list' }, ...matches.slice(0, 200).map((m) => h('div', { class: 'kyb-row' + (m.book ? ' hit' : ' miss') },
      h('span', null, (m.book ? '✓ ' : '– ') + m.row.title + (m.row.author ? ' — ' + m.row.author : '')),
      h('span', { class: 'muted small' }, [m.status ? label[m.status] : '', m.tags.join(', ')].filter(Boolean).join(' · '))))),
    matches.length > 200 ? h('p', { class: 'muted small' }, `…and ${matches.length - 200} more`) : null,
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'kyb-apply', disabled: !hit.length, onclick: async () => { const s = await apply(matches, opt); close(); summarySheet(s); } }, `Apply to ${hit.length} books`)),
  ], { tall: true, closeLabel: 'Cancel' });
}
function summarySheet(s) {
  sheet('KyBook import — done', () => [
    h('ul', { id: 'kyb-summary' },
      h('li', null, `${s.matched} books matched`), h('li', null, `${s.statusSet} statuses set`),
      h('li', null, `${s.shelfAdds} shelf placements` + (s.shelvesCreated.length ? ` · new shelves: ${s.shelvesCreated.join(', ')}` : '')),
      h('li', null, `${s.notInLibrary} skipped (not in Folio)`)),
    h('p', { class: 'muted small' }, 'These changes sync like any other edit.'),
  ]);
}
function unknownSheet(info, msg) {
  const report = sampleReport(info, msg);
  sheet('Can’t read this file yet', (close) => [
    h('p', { id: 'kyb-unknown' }, msg),
    h('p', null, 'Folio doesn’t know this KyBook format yet — send us a sample and we’ll add it. Tapping below sends only the file’s structure (shown here), never book text:'),
    h('pre', { class: 'kyb-report', id: 'kyb-report' }, report),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'kyb-send-sample', onclick: async (e) => {
      e.target.disabled = true;
      try { const { submitSuggestion } = await import('./suggest.js'); const it = await submitSuggestion(report); toast(it.status === 'sent' ? 'Sent — thank you!' : 'Saved — it will send when you’re online.'); close(); }
      catch (err) { e.target.disabled = false; toast(err.message || 'Couldn’t send'); }
    } }, 'Send file details')),
  ]);
}

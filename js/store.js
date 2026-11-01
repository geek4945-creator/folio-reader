// Library data layer: books, sets (series), shelves, manual orders, per-book style overrides.
import { DB, uid, GROUPS } from './db.js';
import { forceUo } from './bookinfo.js';
import { parseEpub, shrinkCover } from './epubmeta.js';
import { settings, clampPt, clearSort } from './settings.js';
import { fetchSmart, openLibraryCover } from './net.js';
import { isPdf, parsePdf } from './pdf.js';
import { applyPendingMeta, getPendingMeta, setPendingMeta, isbnFrom } from './metasync.js';
import { detectKindle, kindleToEpub, looksLikeKfxZip, kfxError } from './kindle.js';

export const STATUSES = [
  { id: 'reading', name: 'Currently Reading' },
  { id: 'want', name: 'Want to Read' },
  { id: 'finished', name: 'Finished' },
];
// v0.5.18: "Currently Reading" is no longer a Library shelf (the Reading now tab covers it). It stays a status (sorting, grouping, sync, Reading now).
export const SHELF_STATUSES = STATUSES.filter((s) => s.id !== 'reading');
export const statusName = (id) => STATUSES.find((s) => s.id === id)?.name || id;

const bus = new EventTarget();
export const onLibraryChange = (fn) => bus.addEventListener('change', fn);
export const emitChange = () => bus.dispatchEvent(new Event('change'));

/* ---------- books ---------- */
export const getBooks = () => DB.all('books');
export const getBook = (id) => DB.get('books', id);
export async function saveBook(b) { await DB.put('books', b); emitChange(); return b; }

export async function addBookFromBuffer(buffer, hints = {}) {
  // Kindle formats (.mobi/.azw/.azw3/.kf8) are sniffed by content and converted to EPUB first; DRM files throw a friendly error.
  let origFormat = null; const pdfMeta = isPdf(buffer) ? await parsePdf(buffer, hints.filename || '') : null;
  if (!pdfMeta && detectKindle(buffer)) { const c = await kindleToEpub(buffer, { filename: hints.filename || '' }); buffer = c.buffer; origFormat = c.kind; }
  let meta;
  try { meta = pdfMeta || await parseEpub(buffer); }
  catch (e) { if (/container\.xml/.test(e.message) && await looksLikeKfxZip(buffer)) throw kfxError(); throw e; }
  const books = await getBooks();
  if (hints.sourceKey && books.some((b) => b.sourceKey === hints.sourceKey)) throw new Error('Already in your library');
  const dupe = books.find((b) => meta.identifier && b.identifier === meta.identifier && b.title === meta.title);
  if (dupe) throw new Error('"' + meta.title + '" is already in your library');

  let cover = meta.coverBlob; let coverSource = cover ? 'file' : 'file';
  if (!cover && hints.coverUrl) {
    try { const r = await fetchSmart(hints.coverUrl, { timeout: 15000 }); const b = await r.blob(); if (/^image\//.test(b.type)) { cover = b; coverSource = 'enrich'; } } catch { /* hotlink blocked */ }
  }
  if (cover) cover = await shrinkCover(cover);

  const series = meta.series || hints.series || '';
  const seriesIndex = meta.series ? meta.seriesIndex : (hints.series ? hints.seriesIndex : null);
  const setId = null;   // v0.5.21: the file's series is only used when no other device has already decided this book's set (see applyPending below)

  const book = {
    id: uid(), title: (meta.title && !/^untitled$/i.test(meta.title.trim()) ? meta.title : (hints.title || meta.title || 'Untitled')), author: meta.author !== 'Unknown author' ? meta.author : (hints.author || meta.author),
    language: meta.language, description: meta.description || hints.summary || '', identifier: meta.identifier, year: meta.year || null, isbn: isbnFrom(meta.identifier), coverSource,
    addedAt: Date.now(), lastOpened: 0, progress: 0, cfi: null, status: 'want', shelves: [],
    setId, seriesIndex: seriesIndex ?? null, coverBlob: cover || null, size: buffer.byteLength, format: pdfMeta ? 'pdf' : 'epub', pages: pdfMeta ? pdfMeta.pages : null,
    syncKey: uniqueSyncKey(books, meta, buffer.byteLength, hints.syncKey), filename: hints.filename || null,
    sourceKey: hints.sourceKey || null, source: hints.source || 'import', origFormat, overrides: null, locations: null,
  };
  if (hints.borrowed) Object.assign(book, { borrowed: true, dueAt: hints.dueAt || null, loanAt: Date.now(), loanSource: hints.source || '' });   // library loan: lands in the Borrowed filter
  const dec = applyPending(book); book.posAt ??= 0;
  if (series && !dec.series) book.setId = (await ensureSet(series, true)).id;
  if (dec.series && book.setId && !(await DB.get('sets', book.setId))) { book.setId = null; book.seriesIndex = null; }   // a fresh import has no position of its own (never outranks another device's)
  await DB.put('files', { id: book.id, blob: new Blob([buffer], { type: pdfMeta ? 'application/pdf' : 'application/epub+zip' }) });
  // A fresh import is not a user edit (keeps cross-device merge fair), unless the book was deleted before: then it must outrank the deletion tombstone.
  const tombed = getTombs().some((t) => t.t === 'book' && t.id === book.syncKey);
  if (tombed) { localStorage.setItem('folio.tombs', JSON.stringify(getTombs().filter((t) => !(t.t === 'book' && t.id === book.syncKey)))); book.updatedAt = Date.now(); book._noTouch = true; }
  else { book._noTouch = true; book.updatedAt = 0; }
  await DB.put('books', book);
  await resolveOrderPlaceholders(book);
  emitChange();
  if (settings.get('autoEnrich')) import('./enrich.js').then((m) => m.autoEnrichNew(book, 'book'));   // background, high-confidence only, never throws
  return book;
}

/** Delete one or more books everywhere on this device: record (cover, position, overrides), file, bookmarks, manual-order entries, and sets
 *  that end up empty. Adds sync tombstones so the deletion reaches Drive state. Originals on the device / Drive are never touched.
 *  Returns an undo snapshot for restoreBooks(). opts: { tomb: false } when applying a remote deletion; { emit: false } to skip the change event. */
export async function deleteBooks(ids, opts = {}) {
  ids = [...new Set(ids)]; const idset = new Set(ids);
  const snap = { books: [], files: [], bookmarks: [], orders: [], sets: [], keys: [] };
  const all = await getBooks(); const setIds = new Set();
  for (const id of ids) {
    const b = all.find((x) => x.id === id); if (!b) continue;
    snap.books.push(b); const f = await DB.get('files', id); if (f) snap.files.push(f);
    snap.bookmarks.push(...(await DB.byIndex('bookmarks', 'bookId', id)));
    snap.keys.push(bookSyncKey(b)); if (b.setId) setIds.add(b.setId);
  }
  for (const b of snap.books) await DB.deleteBookData(b.id);
  const gone = new Set(snap.books.map((b) => b.id));
  const remaining = all.filter((b) => !gone.has(b.id));
  const deadSets = [];
  for (const sid of setIds) if (!remaining.some((b) => b.setId === sid)) { const set = await DB.get('sets', sid); if (set) { snap.sets.push(set); deadSets.push(sid); } }
  const dropKeys = new Set([...[...gone].map((id) => 'b:' + id), ...deadSets.map((id) => 's:' + id)]);
  const keyOfDel = new Map(snap.books.map((b) => ['b:' + b.id, 'k:' + bookSyncKey(b)])); const allKeyOf = new Map(all.map((b) => ['b:' + b.id, 'k:' + bookSyncKey(b)]));
  for (const o of await DB.all('orders')) {
    if (o.ids.some((x) => dropKeys.has(x))) {
      snap.orders.push(structuredClone(o));
      if (opts.tomb !== false) rememberSlots(o.key, o.ids.map((x) => allKeyOf.get(x) || keyOfDel.get(x) || x));   // so that importing the book again can put it back where it was
      o.ids = o.ids.filter((x) => !dropKeys.has(x)); await DB.put('orders', o);
    }
  }
  for (const sid of deadSets) { await rememberSet(snap.sets.find((x) => x.id === sid), snap.books); await DB.del('sets', sid); const so = await DB.get('orders', 'set:' + sid); if (so) { snap.orders.push(structuredClone(so)); await DB.del('orders', 'set:' + sid); } if (opts.tomb !== false) addTomb('set', sid); }
  if (opts.tomb !== false) for (const k of snap.keys) addTomb('book', k);
  if (opts.emit !== false) emitChange();
  return snap;
}
export const deleteBook = (id) => deleteBooks([id]);
/** Undo a deleteBooks(): puts everything back (and drops the tombstones so sync keeps the books). */
export async function restoreBooks(snap) {
  for (const set of snap.sets) if (!(await DB.get('sets', set.id))) await DB.put('sets', set);
  for (const f of snap.files) await DB.put('files', f);
  for (const b of snap.books) await DB.put('books', b);   // put() restamps updatedAt, so it outranks the tombstone
  for (const bm of snap.bookmarks) await DB.put('bookmarks', bm);
  for (const o of snap.orders) await DB.put('orders', o);
  const keys = new Set(snap.keys), sids = new Set(snap.sets.map((x) => x.id));
  localStorage.setItem('folio.tombs', JSON.stringify(getTombs().filter((t) => !((t.t === 'book' && keys.has(t.id)) || (t.t === 'set' && sids.has(t.id))))));
  emitChange();
}
/** "Delete all books": wipes every book, file, bookmark, order and set (shelves and settings stay). Not undoable. */
export async function deleteAllBooks() {
  const books = await getBooks(); const sets = await getSets();
  for (const b of books) addTomb('book', bookSyncKey(b));
  for (const k of Object.keys(getPending())) addTomb('book', k);   // books known only from Drive state on this device
  for (const x of sets) addTomb('set', x.id);
  for (const st of ['books', 'files', 'bookmarks', 'orders', 'sets', 'pagecache']) await DB.clear(st);
  setPending({}); setPendingBookmarks({});
  emitChange(); return books.length;
}
export async function setStatusMany(ids, status) {
  for (const id of ids) { const b = await getBook(id); if (!b) continue; b.status = status; if (status === 'finished') { b.finishedAt = Date.now(); } await DB.put('books', b); }
  emitChange();
}
export async function addToShelfMany(ids, shelfId) {
  for (const id of ids) { const b = await getBook(id); if (!b) continue; b.shelves = b.shelves || []; if (!b.shelves.includes(shelfId)) { b.shelves = [...b.shelves, shelfId]; await DB.put('books', b); } }
  emitChange();
}

/* ---------- page-count cache (reader footer): per book + layout settings, in IndexedDB ---------- */
export async function getPageCache(key) { return (await DB.get('pagecache', key))?.v; }
export async function putPageCache(bookId, key, v) { await DB.put('pagecache', { key, bookId, v }); }

export async function getFile(id) { return (await DB.get('files', id))?.blob; }

/* ---------- sets (series) ---------- */
export const getSets = () => DB.all('sets');
export async function ensureSet(name, auto = false) {
  const sets = await getSets();
  const n = name.trim().toLowerCase();
  const hit = sets.find((s) => s.name.toLowerCase() === n) || (auto ? sets.find((s) => s.orig === n) : null);   // v0.5.21: a series the user renamed ("Default Saga 1" → "Correct Saga 1") keeps catching that series' books
  if (hit) return hit;
  const s = { id: uid(), name: name.trim(), auto, createdAt: Date.now(), ...(auto ? { orig: n, updatedAt: 0, _noTouch: true } : {}) };   // v0.5.21: a set made from a file's series is not an edit: any other device's version of it wins
  await DB.put('sets', s); delete s._noTouch; await adoptSetMemory(s); return s;
}
/* A set that is deleted, pruned (auto sets without books) or removed by a sync keeps its manual order and sort mode in a small device-local memory, keyed by name,
   so making the set again (enrichment, regrouping, "New set…") brings the arrangement back instead of starting over. */
const MEM = 'folio.setmem', memKey = (n) => String(n || '').trim().toLowerCase();
const readMem = () => { try { return JSON.parse(localStorage.getItem(MEM) || '{}') || {}; } catch { return {}; } };
export async function rememberSet(set, extraBooks = []) {
  if (!set) return;
  const o = await DB.get('orders', 'set:' + set.id); const sort = (settings.get('sorts') || {})['set:' + set.id]; if (!(o && o.ids.length) && !sort) return;
  const books = [...(await getBooks()), ...extraBooks]; const keyOf = new Map(books.map((b) => ['b:' + b.id, 'k:' + bookSyncKey(b)]));
  const mem = readMem(); mem[memKey(set.name)] = { ids: ((o && o.ids) || []).map((x) => keyOf.get(x) || x).filter((x) => x.startsWith('k:')), sort: sort || null, at: Date.now() };
  const keep = Object.entries(mem).sort((a, b) => b[1].at - a[1].at).slice(0, 40); try { localStorage.setItem(MEM, JSON.stringify(Object.fromEntries(keep))); } catch { /* quota */ }
}
async function adoptSetMemory(set) {
  const mem = readMem(), k = memKey(set.name), m = mem[k]; if (!m) return;
  delete mem[k]; try { localStorage.setItem(MEM, JSON.stringify(mem)); } catch { /* quota */ }
  const byKey = new Map((await getBooks()).map((b) => ['k:' + bookSyncKey(b), 'b:' + b.id]));
  if (m.ids.length) { const cur = await DB.get('orders', 'set:' + set.id); if (!cur) await DB.put('orders', { key: 'set:' + set.id, ids: m.ids.map((x) => byKey.get(x) || x), updatedAt: 0, _noTouch: true }); }   // v0.5.21: a remembered arrangement is not a new edit (never beats one synced from another device)
  if (m.sort && m.sort.field) settings.set({ sorts: { ...(settings.get('sorts') || {}), ['set:' + set.id]: m.sort } });
}
export async function renameSet(id, name) { const s = await DB.get('sets', id); if (s.auto && !s.orig) s.orig = s.name.trim().toLowerCase(); s.name = name; s.auto = false; await DB.put('sets', s); emitChange(); }
export async function deleteSet(id) {
  await rememberSet(await DB.get('sets', id));
  for (const b of await getBooks()) if (b.setId === id) { b.setId = null; b.seriesIndex = null; await DB.put('books', b); }
  await DB.del('sets', id); await DB.del('orders', 'set:' + id); addTomb('set', id); clearSort('set:' + id); emitChange();
}
export async function createSet(name) { const s = await ensureSet(name, false); s.auto = false; await DB.put('sets', s); emitChange(); return s; }
export async function assignSet(bookId, setId, index) {
  const b = await getBook(bookId); b.setId = setId || null; b.seriesIndex = setId ? (index ?? b.seriesIndex ?? null) : null;
  await DB.put('books', b); emitChange();
}
/** Remove auto-created sets that no longer have books. */
export async function pruneSets() {
  const [sets, books] = await Promise.all([getSets(), getBooks()]);
  const waiting = new Set(Object.values(getPending()).map((st) => st.setId).filter(Boolean));   // v0.5.21: a set that books still to be downloaded belong to stays
  for (const s of sets) if (s.auto && !waiting.has(s.id) && !books.some((b) => b.setId === s.id)) { await rememberSet(s); await DB.del('sets', s.id); }
}

/* ---------- shelves ---------- */
export const getShelves = async () => orderShelves(await DB.all('shelves'));
/** v0.5.20: the reader's own shelf order (settings.shelfOrder, synced); shelves not in it yet (new, or from another device) follow by creation time. */
export function orderShelves(list) { const ord = settings.get('shelfOrder') || []; const ix = (s) => { const i = ord.indexOf(s.id); return i < 0 ? 1e9 : i; }; return [...list].sort((a, b) => ix(a) - ix(b) || (a.createdAt || 0) - (b.createdAt || 0)); }
export async function setShelfOrder(ids) { settings.set({ shelfOrder: [...ids] }); emitChange(); }
export async function moveShelf(id, delta) { const ids = (await getShelves()).map((s) => s.id); const i = ids.indexOf(id), j = i + delta; if (i < 0 || j < 0 || j >= ids.length) return ids; [ids[i], ids[j]] = [ids[j], ids[i]]; await setShelfOrder(ids); return ids; }
export async function createShelf(name) { const s = { id: uid(), name, createdAt: Date.now() }; await DB.put('shelves', s); emitChange(); return s; }
export async function renameShelf(id, name) { const s = await DB.get('shelves', id); s.name = name; await DB.put('shelves', s); emitChange(); }
export async function deleteShelf(id) {
  for (const b of await getBooks()) if (b.shelves?.includes(id)) { b.shelves = b.shelves.filter((x) => x !== id); await DB.put('books', b); }
  for (const b of await DB.all('audiobooks')) if (b.shelves?.includes(id)) { b.shelves = b.shelves.filter((x) => x !== id); await DB.put('audiobooks', b); }   // shelves are shared with audiobooks
  await DB.del('shelves', id); await DB.del('orders', 'shelf:' + id); addTomb('shelf', id); emitChange();
}
export async function setStatus(bookId, status) { const b = await getBook(bookId); b.status = status; if (status === 'finished') b.finishedAt = Date.now(); await DB.put('books', b); emitChange(); }
/* ---------- Reading now (v0.5.14) ---------- */
/** A book belongs in Reading now while it is being read (status Reading, or started and not finished) … */
export const isReadingNow = (b) => b.status === 'reading' || (b.status !== 'finished' && (b.progress || 0) > 0.005);
/** … unless she removed it by hand: hidden while the removal is newer than the last time it was opened, so reading it again brings it back by itself. */
export const isHiddenFromNow = (b) => (b.nowHiddenAt || 0) > (b.lastOpened || 0);
/** Hide (on) or show (off) books in Reading now; returns the previous values so the caller can offer Undo. */
export async function setNowHidden(ids, on) {
  const prev = {};
  for (const id of ids) { const b = await getBook(id); if (!b) continue; prev[id] = b.nowHiddenAt || 0; b.nowHiddenAt = on ? Math.max(Date.now(), (b.lastOpened || 0) + 1) : 0; await DB.put('books', b); }
  emitChange(); return prev;
}
export async function restoreNowHidden(prev) {
  for (const [id, v] of Object.entries(prev)) { const b = await getBook(id); if (!b) continue; b.nowHiddenAt = v; await DB.put('books', b); }
  emitChange();
}
export async function toggleShelf(bookId, shelfId) {
  const b = await getBook(bookId); b.shelves = b.shelves || [];
  b.shelves = b.shelves.includes(shelfId) ? b.shelves.filter((x) => x !== shelfId) : [...b.shelves, shelfId];
  await DB.put('books', b); emitChange();
}

/* ---------- manual order ---------- */
export async function getOrder(key) { return (await DB.get('orders', key))?.ids || []; }
export async function saveOrder(key, ids) { await DB.put('orders', { key, ids }); }
export async function clearOrder(key) { await DB.del('orders', key); }
/** items: [{key}], saved: ids. Items missing from saved append in their incoming order (caller pre-sorts by addedAt). */
export function applyOrder(items, saved) {
  const pos = new Map(saved.map((k, i) => [k, i]));
  const known = items.filter((i) => pos.has(i.key)).sort((a, b) => pos.get(a.key) - pos.get(b.key));
  const fresh = items.filter((i) => !pos.has(i.key));
  return [...known, ...fresh];
}

/* ---------- per-book style overrides ---------- */
export const OVERRIDE_KEYS = ['fontSizePt', 'font', 'lineHeight', 'margin', 'hideScrub'];   // hideScrub (v0.5.8): true / false for this book, absent = follow the global setting
export function effectiveStyle(book) {
  const g = settings.all(); const o = (book && book.overrides) || {};
  const out = {};
  for (const k of OVERRIDE_KEYS) out[k] = o[k] != null ? o[k] : g[k];
  out.fontSizePt = clampPt(out.fontSizePt);
  return out;
}
export const hasOverrides = (book) => !!(book && book.overrides && OVERRIDE_KEYS.some((k) => book.overrides[k] != null));
export async function setOverride(bookId, patch) {
  const b = await getBook(bookId); b.overrides = { ...(b.overrides || {}), ...patch };
  for (const k of Object.keys(b.overrides)) if (b.overrides[k] == null) delete b.overrides[k];
  if (!Object.keys(b.overrides).length) b.overrides = null;
  await DB.put('books', b); emitChange(); return b;
}
export async function resetOverrides(bookId) { const b = await getBook(bookId); b.overrides = null; await DB.put('books', b); emitChange(); return b; }

/* ---------- bookmarks ---------- */
export const getBookmarks = async (bookId) => (await DB.byIndex('bookmarks', 'bookId', bookId)).sort((a, b) => a.progress - b.progress);
export async function addBookmark(bm) { bm.id = uid(); bm.createdAt = Date.now(); await DB.put('bookmarks', bm); return bm; }
export const removeBookmark = async (id) => { await DB.del('bookmarks', id); addTomb('bookmark', id); };

/* ---------- sources ---------- */
export const SEED_SOURCES = [
  { id: 'seed-gutenberg', name: 'Project Gutenberg', kind: 'opds', url: 'https://www.gutenberg.org/ebooks.opds/', searchTemplate: 'https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}', note: 'Public-domain classics (OPDS)', builtin: true },
  { id: 'seed-gutendex', name: 'Gutenberg (Gutendex)', kind: 'gutendex', url: 'https://gutendex.com/books/', note: 'Gutenberg JSON API with cover URLs', builtin: true },
  { id: 'seed-se', name: 'Standard Ebooks', kind: 'opds', url: 'https://standardebooks.org/feeds/opds/all?query=fiction&per-page=24', searchTemplate: 'https://standardebooks.org/feeds/opds/all?query={searchTerms}&per-page=24&page=1', note: 'Beautifully formatted public-domain editions', builtin: true },
  { id: 'seed-ia', name: 'Internet Archive', kind: 'ia', url: 'https://archive.org/', note: 'Open, freely downloadable EPUBs only', builtin: true },
];
export async function getSources() {
  let s = await DB.all('sources');
  if (!s.length && !localStorage.getItem('folio.seeded')) {
    for (const [i, x] of SEED_SOURCES.entries()) await DB.put('sources', { ...x, order: i });
    localStorage.setItem('folio.seeded', '1'); s = await DB.all('sources');
  }
  return s.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}
export async function addSource(src) { src.id = src.id || uid(); src.order = Date.now(); await DB.put('sources', src); return src; }
export const removeSource = (id) => DB.del('sources', id);
export async function restoreSeeds() {
  const have = new Set((await DB.all('sources')).map((s) => s.id));
  for (const [i, x] of SEED_SOURCES.entries()) if (!have.has(x.id)) await DB.put('sources', { ...x, order: i });
}

/* ---------- sync support: state for books not (yet) on this device ---------- */
/** v0.5.20: the key a book's state is synced under must be unique: two different books that shared one (same ID, different titles; or same
 *  title + author without an ID) were silently merged into one entry, so other devices showed fewer books. hint = the key the other device used. */
const baseKey = (m) => (m.identifier ? 'id:' + m.identifier : 'ti:' + (m.title + '|' + m.author).toLowerCase());
function altKey(m, size) { return m.identifier ? 'id:' + m.identifier + '|' + String(m.title || '').toLowerCase() : baseKey(m) + '|s' + (size || 0); }
export function uniqueSyncKey(books, meta, size, hint) {
  const used = new Set(books.map(bookSyncKey));
  if (hint && !used.has(hint)) return hint;
  let k = baseKey(meta); if (!used.has(k)) return k;
  k = altKey(meta, size); if (!used.has(k)) return k;
  let n = 2; while (used.has(k + '#' + n)) n++; return k + '#' + n;
}
/** Older libraries may already hold colliding keys: the first-added book keeps the key, later ones get their own (once, saved). */
export async function fixKeyCollisions(books) {
  const by = new Map(); for (const b of books) { const k = bookSyncKey(b); (by.get(k) || by.set(k, []).get(k)).push(b); }
  for (const list of by.values()) {
    if (list.length < 2) continue; list.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || String(a.id).localeCompare(String(b.id)));
    for (const b of list.slice(1)) {
      const others = books.filter((x) => x !== b); b.syncKey = uniqueSyncKey(others, b, b.size, null);
      const rec = await DB.get('books', b.id); if (rec) await DB.put('books', { ...rec, syncKey: b.syncKey, _noTouch: true });
    }
  }
}
export const bookSyncKey = (b) => b.syncKey || (b.identifier ? 'id:' + b.identifier : 'ti:' + (b.title + '|' + b.author).toLowerCase());
export const getPending = () => { try { return JSON.parse(localStorage.getItem('folio.pending') || '{}'); } catch { return {}; } };
export const setPending = (p) => localStorage.setItem('folio.pending', JSON.stringify(p));
/** Apply the state another device synced for a book that wasn't here yet. Returns {series: true} when that state decided the book's set (so the file's series is not used).
 *  v0.5.21: exactly the other device's values and stamps, group by group (a set it cleared stays cleared), plus its per-field user edits. */
export function applyPending(book) {
  const p = getPending(); const st = p[bookSyncKey(book)]; if (!st) return {};
  Object.assign(book, { status: st.status || book.status, shelves: st.shelves || [], overrides: st.overrides || null, progress: st.progress || 0, cfi: st.cfi || null, lastOpened: st.lastOpened || 0 });
  if (st.posAt) Object.assign(book, { posAt: st.posAt, posDev: st.dev || '', posDevName: st.devName || '' }); if (st.ovAt) book.ovAt = st.ovAt; if (st.updatedAt) book.structAt = st.updatedAt;
  const gat = (g) => st.gAt?.[g] ?? (GROUPS[g].noLegacy ? 0 : st.updatedAt || 0); const dec = {};
  book.gAt = {};
  for (const g of Object.keys(GROUPS)) book.gAt[g] = gat(g);
  if (gat('series') > 0 || st.uo?.setId) { book.setId = st.setId || null; book.seriesIndex = st.seriesIndex ?? null; dec.series = true; }
  if (st.title) book.title = st.title; if (st.author) book.author = st.author;
  if (st.uo) { book.uo = structuredClone(st.uo); forceUo(book); if (book.uo.setId) dec.series = true; book.userSet = book.userSet || {}; for (const f of Object.keys(book.uo)) if (book.uo[f]) book.userSet[f === 'setId' || f === 'seriesIndex' ? 'series' : f] = true; }
  if (st.nowHiddenAt) book.nowHiddenAt = st.nowHiddenAt;
  if (st.pdfPage) Object.assign(book, { pdfPage: st.pdfPage, pdfZoom: st.pdfZoom || 1, pdfText: !!st.pdfText }); if (st.finishedAt) book.finishedAt = st.finishedAt;
  if (st.loan && (st.loan.at || 0) > (book.loanAt || 0)) Object.assign(book, { borrowed: !!st.loan.b, dueAt: st.loan.due || null, loanAt: st.loan.at, ...(st.loan.src ? { loanSource: st.loan.src } : {}) });   // Borrowed flag + due date kept for a book that wasn't here yet
  applyPendingMeta(book, 'book', bookSyncKey(book)); { const pm = getPendingMeta('book'); delete pm[bookSyncKey(book)]; setPendingMeta('book', pm); }
  const bms = (getPendingBookmarks()[bookSyncKey(book)] || []);
  bms.forEach((bm) => DB.put('bookmarks', { ...bm, bookId: book.id, _noTouch: true }));
  delete p[bookSyncKey(book)]; setPending(p);
  return dec;
}
const getPendingBookmarks = () => { try { return JSON.parse(localStorage.getItem('folio.pendingBm') || '{}'); } catch { return {}; } };
export const setPendingBookmarks = (p) => localStorage.setItem('folio.pendingBm', JSON.stringify(p));
export { getPendingBookmarks };
export const getTombs = () => { try { return JSON.parse(localStorage.getItem('folio.tombs') || '[]'); } catch { return []; } };
export const addTomb = (t, id) => { const x = getTombs(); x.push({ t, id, at: Date.now() }); localStorage.setItem('folio.tombs', JSON.stringify(x.slice(-5000))); };

/** Manual orders synced from another device may reference books that weren't here yet ('k:<syncKey>'). Bind them on import. */
const SLOTS = 'folio.slotmem';
function rememberSlots(key, ks) {
  let mem; try { mem = JSON.parse(localStorage.getItem(SLOTS) || '{}') || {}; } catch { mem = {}; }
  const prev = mem[key]; const merged = prev && Date.now() - prev.at < 30 * 864e5 ? [...ks, ...prev.ids.filter((x) => !ks.includes(x))] : ks;   // keep slots of books deleted earlier too
  mem[key] = { ids: merged.slice(0, 600), at: Date.now() };
  const keep = Object.entries(mem).sort((a, b) => b[1].at - a[1].at).slice(0, 60); try { localStorage.setItem(SLOTS, JSON.stringify(Object.fromEntries(keep))); } catch { /* quota */ }
}
/** A book that was deleted on this device and is imported again goes back to its old place in every manual order that listed it. */
async function restoreSlots(book) {
  let mem; try { mem = JSON.parse(localStorage.getItem(SLOTS) || '{}') || {}; } catch { return; } const me = 'k:' + bookSyncKey(book); let ch = false;
  const books = await getBooks(); const idOf = new Map(books.map((b) => ['k:' + bookSyncKey(b), 'b:' + b.id]));
  for (const [key, m] of Object.entries(mem)) {
    const i = m.ids.indexOf(me); if (i < 0) continue;
    const o = await DB.get('orders', key); if (o && !o.ids.includes('b:' + book.id) && !o.ids.includes(me)) {
      let at = 0; for (let j = i - 1; j >= 0; j--) { const id = idOf.get(m.ids[j]) || m.ids[j]; const p = o.ids.indexOf(id); if (p >= 0) { at = p + 1; break; } }
      o.ids = [...o.ids.slice(0, at), 'b:' + book.id, ...o.ids.slice(at)]; o._noTouch = true; await DB.put('orders', o);
    }
    m.ids = m.ids.filter((x) => x !== me); if (!m.ids.length) delete mem[key]; ch = true;
  }
  if (ch) try { localStorage.setItem(SLOTS, JSON.stringify(mem)); } catch { /* quota */ }
}
async function resolveOrderPlaceholders(book) {
  await restoreSlots(book);
  const ph = 'k:' + bookSyncKey(book);
  for (const o of await DB.all('orders')) {
    if (o.ids.includes(ph)) { o.ids = o.ids.map((x) => (x === ph ? 'b:' + book.id : x)); o._noTouch = true; await DB.put('orders', o); }
  }
}

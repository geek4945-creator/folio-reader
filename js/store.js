// Library data layer: books, sets (series), shelves, manual orders, per-book style overrides.
import { DB, uid } from './db.js';
import { parseEpub, shrinkCover } from './epubmeta.js';
import { settings, clampPt } from './settings.js';
import { fetchSmart, openLibraryCover } from './net.js';
import { isPdf, parsePdf } from './pdf.js';
import { detectKindle, kindleToEpub, looksLikeKfxZip, kfxError } from './kindle.js';

export const STATUSES = [
  { id: 'reading', name: 'Currently Reading' },
  { id: 'want', name: 'Want to Read' },
  { id: 'finished', name: 'Finished' },
];
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

  let cover = meta.coverBlob;
  if (!cover && hints.coverUrl) {
    try { const r = await fetchSmart(hints.coverUrl, { timeout: 15000 }); const b = await r.blob(); if (/^image\//.test(b.type)) cover = b; } catch { /* hotlink blocked */ }
  }
  if (!cover) {
    const u = await openLibraryCover(meta.title, meta.author);
    if (u) { try { const r = await fetch(u); if (r.ok) { const b = await r.blob(); if (/^image\//.test(b.type) && b.size > 1200) cover = b; } } catch { /* offline */ } }
  }
  if (cover) cover = await shrinkCover(cover);

  const series = meta.series || hints.series || '';
  const seriesIndex = meta.series ? meta.seriesIndex : (hints.series ? hints.seriesIndex : null);
  let setId = null;
  if (series) setId = (await ensureSet(series, true)).id;

  const book = {
    id: uid(), title: meta.title || hints.title || 'Untitled', author: meta.author !== 'Unknown author' ? meta.author : (hints.author || meta.author),
    language: meta.language, description: meta.description || hints.summary || '', identifier: meta.identifier,
    addedAt: Date.now(), lastOpened: 0, progress: 0, cfi: null, status: 'want', shelves: [],
    setId, seriesIndex: seriesIndex ?? null, coverBlob: cover || null, size: buffer.byteLength, format: pdfMeta ? 'pdf' : 'epub', pages: pdfMeta ? pdfMeta.pages : null,
    syncKey: meta.identifier ? 'id:' + meta.identifier : 'ti:' + (meta.title + '|' + meta.author).toLowerCase(),
    sourceKey: hints.sourceKey || null, source: hints.source || 'import', origFormat, overrides: null, locations: null,
  };
  applyPending(book);
  await DB.put('files', { id: book.id, blob: new Blob([buffer], { type: pdfMeta ? 'application/pdf' : 'application/epub+zip' }) });
  // A fresh import is not a user edit (keeps cross-device merge fair), unless the book was deleted before: then it must outrank the deletion tombstone.
  const tombed = getTombs().some((t) => t.t === 'book' && t.id === book.syncKey);
  if (tombed) { localStorage.setItem('folio.tombs', JSON.stringify(getTombs().filter((t) => !(t.t === 'book' && t.id === book.syncKey)))); book.updatedAt = Date.now(); book._noTouch = true; }
  else { book._noTouch = true; book.updatedAt = 0; }
  await DB.put('books', book);
  await resolveOrderPlaceholders(book);
  emitChange();
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
  for (const o of await DB.all('orders')) {
    if (o.ids.some((x) => dropKeys.has(x))) { snap.orders.push(structuredClone(o)); o.ids = o.ids.filter((x) => !dropKeys.has(x)); await DB.put('orders', o); }
  }
  for (const sid of deadSets) { await DB.del('sets', sid); const so = await DB.get('orders', 'set:' + sid); if (so) { snap.orders.push(structuredClone(so)); await DB.del('orders', 'set:' + sid); } if (opts.tomb !== false) addTomb('set', sid); }
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
  const hit = sets.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (hit) return hit;
  const s = { id: uid(), name: name.trim(), auto, createdAt: Date.now() };
  await DB.put('sets', s); return s;
}
export async function renameSet(id, name) { const s = await DB.get('sets', id); s.name = name; s.auto = false; await DB.put('sets', s); emitChange(); }
export async function deleteSet(id) {
  for (const b of await getBooks()) if (b.setId === id) { b.setId = null; b.seriesIndex = null; await DB.put('books', b); }
  await DB.del('sets', id); await DB.del('orders', 'set:' + id); addTomb('set', id); emitChange();
}
export async function createSet(name) { const s = await ensureSet(name, false); s.auto = false; await DB.put('sets', s); emitChange(); return s; }
export async function assignSet(bookId, setId, index) {
  const b = await getBook(bookId); b.setId = setId || null; b.seriesIndex = setId ? (index ?? b.seriesIndex ?? null) : null;
  await DB.put('books', b); emitChange();
}
/** Remove auto-created sets that no longer have books. */
export async function pruneSets() {
  const [sets, books] = await Promise.all([getSets(), getBooks()]);
  for (const s of sets) if (s.auto && !books.some((b) => b.setId === s.id)) await DB.del('sets', s.id);
}

/* ---------- shelves ---------- */
export const getShelves = async () => (await DB.all('shelves')).sort((a, b) => a.createdAt - b.createdAt);
export async function createShelf(name) { const s = { id: uid(), name, createdAt: Date.now() }; await DB.put('shelves', s); emitChange(); return s; }
export async function renameShelf(id, name) { const s = await DB.get('shelves', id); s.name = name; await DB.put('shelves', s); emitChange(); }
export async function deleteShelf(id) {
  for (const b of await getBooks()) if (b.shelves?.includes(id)) { b.shelves = b.shelves.filter((x) => x !== id); await DB.put('books', b); }
  for (const b of await DB.all('audiobooks')) if (b.shelves?.includes(id)) { b.shelves = b.shelves.filter((x) => x !== id); await DB.put('audiobooks', b); }   // shelves are shared with audiobooks
  await DB.del('shelves', id); await DB.del('orders', 'shelf:' + id); addTomb('shelf', id); emitChange();
}
export async function setStatus(bookId, status) { const b = await getBook(bookId); b.status = status; if (status === 'finished') b.finishedAt = Date.now(); await DB.put('books', b); emitChange(); }
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
export const OVERRIDE_KEYS = ['fontSizePt', 'font', 'lineHeight', 'margin'];
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
export const bookSyncKey = (b) => b.syncKey || (b.identifier ? 'id:' + b.identifier : 'ti:' + (b.title + '|' + b.author).toLowerCase());
export const getPending = () => { try { return JSON.parse(localStorage.getItem('folio.pending') || '{}'); } catch { return {}; } };
export const setPending = (p) => localStorage.setItem('folio.pending', JSON.stringify(p));
export function applyPending(book) {
  const p = getPending(); const st = p[bookSyncKey(book)]; if (!st) return;
  Object.assign(book, { status: st.status || book.status, shelves: st.shelves || [], setId: st.setId || book.setId, seriesIndex: st.seriesIndex ?? book.seriesIndex, overrides: st.overrides || null, progress: st.progress || 0, cfi: st.cfi || null, lastOpened: st.lastOpened || 0 });
  if (st.title) book.title = st.title; if (st.author) book.author = st.author;
  const bms = (getPendingBookmarks()[bookSyncKey(book)] || []);
  bms.forEach((bm) => DB.put('bookmarks', { ...bm, bookId: book.id, _noTouch: true }));
  delete p[bookSyncKey(book)]; setPending(p);
}
const getPendingBookmarks = () => { try { return JSON.parse(localStorage.getItem('folio.pendingBm') || '{}'); } catch { return {}; } };
export const setPendingBookmarks = (p) => localStorage.setItem('folio.pendingBm', JSON.stringify(p));
export { getPendingBookmarks };
export const getTombs = () => { try { return JSON.parse(localStorage.getItem('folio.tombs') || '[]'); } catch { return []; } };
export const addTomb = (t, id) => { const x = getTombs(); x.push({ t, id, at: Date.now() }); localStorage.setItem('folio.tombs', JSON.stringify(x.slice(-5000))); };

/** Manual orders synced from another device may reference books that weren't here yet ('k:<syncKey>'). Bind them on import. */
async function resolveOrderPlaceholders(book) {
  const ph = 'k:' + bookSyncKey(book);
  for (const o of await DB.all('orders')) {
    if (o.ids.includes(ph)) { o.ids = o.ids.map((x) => (x === ph ? 'b:' + book.id : x)); o._noTouch = true; await DB.put('orders', o); }
  }
}

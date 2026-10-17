// Tiny promise wrapper around IndexedDB.
// Stores: books (metadata + cover blob), files (epub blobs), bookmarks, sets (series),
// shelves (custom), orders (manual order per context), sources (catalog sources).
const NAME = 'folio-reader';
const VERSION = 6;   // v2: pagecache (page-count caches for the reader footer); v3: audiobooks + audiofiles; v4: links (audiobook ↔ ebook, synced); v5: undo (pre-import snapshot, device-only); v6: glossary (per-book glossary entries + saved words, synced) + dict (offline dictionary cache, device-only)
let dbp;
const TRACKED = new Set(['books', 'bookmarks', 'sets', 'shelves', 'orders', 'links', 'glossary']);
import { deviceId, deviceName } from './device.js';

/* Fine-grained change stamps for cross-device sync. A book / audiobook has three independent kinds of change:
 *   structAt – shelves, status, series, titles   (library file)      posAt – where you are in it + when last opened (positions file)
 *   ovAt     – per-key stamps of the per-book reading overrides (font size, margins…)
 * They are set here, by comparing the record with what is stored, so any code path that saves a book gets them right. Records saved with _noTouch
 * (sync apply, imports) keep the stamps they carry. Legacy records (no stamps) fall back to updatedAt / lastOpened. */
const STAMPED = new Set(['books', 'audiobooks']);
const J = JSON.stringify;
/** Structure is stamped in independent groups so e.g. an automatic "Reading" status on one device can't undo a shelf change made on another. */
export const GROUPS = {
  status: { fields: ['status', 'finishedAt'], sig: (b) => J([b.status, b.finishedAt || 0]) },
  shelves: { fields: ['shelves'], sig: (b) => J([...(b.shelves || [])].sort()) },
  series: { fields: ['setId', 'seriesIndex'], sig: (b) => J([b.setId || null, b.seriesIndex ?? null]) },
  name: { fields: ['title', 'author'], sig: (b) => J([b.title, b.author || '']) },
  now: { fields: ['nowHiddenAt'], sig: (b) => J([b.nowHiddenAt || 0]), noLegacy: true },   // v0.5.14: "Remove from Reading now" (hidden while nowHiddenAt > lastOpened); older files carry no stamp for it, so they never overwrite it
};
const posSig = (b) => J([b.cfi || null, Math.round((b.progress || 0) * 1e4), b.pdfPage || 0, b.pdfText ? 1 : 0, b.pdfZoom || 0, Math.round(b.position || 0), b.trackIndex ?? null]);
export const structAtOf = (b) => b.structAt ?? b.updatedAt ?? 0;
export const gAtOf = (b, g) => b.gAt?.[g] ?? (GROUPS[g] && GROUPS[g].noLegacy ? 0 : structAtOf(b));
export const posAtOf = (b) => b.posAt ?? Math.max(b.lastOpened || 0, b.updatedAt || 0);   // legacy records: their last touch
export const posAtOfState = (st) => st.posAt ?? Math.max(st.lastOpened || 0, st.updatedAt || 0);
function stamp(val, old) {
  const now = Date.now();
  if (!old) { val.structAt = 0; val.gAt = {}; val.posAt = (val.progress || val.position) ? now : 0; val.posDev = deviceId(); val.posDevName = deviceName(); return; }
  const g = {}; let top = 0;
  for (const [n, d] of Object.entries(GROUPS)) { g[n] = d.sig(old) === d.sig(val) ? gAtOf(old, n) : now; top = Math.max(top, g[n]); }
  val.gAt = g; val.structAt = top === now ? now : structAtOf(old);
  if (posSig(old) === posSig(val)) { val.posAt = posAtOf(old); if (old.posDev) { val.posDev = old.posDev; val.posDevName = old.posDevName; } }
  else { val.posAt = now; val.posDev = deviceId(); val.posDevName = deviceName(); try { window.dispatchEvent(new Event('folio-position')); } catch { /* not in a window */ } }
  if (val.overrides || old.overrides) {   // per-key stamps for the per-book reading overrides (font size, margins, theme…): independent last-writer-wins
    const a = old.overrides || {}, b = val.overrides || {}, at = { ...(old.ovAt || {}) };
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (J(a[k]) !== J(b[k])) at[k] = now;
    val.ovAt = at;
  }
}

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result; const mk = (n, opts, f) => { if (!db.objectStoreNames.contains(n)) { const o = db.createObjectStore(n, opts); f && f(o); } };
      mk('books', { keyPath: 'id' }); mk('files', { keyPath: 'id' });
      mk('bookmarks', { keyPath: 'id' }, (o) => o.createIndex('bookId', 'bookId'));
      mk('sets', { keyPath: 'id' }); mk('shelves', { keyPath: 'id' }); mk('orders', { keyPath: 'key' }); mk('sources', { keyPath: 'id' });
      mk('audiobooks', { keyPath: 'id' }); mk('audiofiles', { keyPath: 'id' });   // audiobooks: metadata + cover; audiofiles: one blob per track ('<bookId>:<n>'), device-only (never synced)
      mk('links', { keyPath: 'id' });   // audiobook ↔ ebook links + remembered rejections (synced; see links.js)
      mk('undo', { keyPath: 'id' });   // one record: the library state before the last backup import (Undo)
      mk('glossary', { keyPath: 'id' }, (o) => o.createIndex('bookKey', 'bookKey'));   // v0.5.6: glossary terms, saved words and per-book share flags (synced; see glossary.js)
      mk('dict', { keyPath: 'word' });   // v0.5.6: offline cache of dictionary lookups (device-only)
      mk('pagecache', { keyPath: 'key' });   // not synced: {key: '<bookId>|chars' | '<bookId>|k' | '<bookId>|cal|<layout>', bookId, v}
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } dbp = null; }; resolve(db); };   // let a newer version of the app (another tab / window) upgrade the database instead of blocking it
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { try { window.dispatchEvent(new Event('db-blocked')); } catch { /* ignore */ } };   // an older tab still has the database open
  });
  return dbp;
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () =>
  (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const DB = {
  async get(s, key) { return wrap((await store(s)).get(key)); },
  async all(s) { return wrap((await store(s)).getAll()); },
  // Records in synced stores get an updatedAt stamp (used for last-writer-wins sync) unless _noTouch is set.
  async put(s, val) {
    if (val && STAMPED.has(s) && !val._noTouch) stamp(val, await wrap((await store(s)).get(val.id)));
    if (val && TRACKED.has(s)) { if (val._noTouch) delete val._noTouch; else val.updatedAt = Date.now(); }
    else if (val && val._noTouch) delete val._noTouch;
    return wrap((await store(s, 'readwrite')).put(val));
  },
  async del(s, key) { return wrap((await store(s, 'readwrite')).delete(key)); },
  async byIndex(s, index, key) { return wrap((await store(s)).index(index).getAll(key)); },
  async clear(s) { return wrap((await store(s, 'readwrite')).clear()); },
  async deleteBookData(id) {
    const db = await open();
    const bms = await this.byIndex('bookmarks', 'bookId', id);
    const pc = (await this.all('pagecache')).filter((x) => x.bookId === id);
    const tx = db.transaction(['books', 'files', 'bookmarks', 'pagecache'], 'readwrite');
    for (const x of pc) tx.objectStore('pagecache').delete(x.key);
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
    for (const b of bms) tx.objectStore('bookmarks').delete(b.id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
};

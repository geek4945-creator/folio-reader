// Tiny promise wrapper around IndexedDB.
// Stores: books (metadata + cover blob), files (epub blobs), bookmarks, sets (series),
// shelves (custom), orders (manual order per context), sources (catalog sources).
const NAME = 'folio-reader';
const VERSION = 4;   // v2: pagecache (page-count caches for the reader footer); v3: audiobooks + audiofiles; v4: links (audiobook ↔ ebook, synced)
let dbp;
const TRACKED = new Set(['books', 'bookmarks', 'sets', 'shelves', 'orders', 'links']);

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
      mk('pagecache', { keyPath: 'key' });   // not synced: {key: '<bookId>|chars' | '<bookId>|k' | '<bookId>|cal|<layout>', bookId, v}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
    if (val && TRACKED.has(s)) { if (val._noTouch) delete val._noTouch; else val.updatedAt = Date.now(); }
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

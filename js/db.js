// Tiny promise wrapper around IndexedDB.
// Stores: books (metadata + cover blob), files (epub blobs), bookmarks, sets (series),
// shelves (custom), orders (manual order per context), sources (catalog sources).
const NAME = 'folio-reader';
const VERSION = 1;
let dbp;
const TRACKED = new Set(['books', 'bookmarks', 'sets', 'shelves', 'orders']);

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
      const bm = db.createObjectStore('bookmarks', { keyPath: 'id' });
      bm.createIndex('bookId', 'bookId');
      db.createObjectStore('sets', { keyPath: 'id' });
      db.createObjectStore('shelves', { keyPath: 'id' });
      db.createObjectStore('orders', { keyPath: 'key' });
      db.createObjectStore('sources', { keyPath: 'id' });
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
    const tx = db.transaction(['books', 'files', 'bookmarks'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
    for (const b of bms) tx.objectStore('bookmarks').delete(b.id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  },
};

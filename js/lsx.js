// v0.5.22: localStorage overflow guard. iOS Safari gives localStorage ~5 MB; with 400+ synced books the big sync records (pending book info,
// tombstones, cover queue, sync state…) overflowed it → "QuotaExceededError" aborted sync. Big keys now live in IndexedDB (db 'folio-kv') behind an
// in-memory cache that is loaded BEFORE the app starts, so every existing synchronous localStorage.getItem/setItem keeps working unchanged.
// Any other key whose write hits the quota spills to the same store instead of throwing. Old localStorage copies are migrated once and removed.
const BIG = new Set(['folio.pending', 'folio.pendingBm', 'folio.pendingAudio', 'folio.tombs', 'folio.coverQ', 'folio.coverSess', 'folio.sync.state', 'folio.driveImported', 'folio.sync.devices', 'folio.sync.counts', 'folio.metaSlots', 'folio.sync.conflict', 'folio.setmem', 'folio.slotmem']);
const isBig = (k) => BIG.has(k) || /^folio\.(pending|meta)/.test(k);
const cache = new Map(); let db = null; const dirty = new Map(); let flushT = null;
export const isQuota = (e) => !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(e.message || ''));
function openKV() {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (!done) { done = true; res(v); } }; setTimeout(() => fin(null), 3000);
    try { const r = indexedDB.open('folio-kv', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => fin(r.result); r.onerror = () => fin(null); } catch { fin(null); }
  });
}
function flush() {
  flushT = null; if (!db || !dirty.size) return; const batch = [...dirty]; dirty.clear();
  try { const tx = db.transaction('kv', 'readwrite'); const st = tx.objectStore('kv'); for (const [k, v] of batch) { if (v == null) st.delete(k); else st.put(v, k); } } catch { /* full: kept in memory for this session */ }
}
const queue = (k, v) => { dirty.set(k, v); if (!flushT) flushT = setTimeout(flush, 0); };
const P = Storage.prototype; const oGet = P.getItem, oSet = P.setItem, oRem = P.removeItem;
const isLS = (s) => { try { return s === window.localStorage; } catch { return false; } };
export const ready = (async () => {
  db = await openKV();
  if (db) await new Promise((res) => { try { const tx = db.transaction('kv'); const st = tx.objectStore('kv'); const rk = st.getAllKeys(), rv = st.getAll(); tx.oncomplete = () => { rk.result.forEach((k, i) => cache.set(k, rv.result[i])); res(); }; tx.onerror = () => res(); } catch { res(); } });
  // one-time migration: big keys move out of localStorage
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && isBig(k)) { const v = oGet.call(localStorage, k); if (!cache.has(k) && v != null) { cache.set(k, v); queue(k, v); } oRem.call(localStorage, k); } } } catch { /* ignore */ }
  P.getItem = function (k) { if (isLS(this) && cache.has(String(k))) return cache.get(String(k)); return oGet.call(this, k); };
  P.setItem = function (k, v) {
    k = String(k); v = String(v); if (!isLS(this)) return oSet.call(this, k, v);
    if (db && isBig(k)) { cache.set(k, v); queue(k, v); return; }
    try { oSet.call(this, k, v); if (cache.has(k)) { cache.delete(k); queue(k, null); } }
    catch (e) { if (!isQuota(e)) throw e; cache.set(k, v); queue(k, v); try { oRem.call(this, k); } catch { /* ignore */ } }
  };
  P.removeItem = function (k) { k = String(k); if (isLS(this) && cache.has(k)) { cache.delete(k); queue(k, null); } return oRem.call(this, k); };
  try { if (!oGet.call(localStorage, 'folio.persistAsked')) { navigator.storage?.persist?.(); try { oSet.call(localStorage, 'folio.persistAsked', '1'); } catch { /* ignore */ } } } catch { /* ignore */ }
  addEventListener('pagehide', flush);
})();

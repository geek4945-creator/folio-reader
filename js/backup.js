// Library backup (v0.5.4): one .zip file with everything that makes the library yours — settings, per-book styles, reading positions, shelves, sets, custom order,
// metadata + covers, links, loans, sources — and (optionally) the book files. Written / read as a stream so a big library never has to fit in memory.
// Same schema in Folio Reader and Flimsy Read (the app is recorded in the manifest; either can import the other's). Google tokens / secrets are never exported.
import { DB } from './db.js';
import { settings, SYNCED } from './settings.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import { zipStream, openZip } from './zip.js';
import { buildSnapshot, mergeSnapshots, applySnapshot } from './google.js';
import { getPendingMeta, setPendingMeta } from './metasync.js';
import { isCapacitor } from './env.js';

export const APP_ID = 'folio', APP_NAME = 'Folio Reader', APP_VERSION = '0.5.4';
export const FORMAT = 'folio-library-backup', FORMAT_VERSION = 1;
const SECRET_RE = /token|secret|passw|apikey|api_key|authorization|bearer|credential|cookie/i;
const NOT_EXPORTED = new Set(['proxyUrl']);   // deployment config of this device, not part of the library
const LS = { settings: 'folio.settings', settingsAt: 'folio.settings.at', tombs: 'folio.tombs', pending: 'folio.pending', pendingBm: 'folio.pendingBm', pendingAudio: 'folio.pendingAudio' };
const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ta = (b) => norm(b.title) + '|' + norm(b.author);
export const todayStamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const backupFileName = () => `${APP_ID}-backup-${todayStamp()}.zip`;
const extOf = (b) => (b.format === 'pdf' ? 'pdf' : 'epub');

/** Drop anything that looks like a credential, deeply. URLs lose user:pass@. */
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object' && !(v instanceof Blob)) { const o = {}; for (const [k, x] of Object.entries(v)) { if (SECRET_RE.test(k)) continue; o[k] = scrub(x); } return o; }
  if (typeof v === 'string' && /^https?:\/\/[^/@\s]+@/i.test(v)) return v.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1');
  return v;
}
const jsonOf = (rec, drop = []) => { const o = { ...rec }; for (const k of ['coverBlob', 'locations', ...drop]) delete o[k]; return scrub(o); };

/* ---------------------------------------------------------------- export */
/** What an export would contain, and a size estimate. */
export async function backupPlan({ includeFiles = false } = {}) {
  const [books, audio] = await Promise.all([S.getBooks(), A.getAudiobooks()]);
  const fileBytes = books.reduce((a, b) => a + (b.size || 0), 0); const coverBytes = [...books, ...audio].reduce((a, b) => a + (b.coverBlob ? b.coverBlob.size : 0), 0);
  return { books: books.length, audiobooks: audio.length, fileBytes, coverBytes, metaBytes: 200 * 1024 + (books.length + audio.length) * 3000, estimate: (includeFiles ? fileBytes : 0) + coverBytes + 200 * 1024 + (books.length + audio.length) * 3000 };
}
async function buildManifest(includeFiles) {
  const [books, audio, snapshot, sources, sets, shelves] = await Promise.all([S.getBooks(), A.getAudiobooks(), buildSnapshot(), DB.all('sources'), S.getSets(), DB.all('shelves')]);
  const st = settings.all(); for (const k of NOT_EXPORTED) delete st[k];
  const bookRecs = books.map((b) => ({ ...jsonOf(b), coverFile: b.coverBlob ? 'covers/book-' + b.id : null, file: includeFiles ? `files/${b.id}.${extOf(b)}` : null }));
  const audioRecs = audio.map((b) => ({ ...jsonOf(b), coverFile: b.coverBlob ? 'covers/audio-' + b.id : null }));
  const man = {
    format: FORMAT, version: FORMAT_VERSION, app: APP_ID, appName: APP_NAME, appVersion: APP_VERSION, createdAt: Date.now(), includesFiles: !!includeFiles,
    counts: { books: books.length, audiobooks: audio.length, shelves: shelves.length, sets: sets.length, sources: sources.length, files: includeFiles ? books.filter((b) => b.size).length : 0 },
    settings: { all: scrub(st), updatedAt: settings.updatedAt(), synced: SYNCED },
    snapshot: scrub(snapshot), books: bookRecs, audiobooks: audioRecs, sources: sources.map((x) => scrub(x)),
    pending: { audio: readLS(LS.pendingAudio, {}) },
  };
  return { man, books, audio };
}
const readLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };

async function* entriesOf(man, books, audio, includeFiles, onProgress) {
  yield { name: 'backup.json', data: JSON.stringify(man) };
  const total = books.length + audio.length + (includeFiles ? books.length : 0); let n = 0; const tick = (label) => onProgress && onProgress({ done: ++n, total, label });
  for (const b of books) if (b.coverBlob) yield { name: 'covers/book-' + b.id, data: b.coverBlob };
  for (const b of audio) if (b.coverBlob) yield { name: 'covers/audio-' + b.id, data: b.coverBlob };
  if (includeFiles) for (const b of books) { const f = await DB.get('files', b.id); tick(b.title); if (f && f.blob) yield { name: `files/${b.id}.${extOf(b)}`, data: f.blob }; }
}
export async function exportBackupStream({ includeFiles = false, onProgress } = {}) {
  const { man, books, audio } = await buildManifest(includeFiles);
  if (includeFiles) { const have = new Set(); for (const b of books) { if (await DB.get('files', b.id)) have.add(b.id); } for (const r of man.books) if (r.file && !have.has(r.id)) r.file = null; man.counts.files = man.books.filter((r) => r.file).length; }
  return { manifest: man, stream: zipStream(entriesOf(man, books, audio, includeFiles, onProgress)) };
}

/* sinks ------------------------------------------------------------------ */
const cap = () => window.Capacitor && window.Capacitor.Plugins;
export const nativeShare = () => isCapacitor() && !!(cap() && cap().Filesystem && cap().Share);
export const canPickSaveFile = () => typeof window.showSaveFilePicker === 'function' && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
async function* batched(stream, size = 1 << 20) { let parts = [], n = 0; for await (const c of stream) { parts.push(c); n += c.length; if (n >= size) { yield concat(parts, n); parts = []; n = 0; } } if (n) yield concat(parts, n); }
const concat = (parts, n) => { if (parts.length === 1) return parts[0]; const o = new Uint8Array(n); let p = 0; for (const x of parts) { o.set(x, p); p += x.length; } return o; };

/** Write the stream somewhere the user can get it. Returns { kind: 'picker' | 'native' | 'blob', blob?, name }. `handle` = an already-chosen FileSystemFileHandle. */
export async function writeBackup(stream, name, { handle = null } = {}) {
  if (handle) { const w = await handle.createWritable(); try { for await (const c of batched(stream)) await w.write(c); await w.close(); } catch (e) { try { await w.abort(); } catch { /* ignore */ } throw e; } return { kind: 'picker', name: handle.name || name }; }
  if (nativeShare()) {
    const { Filesystem, Share } = cap(); const path = 'backups/' + name; try { await Filesystem.deleteFile({ path, directory: 'CACHE' }); } catch { /* none */ }
    let first = true; for await (const c of batched(stream, 1 << 19)) { const data = b64(c); if (first) { await Filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true }); first = false; } else await Filesystem.appendFile({ path, data, directory: 'CACHE' }); }
    const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
    return { kind: 'native', name, uri, share: () => Share.share({ title: name, dialogTitle: 'Save your ' + APP_NAME + ' backup', files: [uri] }) };
  }
  const parts = []; for await (const c of stream) parts.push(c);   // the browser keeps large Blobs on disk where it can
  return { kind: 'blob', name, blob: new Blob(parts, { type: 'application/zip' }) };
}
/** Hand a finished Blob to the user: share sheet on phones (iOS / Android browsers), a download elsewhere. Needs a fresh tap on iOS. */
export async function deliverBlob(blob, name) {
  const file = new File([blob], name, { type: 'application/zip' });
  if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; } }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); return 'downloaded';
}

/* ---------------------------------------------------------------- import: read + validate */
export class BackupError extends Error {}
export async function readBackup(file) {
  if (!file) throw new BackupError('No file chosen.');
  let zip; try { zip = await openZip(file); } catch (e) { throw new BackupError('That isn’t a ' + APP_NAME + ' backup — it isn’t a valid .zip file.'); }
  if (!zip.has('backup.json')) throw new BackupError('That .zip has no backup.json, so it isn’t a Folio Reader / Flimsy Read backup.');
  if (zip.size('backup.json') > 200 * 1024 * 1024) throw new BackupError('The backup index is unreasonably large; the file is probably damaged.');
  let man; try { man = JSON.parse(await zip.text('backup.json')); } catch { throw new BackupError('The backup index (backup.json) is damaged and can’t be read.'); }
  if (!man || man.format !== FORMAT) throw new BackupError('That file isn’t a Folio Reader / Flimsy Read library backup.');
  if (!['folio', 'flimsy'].includes(man.app)) throw new BackupError('This backup comes from an unknown app (“' + man.app + '”).');
  if (typeof man.version !== 'number' || man.version > FORMAT_VERSION) throw new BackupError('This backup was made by a newer version of the app (format ' + man.version + '). Update the app, then try again.');
  if (!man.snapshot || !Array.isArray(man.books)) throw new BackupError('The backup is incomplete (library data missing).');
  const files = man.books.filter((b) => b.file && zip.has(b.file)).length;
  return { zip, manifest: man, size: file.size, summary: { app: man.appName || man.app, fromOtherApp: man.app !== APP_ID, createdAt: man.createdAt, books: man.books.length, audiobooks: (man.audiobooks || []).length, shelves: (man.snapshot.shelves || []).length, sets: (man.snapshot.sets || []).length, sources: (man.sources || []).length, bookmarks: Object.values(man.snapshot.bookmarks || {}).reduce((a, l) => a + l.length, 0), links: (man.snapshot.links || []).length, files, settings: Object.keys((man.settings || {}).all || {}).length } };
}

/* ---------------------------------------------------------------- undo snapshot */
const UNDO_STORES = ['books', 'audiobooks', 'sets', 'shelves', 'orders', 'bookmarks', 'links', 'sources'];
export async function makeUndo(label) {
  const rec = { id: 'last', at: Date.now(), label: label || '', stores: {}, ls: {} };
  for (const s of UNDO_STORES) rec.stores[s] = await DB.all(s);
  for (const [k, key] of Object.entries(LS)) rec.ls[k] = localStorage.getItem(key);
  rec.ls.pendingBookMeta = JSON.stringify(getPendingMeta('book')); rec.ls.pendingAudioMeta = JSON.stringify(getPendingMeta('audio'));
  await DB.put('undo', rec); return rec;
}
export async function undoInfo() { const r = await DB.get('undo', 'last'); return r ? { at: r.at, label: r.label, books: r.stores.books.length } : null; }
export async function undoImport() {
  const rec = await DB.get('undo', 'last'); if (!rec) throw new BackupError('Nothing to undo.');
  for (const s of UNDO_STORES) {
    const keep = new Set(rec.stores[s].map((x) => x.id ?? x.key)); const now = await DB.all(s);
    for (const x of now) if (!keep.has(x.id ?? x.key)) { await DB.del(s, x.id ?? x.key); if (s === 'books') await DB.del('files', x.id); }   // added by the import
    for (const x of rec.stores[s]) await DB.put(s, { ...x, _noTouch: true });
  }
  for (const [k, key] of Object.entries(LS)) { if (rec.ls[k] == null) localStorage.removeItem(key); else localStorage.setItem(key, rec.ls[k]); }
  setPendingMeta('book', JSON.parse(rec.ls.pendingBookMeta || '{}')); setPendingMeta('audio', JSON.parse(rec.ls.pendingAudioMeta || '{}'));
  try { const saved = JSON.parse(rec.ls.settings || '{}'); settings.set(saved, { remote: true }); } catch { /* ignore */ }
  await DB.del('undo', 'last'); await refreshUI();
}
/** Forget the undo snapshot and delete the files / audio of books that only it still referenced. */
export async function discardUndo() {
  await DB.del('undo', 'last');
  const have = new Set((await S.getBooks()).map((b) => b.id)); for (const f of await DB.all('files')) if (!have.has(f.id)) await DB.del('files', f.id);
  const hasA = new Set((await A.getAudiobooks()).map((b) => b.id)); for (const f of await DB.all('audiofiles')) if (!hasA.has(String(f.id).split(':')[0])) await DB.del('audiofiles', f.id);
}
export async function expireUndo(maxAgeMs = 14 * 864e5) { try { const r = await DB.get('undo', 'last'); if (r && Date.now() - r.at > maxAgeMs) await discardUndo(); } catch { /* ignore */ } }
async function refreshUI() { try { S.emitChange && S.emitChange(); } catch { /* ignore */ } try { A.emitAudio(); } catch { /* ignore */ } try { (await import('./library.js')).refreshLibrary(); } catch { /* ignore */ } }

/* ---------------------------------------------------------------- import: apply */
/** backupKey → localKey for books that are the same book under different ids / keys (id, sync key, then normalised title + author). */
export function matchBooks(local, backup) {
  const byId = new Map(local.map((b) => [b.id, b])), byKey = new Map(local.map((b) => [S.bookSyncKey(b), b])), byTa = new Map(local.map((b) => [ta(b), b]));
  const keyMap = new Map(), pair = new Map();   // pair: backup id → local book
  for (const bb of backup) { const m = byId.get(bb.id) || byKey.get(S.bookSyncKey(bb)) || (norm(bb.title) ? byTa.get(ta(bb)) : null); if (m) { pair.set(bb.id, m); const bk = S.bookSyncKey(bb), lk = S.bookSyncKey(m); if (bk !== lk) keyMap.set(bk, lk); } }
  return { keyMap, pair };
}
function remapSnapshot(snap, keyMap) {
  if (!keyMap.size) return snap; const m = (k) => keyMap.get(k) || k; const re = (o) => { const r = {}; for (const [k, v] of Object.entries(o || {})) r[m(k)] = v; return r; };
  snap.books = re(snap.books); snap.bookmarks = re(snap.bookmarks); snap.meta = re(snap.meta);
  snap.loans = Object.fromEntries(Object.entries(snap.loans || {}).map(([k, v]) => [k.startsWith('book:') ? 'book:' + m(k.slice(5)) : k, v]));
  snap.links = (snap.links || []).map((x) => ({ ...x, bookKey: m(x.bookKey) }));
  snap.orders = (snap.orders || []).map((o) => ({ ...o, ids: o.ids.map((x) => (x.startsWith('b:') ? 'b:' + m(x.slice(2)) : x)) }));
  snap.tombstones = (snap.tombstones || []).map((t) => (t.t === 'book' ? { ...t, id: m(t.id) } : t));
  return snap;
}
const emptySnapshot = () => ({ v: 1, meta: {}, audioMeta: {}, loans: {}, links: [], savedAt: 0, settings: { values: {}, updatedAt: -1 }, shelves: [], sets: [], orders: [], books: {}, bookmarks: {}, tombstones: [] });
const AUDIO_STATE = ['position', 'progress', 'status', 'shelves', 'speed', 'lastOpened', 'finishedAt', 'track', 'trackIndex'];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * mode: 'merge' (newest wins, user-set beats auto, nothing is removed) | 'replace' (this library becomes the backup; book files already on the device are kept for matching books).
 * Everything can be undone with undoImport().
 */
export async function importBackup(P, { mode = 'merge', onProgress = () => {} } = {}) {
  const { zip, manifest: man } = P; const rep = { mode, booksMatched: 0, booksAdded: 0, booksPending: 0, filesImported: 0, filesFailed: [], audiobooks: 0, audiobooksPending: 0, shelves: 0, sets: 0, sources: 0 };
  onProgress({ phase: 'Saving an undo snapshot…', pct: 0.02 }); await discardUndo().catch(() => {}); await makeUndo((mode === 'replace' ? 'Replace' : 'Merge') + ' from ' + (man.appName || man.app));
  try {
    const localBooks = await S.getBooks(); const { keyMap, pair } = matchBooks(localBooks, man.books); rep.booksMatched = pair.size;
    const snap = remapSnapshot(structuredClone(man.snapshot), keyMap);
    const coverFor = new Map(); for (const r of [...man.books, ...(man.audiobooks || [])]) if (r.coverId && r.coverFile && zip.has(r.coverFile)) coverFor.set(r.coverId, r.coverFile);
    const getCover = async (id) => { const f = coverFor.get(id); return f ? zip.blob(f, 'image/jpeg') : null; };
    if (mode === 'replace') {
      onProgress({ phase: 'Clearing this library…', pct: 0.06 });
      const keepIds = new Set([...pair.values()].map((b) => b.id));
      for (const b of localBooks) if (!keepIds.has(b.id)) { await DB.del('books', b.id); for (const bm of await DB.byIndex('bookmarks', 'bookId', b.id)) await DB.del('bookmarks', bm.id); }   // files stay until the undo is discarded
      for (const b of localBooks) if (keepIds.has(b.id)) { delete b.metaAt; delete b.userSet; delete b.loanAt; b.updatedAt = 0; await DB.put('books', { ...b, _noTouch: true }); }
    }
    onProgress({ phase: 'Merging shelves, sets, positions and metadata…', pct: 0.12 });
    const local = mode === 'replace' ? emptySnapshot() : await buildSnapshot(); const merged = mergeSnapshots(local, snap);
    const ar = await applySnapshot(merged, { getCover, force: mode === 'replace' }); rep.booksPending = ar.pending; rep.shelves = merged.shelves.length; rep.sets = merged.sets.length;
    // device-only preferences (pinch, hold time, footer, audio speed …): Replace takes all of them; Merge only fills the ones still at their default
    const wanted = (man.settings && man.settings.all) || {}; const cur = settings.all(); const patch = {}; const { DEFAULTS } = await import('./settings.js');
    for (const [k, v] of Object.entries(wanted)) { if (NOT_EXPORTED.has(k) || SECRET_RE.test(k)) continue; if (!(k in DEFAULTS)) continue; if (mode === 'replace' ? !sameJson(cur[k], v) : (!SYNCED.includes(k) && sameJson(cur[k], DEFAULTS[k]) && !sameJson(v, DEFAULTS[k]))) patch[k] = v; }
    if (Object.keys(patch).length) settings.set(patch, { remote: true });
    if (mode === 'replace' && man.settings && man.settings.updatedAt) localStorage.setItem(LS.settingsAt, String(man.settings.updatedAt));
    // sources
    onProgress({ phase: 'Catalog sources…', pct: 0.2 });
    const haveSrc = new Map((await DB.all('sources')).map((x) => [x.id, x]));
    if (mode === 'replace') for (const id of haveSrc.keys()) if (!(man.sources || []).some((x) => x.id === id)) await DB.del('sources', id);
    for (const x of man.sources || []) if (mode === 'replace' || !haveSrc.has(x.id)) { await DB.put('sources', scrub(x)); rep.sources++; }
    // audiobooks
    onProgress({ phase: 'Audiobooks…', pct: 0.25 }); await restoreAudiobooks(man, zip, mode, merged, rep);
    // book files that aren't in this library yet
    const todo = man.books.filter((r) => !pair.has(r.id) && r.file && zip.has(r.file)); let i = 0;
    for (const r of todo) {
      onProgress({ phase: 'Adding “' + r.title + '”…', pct: 0.3 + 0.68 * (i++ / Math.max(1, todo.length)) });
      try {
        const buf = await (await zip.blob(r.file)).arrayBuffer(); const book = await S.addBookFromBuffer(buf, { filename: r.title + '.' + (r.format === 'pdf' ? 'pdf' : 'epub'), source: 'backup' });
        if (r.coverFile && zip.has(r.coverFile) && (r.coverSource === 'user' || r.coverSource === 'enrich')) { const b = await S.getBook(book.id); Object.assign(b, { coverBlob: await zip.blob(r.coverFile, 'image/jpeg'), coverSource: r.coverSource, coverId: r.coverId, metaAt: r.metaAt || b.metaAt, userSet: r.userSet || b.userSet }); await DB.put('books', { ...b, _noTouch: true }); }
        rep.filesImported++; rep.booksAdded++; rep.booksPending = Math.max(0, rep.booksPending - 1);
      } catch (e) { if (!/already in your library/i.test(e.message)) rep.filesFailed.push({ title: r.title, error: e.message }); }
    }
    onProgress({ phase: 'Done', pct: 1 }); await refreshUI(); return rep;
  } catch (e) {
    try { await undoImport(); } catch { /* keep going */ }
    throw new BackupError('The import failed, so nothing was changed: ' + (e && e.message ? e.message : e));
  }
}

async function restoreAudiobooks(man, zip, mode, merged, rep) {
  const recs = man.audiobooks || []; const local = await A.getAudiobooks(); const idmap = new Map(merged.idmap || []);
  const byId = new Map(local.map((b) => [b.id, b])), byKey = new Map(local.map((b) => [b.syncKey || b.id, b])), byTa = new Map(local.map((b) => [ta(b), b]));
  const matched = new Set(); const pend = readLS(LS.pendingAudio, {});
  for (const r of recs) {
    const m = byId.get(r.id) || byKey.get(r.syncKey || r.id) || (norm(r.title) ? byTa.get(ta(r)) : null); const shelves = (r.shelves || []).map((x) => idmap.get(x) || x);
    if (m) {
      matched.add(m.id);
      if (mode === 'replace' || (r.lastOpened || 0) > (m.lastOpened || 0)) { for (const k of AUDIO_STATE) if (r[k] !== undefined) m[k] = r[k]; m.shelves = shelves; await DB.put('audiobooks', { ...m, _noTouch: true }); }
      rep.audiobooks++;
    } else {
      const streamable = (r.tracks || []).length && r.tracks.every((t) => t.url);
      if (streamable) { const rec = { ...r, shelves, tracks: r.tracks.map((t) => ({ ...t, stored: false })) }; delete rec.coverFile; if (r.coverFile && zip.has(r.coverFile)) rec.coverBlob = await zip.blob(r.coverFile, 'image/jpeg'); if (await DB.get('audiobooks', rec.id)) rec.id = crypto.randomUUID ? crypto.randomUUID() : rec.id + '-b'; await DB.put('audiobooks', { ...rec, _noTouch: true }); rep.audiobooks++; }
      else { const st = {}; for (const k of AUDIO_STATE) if (r[k] !== undefined) st[k] = r[k]; st.shelves = shelves; st.title = r.title; pend[r.syncKey || r.id] = st; rep.audiobooksPending++; }
    }
  }
  if (mode === 'replace') for (const b of local) if (!matched.has(b.id)) await DB.del('audiobooks', b.id);
  localStorage.setItem(LS.pendingAudio, JSON.stringify(pend));
}

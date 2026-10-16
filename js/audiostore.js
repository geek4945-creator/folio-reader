// Audiobook data layer: books (metadata + cover + position), per-track audio blobs, import from files / folders / zips, online sources,
// offline downloads, delete + undo. Device-only: audio is large, so it is never synced (shelves are shared with ebooks).
import { DB, uid } from './db.js';
import { shrinkCover } from './epubmeta.js';
import { readAudioMeta, probeDuration, AUDIO_EXT, DRM_EXT } from './audiotags.js';
import { download } from './net.js';
import { settings } from './settings.js';
import { applyPendingMeta, getPendingMeta, setPendingMeta } from './metasync.js';

const tombs = () => { try { return JSON.parse(localStorage.getItem('folio.tombs') || '[]'); } catch { return []; } };
const setTombs = (t) => localStorage.setItem('folio.tombs', JSON.stringify(t.slice(-5000)));
const audioKey = (b) => b.syncKey || b.id;
/** Metadata synced from another device before this audiobook was imported here. */
function applyPendingAudio(book) {
  const k = audioKey(book);
  try { const pa = JSON.parse(localStorage.getItem('folio.pendingAudio') || '{}'); const st = pa[k]; if (st) { for (const f of ['position', 'progress', 'status', 'shelves', 'speed', 'lastOpened', 'finishedAt', 'track', 'trackIndex']) if (st[f] !== undefined) book[f] = st[f]; delete pa[k]; localStorage.setItem('folio.pendingAudio', JSON.stringify(pa)); } } catch { /* ignore */ }   // position / status kept from a library backup
  if (applyPendingMeta(book, 'audio', k)) { const p = getPendingMeta('audio'); delete p[k]; setPendingMeta('audio', p); }
}

const bus = new EventTarget();
export const onAudioChange = (fn) => bus.addEventListener('change', fn);
export const emitAudio = () => bus.dispatchEvent(new Event('change'));

export const AUDIO_STATUSES = [{ id: 'reading', name: 'Listening' }, { id: 'want', name: 'Want to Listen' }, { id: 'finished', name: 'Finished' }];
export const audioStatusName = (id) => AUDIO_STATUSES.find((s) => s.id === id)?.name || id;
export const COPY_PROTECTED_MSG = 'This audiobook is copy-protected (DRM), so Folio can’t import it. Audible (.aax / .aa) and iTunes (.m4p) files only play in their own apps. Look for a DRM-free copy from where you got it, for example your library’s Libby app, LibriVox, or a publisher that sells DRM-free MP3 / M4B.';
const UNSUPPORTED = 'Unsupported audio format. Folio plays MP3, M4A, M4B, AAC, OGG, Opus, FLAC and WAV.';
export class AudioImportError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

export const getAudiobooks = () => DB.all('audiobooks');
export const getAudiobook = (id) => DB.get('audiobooks', id);
export async function saveAudiobook(b, emit = true) { await DB.put('audiobooks', b); if (emit) emitAudio(); return b; }
export const trackKey = (id, i) => id + ':' + i;
export async function getTrackBlob(book, i) { return (await DB.get('audiofiles', trackKey(book.id, i)))?.blob || null; }
export const isStreaming = (b) => b.tracks.some((t) => t.url && !t.stored);
export const isDownloaded = (b) => b.tracks.every((t) => t.stored);
export const totalDuration = (b) => b.tracks.reduce((a, t) => a + (t.duration || 0), 0);
export const hasUrls = (b) => b.tracks.some((t) => t.url);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalSort = (a, b) => collator.compare(a.name, b.name);
const MIME = { mp3: 'audio/mpeg', mp4: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav' };
const stem = (n) => n.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
const prettyName = (n) => stem(n).replace(/^\d+\s*[-.)_ ]\s*/, '').trim() || stem(n);
export const isAudioName = (n) => AUDIO_EXT.test(n); export const isDrmName = (n) => DRM_EXT.test(n);

function commonPrefix(names) {
  if (names.length < 2) return ''; let p = names[0]; for (const n of names) { while (!n.startsWith(p)) p = p.slice(0, -1); }
  return p.replace(/[\s\-_.,0-9(\[]+$/g, '').trim();
}

/** Read zips into [{name, blob}] entries (audio + a cover image), skipping junk. */
export async function expandZip(file) {
  if (!window.JSZip) throw new AudioImportError('Zip support is not available');
  const zip = await JSZip.loadAsync(file); const out = []; let image = null;
  for (const e of Object.values(zip.files)) {
    if (e.dir || /(^|\/)(__MACOSX|\.)/.test(e.name) || /\/\./.test(e.name)) continue;
    if (isDrmName(e.name)) { out.push({ name: e.name, drm: true }); continue; }
    if (isAudioName(e.name)) out.push({ name: e.name, blob: await e.async('blob') });
    else if (!image && /\.(jpe?g|png)$/i.test(e.name) && /cover|folder|front|art/i.test(e.name)) image = { name: e.name, blob: await e.async('blob') };
  }
  return { entries: out, image };
}

/** Group dropped / picked files into book groups. mode: 'one' (all one book), 'each' (one book per file), 'auto' (zip = book, folder = book, loose file = book). */
export async function groupFiles(files, mode = 'auto') {
  const groups = []; const folders = new Map(); const loose = [];
  for (const f of files) {
    const name = f.name; const rel = f.webkitRelativePath || f._rel || '';
    if (/\.zip$/i.test(name)) {
      const { entries, image } = await expandZip(f);
      groups.push({ name: stem(name), entries, image }); continue;
    }
    if (rel && rel.includes('/')) { const dir = rel.split('/').slice(0, -1).join('/'); if (!folders.has(dir)) folders.set(dir, { name: rel.split('/')[rel.split('/').length - 2], entries: [], image: null }); const g = folders.get(dir);
      if (isAudioName(name) || isDrmName(name)) g.entries.push({ name: rel, blob: f, drm: isDrmName(name) }); else if (/\.(jpe?g|png)$/i.test(name) && (!g.image || /cover|folder|front/i.test(name))) g.image = { name, blob: f }; continue; }
    loose.push(f);
  }
  const looseEntries = loose.filter((f) => isAudioName(f.name) || isDrmName(f.name) || /^audio\//.test(f.type)).map((f) => ({ name: f.name, blob: f, drm: isDrmName(f.name) }));
  if (mode === 'one' && looseEntries.length) groups.push({ name: '', entries: looseEntries, image: null });
  else for (const e of looseEntries) groups.push({ name: stem(e.name), entries: [e], image: null });
  groups.push(...folders.values());
  return groups.filter((g) => g.entries.length);
}

/** Build + store one audiobook from a group. Throws AudioImportError (code 'drm' | 'dupe' | 'unsupported'). */
export async function importGroup(group, opts = {}) {
  const entries = [...group.entries].sort(naturalSort);
  if (entries.some((e) => e.drm)) throw new AudioImportError(COPY_PROTECTED_MSG, 'drm');
  const parts = [];
  for (const e of entries) {
    const meta = await readAudioMeta(e.blob, e.name);
    if (meta.drm) throw new AudioImportError(COPY_PROTECTED_MSG, 'drm');
    if (!meta.kind) throw new AudioImportError(UNSUPPORTED + ' (' + e.name + ')', 'unsupported');
    if (!(meta.duration > 0)) meta.duration = (await probeDuration(e.blob)) || 0;
    parts.push({ e, meta });
  }
  const first = parts[0].meta; const multi = parts.length > 1;
  const title = (multi ? (first.album || group.name || commonPrefix(parts.map((p) => stem(p.e.name)))) : (first.title || first.album || group.name)) || stem(parts[0].e.name) || 'Audiobook';
  const author = first.albumArtist || first.artist || '';
  const tracks = []; const chapters = []; let cover = parts.map((p) => p.meta.cover).find(Boolean) || group.image?.blob || null;
  parts.forEach(({ e, meta }, i) => {
    const type = MIME[meta.kind] || e.blob.type || 'audio/mpeg';
    tracks.push({ name: e.name.replace(/^.*[\\/]/, ''), title: meta.title || prettyName(e.name), size: e.blob.size, duration: meta.duration || 0, type });
    if (meta.chapters.length) for (const c of meta.chapters) chapters.push({ title: c.title || `Chapter ${chapters.length + 1}`, track: i, start: c.start });
    else if (multi) chapters.push({ title: meta.title || prettyName(e.name), track: i, start: 0 });
  });
  const duration = tracks.reduce((a, t) => a + t.duration, 0);
  const syncKey = (title + '|' + author + '|' + Math.round(duration)).toLowerCase();
  const all = await getAudiobooks();
  if (opts.sourceKey && all.some((b) => b.sourceKey === opts.sourceKey)) throw new AudioImportError('Already in your audiobooks', 'dupe');
  if (all.some((b) => b.syncKey === syncKey)) throw new AudioImportError('“' + title + '” is already in your audiobooks', 'dupe');
  if (cover) cover = await shrinkCover(cover);
  const book = { id: uid(), kind: 'audio', title, author, description: '', addedAt: Date.now(), lastOpened: 0, position: 0, progress: 0, status: 'want', shelves: [], speed: null,
    source: opts.source || 'import', sourceKey: opts.sourceKey || null, syncKey, coverBlob: cover, coverSource: 'file', tracks, chapters, duration, size: tracks.reduce((a, t) => a + t.size, 0) };
  applyPendingAudio(book);
  for (const [i, { e, meta }] of parts.entries()) await DB.put('audiofiles', { id: trackKey(book.id, i), bookId: book.id, blob: new Blob([e.blob], { type: MIME[meta.kind] || e.blob.type || 'audio/mpeg' }) });
  tracks.forEach((t) => { t.stored = true; });
  await DB.put('audiobooks', book); emitAudio(); autoEnrichLater(book); return book;
}
const autoEnrichLater = (b) => { if (settings.get('autoEnrich')) import('./enrich.js').then((m) => m.autoEnrichNew(b, 'audio')); };

/** Import files from a picker / drop: returns { ok:[books], drm:[names], errs:[msgs] }. */
export async function importAudioFiles(files, mode = 'auto') {
  const res = { ok: [], drm: [], errs: [] };
  let groups; try { groups = await groupFiles(files, mode); } catch (e) { res.errs.push(e.message); return res; }
  const protectedLoose = files.filter((f) => isDrmName(f.name) && !/\.zip$/i.test(f.name));
  for (const g of groups) {
    const label = g.entries.length === 1 ? g.entries[0].name : g.name || g.entries[0].name;
    try { res.ok.push(await importGroup(g)); } catch (e) { if (e.code === 'drm') res.drm.push(label); else res.errs.push(label + ': ' + (e.message || e)); }
  }
  for (const f of protectedLoose) if (!res.drm.includes(f.name)) res.drm.push(f.name);
  return res;
}

/** Online source (LibriVox / Internet Archive): add as a streaming book, optionally with a cover URL. */
export async function addRemoteAudiobook(info, fetchCover) {
  const all = await getAudiobooks();
  if (info.sourceKey && all.some((b) => b.sourceKey === info.sourceKey)) throw new AudioImportError('Already in your audiobooks', 'dupe');
  let cover = null;
  if (info.coverUrl && fetchCover) { try { cover = await fetchCover(info.coverUrl); if (cover) cover = await shrinkCover(cover); } catch { cover = null; } }
  const tracks = info.tracks.map((t, i) => ({ name: (t.url || '').split('/').pop() || 'track' + (i + 1), title: t.title || 'Part ' + (i + 1), size: t.size || 0, duration: t.duration || 0, type: 'audio/mpeg', url: t.url, stored: false }));
  const book = { id: uid(), kind: 'audio', title: info.title || 'Audiobook', author: info.author || '', description: info.description || '', addedAt: Date.now(), lastOpened: 0, position: 0, progress: 0, status: 'want', shelves: [], speed: null,
    source: info.source || 'online', sourceKey: info.sourceKey || null, sourceUrl: info.pageUrl || '', coverUrl: info.coverUrl || '', license: info.license || '', syncKey: (info.title + '|' + info.author + '|' + (info.sourceKey || '')).toLowerCase(), coverBlob: cover, coverSource: 'file',
    tracks, chapters: tracks.map((t, i) => ({ title: t.title, track: i, start: 0 })), duration: tracks.reduce((a, t) => a + t.duration, 0), size: 0 };
  applyPendingAudio(book);
  await DB.put('audiobooks', book); emitAudio(); autoEnrichLater(book); return book;
}

/** Save every streamed track for offline play. onProgress(doneTracks, total, fraction). Resolves to the updated book. */
export async function downloadOffline(id, onProgress, signal = { cancelled: false }) {
  let book = await getAudiobook(id); const total = book.tracks.length;
  for (let i = 0; i < total; i++) {
    if (signal.cancelled) break; book = await getAudiobook(id); if (!book) return null; const t = book.tracks[i];
    if (t.stored || !t.url) { onProgress && onProgress(i + 1, total, 1); continue; }
    const blob = await download(t.url, (f) => onProgress && onProgress(i, total, f));
    await DB.put('audiofiles', { id: trackKey(id, i), bookId: id, blob: new Blob([blob], { type: t.type || 'audio/mpeg' }) });
    book = await getAudiobook(id); book.tracks[i].stored = true; book.tracks[i].size = blob.size; book.size = book.tracks.reduce((a, x) => a + (x.size || 0), 0); await DB.put('audiobooks', book);
    onProgress && onProgress(i + 1, total, 1);
  }
  emitAudio(); return getAudiobook(id);
}
export async function removeDownload(id) {
  const book = await getAudiobook(id); if (!book || !hasUrls(book)) return book;
  for (let i = 0; i < book.tracks.length; i++) if (book.tracks[i].url) { await DB.del('audiofiles', trackKey(id, i)); book.tracks[i].stored = false; }
  await DB.put('audiobooks', book); emitAudio(); return book;
}

/* ---------- delete / undo / status / shelves ---------- */
export async function deleteAudiobooks(ids) {
  const snap = { books: [], files: [] };
  for (const id of new Set(ids)) {
    const b = await getAudiobook(id); if (!b) continue; snap.books.push(b);
    for (let i = 0; i < b.tracks.length; i++) { const f = await DB.get('audiofiles', trackKey(id, i)); if (f) snap.files.push(f); }
  }
  for (const b of snap.books) { for (let i = 0; i < b.tracks.length; i++) await DB.del('audiofiles', trackKey(b.id, i)); await DB.del('audiobooks', b.id); }
  { const t = tombs(); for (const b of snap.books) t.push({ t: 'audio', id: audioKey(b), at: Date.now() }); setTombs(t); }   // so enriched metadata + covers of deleted audiobooks are dropped from Drive on every device
  for (const o of await DB.all('orders')) if (o.key.startsWith('audio:') && o.ids.some((x) => snap.books.some((b) => x === 'b:' + b.id))) { o.ids = o.ids.filter((x) => !snap.books.some((b) => x === 'b:' + b.id)); await DB.put('orders', o); }
  emitAudio(); return snap;
}
export async function restoreAudiobooks(snap) {
  for (const f of snap.files) await DB.put('audiofiles', f);
  for (const b of snap.books) await DB.put('audiobooks', b);
  { const keys = new Set(snap.books.map(audioKey)); setTombs(tombs().filter((t) => !(t.t === 'audio' && keys.has(t.id)))); }
  emitAudio();
}
export async function deleteAllAudiobooks() { const n = (await getAudiobooks()).length; await DB.clear('audiobooks'); await DB.clear('audiofiles'); emitAudio(); return n; }
export async function setAudioStatusMany(ids, status) {
  for (const id of ids) { const b = await getAudiobook(id); if (!b) continue; b.status = status; if (status === 'finished') { b.finishedAt = Date.now(); b.progress = 1; } await DB.put('audiobooks', b); }
  emitAudio();
}
export async function addAudioToShelfMany(ids, shelfId) {
  for (const id of ids) { const b = await getAudiobook(id); if (!b) continue; b.shelves = b.shelves || []; if (!b.shelves.includes(shelfId)) { b.shelves = [...b.shelves, shelfId]; await DB.put('audiobooks', b); } }
  emitAudio();
}
export async function toggleAudioShelf(id, shelfId) {
  const b = await getAudiobook(id); b.shelves = b.shelves || []; b.shelves = b.shelves.includes(shelfId) ? b.shelves.filter((x) => x !== shelfId) : [...b.shelves, shelfId];
  await DB.put('audiobooks', b); emitAudio();
}
export async function setAudioStatus(id, status) { await setAudioStatusMany([id], status); }

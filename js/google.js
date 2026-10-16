// Google sign-in (Google Identity Services token flow) + Drive appDataFolder sync.
// No backend: access tokens last ~1h; the app silently re-requests them (prompt:'' + login_hint) and remembers the profile.
import { settings, SYNCED } from './settings.js';
import { DB } from './db.js';
import * as S from './store.js';
import { onLibraryChange } from './store.js';
import { isCapacitor } from './env.js';
import * as A from './audiostore.js';
import { hashBlob } from './covers.js';
import { localMeta, mergeMetaMaps, applyTextFields, remoteCoverWins, setPendingMeta, getPendingMeta, ensureCoverIds, lastAtOf } from './metasync.js';

const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const AUTH_KEY = 'folio.google';
const FILE_NAME = 'folio-sync.json';
const status = { state: 'signed-out', message: '', lastSync: +(localStorage.getItem('folio.lastSync') || 0) };
const listeners = new Set();
export const onSyncStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const setStatus = (state, message = '') => { Object.assign(status, { state, message }); listeners.forEach((f) => f(status)); };
export const getStatus = () => ({ ...status });

export const getClientId = () => (localStorage.getItem('folio.gClientId') || (window.FOLIO_CONFIG && window.FOLIO_CONFIG.googleClientId) || '').trim();
export const webAppUrl = () => (window.FOLIO_CONFIG && window.FOLIO_CONFIG.webAppUrl) || 'https://geek4945-creator.github.io/folio-reader/';
/** Google blocks OAuth inside embedded WebViews (and the GIS popup can't open there), so the Android app can't sign in itself. */
export const signInUnavailableHere = () => isCapacitor();
export const ANDROID_SIGNIN_MSG = 'Google sign-in doesn’t work inside the Android app (Google blocks it in app WebViews). Open Folio in your browser to sign in and sync: ' ;
export const setClientId = (id) => localStorage.setItem('folio.gClientId', id.trim());
const load = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } };
const save = (a) => localStorage.setItem(AUTH_KEY, JSON.stringify(a));
export const getProfile = () => load()?.profile || null;
export const isSignedIn = () => !!getProfile();

/* ---------- GIS ---------- */
let gisP;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = res; s.onerror = () => { gisP = null; rej(new Error('Could not load Google sign-in (offline?)')); };
    document.head.append(s);
  });
  return gisP;
}

function requestToken(prompt, hint, scope = SCOPES) {
  return new Promise((resolve, reject) => {
    if (isCapacitor()) return reject(new Error(ANDROID_SIGNIN_MSG + webAppUrl()));
    const cid = getClientId(); if (!cid) return reject(new Error('Add your Google OAuth Client ID in Settings first.'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope, prompt, login_hint: hint || undefined,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in window closed' : e.type === 'popup_failed_to_open' ? 'The sign-in window couldn’t open here. Allow pop-ups for this site, or open Folio in your browser: ' + webAppUrl() : (e.message || e.type || 'Sign-in failed'))),
    });
    client.requestAccessToken();
  });
}

let renewTimer;
function scheduleRenew(exp) {
  clearTimeout(renewTimer);
  const ms = Math.max(30000, exp - Date.now() - 5 * 60000);
  renewTimer = setTimeout(() => getToken().catch(() => {}), ms);
}

export async function getToken() {
  const a = load(); if (!a) throw new Error('Not signed in');
  if (a.token && a.exp - Date.now() > 60000) return a.token;
  await loadGis();
  try {
    const r = await requestToken('', a.profile?.email, a.scope || SCOPES);           // silent renewal; no UI if the Google session is alive
    a.token = r.access_token; a.exp = Date.now() + (r.expires_in - 30) * 1000; save(a); scheduleRenew(a.exp);
    if (status.state === 'needs-reauth') setStatus('connected');
    return a.token;
  } catch (e) {
    setStatus('needs-reauth', 'Tap “Reconnect” to refresh your Google session.');
    throw e;
  }
}

export async function signIn() {
  if (isCapacitor()) throw new Error(ANDROID_SIGNIN_MSG + webAppUrl());
  await loadGis();
  const r = await requestToken(isSignedIn() ? '' : 'consent', getProfile()?.email);
  const scopes = r.scope || '';
  if (!scopes.includes('drive.appdata')) throw new Error('Drive app-data permission was not granted.');
  const ui = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + r.access_token } })).json();
  const a = { token: r.access_token, exp: Date.now() + (r.expires_in - 30) * 1000, scope: SCOPES, profile: { name: ui.name || ui.email, email: ui.email, picture: ui.picture || '' } };
  save(a); scheduleRenew(a.exp); setStatus('connected');
  return a.profile;
}

/* ---------- Google Drive browse / import (optional, extra read-only scope requested on first use) ---------- */
const DRIVE_READ = 'https://www.googleapis.com/auth/drive.readonly';
export const canBrowseDrive = () => !!(load()?.scope || '').includes('drive.readonly');
/** Ask for read-only Drive access (needs a user tap: Google shows a consent popup). */
export async function enableDriveBrowse() {
  const a = load(); if (!a) throw new Error('Sign in with Google first (Settings).');
  await loadGis();
  const scope = SCOPES + ' ' + DRIVE_READ;
  const r = await requestToken('consent', a.profile?.email, scope);
  if (!(r.scope || '').includes('drive.readonly')) throw new Error('Drive read access was not granted.');
  a.token = r.access_token; a.exp = Date.now() + (r.expires_in - 30) * 1000; a.scope = scope; save(a); scheduleRenew(a.exp);
}
const EBOOK_Q = "(mimeType='application/vnd.google-apps.folder' or mimeType='application/epub+zip' or mimeType='application/pdf' or mimeType='application/x-mobipocket-ebook' or mimeType='application/vnd.amazon.ebook' or name contains '.epub' or name contains '.pdf' or name contains '.mobi' or name contains '.azw')";
const IMAGE_Q = "(mimeType='application/vnd.google-apps.folder' or mimeType contains 'image/' or name contains '.jpg' or name contains '.jpeg' or name contains '.png' or name contains '.webp' or name contains '.gif')";
const AUDIO_Q = "(mimeType='application/vnd.google-apps.folder' or mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.m4b' or name contains '.aac' or name contains '.ogg' or name contains '.opus' or name contains '.flac' or name contains '.wav' or name contains '.zip')";
export async function listDriveFiles({ folderId = 'root', search = '', pageToken = '', audio = false, images = false } = {}) {
  const EPUB_Q = images ? IMAGE_Q : audio ? AUDIO_Q : EBOOK_Q;
  const q = search ? `trashed=false and name contains '${search.replace(/['\\]/g, ' ')}' and ${EPUB_Q}` : `trashed=false and '${folderId}' in parents and ${EPUB_Q}`;
  const u = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({ q, orderBy: 'folder,name', pageSize: '50', fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)', spaces: 'drive', ...(pageToken ? { pageToken } : {}) });
  const r = await drive(u); return r.json();
}
export async function downloadDriveFile(id, { retries = 0 } = {}) { return (await drive(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { retries })).blob(); }
/** Name of a Drive folder (cached): used to title audiobooks made from several files of one folder. */
const folderNames = new Map();
export async function driveFolderName(id) { if (!id) return ''; if (folderNames.has(id)) return folderNames.get(id); let n = ''; try { n = (await (await drive(`https://www.googleapis.com/drive/v3/files/${id}?fields=name`, { retries: 2 })).json()).name || ''; } catch { /* ignore */ } folderNames.set(id, n); return n; }

/* ---------- batch scan: every book / audio file in a folder (optionally with subfolders) or in the whole Drive ---------- */
const BOOK_T = "(mimeType='application/epub+zip' or mimeType='application/pdf' or mimeType='application/x-mobipocket-ebook' or mimeType='application/vnd.amazon.ebook' or name contains '.epub' or name contains '.pdf' or name contains '.mobi' or name contains '.azw')";
const AUDIO_T = "(mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.m4b' or name contains '.aac' or name contains '.ogg' or name contains '.opus' or name contains '.flac' or name contains '.wav')";
const FOLDER = "mimeType='application/vnd.google-apps.folder'";
export const BOOK_EXT_RE = /\.(epub|pdf|mobi|azw3?|kf8)$/i, AUDIO_EXT_RE = /\.(mp3|m4a|m4b|aac|ogg|opus|flac|wav)$/i;
/** folderId null = the whole Drive (search by mime type / extension). Follows nextPageToken; honours signal.cancelled; caps at maxFiles / maxFolders. */
export async function scanDrive({ kind = 'book', folderId = null, folderName = '', recursive = false, signal = {}, onProgress = () => {}, maxFiles = 5000, maxFolders = 500 } = {}) {
  const T = kind === 'audio' ? AUDIO_T : BOOK_T; const okName = kind === 'audio' ? AUDIO_EXT_RE : BOOK_EXT_RE; const files = []; const seen = new Set(); let truncated = false, folders = 0;
  const fields = 'nextPageToken,files(id,name,mimeType,size,parents)';
  const page = async (q, tok) => (await drive('https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({ q, pageSize: '200', fields, spaces: 'drive', orderBy: 'folder,name', ...(tok ? { pageToken: tok } : {}) }), { retries: 3 })).json();
  const add = (f, folder) => { if (seen.has(f.id)) return; seen.add(f.id); if ((f.mimeType || '').startsWith('application/vnd.google-apps')) return; if (!(f.mimeType || '').startsWith(kind === 'audio' ? 'audio/' : 'application/') && !okName.test(f.name)) return; files.push({ id: f.id, name: f.name, size: +f.size || 0, mimeType: f.mimeType, parent: (f.parents || [])[0] || null, folder: folder || '' }); };
  if (!folderId) {
    let tok = '';
    do { const d = await page(`trashed=false and ${FOLDER.replace('=', '!=')} and ${T}`, tok); for (const f of d.files || []) add(f, ''); tok = d.nextPageToken || ''; onProgress({ found: files.length, folders: 0 }); if (files.length >= maxFiles) { truncated = !!tok; break; } } while (tok && !signal.cancelled);
  } else {
    const queue = [{ id: folderId, name: folderName }];
    while (queue.length && !signal.cancelled) {
      const cur = queue.shift(); folders++; let tok = '';
      do { const d = await page(`trashed=false and '${cur.id}' in parents and (${FOLDER} or ${T})`, tok); for (const f of d.files || []) { if (f.mimeType === 'application/vnd.google-apps.folder') { if (recursive) { if (folders + queue.length < maxFolders) queue.push({ id: f.id, name: f.name }); else truncated = true; } } else add(f, cur.name); } tok = d.nextPageToken || ''; onProgress({ found: files.length, folders }); if (files.length >= maxFiles) { truncated = true; queue.length = 0; break; } } while (tok && !signal.cancelled);
    }
  }
  return { files, truncated, cancelled: !!signal.cancelled, folders };
}

export function signOut() {
  clearTimeout(renewTimer); localStorage.removeItem(AUTH_KEY); setStatus('signed-out');
  try { google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
}
export async function disconnect() {
  const a = load();
  if (a?.token) { try { await loadGis(); await new Promise((r) => google.accounts.oauth2.revoke(a.token, r)); } catch { /* ignore */ } }
  signOut();
}

/* ---------- Drive appDataFolder ---------- */
/** Drive request pacing / retry (used by batch import; sync keeps the defaults: no gap, no retries). */
export const driveRate = { gap: 0, backoff: 700 };
let lastDriveAt = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const isTransient = (e) => !!e && (e.status === 429 || e.status >= 500 || (e.status === 403 && e.rate) || e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message || ''));
async function drive(path, init = {}, retry = true, tried = 0) {
  const { retries = 0, ...fi } = init;
  if (driveRate.gap) { const w = lastDriveAt + driveRate.gap - Date.now(); if (w > 0) await wait(w); lastDriveAt = Date.now(); }
  const token = await getToken();
  let r;
  try { r = await fetch(path, { ...fi, headers: { ...(fi.headers || {}), Authorization: 'Bearer ' + token } }); }
  catch (e) { if (tried < retries) { await wait(driveRate.backoff * 2 ** tried); return drive(path, init, retry, tried + 1); } throw e; }
  if (r.status === 401 && retry) { const a = load(); a.exp = 0; save(a); return drive(path, init, false, tried); }
  if (!r.ok) {
    let rate = false; if (r.status === 403) { try { rate = /rateLimit|userRateLimit|quota/i.test(await r.clone().text()); } catch { /* ignore */ } }
    const err = Object.assign(new Error('Google Drive error ' + r.status), { status: r.status, rate });
    if (tried < retries && isTransient(err)) { const ra = +r.headers.get('retry-after') || 0; await wait(ra ? Math.min(ra * 1000, 20000) : driveRate.backoff * 2 ** tried); return drive(path, init, retry, tried + 1); }
    throw err;
  }
  return r;
}
async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=5`);
  return (await r.json()).files?.[0] || null;
}
async function readRemote() {
  const f = await findFile(); if (!f) return { id: null, data: null };
  const r = await drive(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
  return { id: f.id, data: await r.json() };
}
async function writeRemote(id, data) {
  const body = JSON.stringify(data);
  if (id) { await drive(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }); return id; }
  const boundary = 'folio' + Math.random().toString(36).slice(2);
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart });
  return (await r.json()).id;
}

/* ---------- snapshot / merge / apply ---------- */
const putQuiet = (store) => (it) => DB.put(store, { ...it, _noTouch: true });
export async function buildSnapshot() {
  const [books, sets, shelves, orders, bms, audio, links] = await Promise.all([S.getBooks(), S.getSets(), DB.all('shelves'), DB.all('orders'), DB.all('bookmarks'), A.getAudiobooks(), DB.all('links')]);
  await ensureCoverIds(books, putQuiet('books'), hashBlob); await ensureCoverIds(audio, putQuiet('audiobooks'), hashBlob);
  const keyOf = new Map(books.map((b) => [b.id, S.bookSyncKey(b)]));
  const bookState = {};
  for (const b of books) bookState[keyOf.get(b.id)] = { title: b.title, addedAt: b.addedAt || 0, author: b.author, status: b.status, shelves: b.shelves || [], setId: b.setId || null, seriesIndex: b.seriesIndex ?? null, overrides: b.overrides || null, progress: b.progress || 0, cfi: b.cfi || null, lastOpened: b.lastOpened || 0, updatedAt: b.updatedAt || 0 };   // untouched imports are 0 so another device's edits win
  const bookmarks = {};
  for (const bm of bms) { const k = keyOf.get(bm.bookId); if (k) (bookmarks[k] ||= []).push({ id: bm.id, cfi: bm.cfi, label: bm.label, progress: bm.progress, createdAt: bm.createdAt, updatedAt: bm.updatedAt || bm.createdAt }); }
  const mapOrderId = (id) => (id.startsWith('b:') ? 'b:' + (keyOf.get(id.slice(2)) || id.slice(2)) : id.startsWith('k:') ? 'b:' + id.slice(2) : id);   // k: = placeholder for a book not on this device yet
  const s = settings.all(); const sv = {}; for (const k of SYNCED) sv[k] = s[k];
  if (s.flow === 'scrolled' && !s.flowChosen) delete sv.flow;   // the default (not a choice) must not overwrite another device's explicit Pages / Scroll setting
  const meta = {}; for (const b of books) { const e = localMeta(b); if (e) meta[keyOf.get(b.id)] = e; }
  const audioMeta = {}; for (const a of audio) { const e = localMeta(a); if (e) audioMeta[a.syncKey || a.id] = e; }
  const loans = {};   // Borrowed flag + due date, last-writer-wins on loanAt: 'book:<key>' / 'audio:<key>'
  for (const b of books) if (b.loanAt) loans['book:' + keyOf.get(b.id)] = { b: b.borrowed ? 1 : 0, due: b.dueAt || null, src: b.loanSource || '', at: b.loanAt };
  for (const a of audio) if (a.loanAt) loans['audio:' + (a.syncKey || a.id)] = { b: a.borrowed ? 1 : 0, due: a.dueAt || null, src: a.loanSource || '', at: a.loanAt };
  return { meta, audioMeta, v: 1, loans,
    links: links.map((x) => ({ id: x.id, bookKey: x.bookKey, audioKey: x.audioKey, state: x.state, by: x.by || 'user', score: x.score ?? null, bookTitle: x.bookTitle || '', audioTitle: x.audioTitle || '', createdAt: x.createdAt || 0, updatedAt: x.updatedAt || x.createdAt || 0 })),
    savedAt: Date.now(), settings: { values: sv, updatedAt: settings.updatedAt() },
    shelves: shelves.map((x) => ({ id: x.id, name: x.name, createdAt: x.createdAt, updatedAt: x.updatedAt || x.createdAt })),
    sets: sets.map((x) => ({ id: x.id, name: x.name, auto: !!x.auto, createdAt: x.createdAt, updatedAt: x.updatedAt || x.createdAt })),
    orders: orders.map((o) => ({ key: o.key, ids: o.ids.map(mapOrderId), updatedAt: o.updatedAt || 0 })),
    books: bookState, bookmarks, tombstones: S.getTombs() };
}

function canonicalize(snap, idmap) {   // unify duplicate sets/shelves with the same name created independently on two devices
  const m = (id) => idmap.get(id) || id;
  snap.shelves = snap.shelves.map((x) => ({ ...x, id: m(x.id) }));
  snap.sets = snap.sets.map((x) => ({ ...x, id: m(x.id) }));
  for (const st of Object.values(snap.books)) { if (st.setId) st.setId = m(st.setId); st.shelves = (st.shelves || []).map(m); }
  snap.orders = snap.orders.map((o) => { const [kind, id] = [o.key.split(':')[0], o.key.slice(o.key.indexOf(':') + 1)]; return { ...o, key: kind === 'set' || kind === 'shelf' ? kind + ':' + m(id) : o.key, ids: o.ids.map((x) => (x.startsWith('s:') ? 's:' + m(x.slice(2)) : x)) }; });
  return snap;
}

export function mergeSnapshots(local, remote) {
  if (!remote) return local;
  const idmap = new Map();
  for (const kind of ['sets', 'shelves']) {
    const all = [...local[kind], ...remote[kind]].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const byName = new Map();
    for (const x of all) { const n = x.name.trim().toLowerCase(); if (!byName.has(n)) byName.set(n, x.id); else if (byName.get(n) !== x.id) idmap.set(x.id, byName.get(n)); }
  }
  const L = canonicalize(structuredClone(local), idmap), R = canonicalize(structuredClone(remote), idmap);
  const tombs = [...(L.tombstones || []), ...(R.tombstones || [])];
  const dead = (t, id, ts) => tombs.some((x) => x.t === t && x.id === id && x.at >= ts);
  const lww = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
  const mergeList = (kind, keyf, t) => { const m = new Map(); for (const x of [...(L[kind] || []), ...(R[kind] || [])]) m.set(keyf(x), lww(m.get(keyf(x)), x)); return [...m.values()].filter((x) => !t || !dead(t, x.id, x.updatedAt || 0)); };
  const out = { v: 1, savedAt: Date.now(), tombstones: tombs.filter((t) => Date.now() - t.at < 90 * 864e5) };
  out.settings = (R.settings.updatedAt || 0) > (L.settings.updatedAt || 0) ? R.settings : L.settings;
  out.shelves = mergeList('shelves', (x) => x.id, 'shelf');
  out.sets = mergeList('sets', (x) => x.id, 'set');
  out.orders = mergeList('orders', (x) => x.key);
  out.books = {}; const deadBooks = new Set();
  for (const k of new Set([...Object.keys(L.books), ...Object.keys(R.books)])) { const st = lww(L.books[k], R.books[k]); if (dead('book', k, Math.max(st.updatedAt || 0, st.addedAt || 0))) deadBooks.add(k); else out.books[k] = st; }   // deleted on some device → gone everywhere
  out.bookmarks = {};
  for (const k of new Set([...Object.keys(L.bookmarks), ...Object.keys(R.bookmarks)])) {
    const m = new Map(); for (const x of [...(L.bookmarks[k] || []), ...(R.bookmarks[k] || [])]) m.set(x.id, lww(m.get(x.id), x));
    out.bookmarks[k] = [...m.values()].filter((x) => !dead('bookmark', x.id, x.updatedAt || 0));
  }
  for (const k of deadBooks) delete out.bookmarks[k];
  out.orders = out.orders.map((o) => ({ ...o, ids: o.ids.filter((x) => !(x.startsWith('b:') && deadBooks.has(x.slice(2)))) }));
  const live = new Set([...out.shelves.map((x) => x.id), ...out.sets.map((x) => x.id)]);
  for (const st of Object.values(out.books)) { st.shelves = (st.shelves || []).filter((id) => live.has(id)); if (st.setId && !live.has(st.setId)) st.setId = null; }
  const deadMeta = (type) => (k, at) => dead(type, k, at);
  out.meta = mergeMetaMaps(L.meta, R.meta, (k, at) => deadBooks.has(k) || dead('book', k, at));
  out.audioMeta = mergeMetaMaps(L.audioMeta, R.audioMeta, deadMeta('audio'));
  out.links = mergeList('links', (x) => x.id);   // audiobook ↔ ebook links + remembered rejections (older snapshots have none)
  out.loans = {}; for (const k of new Set([...Object.keys(L.loans || {}), ...Object.keys(R.loans || {})])) { const a = (L.loans || {})[k], b = (R.loans || {})[k]; out.loans[k] = !a ? b : !b ? a : (b.at || 0) > (a.at || 0) ? b : a; }
  out.idmap = [...idmap.entries()];
  return out;
}

/** Write the merged snapshot into IndexedDB / localStorage. Returns counts. */
export async function applySnapshot(m, ctx = {}) {
  const [books, sets, shelves, orders, bms] = await Promise.all([S.getBooks(), S.getSets(), DB.all('shelves'), DB.all('orders'), DB.all('bookmarks')]);
  const idmap = new Map(m.idmap || []);
  const touch = { _noTouch: true };
  // remap local ids that were merged into a canonical duplicate
  for (const x of [...sets, ...shelves]) if (idmap.has(x.id)) await DB.del(sets.includes(x) ? 'sets' : 'shelves', x.id);
  for (const x of m.sets) await DB.put('sets', { ...x, ...touch });
  for (const x of m.shelves) await DB.put('shelves', { ...x, ...touch });
  for (const s of sets) if (!m.sets.some((x) => x.id === (idmap.get(s.id) || s.id))) await DB.del('sets', s.id);
  for (const s of shelves) if (!m.shelves.some((x) => x.id === (idmap.get(s.id) || s.id))) await DB.del('shelves', s.id);
  if ((m.settings.updatedAt || 0) > settings.updatedAt()) { settings.set(m.settings.values, { remote: true }); localStorage.setItem('folio.settings.at', String(m.settings.updatedAt)); }
  const keyToId = new Map(); const pending = {}; let appliedBooks = 0, deletedBooks = 0;
  for (const b of books) {
    const key = S.bookSyncKey(b); keyToId.set(key, b.id); const st = m.books[key];
    if (!st) { if ((m.tombstones || []).some((t) => t.t === 'book' && t.id === key && t.at >= Math.max(b.updatedAt || 0, b.addedAt || 0))) { await S.deleteBooks([b.id], { tomb: false, emit: false }); keyToId.delete(key); deletedBooks++; } continue; }   // deleted on another device
    const localAt = b.updatedAt || 0;
    if ((st.updatedAt || 0) > localAt) {
      Object.assign(b, { status: st.status, shelves: st.shelves, setId: st.setId, seriesIndex: st.seriesIndex, overrides: st.overrides, progress: st.progress, cfi: st.cfi, lastOpened: st.lastOpened, title: st.title || b.title, author: st.author || b.author, updatedAt: st.updatedAt, _noTouch: true });
      await DB.put('books', b); appliedBooks++;
    } else if (idmap.size) { b.setId = idmap.get(b.setId) || b.setId; b.shelves = (b.shelves || []).map((x) => idmap.get(x) || x); await DB.put('books', { ...b, _noTouch: true }); }
  }
  for (const [k, st] of Object.entries(m.books)) if (!keyToId.has(k)) pending[k] = st;
  S.setPending(pending);
  const metaRes = await applyMeta(m, keyToId, ctx);
  for (const x of m.links || []) { const cur = await DB.get('links', x.id); if (!cur || (x.updatedAt || 0) > (cur.updatedAt || 0)) await DB.put('links', { ...x, _noTouch: true }); }
  await applyLoans(m.loans || {});
  // bookmarks
  const have = new Map(bms.map((x) => [x.id, x]));
  const pendBm = {};
  for (const [k, list] of Object.entries(m.bookmarks)) {
    const bid = keyToId.get(k); if (!bid) { pendBm[k] = list; continue; }
    const ids = new Set(list.map((x) => x.id));
    for (const x of list) { const h = have.get(x.id); if (!h || (x.updatedAt || 0) > (h.updatedAt || 0)) await DB.put('bookmarks', { ...x, bookId: bid, _noTouch: true }); }
    for (const x of bms) if (x.bookId === bid && !ids.has(x.id)) await DB.del('bookmarks', x.id);
  }
  S.setPendingBookmarks(pendBm);
  // orders: translate book keys back to local ids
  const unmapOrder = (id) => (id.startsWith('b:') ? (keyToId.has(id.slice(2)) ? 'b:' + keyToId.get(id.slice(2)) : 'k:' + id.slice(2)) : id);
  const liveKeys = new Set();
  for (const o of m.orders) {
    const ids = o.ids.map(unmapOrder); liveKeys.add(o.key);
    const cur = orders.find((x) => x.key === o.key);
    if (!cur || (o.updatedAt || 0) > (cur.updatedAt || 0)) await DB.put('orders', { key: o.key, ids, updatedAt: o.updatedAt, _noTouch: true });
  }
  for (const o of orders) if (!liveKeys.has(o.key) && (o.key.startsWith('set:') || o.key.startsWith('shelf:')) && !m.sets.concat(m.shelves).some((x) => o.key.endsWith(':' + x.id))) await DB.del('orders', o.key);
  localStorage.setItem('folio.tombs', JSON.stringify(m.tombstones || []));
  return { appliedBooks, deletedBooks, pending: Object.keys(pending).length, ...metaRes };
}

/** Borrowed flag + due date from another device (newest change wins). */
async function applyLoans(loans) {
  for (const kind of ['book', 'audio']) {
    const items = kind === 'book' ? await S.getBooks() : await A.getAudiobooks(); const store = kind === 'book' ? 'books' : 'audiobooks';
    for (const it of items) {
      const e = loans[kind + ':' + (kind === 'book' ? S.bookSyncKey(it) : (it.syncKey || it.id))]; if (!e || (e.at || 0) <= (it.loanAt || 0)) continue;
      it.borrowed = !!e.b; it.dueAt = e.due || null; it.loanAt = e.at; if (e.src) it.loanSource = e.src; else delete it.loanSource;
      await DB.put(store, { ...it, _noTouch: true });
    }
  }
}
/** Enriched / hand-edited metadata + covers for books and audiobooks. ctx.getCover(id) → Blob | null (Drive download). */
async function applyMeta(m, keyToId, ctx) {
  let metaApplied = 0, coversApplied = 0;
  const { resizeCover, revertCover } = await import('./covers.js');
  for (const kind of ['book', 'audio']) {
    const map = (kind === 'book' ? m.meta : m.audioMeta) || {}; const items = kind === 'book' ? await S.getBooks() : await A.getAudiobooks(); const store = kind === 'book' ? 'books' : 'audiobooks';
    const byKey = new Map(items.map((it) => [kind === 'book' ? S.bookSyncKey(it) : (it.syncKey || it.id), it])); const pend = {};
    for (const [k, e] of Object.entries(map)) {
      const it = byKey.get(k); if (!it) { pend[k] = e; continue; }
      let ch = applyTextFields(it, e);
      if (e.cover && remoteCoverWins(it, e.cover)) {
        const c = e.cover; it.metaAt = it.metaAt || {}; it.userSet = it.userSet || {};
        if (c.id) { const blob = ctx.getCover ? await ctx.getCover(c.id) : null; if (blob) { it.coverBlob = blob; it.coverId = c.id; it.coverSource = c.u ? 'user' : 'enrich'; it.metaAt.cover = c.at; if (c.u) it.userSet.cover = true; else delete it.userSet.cover; it.revertedAt = Math.max(it.revertedAt || 0, c.rv || 0); ch = true; coversApplied++; } }
        else { await revertCover(kind, it.id, { at: c.at, quiet: true }); const fresh = await (kind === 'book' ? S.getBook(it.id) : A.getAudiobook(it.id)); if (fresh) { Object.assign(it, fresh); it.revertedAt = Math.max(it.revertedAt || 0, c.rv || 0, c.at || 0); ch = true; coversApplied++; } }
      }
      if (ch) { await DB.put(store, { ...it, _noTouch: true }); metaApplied++; }
    }
    setPendingMeta(kind, pend);
  }
  return { metaApplied, coversApplied };
}

/* ---------- covers in appDataFolder: cover-<sha1>.jpg ---------- */
async function listCoverFiles() {
  const out = new Map(); let tok = '';
  do {
    const q = encodeURIComponent("name contains 'cover-' and trashed=false");
    const r = await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=nextPageToken,files(id,name,createdTime)&pageSize=200${tok ? '&pageToken=' + tok : ''}`);
    const d = await r.json(); for (const f of d.files || []) out.set(f.name, f); tok = d.nextPageToken || '';
  } while (tok);
  return out;
}
async function uploadCover(id, blob) {
  const b = 'folio' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: `cover-${id}.jpg`, parents: ['appDataFolder'], mimeType: 'image/jpeg' })}\r\n--${b}\r\nContent-Type: image/jpeg\r\n\r\n`, blob, `\r\n--${b}--`]);
  const r = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
  return r.json();
}
async function localCoverBlobs() {
  const out = new Map(); for (const it of [...await S.getBooks(), ...await A.getAudiobooks()]) if (it.coverId && it.coverBlob && (it.coverSource === 'enrich' || it.coverSource === 'user')) out.set(it.coverId, it.coverBlob);
  return out;
}
const coverIdsIn = (snap) => new Set([...Object.values(snap.meta || {}), ...Object.values(snap.audioMeta || {})].map((e) => e.cover?.id).filter(Boolean));
export const COVER_GC_AGE = 3600e3;

/* ---------- sync driver ---------- */
let syncing = false, dirtyTimer, hookInstalled = false, inflight = null, internalEmit = false;
/** Runs one sync. If one is already running, waits for it and then runs again so changes made meanwhile are never lost. */
export async function syncNow({ quiet = false } = {}) {
  if (!isSignedIn()) return null;
  while (inflight) { try { await inflight; } catch { /* previous failure is reported by its own caller */ } }
  inflight = doSync(quiet);
  try { return await inflight; } finally { inflight = null; }
}
async function doSync(quiet) {
  syncing = true; setStatus('syncing', 'Syncing…');
  try {
    const { id, data } = await readRemote();
    const local = await buildSnapshot();
    const merged = mergeSnapshots(local, data);
    let covers = null; try { covers = await listCoverFiles(); } catch { /* covers are best-effort: metadata still syncs */ }
    const getCover = async (cid) => { const f = covers?.get(`cover-${cid}.jpg`); if (!f) return null; try { return await (await drive(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).blob(); } catch { return null; } };
    const res = await applySnapshot(merged, { getCover });
    const finalSnap = await buildSnapshot();   // re-read so ids/timestamps are consistent
    const toPush = mergeSnapshots(finalSnap, merged);
    if (covers) {
      const blobs = await localCoverBlobs(); let up = 0;
      for (const cid of coverIdsIn(toPush)) { const name = `cover-${cid}.jpg`; if (covers.has(name) || !blobs.has(cid)) continue; try { covers.set(name, await uploadCover(cid, blobs.get(cid))); up++; } catch { /* retried next sync */ } }
      res.coversUploaded = up;
    }
    await writeRemote(id, toPush);
    if (covers) {   // garbage-collect covers nothing references any more (never ones younger than an hour: another device may be mid-sync)
      const keep = coverIdsIn(toPush); let gc = 0;
      for (const [name, f] of covers) { const m = /^cover-([0-9a-f]+)\.jpg$/.exec(name); if (!m || keep.has(m[1])) continue; if (Date.now() - Date.parse(f.createdTime || 0) < COVER_GC_AGE) continue; try { await drive(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); gc++; } catch { /* ignore */ } }
      res.coversDeleted = gc;
    }
    status.lastSync = Date.now(); localStorage.setItem('folio.lastSync', String(status.lastSync));
    setStatus('connected', 'Synced');
    internalEmit = true; try { S.emitChange(); } finally { internalEmit = false; }   // refresh UI without re-triggering sync
    return res;
  } catch (e) {
    if (status.state !== 'needs-reauth') setStatus('error', e.message || String(e));
    if (!quiet) throw e; return null;
  } finally { syncing = false; }
}
export function scheduleSync(ms = 5000) {
  if (!isSignedIn()) return;
  clearTimeout(dirtyTimer); dirtyTimer = setTimeout(() => syncNow({ quiet: true }), ms);
}
export function initSync() {
  if (hookInstalled) return; hookInstalled = true;
  if (isSignedIn()) { setStatus('connected', status.lastSync ? 'Last synced ' + new Date(status.lastSync).toLocaleString() : ''); const a = load(); if (a.exp > Date.now()) scheduleRenew(a.exp); }
  onLibraryChange(() => { if (!internalEmit) scheduleSync(); });
  settings.onChange((p) => { if (Object.keys(p).some((k) => SYNCED.includes(k))) scheduleSync(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (isSignedIn()) syncNow({ quiet: true }); } else if (isSignedIn() && navigator.onLine) syncNow({ quiet: true }); });
  window.addEventListener('online', () => scheduleSync(1000));
  if (isSignedIn() && navigator.onLine) setTimeout(() => syncNow({ quiet: true }), 1500);
}

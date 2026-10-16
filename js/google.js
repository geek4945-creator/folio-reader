// Google sign-in (Google Identity Services token flow) + Drive appDataFolder sync.
// No backend: access tokens last ~1h; the app silently re-requests them (prompt:'' + login_hint) and remembers the profile.
import { settings, SYNCED } from './settings.js';
import { DB } from './db.js';
import * as S from './store.js';
import { onLibraryChange } from './store.js';

const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const AUTH_KEY = 'folio.google';
const FILE_NAME = 'folio-sync.json';
const status = { state: 'signed-out', message: '', lastSync: +(localStorage.getItem('folio.lastSync') || 0) };
const listeners = new Set();
export const onSyncStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const setStatus = (state, message = '') => { Object.assign(status, { state, message }); listeners.forEach((f) => f(status)); };
export const getStatus = () => ({ ...status });

export const getClientId = () => (localStorage.getItem('folio.gClientId') || (window.FOLIO_CONFIG && window.FOLIO_CONFIG.googleClientId) || '').trim();
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
    const cid = getClientId(); if (!cid) return reject(new Error('Add your Google OAuth Client ID in Settings first.'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: cid, scope, prompt, login_hint: hint || undefined,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'Sign-in window closed' : (e.message || e.type || 'Sign-in failed'))),
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
const EPUB_Q = "(mimeType='application/vnd.google-apps.folder' or mimeType='application/epub+zip' or name contains '.epub')";
export async function listDriveFiles({ folderId = 'root', search = '', pageToken = '' } = {}) {
  const q = search ? `trashed=false and name contains '${search.replace(/['\\]/g, ' ')}' and ${EPUB_Q}` : `trashed=false and '${folderId}' in parents and ${EPUB_Q}`;
  const u = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({ q, orderBy: 'folder,name', pageSize: '50', fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', spaces: 'drive', ...(pageToken ? { pageToken } : {}) });
  const r = await drive(u); return r.json();
}
export async function downloadDriveFile(id) { return (await drive(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).blob(); }

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
async function drive(path, init = {}, retry = true) {
  const token = await getToken();
  const r = await fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401 && retry) { const a = load(); a.exp = 0; save(a); return drive(path, init, false); }
  if (!r.ok) throw new Error('Google Drive error ' + r.status);
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
export async function buildSnapshot() {
  const [books, sets, shelves, orders, bms] = await Promise.all([S.getBooks(), S.getSets(), DB.all('shelves'), DB.all('orders'), DB.all('bookmarks')]);
  const keyOf = new Map(books.map((b) => [b.id, S.bookSyncKey(b)]));
  const bookState = {};
  for (const b of books) bookState[keyOf.get(b.id)] = { title: b.title, author: b.author, status: b.status, shelves: b.shelves || [], setId: b.setId || null, seriesIndex: b.seriesIndex ?? null, overrides: b.overrides || null, progress: b.progress || 0, cfi: b.cfi || null, lastOpened: b.lastOpened || 0, updatedAt: b.updatedAt || 0 };   // untouched imports are 0 so another device's edits win
  const bookmarks = {};
  for (const bm of bms) { const k = keyOf.get(bm.bookId); if (k) (bookmarks[k] ||= []).push({ id: bm.id, cfi: bm.cfi, label: bm.label, progress: bm.progress, createdAt: bm.createdAt, updatedAt: bm.updatedAt || bm.createdAt }); }
  const mapOrderId = (id) => (id.startsWith('b:') ? 'b:' + (keyOf.get(id.slice(2)) || id.slice(2)) : id.startsWith('k:') ? 'b:' + id.slice(2) : id);   // k: = placeholder for a book not on this device yet
  const s = settings.all(); const sv = {}; for (const k of SYNCED) sv[k] = s[k];
  return { v: 1, savedAt: Date.now(), settings: { values: sv, updatedAt: settings.updatedAt() },
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
  const mergeList = (kind, keyf, t) => { const m = new Map(); for (const x of [...L[kind], ...R[kind]]) m.set(keyf(x), lww(m.get(keyf(x)), x)); return [...m.values()].filter((x) => !t || !dead(t, x.id, x.updatedAt || 0)); };
  const out = { v: 1, savedAt: Date.now(), tombstones: tombs.filter((t) => Date.now() - t.at < 90 * 864e5) };
  out.settings = (R.settings.updatedAt || 0) > (L.settings.updatedAt || 0) ? R.settings : L.settings;
  out.shelves = mergeList('shelves', (x) => x.id, 'shelf');
  out.sets = mergeList('sets', (x) => x.id, 'set');
  out.orders = mergeList('orders', (x) => x.key);
  out.books = {}; for (const k of new Set([...Object.keys(L.books), ...Object.keys(R.books)])) out.books[k] = lww(L.books[k], R.books[k]);
  out.bookmarks = {};
  for (const k of new Set([...Object.keys(L.bookmarks), ...Object.keys(R.bookmarks)])) {
    const m = new Map(); for (const x of [...(L.bookmarks[k] || []), ...(R.bookmarks[k] || [])]) m.set(x.id, lww(m.get(x.id), x));
    out.bookmarks[k] = [...m.values()].filter((x) => !dead('bookmark', x.id, x.updatedAt || 0));
  }
  const live = new Set([...out.shelves.map((x) => x.id), ...out.sets.map((x) => x.id)]);
  for (const st of Object.values(out.books)) { st.shelves = (st.shelves || []).filter((id) => live.has(id)); if (st.setId && !live.has(st.setId)) st.setId = null; }
  out.idmap = [...idmap.entries()];
  return out;
}

/** Write the merged snapshot into IndexedDB / localStorage. Returns counts. */
export async function applySnapshot(m) {
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
  const keyToId = new Map(); const pending = {}; let appliedBooks = 0;
  for (const b of books) {
    const key = S.bookSyncKey(b); keyToId.set(key, b.id); const st = m.books[key]; if (!st) continue;
    const localAt = b.updatedAt || 0;
    if ((st.updatedAt || 0) > localAt) {
      Object.assign(b, { status: st.status, shelves: st.shelves, setId: st.setId, seriesIndex: st.seriesIndex, overrides: st.overrides, progress: st.progress, cfi: st.cfi, lastOpened: st.lastOpened, title: st.title || b.title, author: st.author || b.author, updatedAt: st.updatedAt, _noTouch: true });
      await DB.put('books', b); appliedBooks++;
    } else if (idmap.size) { b.setId = idmap.get(b.setId) || b.setId; b.shelves = (b.shelves || []).map((x) => idmap.get(x) || x); await DB.put('books', { ...b, _noTouch: true }); }
  }
  for (const [k, st] of Object.entries(m.books)) if (!keyToId.has(k)) pending[k] = st;
  S.setPending(pending);
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
  return { appliedBooks, pending: Object.keys(pending).length };
}

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
    const res = await applySnapshot(merged);
    const finalSnap = await buildSnapshot();   // re-read so ids/timestamps are consistent
    const toPush = mergeSnapshots(finalSnap, merged);
    await writeRemote(id, toPush);
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

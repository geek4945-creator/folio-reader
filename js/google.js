// Google sign-in (Google Identity Services token flow) + Drive appDataFolder sync.
// No backend: access tokens last ~1h; the app silently re-requests them (prompt:'' + login_hint) and remembers the profile.
import { settings, SYNCED, syncedKeys, settingStamps, deviceOnlyGroups } from './settings.js';
import { DB, structAtOf, posAtOf, posAtOfState, gAtOf, GROUPS } from './db.js';
import { deviceId, deviceName, devicePlatform } from './device.js';
import { applyPosition, markSynced } from './positions.js';
import { APP_VERSION } from './device.js';
import * as S from './store.js';
import { onLibraryChange } from './store.js';
import { isCapacitor } from './env.js';
import * as A from './audiostore.js';
import { hashBlob } from './covers.js';
import { localMeta, mergeMetaMaps, applyTextFields, remoteCoverWins, setPendingMeta, getPendingMeta, ensureCoverIds, lastAtOf } from './metasync.js';

const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const AUTH_KEY = 'folio.google';
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
    const err = Object.assign(new Error('Google Drive error ' + r.status), { status: r.status, rate, retryAfter: +r.headers.get('retry-after') || 0 });
    if (tried < retries && isTransient(err)) { const ra = +r.headers.get('retry-after') || 0; await wait(ra ? Math.min(ra * 1000, 20000) : driveRate.backoff * 2 ** tried); return drive(path, init, retry, tried + 1); }
    throw err;
  }
  return r;
}
/* ---- sync files: one small file per domain, so a change in one place rewrites only that file ---- */
const FILES = { library: 'folio-sync.json', settings: 'folio-settings.json', positions: 'folio-positions.json', devices: 'folio-devices.json' };
export const SYNC_DOMAINS = [
  { id: 'positions', name: 'Reading positions', hint: 'where you are in every book and audiobook, finished / reading status' },
  { id: 'library', name: 'Library', hint: 'shelves, series, order, metadata & covers, per-book reading settings, Borrowed, audiobook ↔ ebook links' },
  { id: 'settings', name: 'Settings', hint: 'theme, text size, margins, page flow, sorting and the rest (each one on its own)' },
];
const lsj = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
export const domainEnabled = (d) => lsj('folio.sync.on', {})[d] !== false;
export function setDomainEnabled(d, on) { const o = lsj('folio.sync.on', {}); if (on) delete o[d]; else o[d] = false; localStorage.setItem('folio.sync.on', JSON.stringify(o)); }
const syncState = () => { const x = lsj('folio.sync.state', {}); x.rev ||= {}; x.hash ||= {}; return x; };
const saveSyncState = (x) => localStorage.setItem('folio.sync.state', JSON.stringify(x));
export const syncTuning = { minGap: 20000, foregroundGap: 15000, deviceEvery: 600000 };
const revOf = (f) => f && (f.md5Checksum || f.modifiedTime || f.id);
async function listSyncFiles() {
  const q = encodeURIComponent('(' + Object.values(FILES).map((n) => `name='${n}'`).join(' or ') + ') and trashed=false');
  const r = await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&orderBy=createdTime&fields=files(id,name,md5Checksum,modifiedTime,createdTime)&pageSize=20`, { retries: 2 });
  const out = new Map(); for (const f of (await r.json()).files || []) if (!out.has(f.name)) out.set(f.name, f);   // if two devices raced to create one, the oldest is the real one
  return out;
}
async function readFile(f) { return (await drive(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { retries: 2 })).json(); }
async function writeFile(name, f, data) {
  const body = JSON.stringify(data);
  if (f) { const r = await drive(`https://www.googleapis.com/upload/drive/v3/files/${f.id}?uploadType=media&fields=id,md5Checksum,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body, retries: 2 }); return { ...f, ...(await r.json()) }; }
  const boundary = 'folio' + Math.random().toString(36).slice(2);
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,md5Checksum,modifiedTime', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart, retries: 2 });
  return { name, ...(await r.json()) };
}

/* ---------- settings: every preference carries its own last-write-wins stamp ---------- */
export const POS_STATE = ['progress', 'cfi', 'lastOpened', 'pdfPage', 'pdfZoom', 'pdfText', 'posAt', 'dev', 'devName'];
export const AUDIO_POS_STATE = ['position', 'progress', 'track', 'trackIndex', 'speed', 'lastOpened', 'posAt', 'dev', 'devName'];
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gAtsOf = (b) => Object.fromEntries(Object.keys(GROUPS).map((g) => [g, gAtOf(b, g)]));
const stGroupAt = (st, g) => st.gAt?.[g] ?? st.updatedAt ?? 0;
export function buildSettingsPart() {
  const all = settings.all(), stamps = settingStamps(), flat = {}, legacy = 0;
  for (const k of syncedKeys()) {
    if (k === 'flow' && !all.flowChosen) continue;   // the default (not a choice) must not overwrite another device's explicit Pages / Scroll setting
    if (k === 'sorts') { const o = all.sorts || {}; for (const c of new Set([...Object.keys(o), ...Object.keys(stamps).filter((x) => x.startsWith('sorts/')).map((x) => x.slice(6))])) { const at = stamps['sorts/' + c] ?? legacy; flat['sorts/' + c] = o[c] === undefined ? { v: null, at, d: 1 } : { v: o[c], at }; } }
    else flat[k] = { v: all[k], at: stamps[k] ?? legacy };
  }
  return { flat, updatedAt: legacy };
}
/** Older snapshots / backups carry { values, updatedAt }: one stamp for all keys. */
export function settingsFlat(s) {
  if (!s) return {}; if (s.flat) return s.flat;
  const flat = {}; for (const [k, v] of Object.entries(s.values || {})) { if (k === 'sorts' && v) { for (const [c, x] of Object.entries(v)) flat['sorts/' + c] = { v: x, at: s.updatedAt || 0 }; } else flat[k] = { v, at: s.updatedAt || 0 }; }
  return flat;
}
function mergeSettingsPart(L, R) {
  const a = settingsFlat(L), b = settingsFlat(R), flat = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) flat[k] = !a[k] ? b[k] : !b[k] ? a[k] : (b[k].at || 0) > (a[k].at || 0) ? b[k] : a[k];
  return { flat, updatedAt: Math.max(L?.updatedAt || 0, R?.updatedAt || 0) };
}
/** Write merged settings into this device (per key: only where the merged stamp is newer, or always with force). */
function applySettingsPart(part, ctx) {
  const flat = settingsFlat(part), stamps = settingStamps(), legacy = 0, allowed = new Set(syncedKeys());
  const patch = {}, newStamps = { ...stamps }; let sorts = null; let n = 0;
  for (const [k, e] of Object.entries(flat)) {
    const base = k.split('/')[0]; if (!allowed.has(base)) continue;
    if (!ctx.force && (e.at || 0) <= (stamps[k] ?? legacy)) continue;
    if (k.startsWith('sorts/')) { sorts = sorts || { ...(settings.get('sorts') || {}) }; const c = k.slice(6); if (e.d || e.v == null) delete sorts[c]; else sorts[c] = e.v; }
    else patch[k] = e.v;
    newStamps[k] = e.at || 0; n++;
  }
  if (sorts) patch.sorts = sorts;
  if (Object.keys(patch).length) { if (patch.flow && !settings.get('flowChosen')) patch.flowChosen = true; settings.set(patch, { remote: true }); }
  if (n) { localStorage.setItem('folio.settings.keyAt', JSON.stringify(newStamps)); localStorage.setItem('folio.settings.at', String(ctx.force ? Math.max(part.updatedAt || 0, 1) : Math.max(settings.updatedAt(), ...Object.values(flat).map((e) => e.at || 0)))); }
  return n;
}

/* ---------- snapshot / merge / apply ---------- */
const putQuiet = (store) => (it) => DB.put(store, { ...it, _noTouch: true });
export async function buildSnapshot() {
  const [books, sets, shelves, orders, bms, audio, links] = await Promise.all([S.getBooks(), S.getSets(), DB.all('shelves'), DB.all('orders'), DB.all('bookmarks'), A.getAudiobooks(), DB.all('links')]);
  await ensureCoverIds(books, putQuiet('books'), hashBlob); await ensureCoverIds(audio, putQuiet('audiobooks'), hashBlob);
  const keyOf = new Map(books.map((b) => [b.id, S.bookSyncKey(b)]));
  const bookState = {};
  for (const b of books) bookState[keyOf.get(b.id)] = { title: b.title, addedAt: b.addedAt || 0, author: b.author, status: b.status, shelves: b.shelves || [], setId: b.setId || null, seriesIndex: b.seriesIndex ?? null, overrides: b.overrides || null, ...(b.ovAt ? { ovAt: b.ovAt } : {}), progress: b.progress || 0, cfi: b.cfi || null, lastOpened: b.lastOpened || 0, updatedAt: structAtOf(b), gAt: gAtsOf(b), posAt: posAtOf(b), dev: b.posDev || '', devName: b.posDevName || '', ...(b.pdfPage ? { pdfPage: b.pdfPage, pdfZoom: b.pdfZoom || 1, pdfText: !!b.pdfText } : {}), ...(b.finishedAt ? { finishedAt: b.finishedAt } : {}), ...(b.loanAt ? { loan: { b: b.borrowed ? 1 : 0, due: b.dueAt || null, src: b.loanSource || '', at: b.loanAt } } : {}) };   // untouched imports are 0 so another device's edits win
  const bookmarks = {};
  for (const bm of bms) { const k = keyOf.get(bm.bookId); if (k) (bookmarks[k] ||= []).push({ id: bm.id, cfi: bm.cfi, label: bm.label, progress: bm.progress, createdAt: bm.createdAt, updatedAt: bm.updatedAt || bm.createdAt }); }
  const mapOrderId = (id) => (id.startsWith('b:') ? 'b:' + (keyOf.get(id.slice(2)) || id.slice(2)) : id.startsWith('k:') ? 'b:' + id.slice(2) : id);   // k: = placeholder for a book not on this device yet
  const audioState = {};
  for (const a of audio) audioState[a.syncKey || a.id] = { title: a.title, author: a.author || '', addedAt: a.addedAt || 0, status: a.status, shelves: a.shelves || [], finishedAt: a.finishedAt || 0, speed: a.speed ?? null, position: a.position || 0, progress: a.progress || 0, track: a.track ?? null, trackIndex: a.trackIndex ?? null, lastOpened: a.lastOpened || 0, updatedAt: structAtOf(a), gAt: gAtsOf(a), posAt: posAtOf(a), dev: a.posDev || '', devName: a.posDevName || '' };
  const meta = {}; for (const b of books) { const e = localMeta(b); if (e) meta[keyOf.get(b.id)] = e; }
  const audioMeta = {}; for (const a of audio) { const e = localMeta(a); if (e) audioMeta[a.syncKey || a.id] = e; }
  const loans = {};   // Borrowed flag + due date, last-writer-wins on loanAt: 'book:<key>' / 'audio:<key>'
  for (const b of books) if (b.loanAt) loans['book:' + keyOf.get(b.id)] = { b: b.borrowed ? 1 : 0, due: b.dueAt || null, src: b.loanSource || '', at: b.loanAt };
  for (const a of audio) if (a.loanAt) loans['audio:' + (a.syncKey || a.id)] = { b: a.borrowed ? 1 : 0, due: a.dueAt || null, src: a.loanSource || '', at: a.loanAt };
  return { meta, audioMeta, audioState, v: 1, loans,
    links: links.map((x) => ({ id: x.id, bookKey: x.bookKey, audioKey: x.audioKey, state: x.state, by: x.by || 'user', score: x.score ?? null, bookTitle: x.bookTitle || '', audioTitle: x.audioTitle || '', createdAt: x.createdAt || 0, updatedAt: x.updatedAt || x.createdAt || 0 })),
    savedAt: Date.now(), settings: buildSettingsPart(),
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
  for (const st of Object.values(snap.audioState || {})) st.shelves = (st.shelves || []).map(m);
  snap.orders = snap.orders.map((o) => { const [kind, id] = [o.key.split(':')[0], o.key.slice(o.key.indexOf(':') + 1)]; return { ...o, key: kind === 'set' || kind === 'shelf' ? kind + ':' + m(id) : o.key, ids: o.ids.map((x) => (x.startsWith('s:') ? 's:' + m(x.slice(2)) : x)) }; });
  return snap;
}

/** One book / audiobook state from two devices. Structure (shelves, status, series…) is last-writer-wins on `updatedAt`, the reading position independently on
 *  `posAt`, and the per-book reading overrides key by key on `ovAt` — so reading on one device never hides a shelf change made on another. */
function mergeState(a, b, posFields) {
  if (!a || !b) { const x = structuredClone(a || b); return x; }
  const st = structuredClone((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
  st.gAt = {};   // each group of structure (status / shelves / series / name) is last-writer-wins on its own stamp
  for (const [g, d] of Object.entries(GROUPS)) { const w = stGroupAt(b, g) > stGroupAt(a, g) ? b : a; st.gAt[g] = Math.max(stGroupAt(a, g), stGroupAt(b, g)); for (const f of d.fields) { if (w[f] === undefined) delete st[f]; else st[f] = structuredClone(w[f]); } }
  st.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  const posA = posAtOfState(a), posB = posAtOfState(b);
  const pw = posB > posA ? b : a; if (pw !== ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a)) for (const f of posFields) { if (pw[f] === undefined) delete st[f]; else st[f] = structuredClone(pw[f]); }
  st.posAt = Math.max(posA, posB);
  if (a.overrides || b.overrides || a.ovAt || b.ovAt) {
    const at = (x, k) => x.ovAt?.[k] ?? x.updatedAt ?? 0, ov = {}, ovAt = {};
    for (const k of new Set([...Object.keys(a.overrides || {}), ...Object.keys(b.overrides || {}), ...Object.keys(a.ovAt || {}), ...Object.keys(b.ovAt || {})])) {
      const w = at(b, k) > at(a, k) ? b : a; ovAt[k] = Math.max(at(a, k), at(b, k)); if (w.overrides && w.overrides[k] != null) ov[k] = w.overrides[k];
    }
    st.overrides = Object.keys(ov).length ? ov : null; st.ovAt = ovAt;
  }
  return st;
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
  out.settings = mergeSettingsPart(L.settings, R.settings);
  out.shelves = mergeList('shelves', (x) => x.id, 'shelf');
  out.sets = mergeList('sets', (x) => x.id, 'set');
  out.orders = mergeList('orders', (x) => x.key);
  out.books = {}; const deadBooks = new Set();
  for (const k of new Set([...Object.keys(L.books), ...Object.keys(R.books)])) { const st = mergeState(L.books[k], R.books[k], POS_STATE); if (dead('book', k, Math.max(st.updatedAt || 0, st.addedAt || 0))) deadBooks.add(k); else out.books[k] = st; }   // deleted on some device → gone everywhere
  out.audioState = {}; for (const k of new Set([...Object.keys(L.audioState || {}), ...Object.keys(R.audioState || {})])) out.audioState[k] = mergeState((L.audioState || {})[k], (R.audioState || {})[k], AUDIO_POS_STATE);
  out.bookmarks = {};
  for (const k of new Set([...Object.keys(L.bookmarks), ...Object.keys(R.bookmarks)])) {
    const m = new Map(); for (const x of [...(L.bookmarks[k] || []), ...(R.bookmarks[k] || [])]) m.set(x.id, lww(m.get(x.id), x));
    out.bookmarks[k] = [...m.values()].filter((x) => !dead('bookmark', x.id, x.updatedAt || 0));
  }
  for (const k of deadBooks) delete out.bookmarks[k];
  out.orders = out.orders.map((o) => ({ ...o, ids: o.ids.filter((x) => !(x.startsWith('b:') && deadBooks.has(x.slice(2)))) }));
  const live = new Set([...out.shelves.map((x) => x.id), ...out.sets.map((x) => x.id)]);
  for (const st of Object.values(out.books)) { st.shelves = (st.shelves || []).filter((id) => live.has(id)); if (st.setId && !live.has(st.setId)) st.setId = null; }
  for (const st of Object.values(out.audioState)) st.shelves = (st.shelves || []).filter((id) => live.has(id));
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
  const doms = { library: true, positions: true, settings: true, ...(ctx.domains || {}) };
  if (doms.settings) applySettingsPart(m.settings, ctx);
  const keyToId = new Map(); const pending = {}; let appliedBooks = 0, deletedBooks = 0, posApplied = 0, posConflicts = 0;
  for (const b of books) {
    const key = S.bookSyncKey(b); keyToId.set(key, b.id); const st = m.books[key];
    if (!st) { if ((m.tombstones || []).some((t) => t.t === 'book' && t.id === key && t.at >= Math.max(structAtOf(b), b.addedAt || 0))) { await S.deleteBooks([b.id], { tomb: false, emit: false }); keyToId.delete(key); deletedBooks++; } continue; }   // deleted on another device
    const localAt = structAtOf(b); let dirty = false;
    if (doms.library && (ctx.force || (st.updatedAt || 0) > localAt || Object.keys(GROUPS).some((g) => stGroupAt(st, g) > gAtOf(b, g)))) {
      let did = false; b.gAt = { ...(b.gAt || {}) };
      for (const [g, d] of Object.entries(GROUPS)) {
        if (!(ctx.force || stGroupAt(st, g) > gAtOf(b, g))) continue; did = true;
        for (const f of d.fields) { if (f === 'title' || f === 'author') { if (st[f]) b[f] = st[f]; } else if (st[f] === undefined) delete b[f]; else b[f] = st[f]; }
        b.gAt[g] = stGroupAt(st, g);
      }
      for (const g of Object.keys(GROUPS)) b.gAt[g] ??= gAtOf(b, g);
      if (did) { b.structAt = Math.max(structAtOf(b), st.updatedAt || 0); b.updatedAt = b.structAt; dirty = true; appliedBooks++; }
    } else if (idmap.size) { b.setId = idmap.get(b.setId) || b.setId; b.shelves = (b.shelves || []).map((x) => idmap.get(x) || x); dirty = true; }
    if (doms.library && (ctx.force || !jeq(b.overrides || null, st.overrides || null))) { b.overrides = st.overrides || null; if (st.ovAt) b.ovAt = st.ovAt; dirty = true; }
    if (doms.positions && (st.posAt !== undefined || st.progress !== undefined)) { const r = applyPosition('book', b, st, ctx); if (r === 'applied' || r === 'same') { dirty = true; posApplied++; } else if (r === 'conflict') posConflicts++; }
    if (dirty) await DB.put('books', { ...b, _noTouch: true });
  }
  const audioRes = await applyAudioState(m, doms, ctx);
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
  return { appliedBooks, deletedBooks, posApplied: posApplied + audioRes.posApplied, posConflicts: posConflicts + audioRes.posConflicts, pending: Object.keys(pending).length, ...metaRes };
}

/** Audiobooks: status / shelves (structure) and listening position, same rules as books. Audiobooks not on this device yet are kept pending. */
async function applyAudioState(m, doms, ctx) {
  const audio = await A.getAudiobooks(), states = m.audioState || {}, have = new Set(); let posApplied = 0, posConflicts = 0;
  for (const a of audio) {
    const key = a.syncKey || a.id; have.add(key); const st = states[key]; if (!st) continue; let dirty = false;
    if (doms.library && (ctx.force || Object.keys(GROUPS).some((g) => stGroupAt(st, g) > gAtOf(a, g)))) {
      a.gAt = { ...(a.gAt || {}) };
      for (const g of ['status', 'shelves']) { if (!(ctx.force || stGroupAt(st, g) > gAtOf(a, g))) continue; for (const f of GROUPS[g].fields) { if (st[f] === undefined) delete a[f]; else a[f] = st[f]; } a.gAt[g] = stGroupAt(st, g); dirty = true; }
      for (const g of Object.keys(GROUPS)) a.gAt[g] ??= gAtOf(a, g); a.structAt = Math.max(structAtOf(a), st.updatedAt || 0);
    }
    if (doms.positions) { const r = applyPosition('audio', a, st, ctx); if (r === 'applied' || r === 'same') { dirty = true; posApplied++; } else if (r === 'conflict') posConflicts++; }
    if (dirty) await DB.put('audiobooks', { ...a, _noTouch: true });
  }
  let pend = {}; try { pend = JSON.parse(localStorage.getItem('folio.pendingAudio') || '{}'); } catch { /* ignore */ }
  for (const [k, st] of Object.entries(states)) if (!have.has(k) && (st.posAt || st.updatedAt || st.position)) pend[k] = { ...(pend[k] || {}), ...st };
  localStorage.setItem('folio.pendingAudio', JSON.stringify(pend));
  return { posApplied, posConflicts };
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

/* ---------- splitting a snapshot into the per-domain files, and joining them again ---------- */
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
const hashStr = (str) => { let h1 = 0x811c9dc5, h2 = 5381; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; } return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + str.length.toString(36); };
const bare = (p) => { const { savedAt, ...rest } = p || {}; return rest; };
export const hashPart = (p) => hashStr(stable(bare(p)));
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
const omit = (o, keys) => { const r = { ...o }; for (const k of keys) delete r[k]; return r; };
export function splitSnapshot(snap) {
  const books = {}, bpos = {}, audio = {}, apos = {};
  for (const [k, st] of Object.entries(snap.books)) { if (st.title !== undefined) books[k] = omit(st, POS_STATE); bpos[k] = pick(st, POS_STATE); }
  for (const [k, st] of Object.entries(snap.audioState || {})) { if (st.title !== undefined) audio[k] = omit(st, AUDIO_POS_STATE); apos[k] = pick(st, AUDIO_POS_STATE); }
  const { settings: _s, ...lib } = snap;
  return {
    library: { ...lib, books, audioState: audio, domain: 'library' },
    positions: { v: 1, domain: 'positions', savedAt: snap.savedAt, books: bpos, audio: apos },
    settings: { v: 1, domain: 'settings', savedAt: snap.savedAt, flat: snap.settings.flat, updatedAt: snap.settings.updatedAt },
  };
}
const EMPTY_LIB = () => ({ v: 1, shelves: [], sets: [], orders: [], books: {}, bookmarks: {}, tombstones: [], meta: {}, audioMeta: {}, links: [], loans: {}, audioState: {}, settings: { flat: {}, updatedAt: 0 } });
export function joinParts({ library, positions, settings }) {
  const out = { ...EMPTY_LIB(), ...(library || {}) }; out.books = { ...(out.books || {}) }; out.audioState = { ...(out.audioState || {}) };
  out.settings = settings ? { flat: settings.flat || {}, updatedAt: settings.updatedAt || 0 } : (library && library.settings) || { flat: {}, updatedAt: 0 };   // a v0.5.4 library file still carries the settings
  if (positions) {
    for (const [k, p] of Object.entries(positions.books || {})) out.books[k] = { ...(out.books[k] || {}), ...p };
    for (const [k, p] of Object.entries(positions.audio || {})) out.audioState[k] = { ...(out.audioState[k] || {}), ...p };
  }
  return out;
}

/* ---------- sync driver ---------- */
let syncing = false, dirtyTimer, dueAt = 0, hookInstalled = false, inflight = null, internalEmit = false, lastStart = 0, retryN = 0, retryTimer;
export const markDirty = () => localStorage.setItem('folio.sync.dirty', '1');
export const isDirty = () => localStorage.getItem('folio.sync.dirty') === '1';
/** Runs one sync. If one is already running, waits for it and then runs again so changes made meanwhile are never lost.
 *  opts.only limits it to some domains (e.g. ['positions'] when a book is opened). */
export async function syncNow({ quiet = false, only = null, force = false } = {}) {
  if (!isSignedIn()) return null;
  while (inflight) { try { await inflight; } catch { /* previous failure is reported by its own caller */ } }
  inflight = doSync(quiet, only, force);
  try { return await inflight; } finally { inflight = null; }
}
const DEVICE_NAME_KEY = 'folio.sync.devName';
async function touchDevices(files, st, force) {
  if (!force && Date.now() - (st.devAt || 0) < syncTuning.deviceEvery && localStorage.getItem(DEVICE_NAME_KEY) === deviceName()) return;
  let cur = { v: 1, domain: 'devices', devices: {} }; const f = files.get(FILES.devices);
  if (f) { try { cur = await readFile(f); } catch { /* start fresh */ } }
  cur.devices = cur.devices || {};
  cur.devices[deviceId()] = { name: deviceName(), platform: devicePlatform(), app: 'Folio Reader', version: APP_VERSION, lastSeen: Date.now(), lastSync: Date.now() };
  for (const [id, d] of Object.entries(cur.devices)) if (Date.now() - (d.lastSeen || 0) > 365 * 864e5) delete cur.devices[id];
  const nf = await writeFile(FILES.devices, f, cur); st.rev.devices = revOf(nf); st.devAt = Date.now(); localStorage.setItem(DEVICE_NAME_KEY, deviceName()); localStorage.setItem('folio.sync.devices', JSON.stringify(cur.devices));
}
/** Other devices that sync with this account (read from Drive; falls back to the last copy). */
export async function listDevices({ refresh = false } = {}) {
  if (refresh && isSignedIn() && navigator.onLine) { try { const files = await listSyncFiles(); const f = files.get(FILES.devices); if (f) { const d = await readFile(f); localStorage.setItem('folio.sync.devices', JSON.stringify(d.devices || {})); } } catch { /* offline */ } }
  const d = lsj('folio.sync.devices', {}); return Object.entries(d).map(([id, x]) => ({ id, ...x, me: id === deviceId() })).sort((a, b) => (b.me - a.me) || (b.lastSeen || 0) - (a.lastSeen || 0));
}
export async function forgetDevice(id) {
  if (id === deviceId()) return; const files = await listSyncFiles(); const f = files.get(FILES.devices); if (!f) return;
  const d = await readFile(f); delete (d.devices || {})[id]; await writeFile(FILES.devices, f, d); localStorage.setItem('folio.sync.devices', JSON.stringify(d.devices || {}));
}

async function doSync(quiet, only, force) {
  syncing = true; lastStart = Date.now(); setStatus('syncing', 'Syncing…');
  try {
    const doms = SYNC_DOMAINS.map((d) => d.id).filter((d) => domainEnabled(d) && (!only || only.includes(d)));
    const st = syncState(); const files = await listSyncFiles();
    const local = await buildSnapshot(); const lp = splitSnapshot(local);
    const mode = {};   // per domain: skip (nothing changed anywhere) | push (only this device changed) | merge (the file changed on Drive)
    for (const d of doms) { const f = files.get(FILES[d]); mode[d] = !f ? 'push' : force || revOf(f) !== st.rev[d] ? 'merge' : hashPart(lp[d]) !== st.hash[d] ? 'push' : 'skip'; }
    const res = { domains: mode, uploaded: [], downloaded: [] };
    if (doms.every((d) => mode[d] === 'skip')) { finishOk(st, res, files, only); return res; }
    const read = {}; await Promise.all(doms.filter((d) => mode[d] === 'merge' && files.get(FILES[d])).map(async (d) => { read[d] = await readFile(files.get(FILES[d])); res.downloaded.push(d); }));
    const remote = joinParts({ library: read.library, positions: read.positions, settings: read.settings });
    const merged = mergeSnapshots(local, remote);
    let covers = null; if (doms.includes('library') && mode.library !== 'skip') { try { covers = await listCoverFiles(); } catch { /* covers are best-effort: metadata still syncs */ } }
    const getCover = async (cid) => { const f = covers?.get(`cover-${cid}.jpg`); if (!f) return null; try { return await (await drive(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { retries: 1 })).blob(); } catch { return null; } };
    Object.assign(res, await applySnapshot(merged, { getCover, sync: true, domains: { library: mode.library === 'merge', positions: mode.positions === 'merge' || (mode.library === 'merge' && domainEnabled('positions') && !files.get(FILES.positions)), settings: mode.settings === 'merge' || (mode.library === 'merge' && domainEnabled('settings') && !files.get(FILES.settings) && !!read.library?.settings) } }));   // a v0.5.4 library file still holds positions + settings
    const finalSnap = await buildSnapshot();   // re-read so ids/timestamps are consistent
    const toPush = mergeSnapshots(finalSnap, merged); const pp = splitSnapshot(toPush), fp = splitSnapshot(finalSnap);
    if (covers) {
      const blobs = await localCoverBlobs(); let up = 0, failed = 0;
      for (const cid of coverIdsIn(toPush)) { const name = `cover-${cid}.jpg`; if (covers.has(name) || !blobs.has(cid)) continue; try { covers.set(name, await uploadCover(cid, blobs.get(cid))); up++; } catch { failed++; /* retried next sync */ } }
      res.coversUploaded = up; if (failed) res.coverRetry = true;
    }
    for (const d of doms) {
      if (mode[d] === 'skip') continue;
      const f = files.get(FILES[d]); const same = read[d] && stable(bare(pp[d])) === stable(bare(read[d]));
      if (same) st.rev[d] = revOf(f); else { const nf = await writeFile(FILES[d], f, pp[d]); st.rev[d] = revOf(nf); res.uploaded.push(d); }
      st.hash[d] = (d === 'library' && res.coverRetry) ? 'retry-covers' : hashPart(fp[d]);
    }
    if (covers) {   // garbage-collect covers nothing references any more (never ones younger than an hour: another device may be mid-sync)
      const keep = coverIdsIn(toPush); let gc = 0;
      for (const [name, f] of covers) { const m = /^cover-([0-9a-f]+)\.jpg$/.exec(name); if (!m || keep.has(m[1])) continue; if (Date.now() - Date.parse(f.createdTime || 0) < COVER_GC_AGE) continue; try { await drive(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); gc++; } catch { /* ignore */ } }
      res.coversDeleted = gc;
    }
    markSynced('book', await S.getBooks()); markSynced('audio', await A.getAudiobooks());
    try { await touchDevices(files, st, force); } catch { /* the devices list is a nicety */ }
    finishOk(st, res, files, only);
    internalEmit = true; try { S.emitChange(); } finally { internalEmit = false; }   // refresh UI without re-triggering sync
    return res;
  } catch (e) {
    retryAfterError(e);
    if (!quiet) throw e; return null;
  } finally { syncing = false; }
}
function finishOk(st, res, files, only) {
  saveSyncState(st); retryN = 0; clearTimeout(retryTimer);
  if (!only) { status.lastSync = Date.now(); localStorage.setItem('folio.lastSync', String(status.lastSync)); localStorage.removeItem('folio.sync.dirty'); }
  status.last = { at: Date.now(), uploaded: res.uploaded, downloaded: res.downloaded, conflicts: res.posConflicts || 0 }; localStorage.setItem('folio.sync.last', JSON.stringify(status.last));
  setStatus('connected', 'Synced');
}
/** Offline / rate-limited / server trouble: keep the changes (they are in the local database and the dirty flag), and try again later with backoff. */
function retryAfterError(e) {
  if (status.state === 'needs-reauth') return;
  const offline = !navigator.onLine || e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
  if (offline || isTransient(e)) {
    markDirty(); const wait = e.retryAfter ? Math.min(e.retryAfter * 1000, 600000) : Math.min(600000, 15000 * 2 ** retryN); retryN++;
    clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (isSignedIn() && navigator.onLine) syncNow({ quiet: true }); }, wait);
    setStatus(offline ? 'offline' : 'error', offline ? 'Offline — your changes are saved here and will sync when you’re back online' : (e.status === 429 || e.rate ? 'Google Drive is rate-limiting — will retry in ' + Math.round(wait / 1000) + ' s' : 'Sync problem (' + (e.message || e) + ') — will retry in ' + Math.round(wait / 1000) + ' s'));
  } else setStatus('error', e.message || String(e));
}
/** Debounced + throttled: a burst of changes becomes one sync; continuous reading syncs at most every syncTuning.minGap. */
export function scheduleSync(ms = 5000) {
  if (!isSignedIn()) return; markDirty();
  const at = Date.now() + Math.max(ms, lastStart + syncTuning.minGap - Date.now());
  if (dirtyTimer && dueAt <= at) return;   // already waiting for an earlier slot: don't push it back (that would starve a long reading session)
  clearTimeout(dirtyTimer); dueAt = at; dirtyTimer = setTimeout(() => { dirtyTimer = null; dueAt = 0; syncNow({ quiet: true }); }, at - Date.now());
}
export function initSync() {
  if (hookInstalled) return; hookInstalled = true;
  if (isSignedIn()) { setStatus('connected', status.lastSync ? 'Last synced ' + new Date(status.lastSync).toLocaleString() : ''); const a = load(); if (a.exp > Date.now()) scheduleRenew(a.exp); }
  onLibraryChange(() => { if (!internalEmit) scheduleSync(); });
  settings.onChange((p) => { if (Object.keys(p).some((k) => !['chip', 'audioChip', 'flowChosen'].includes(k))) scheduleSync(); });
  window.addEventListener('folio-position', () => scheduleSync(8000));
  document.addEventListener('visibilitychange', () => {
    if (!isSignedIn()) return;
    if (document.hidden) { if (isDirty()) { clearTimeout(dirtyTimer); dirtyTimer = null; dueAt = 0; syncNow({ quiet: true }); } }   // flush before the app goes to the background
    else if (navigator.onLine && Date.now() - lastStart > syncTuning.foregroundGap) syncNow({ quiet: true });
  });
  window.addEventListener('online', () => { if (isSignedIn()) { retryN = 0; syncNow({ quiet: true }); } });
  window.addEventListener('offline', () => { if (isSignedIn() && isDirty()) setStatus('offline', 'Offline — your changes are saved here and will sync when you’re back online'); });
  if (isSignedIn() && navigator.onLine) setTimeout(() => syncNow({ quiet: true }), 1500);
}

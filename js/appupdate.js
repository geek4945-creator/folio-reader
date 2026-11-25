// "App updates" (Android app). v0.5.26: the section ALWAYS shows in the APK, near the top of Settings.
//  * Native AppUpdater plugin (window.Capacitor.Plugins.AppUpdater): checks GitHub's latest release, downloads quietly in the background,
//    a tap opens Android's installer (Android always asks you to confirm an install — no app can skip that).
//  * Plugin missing (older or unusual build): checks GitHub's API from the page and "Install update" opens the latest APK link in the browser.
//  * Once a day on open (plus "Check for updates"): a small "Update X ready — tap to install" banner, never shown while a book is open.
import { h, toast } from './util.js';
import { APP_VERSION } from './device.js';
import { isNativeApp, nativePlugin } from './native.js';

const REPO = 'geek4945-creator/folio-reader', ASSET = '^folio-reader.*\\.apk$';
export const LATEST_APK = 'https://github.com/' + REPO + '/releases/latest/download/folio-reader.apk';
const DAY = 24 * 3600 * 1000, K_LAST = 'folio.updcheck', K_AVAIL = 'folio.updavail';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* full */ } }, del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } } };

export const isAndroidApp = () => isNativeApp();
const plugin = () => nativePlugin('AppUpdater');

const parse = (v) => String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
export function isNewer(remote, local) { const a = parse(remote), b = parse(local); for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; } return false; }

let state = { current: APP_VERSION, avail: null, downloaded: false }, banner = null, hiddenFor = null;
async function installedVersion() { const P = plugin(); if (P && P.info) { try { const i = await P.info(); if (i && i.versionName) state.current = i.versionName; } catch { /* keep web version */ } } return state.current; }

/** Ask GitHub for the latest release. Returns { available, version, current, apkUrl, size }. */
export async function checkNow() {
  const P = plugin(); let r;
  if (P && P.check) r = await P.check({ repo: REPO, asset: ASSET });
  else {
    const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) throw new Error('Couldn’t reach GitHub (' + res.status + ').');
    const j = await res.json(); const cur = await installedVersion(); const a = (j.assets || []).find((x) => /^folio-reader.*\.apk$/.test(x.name));
    r = { available: isNewer(j.tag_name, cur), version: String(j.tag_name || '').replace(/^v/i, ''), current: cur, apkUrl: (a && a.browser_download_url) || LATEST_APK, size: a ? a.size : -1 };
  }
  ls.set(K_LAST, String(Date.now()));
  if (r.current) state.current = r.current;
  if (r.available) { state.avail = r; ls.set(K_AVAIL, r.version); } else { state.avail = null; ls.del(K_AVAIL); hideBanner(); }
  return r;
}

/** Tap on Install: native → download (if not already) + open the installer; no plugin → open the APK link in the browser. */
export async function installNow(onMsg = () => {}) {
  const P = plugin(), u = state.avail;
  if (!P || !P.install || !u) { openApkLink(); onMsg('The download opened in your browser. Open the file, then tap Update (Android asks you to confirm).'); return 'browser'; }
  onMsg(state.downloaded ? 'Opening the installer…' : 'Downloading ' + u.version + '…');
  await P.install({ apkUrl: u.apkUrl, size: u.size, version: u.version });
  onMsg('Confirm in the Android installer (tap Update). Your books and settings are kept.');
  return 'installer';
}
export function openApkLink() {
  // In the APK, navigating to an outside https link hands it to the browser (Capacitor); on a computer it simply downloads.
  const a = document.createElement('a'); a.href = LATEST_APK; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
}

const reading = () => document.body.classList.contains('reading');
function showBanner() {
  const u = state.avail; if (!u || reading() || hiddenFor === u.version) return;
  if (banner && banner.isConnected) return;
  banner = h('div', { id: 'appupd-banner', role: 'status' },
    h('button', { class: 'btn primary', id: 'appupd-install', onclick: () => { hideBanner(); installNow((m) => toast(m, 6000)).catch((e) => toast((e && e.message) || 'The update didn’t finish. Try Settings → App updates.', 6000)); } }, 'Update ' + u.version + ' ready — tap to install'),
    h('button', { class: 'btn', id: 'appupd-later', 'aria-label': 'Later', onclick: () => { hiddenFor = u.version; hideBanner(); } }, '✕'));
  document.body.append(banner);
}
function hideBanner() { if (banner) { banner.remove(); banner = null; } }

/** Once a day, quietly, after the app opens. */
export function initAppUpdate() {
  if (!isAndroidApp()) return;
  window.addEventListener('reader-opened', hideBanner);
  window.addEventListener('reader-closed', () => setTimeout(showBanner, 800));
  setTimeout(async () => {
    try {
      if (Date.now() - Number(ls.get(K_LAST) || 0) < DAY) { const v = ls.get(K_AVAIL); if (v && isNewer(v, await installedVersion())) { state.avail = { version: v, apkUrl: LATEST_APK, size: -1, available: true }; showBanner(); } return; }
      const r = await checkNow(); if (!r.available) return;
      const P = plugin();
      if (P && P.install) P.install({ apkUrl: r.apkUrl, size: r.size, version: r.version, downloadOnly: true }).then(() => { state.downloaded = true; }).catch(() => {});
      showBanner();
    } catch { /* offline or rate-limited: try again next open */ }
  }, 3000);
}

export function appUpdateSection() {
  if (!isAndroidApp()) return null;
  const P = plugin();
  let busy = false;
  const ver = h('p', { id: 'upd-version' }, 'Installed version ' + state.current);
  installedVersion().then((v) => { ver.textContent = 'Installed version ' + v; });
  const status = h('p', { class: 'muted small', id: 'upd-status' }, state.avail ? 'Update ' + state.avail.version + ' is ready.' : 'Folio checks for updates once a day when you open it. Your books and settings are kept.');
  const check = h('button', { class: 'btn', id: 'upd-check' }, 'Check for updates');
  const inst = h('button', { class: 'btn primary', id: 'upd-install', disabled: !!P && !state.avail }, state.avail ? 'Install update ' + state.avail.version : 'Install update');
  if (P) { try { P.addListener && P.addListener('progress', (e) => { if (busy) status.textContent = 'Downloading… ' + e.percent + '%'; }); } catch { /* ignore */ } }
  const set = (b, msg) => { busy = b; check.disabled = b; inst.disabled = b || (!!P && !state.avail); if (msg) status.textContent = msg; };
  check.addEventListener('click', async () => {
    if (busy) return; set(true, 'Checking GitHub…');
    try { const r = await checkNow(); set(false, r.available ? 'Update ' + r.version + ' is available (you have ' + r.current + ').' : 'You’re up to date (' + r.current + ').'); inst.textContent = r.available ? 'Install update ' + r.version : 'Install update'; inst.disabled = !!P && !r.available; }
    catch (e) { set(false, ((e && e.message) || 'Couldn’t check for updates.') + (P ? '' : ' You can still tap Install update to download the newest version.')); }
  });
  inst.addEventListener('click', async () => {
    if (busy) return; set(true);
    try { await installNow((m) => { status.textContent = m; }); } catch (e) { status.textContent = (e && e.message) || 'The update didn’t finish. Tap to try again.'; }
    set(false);
  });
  return h('section', { class: 'pad card-sec', id: 'sec-appupdate' }, h('h3', null, 'App updates'), ver, status,
    h('div', { class: 'row-actions' }, check, inst),
    h('p', { class: 'muted small' }, 'Android always asks you to confirm an install — tap Update on its screen. ' + (P ? '' : 'This copy of the app opens the download in your browser instead.')));
}

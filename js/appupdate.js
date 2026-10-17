// "App updates" (Android app only): checks this repo's latest GitHub release through the native AppUpdater plugin,
// downloads the APK and opens Android's installer. In a normal browser / installed PWA the section does not render.
import { h, toast } from './util.js';

const REPO = 'geek4945-creator/folio-reader', ASSET = '^folio-reader.*\\.apk$';
const DAY = 24 * 3600 * 1000, K_LAST = 'folio.updcheck', K_AVAIL = 'folio.updavail';

export const isAndroidApp = () => { try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && typeof window.Capacitor.registerPlugin === 'function'); } catch { return false; } };
const plugin = () => window.Capacitor.registerPlugin('AppUpdater');

/** Once a day, silently, when the app opens: remember a newer release and tell the user where to tap. */
export function initAppUpdate() {
  if (!isAndroidApp()) return;
  setTimeout(async () => {
    try {
      if (Date.now() - Number(localStorage.getItem(K_LAST) || 0) < DAY) return;
      const r = await plugin().check({ repo: REPO, asset: ASSET });
      localStorage.setItem(K_LAST, String(Date.now()));
      if (r.available) { localStorage.setItem(K_AVAIL, r.version); toast('Update ' + r.version + ' available: Settings → App updates', 6000); } else localStorage.removeItem(K_AVAIL);
    } catch { /* offline or rate-limited: try again next open */ }
  }, 3000);
}

export function appUpdateSection() {
  if (!isAndroidApp()) return null;
  const P = plugin();
  let busy = false, pending = null;
  const status = h('p', { class: 'muted small', id: 'upd-status' }, 'Checks the latest release on GitHub (also once a day when you open the app). Your books and settings are kept.');
  const btn = h('button', { class: 'btn', id: 'upd-btn' }, 'Check for updates');
  P.info().then((i) => { status.textContent = 'Installed version ' + i.versionName + '. ' + status.textContent; }).catch(() => {});
  try { P.addListener('progress', (e) => { if (busy && pending) status.textContent = 'Downloading ' + pending.version + '… ' + e.percent + '%'; }); } catch { /* ignore */ }
  const set = (b, label, msg) => { busy = b; btn.disabled = b; if (label) btn.textContent = label; if (msg) status.textContent = msg; };
  async function install() {
    set(true, 'Downloading…', 'Downloading ' + pending.version + '…');
    try {
      await P.install({ apkUrl: pending.apkUrl, size: pending.size, version: pending.version });
      set(false, 'Install update ' + pending.version, 'Confirm in the Android installer. If it didn’t open, tap again.');
    } catch (e) { set(false, 'Install update ' + pending.version, (e && e.message) || 'The update didn’t finish. Tap to try again.'); }
  }
  btn.addEventListener('click', async () => {
    if (busy) return;
    if (pending) return install();
    set(true, 'Checking…', 'Checking GitHub…');
    try {
      const r = await P.check({ repo: REPO, asset: ASSET });
      localStorage.setItem(K_LAST, String(Date.now()));
      if (r.available) { pending = r; localStorage.setItem(K_AVAIL, r.version); set(false, 'Download & install ' + r.version, 'Update ' + r.version + ' is available (you have ' + r.current + ').'); }
      else { localStorage.removeItem(K_AVAIL); set(false, 'Check for updates', 'You’re up to date (' + r.current + ').'); }
    } catch (e) { set(false, 'Check for updates', (e && e.message) || 'Couldn’t check for updates.'); }
  });
  return h('section', { class: 'pad card-sec', id: 'sec-appupdate' }, h('h3', null, 'App updates'), status, btn);
}

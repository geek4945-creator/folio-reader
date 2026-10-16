// "Add to Home Screen" (iPhone/iPad Safari) / "Install app" (Android Chrome & desktop via beforeinstallprompt) + dismissible first-visit banner.
import { h, sheet, toast, $ } from './util.js';
import { isIOS, isIOSSafari, isInAppBrowser, isInstalledApp, isAndroid } from './env.js';

const DISMISS_KEY = 'folio.a2hsDismissed';
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; refreshInstallUI(); });
window.addEventListener('appinstalled', () => { deferred = null; refreshInstallUI(); toast('Folio installed'); });
export const _setDeferredForTest = (e) => { deferred = e; refreshInstallUI(); };

/** 'ios' | 'prompt' | null — what kind of install helper applies right now. */
export function installMode() {
  if (isInstalledApp()) return null;
  if (isIOS()) return 'ios';
  if (deferred) return 'prompt';
  return null;
}
export const installLabel = () => (installMode() === 'ios' ? 'Add to iPhone Home Screen' : 'Install app');

export async function startInstall() {
  const m = installMode();
  if (m === 'prompt' && deferred) {
    const d = deferred; deferred = null; refreshInstallUI();
    try { d.prompt(); const r = await d.userChoice; if (r && r.outcome === 'accepted') toast('Installing Folio…'); } catch { openInstallGuide(); }
    return;
  }
  openInstallGuide();
}

/* ---------- inline SVG illustrations ---------- */
const svg = (inner, w = 44, hgt = 44) => { const d = document.createElement('div'); d.className = 'a2hs-ill'; d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 44 44" role="img" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`; return d; };
export const ICON_SHARE = () => svg('<path d="M14 19h-3a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h22a2 2 0 0 0 2-2V21a2 2 0 0 0-2-2h-3"/><path d="M22 27V6"/><path d="M15 12.5 22 6l7 6.5"/>');
export const ICON_ADD_HOME = () => svg('<rect x="7" y="7" width="30" height="30" rx="7"/><path d="M22 14v16M14 22h16"/>');
export const ICON_SAFARI = () => svg('<circle cx="22" cy="22" r="15"/><path d="m28 16-4 8-8 4 4-8z" fill="currentColor"/>');
export const ICON_HOME = () => svg('<rect x="5" y="5" width="34" height="34" rx="8" opacity=".35"/><rect x="11" y="11" width="9" height="9" rx="2.5" fill="currentColor"/><rect x="24" y="11" width="9" height="9" rx="2.5" opacity=".5"/><rect x="11" y="24" width="9" height="9" rx="2.5" opacity=".5"/><rect x="24" y="24" width="9" height="9" rx="2.5" fill="var(--accent)" stroke="none"/>');
export const ICON_MORE = () => svg('<circle cx="10" cy="22" r="2.2" fill="currentColor"/><circle cx="22" cy="22" r="2.2" fill="currentColor"/><circle cx="34" cy="22" r="2.2" fill="currentColor"/>');
export const ICON_INSTALL = () => svg('<rect x="9" y="6" width="26" height="32" rx="5"/><path d="M22 14v13M16.5 22l5.5 6 5.5-6"/>');

/* ---------- guide ---------- */
export function openInstallGuide() {
  const ios = isIOS(); const andr = isAndroid();
  return sheet(ios ? 'Add Folio to your Home Screen' : 'Install Folio', (close) => {
    const step = (ill, n, title, body) => h('li', { class: 'a2hs-step' }, ill, h('div', null, h('strong', null, `${n}. ${title}`), body ? h('p', { class: 'muted small' }, body) : null));
    if (ios) return [
      h('p', { class: 'muted' }, 'Folio runs as a web app. Adding it to your Home Screen gives it an app icon and opens it full screen, like any other app.'),
      isInAppBrowser() ? h('div', { class: 'plib-warn small', id: 'a2hs-inapp' }, h('strong', null, 'You’re in an in-app browser. '), 'Gmail, Messenger, Instagram and similar apps can’t add to the Home Screen. Copy the link below, open ', h('strong', null, 'Safari'), ' and paste it there.') : null,
      h('div', { class: 'plib-warn small' }, h('strong', null, 'Use Safari. '), 'This only works in Safari, not in in-app browsers like Gmail or Messenger.'),
      h('div', { class: 'row-actions' }, h('input', { class: 'field', readonly: true, id: 'a2hs-url', value: location.origin + location.pathname.replace(/index\.html$/, ''), onclick: (e) => e.target.select() }),
        h('button', { class: 'btn', id: 'a2hs-copy', onclick: async () => { try { await navigator.clipboard.writeText($('#a2hs-url').value); toast('Link copied'); } catch { $('#a2hs-url').select(); toast('Press and hold the link to copy'); } } }, 'Copy link')),
      h('ol', { class: 'a2hs-steps', id: 'a2hs-steps' },
        step(ICON_SAFARI(), 1, 'Open this page in Safari', 'Not Gmail, Messenger or another in-app browser. Use the link above if you need to.'),
        step(ICON_SHARE(), 2, 'Tap the Share button', 'It’s the square with an arrow pointing up, at the bottom of Safari (or the top right on iPad). On newer iOS, tap the ⋯ button first if you don’t see it.'),
        step(ICON_ADD_HOME(), 3, 'Scroll down and tap “Add to Home Screen”', 'You may need to scroll the share sheet. If you don’t see the option, tap Edit Actions or More.'),
        step(ICON_MORE(), 4, 'Tap “Add”', 'You can rename it first. Tap Add in the top right corner.'),
        step(ICON_HOME(), 5, 'Open Folio from your Home Screen', 'The Folio icon now sits on your Home Screen and opens full screen, with no browser bars. Your books stay on this device.')),
      h('p', { class: 'muted small' }, 'Tip: add it from the same Safari you normally use, and open Folio from the new icon afterwards. Books you imported in Safari live in Safari’s storage, so import books again from the Home Screen app, or sign in with Google to sync your library settings.'),
    ];
    return [
      h('p', { class: 'muted' }, 'Install Folio for an app icon, full-screen reading and offline use.'),
      deferred ? h('button', { class: 'btn primary block', id: 'a2hs-install-now', onclick: () => { close(); startInstall(); } }, 'Install now') : null,
      h('ol', { class: 'a2hs-steps', id: 'a2hs-steps' },
        step(ICON_MORE(), 1, 'Open your browser menu', andr ? 'In Chrome, tap the ⋮ menu at the top right.' : 'In Chrome or Edge, use the menu or the install icon in the address bar.'),
        step(ICON_INSTALL(), 2, 'Tap “Install app” or “Add to Home screen”', null),
        step(ICON_HOME(), 3, 'Open Folio from your app list', 'It opens full screen with its own icon.')),
      andr ? h('p', { class: 'small' }, 'Prefer a regular app file? ', h('a', { href: 'https://github.com/geek4945-creator/folio-reader/releases/latest/download/folio-reader.apk', target: '_blank', rel: 'noopener noreferrer' }, 'Download the Android APK'), ' (allow “install unknown apps” when asked).') : null,
    ];
  }, { tall: true, closeLabel: 'Done' });
}

/* ---------- banner (first visit, iOS Safari, not standalone) ---------- */
let banner = null;
export function bannerEligible() { return isIOSSafari() && !isInstalledApp() && !localStorage.getItem(DISMISS_KEY); }
function showBanner() {
  if (banner || !bannerEligible()) return;
  banner = h('div', { id: 'a2hs-banner', class: 'a2hs-banner', role: 'region', 'aria-label': 'Add to Home Screen' },
    ICON_SHARE(), h('div', { class: 'grow' }, h('strong', null, 'Add Folio to your Home Screen'), h('div', { class: 'small' }, 'Opens full screen like an app.')),
    h('button', { class: 'btn small', id: 'a2hs-banner-how', onclick: () => openInstallGuide() }, 'How'),
    h('button', { class: 'btn-icon', id: 'a2hs-banner-x', 'aria-label': 'Dismiss', onclick: () => { localStorage.setItem(DISMISS_KEY, '1'); banner.remove(); banner = null; } }, '✕'));
  document.body.append(banner);
}
export function refreshInstallUI() {
  document.querySelectorAll('[data-install-btn]').forEach((b) => { const m = installMode(); b.hidden = !m; if (m) b.textContent = b.dataset.prefix ? b.dataset.prefix + installLabel() : installLabel(); });
  if (banner && !bannerEligible()) { banner.remove(); banner = null; }
}
export function initInstall() { showBanner(); refreshInstallUI(); }

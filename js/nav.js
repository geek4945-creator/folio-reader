// Back button (v0.5.2). One stack of "things to close", in order: the topmost sheet / dialog / guide → the reader (EPUB / PDF / loading screen; progress is saved by closeReader)
// → the full-screen audio player → a tab's own sub-view (select mode, a set page, a catalog feed) → the previous tab (Library is the root) → exit.
//   Android app (Capacitor): @capacitor/app `backButton` listener drives it; at the root a confirm "Exit <app>?" (Cancel / Exit → App.exitApp()).
//   Browser / installed PWA: one extra history entry (pushState) always sits "ahead" so the browser / OS back lands here first; at the root the first press shows
//   "Press back again to exit" and a second press within 2 s lets history proceed (never a loop; re-armed afterwards).
import { closeTopSheet, confirmDlg, toast, $ } from './util.js';
import { isCapacitor } from './env.js';
import { currentReader, closeReader } from './reader.js';
import { playerOpen, closePlayer } from './audioplayer.js';

const tabBack = {};            // tab → () => boolean (true when it closed something inside the tab)
export function registerBack(tab, fn) { tabBack[tab] = fn; }
let api = null, tabs = [], backing = false, exitAsk = false, lastRootBack = 0;
export const EXIT_WINDOW_MS = 2000;
export const appName = () => (document.title || 'Folio Reader').replace(/\s*[|–—-]\s.*$/, '').trim() || 'Folio Reader';

/** The tab history (visited tabs, most recent last). */
export function noteTab(t) { if (backing) return; if (tabs[tabs.length - 1] !== t) tabs.push(t); if (tabs.length > 30) tabs.shift(); }
export const tabHistory = () => tabs.slice();

/** Close the topmost thing. Returns what it was ('sheet' | 'reader' | 'player' | 'tab' | 'tab-switch') or null at the root. */
export async function goBack() {
  if (closeTopSheet()) return 'sheet';
  const ov = $('#overlay'); if (ov && !ov.hidden && ov.children.length) { ov.replaceChildren(); ov.hidden = true; return 'sheet'; }
  const rd = $('#reader');
  if (currentReader() || (rd && !rd.hidden)) { await closeReader(); return 'reader'; }
  if (playerOpen()) { closePlayer(); return 'player'; }
  const cur = api.getTab();
  if (tabBack[cur] && tabBack[cur]()) return 'tab';
  backing = true;
  try {
    while (tabs.length && tabs[tabs.length - 1] === cur) tabs.pop();
    const prev = tabs.length ? tabs[tabs.length - 1] : (cur !== 'library' ? 'library' : null);
    if (prev) { await api.show(prev); return 'tab-switch'; }
  } finally { backing = false; }
  if (!tabs.length) tabs.push(cur);
  return null;
}

function native() { const P = window.Capacitor && window.Capacitor.Plugins; return P && P.App; }

async function rootBack() {
  if (isCapacitor()) {
    if (exitAsk) return; exitAsk = true;
    try { if (await confirmDlg('Exit ' + appName() + '?', 'Your place in every book is saved.', 'Exit')) { const A = native(); if (A && A.exitApp) A.exitApp(); else history.back(); } }
    finally { exitAsk = false; }
    return 'confirm';
  }
  const now = Date.now();
  if (now - lastRootBack < EXIT_WINDOW_MS) { lastRootBack = 0; return 'exit'; }
  lastRootBack = now; toast('Press back again to exit', EXIT_WINDOW_MS); return 'toast';
}

const GUARD = 'folioGuard', ROOT = 'folioRoot';
const arm = () => { try { history.pushState({ [GUARD]: 1 }, ''); } catch { /* ignore */ } };

/** A back press (browser popstate or the Android button). */
export async function onBack() {
  const r = await goBack(); if (r) return r;
  return rootBack();
}

export function initNav(a) {
  api = a; tabs = [a.getTab()];
  const A = native();
  if (isCapacitor() && A && A.addListener) {   // the Capacitor App plugin owns the hardware back button (no history entries needed)
    A.addListener('backButton', () => { onBack(); });
    window.__folioBack = onBack; return;
  }
  const st = history.state || {};
  if (!st[GUARD]) { try { if (!st[ROOT]) history.replaceState({ ...st, [ROOT]: 1 }, ''); } catch { /* ignore */ } arm(); }   // on a reload we are already on the guard entry
  window.addEventListener('popstate', async (e) => {
    if (e.state && e.state[GUARD]) return;          // forward onto the guard: nothing to do
    const r = await onBack();
    if (r === 'exit') { try { history.back(); } catch { /* ignore */ } setTimeout(arm, 700); return; }   // let history proceed (leaves the app / site); re-arm if we are still here
    arm();
  });
  window.__folioBack = onBack;
}

// v0.5.16 non-disruptive app updates. A new version is downloaded in the background by the service worker and WAITS. It is never swapped in while a book is open:
//  * a small "Update ready — tap to refresh" banner appears (not while reading);
//  * it is applied automatically when you close the book (and nothing is playing), or at launch before you start doing anything;
//  * before any reload the reading position is saved exactly, and a book that was open is re-opened at that position afterwards.
// Failed lazy module loads (a half-published deploy) show a "tap to reload" message instead of breaking silently.
import { h, toast } from './util.js';

const REOPEN = 'folio.reopen', TRIED = 'folio.updTried';
let waiting = null, applying = false, banner = null, hooks = { readerOpen: () => false, flush: async () => {}, reopen: () => {} };
const audioBusy = () => { try { return !!(window.__audio && window.__audio.el && !window.__audio.el.paused); } catch { return false; } };
const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }, del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } } };
export const updateWaiting = () => !!waiting;

function showBanner() {
  if (!waiting || applying) return;
  if (hooks.readerOpen()) { hideBanner(); return; }
  if (banner && banner.isConnected) return;
  banner = h('div', { id: 'update-banner', role: 'status' }, h('span', null, 'Update ready'), h('button', { class: 'btn primary', id: 'update-apply', onclick: () => applyUpdate('tap') }, 'Tap to refresh'),
    h('button', { class: 'btn', id: 'update-later', 'aria-label': 'Later', onclick: hideBanner }, '✕'));
  document.body.append(banner);
}
function hideBanner() { if (banner) { banner.remove(); banner = null; } }

/** Save the exact reading position, remember which book is open, then let the waiting worker take over and reload. */
export async function applyUpdate(why = 'tap') {
  if (!waiting || applying) return false;
  applying = true; hideBanner();
  try { await hooks.flush(); } catch { /* ignore */ }
  try { window.__audio && window.__audio.save && window.__audio.save(); } catch { /* ignore */ }
  const r = hooks.readerOpen(); if (r) ss.set(REOPEN, JSON.stringify({ id: r, at: Date.now() }));
  ss.set(TRIED, String(Date.now()));
  try { waiting.postMessage({ type: 'SKIP_WAITING' }); } catch { /* ignore */ }
  setTimeout(() => location.reload(), 2500);   // safety net if controllerchange never arrives
  return true;
}
function found(w) { waiting = w; showBanner(); }

export function initUpdates(h2) {
  hooks = { ...hooks, ...h2 };
  // a book that was open when the page was refreshed for an update comes back at its saved position
  const pend = ss.get(REOPEN); if (pend) { ss.del(REOPEN); try { const o = JSON.parse(pend); if (o && o.id && Date.now() - o.at < 60000) setTimeout(() => hooks.reopen(o.id), 300); } catch { /* ignore */ } }
  window.addEventListener('reader-closed', () => { if (waiting && !audioBusy()) setTimeout(() => { if (waiting && !hooks.readerOpen() && !audioBusy()) applyUpdate('closed'); }, 500); else showBanner(); });
  window.addEventListener('reader-opened', hideBanner);
  // lazy modules that fail to load (half-published deploy / flaky network): say so, never reload by ourselves
  window.addEventListener('unhandledrejection', (e) => {
    const m = String((e.reason && (e.reason.message || e.reason)) || '');
    if (/dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(m)) {
      e.preventDefault();
      toast('Part of the app didn’t load — it may be updating.', 12000, { label: 'Reload', onClick: async () => { try { await hooks.flush(); } catch { /* ignore */ } const r = hooks.readerOpen(); if (r) ss.set(REOPEN, JSON.stringify({ id: r, at: Date.now() })); location.reload(); } });
    }
  });
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying) location.reload(); });   // only when WE asked for it: never a surprise reload
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    const watch = (w) => { if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) found(w); }); };
    if (reg.waiting && navigator.serviceWorker.controller) {
      found(reg.waiting);
      // launched with an update already downloaded (and nothing started yet): take it now, once, instead of waiting for the next session
      const last = +ss.get(TRIED) || 0;
      if (!hooks.readerOpen() && Date.now() - last > 60000) setTimeout(() => { if (waiting && !hooks.readerOpen() && !audioBusy()) applyUpdate('launch'); }, 1200);
    }
    watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
    const check = () => { if (!document.hidden) reg.update().catch(() => {}); };
    check(); document.addEventListener('visibilitychange', check); setInterval(check, 30 * 60 * 1000);
    window.__swReg = reg;
  }).catch((e) => console.warn('SW registration failed', e));
}

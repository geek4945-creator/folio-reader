// v0.5.23 crash guard. iOS Safari shows "A problem repeatedly occurred" when the page crashes (usually out of memory) during launch.
// A flag is set at the start of every launch and cleared once the app has run for a while (or is closed normally). If it is still set at the next
// launch, the last one crashed: this launch starts in SAFE MODE (no automatic sync, no cover downloads, no storage migration, no auto re-open of a book),
// so the library shows and books open. Open index.html?safe=1 to force it. Nothing is deleted or reset in safe mode.
const BOOT = 'folio.bootAt', SAFE_UNTIL = 'folio.safeUntil';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* full */ } }, del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } } };
const q = new URLSearchParams(location.search);
const crashed = !!ls.get(BOOT);
if (crashed) ls.set(SAFE_UNTIL, String(Date.now() + 10 * 60000));   // stay safe for the next few launches too
window.FOLIO_SAFE = q.get('safe') === '1' || crashed || (+ls.get(SAFE_UNTIL) || 0) > Date.now();
if (q.get('safe') === '0') { window.FOLIO_SAFE = false; ls.del(SAFE_UNTIL); }
ls.set(BOOT, String(Date.now()));
const ok = () => ls.del(BOOT);
addEventListener('pagehide', ok);
document.addEventListener('visibilitychange', () => { if (document.hidden) ok(); });
// opening a book is the other heavy moment: a crash while one opens also brings safe mode next time (and that book is not re-opened by itself)
addEventListener('reader-opened', () => { ls.set(BOOT, String(Date.now())); setTimeout(ok, 15000); });
setTimeout(ok, 25000);   // survived the heavy start (first sync, covers): a later crash is not a launch crash
// the last launch crashed and a fixed version is already downloaded: take it now, before the app (and whatever crashed) starts
if (crashed && navigator.serviceWorker && !sessionStorage.getItem('folio.safeSkip')) {
  try { const reg = await Promise.race([navigator.serviceWorker.getRegistration(), new Promise((r) => setTimeout(r, 1500))]);
    if (reg && reg.waiting && navigator.serviceWorker.controller) { sessionStorage.setItem('folio.safeSkip', '1'); ls.del(BOOT); reg.waiting.postMessage({ type: 'SKIP_WAITING' }); navigator.serviceWorker.addEventListener('controllerchange', () => location.reload()); setTimeout(() => location.reload(), 2500); await new Promise(() => {}); } } catch { /* carry on in safe mode */ }
}
await (await import('./lsx.js')).ready;
await import('./app.js');
if (window.FOLIO_SAFE) setTimeout(() => import('./util.js').then(({ toast }) => toast('Safe mode: automatic sync is paused so Folio can open. Your books and edits are safe. Settings → Sync → Sync now when ready.', 9000)).catch(() => {}), 800);

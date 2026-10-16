// Opening a book must never hang silently: step timeouts, a loading screen that always has a way out (✕ / Back), and after ~15 s a clear error with
// Retry / Retry from the start / Back / Copy details instead of an endless spinner. Used by the EPUB / MOBI reader and the PDF reader.
import { h, toast } from './util.js';
import { isCapacitor } from './env.js';

export const WATCHDOG_MS = 15000;
/** Rejects with a readable error when `p` hasn't settled after `ms`. */
export function withTimeout(p, ms, what) {
  let t; return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`Timed out while ${what} (${Math.round(ms / 1000)} s)`), { timeout: true })), ms); })]).finally(() => clearTimeout(t));
}
// the last few uncaught errors, shown in the details
const recent = []; const note = (m) => { recent.push(String(m).slice(0, 200)); if (recent.length > 8) recent.shift(); };
if (typeof window !== 'undefined' && !window.__openGuard) {
  window.__openGuard = true;
  window.addEventListener('error', (e) => note('error: ' + (e.message || e.error?.message || 'unknown')));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; note('rejection: ' + (r && (r.message || (typeof r === 'object' ? JSON.stringify(Object.getOwnPropertyNames(r).reduce((o, k) => (o[k] = String(r[k]).slice(0, 80), o), {})) : r)) || 'unknown')); });
}
const errText = (e) => (e && (e.message || (typeof e === 'object' ? JSON.stringify(e).slice(0, 160) : String(e)))) || 'unknown error';

async function describe(ctx) {
  let sw = '?', caches_ = '?';
  try { sw = (await (await fetch('sw.js', { cache: 'no-store' })).text()).match(/VERSION = '([^']+)'/)?.[1] || '?'; } catch { sw = 'unreachable'; }
  try { caches_ = (await caches.keys()).join(','); } catch { caches_ = 'n/a'; }
  const ctl = (() => { try { return navigator.serviceWorker?.controller ? 'controlled' : 'not controlled'; } catch { return 'n/a'; } })();
  const b = ctx.book || {};
  return [`Book: ${b.title || '?'} (${b.format || 'epub'}, ${Math.round((b.size || 0) / 1024)} kB, id ${b.id || '?'})`, `Saved place: ${b.cfi ? 'yes' : 'no'}${ctx.safe ? ' (ignored: opened from the start)' : ''} · locations cached: ${b.locations ? 'yes' : 'no'}`,
    `Stage: ${ctx.stage || '?'} · elapsed ${Math.round((Date.now() - ctx.t0) / 1000)} s`, ctx.error ? `Error: ${errText(ctx.error)}` : null,
    `App: ${document.title} · service worker ${sw} (${ctl}) · caches ${caches_}`, `Platform: ${isCapacitor() ? 'Android app' : 'browser'} · ${navigator.userAgent}`, `Screen: ${innerWidth}x${innerHeight} @${devicePixelRatio} · memory ${navigator.deviceMemory || '?'} GB`,
    recent.length ? 'Recent errors:\n  ' + recent.join('\n  ') : null].filter(Boolean).join('\n');
}

/**
 * The loading screen. Always shows a Back button (also Escape); after WATCHDOG_MS, or on failure, shows the error panel.
 * opts: { book, onBack(), onRetry(safe) }.  Returns { el, stage(s), fail(err), done(), failed }.
 */
export function makeLoading({ book, onBack, onRetry, ms = (typeof window !== 'undefined' && window.__openWatchdogMs) || WATCHDOG_MS }) {
  const ctx = { book, t0: Date.now(), stage: 'starting', error: null, safe: false };
  const stageEl = h('div', { class: 'muted small r-stage', id: 'r-stage' }, '');
  const back = h('button', { class: 'btn', id: 'r-load-back', onclick: () => stop() && onBack() }, '‹ Back to library');
  const el = h('div', { class: 'r-loading', role: 'status' }, h('div', { class: 'r-load-box' }, h('div', { class: 'spinner' }), h('div', { class: 'r-load-text', id: 'r-load-text' }, 'Opening…'), stageEl, back));
  let timer = setTimeout(() => api.fail(new Error('This is taking longer than expected')), ms); let stopped = false; const api = { el, failed: false };
  const stop = () => { if (stopped) return false; stopped = true; clearTimeout(timer); document.removeEventListener('keydown', esc, true); return true; };
  const esc = (e) => { if (e.key === 'Escape' && el.isConnected) { e.preventDefault(); e.stopPropagation(); stop() && onBack(); } };
  document.addEventListener('keydown', esc, true);
  api.stage = (s) => { ctx.stage = s; stageEl.textContent = s; };
  api.fail = async (err, { keepGoing = true } = {}) => {
    if (stopped && !api.failed) return; api.failed = true; ctx.error = err; if (keepGoing) clearTimeout(timer);
    const detailsPre = h('pre', { class: 'r-details', id: 'r-details' }, 'Collecting details…');
    describe(ctx).then((t) => { detailsPre.textContent = t; ctx.text = t; });
    const copy = h('button', { class: 'btn', id: 'r-copy', onclick: async () => { const t = ctx.text || detailsPre.textContent; try { await navigator.clipboard.writeText(t); toast('Details copied. Paste them in your report.'); } catch { const r = document.createRange(); r.selectNodeContents(detailsPre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Select and copy the details shown above.'); } } }, 'Copy details to report');
    el.replaceChildren(h('div', { class: 'r-load-box r-error', id: 'r-error' }, h('div', { class: 'r-err-title' }, api.timedOut(err) ? 'This book is taking too long to open' : 'This book couldn’t be opened'),
      h('p', { class: 'muted small', id: 'r-err-msg' }, errText(err)), h('p', { class: 'muted small' }, `Stuck at: ${ctx.stage}. You can wait a little longer, retry, or go back; your library is not affected.`),
      h('div', { class: 'r-err-actions' },
        h('button', { class: 'btn primary', id: 'r-retry', onclick: () => { stop(); onRetry(false); } }, 'Retry'),
        book && book.format !== 'pdf' ? h('button', { class: 'btn', id: 'r-retry-start', onclick: () => { ctx.safe = true; stop(); onRetry(true); } }, 'Retry from the start') : null,
        h('button', { class: 'btn', id: 'r-load-back', onclick: () => { stop(); onBack(); } }, '‹ Back to library'), copy),
      h('details', null, h('summary', null, 'Technical details'), detailsPre)));
  };
  api.timedOut = (e) => !!(e && (e.timeout || /longer than expected/.test(e.message || '')));
  api.done = () => { stop(); el.remove(); };
  api.ctx = ctx; return api;
}

/** A book whose nav / NCX file is missing never finishes epub.js's own setup, so `pageList` stays undefined and every page turn throws inside epub.js
 *  (no `relocated`, no saved position). Give it an empty page list. */
export function patchBook(epub) {
  repairSpine(epub);
  try { for (const k of Object.keys(epub.loaded || {})) epub.loaded[k] && epub.loaded[k].catch && epub.loaded[k].catch(() => {}); epub.ready && epub.ready.catch && epub.ready.catch(() => {}); } catch { /* ignore */ }   // a missing optional file must not become an uncaught rejection
  try { if (!epub.pageList) epub.pageList = { pageFromCfi: () => -1, cfiFromPage: () => -1, pageFromPercentage: () => -1, percentageFromPage: () => -1, percentageFromCfi: () => -1, firstPage: 0, lastPage: 0, totalPages: 0, destroy() {} }; } catch { /* ignore */ }
  return epub;
}

/** Some generated EPUBs (e.g. Internet Archive's scanned-page EPUBs) list spine itemrefs (`cover`, …) that are not in the manifest. epub.js then builds a section with no
 *  href and throws "Cannot read properties of undefined (reading 'indexOf')" the moment that section is shown, so the book never opens. Drop the dangling itemrefs. */
export function repairSpine(epub) {
  try {
    const sp = epub && epub.spine; if (!sp || sp.__folioRepaired || typeof sp.unpack !== 'function') return epub;
    const orig = sp.unpack.bind(sp); sp.__folioRepaired = true;
    sp.unpack = (pkg, ...rest) => {
      try {
        if (pkg && Array.isArray(pkg.spine) && pkg.manifest) {
          const ok = pkg.spine.filter((it) => it && (pkg.manifest[it.idref] || it.href)); const bad = pkg.spine.length - ok.length;
          if (bad) { console.warn('EPUB spine: ignoring ' + bad + ' item(s) that are not in the manifest'); if (ok.length) pkg.spine = ok; }
        }
      } catch { /* ignore */ }
      return orig(pkg, ...rest);
    };
  } catch { /* ignore */ }
  return epub;
}

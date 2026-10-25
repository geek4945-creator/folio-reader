// v0.5.18 "Search inside the book": every occurrence across the whole book (EPUB / MOBI·KF8 converted to EPUB / PDF page text layer + Text view).
// The search runs unit by unit (EPUB: spine section, PDF: page), yields to the UI between units and can be cancelled. Results show the chapter
// and a snippet; tapping one jumps there and flashes the match. A small ‹ n / N › bar in the reader steps through the results.
// Reader adapters provide: { key, root(), units, label(i), scan(i, q) → [{ target, text, start, end }] (text = the unit's plain text), show(hit), clearFlash() }.
import { h, sheet, pushLayer } from './util.js';

export const MAX_HITS = 2000;
let session = null; let active = null; let live = null;   // active: the running search job (one at a time); live: the open sheet's { list, row, statusText }   // { key, q, hits, idx, done } — per open book, survives closing the sheet (Next / Previous keep working)

/** Case-, accent- and quote-insensitive text with a map back to the original indices; whitespace runs count as one space. */
export function fold(text) {
  let s = ''; const map = []; let sp = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (!sp && s.length) { s += ' '; map.push(i); } sp = true; continue; }
    sp = false; let f = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/[‘’‛′]/.test(f)) f = "'"; else if (/[“”„″]/.test(f)) f = '"'; else if (/[‐‑‒–—]/.test(f)) f = '-';
    for (const x of f) { s += x; map.push(i); }
  }
  return { s, map };
}
export const foldQuery = (q) => fold(String(q || '').trim()).s;
/** All occurrences of q in text → [{ start, end }] in original indices (end exclusive). */
export function findAll(text, q, limit = MAX_HITS) {
  const needle = foldQuery(q); if (!needle) return [];
  const { s, map } = fold(text); const out = [];
  for (let i = s.indexOf(needle); i >= 0 && out.length < limit; i = s.indexOf(needle, i + needle.length)) out.push({ start: map[i], end: map[i + needle.length - 1] + 1 });
  return out;
}
export function snippet(text, start, end, pad = 48) {
  const a = Math.max(0, start - pad), b = Math.min(text.length, end + pad); const clip = (t) => t.replace(/\s+/g, ' ');
  return { before: (a > 0 ? '…' : '') + clip(text.slice(a, start)).replace(/^\S*\s/, a > 0 ? '' : '$&'), match: clip(text.slice(start, end)), after: clip(text.slice(end, b)).replace(/\s\S*$/, b < text.length ? '' : '$&') + (b < text.length ? '…' : '') };
}

/** Run a search; calls onHit(batch) as results arrive and onProgress(done, total). Returns { cancel(), promise }. */
export function runSearch(ad, q, { onHits, onProgress } = {}) {
  let cancelled = false; let count = 0;
  const promise = (async () => {
    for (let i = 0; i < ad.units; i++) {
      if (cancelled) return { cancelled: true, count };
      let hits = []; try { hits = await ad.scan(i, q); } catch (e) { console.warn('search unit', i, e); }
      if (cancelled) return { cancelled: true, count };
      if (hits.length) { hits = hits.slice(0, MAX_HITS - count); const label = ad.label(i); hits.forEach((x) => { x.unit = i; x.label = x.label || label; x.snip = x.snip || snippet(x.text, x.start, x.end); delete x.text; }); count += hits.length; onHits && onHits(hits); }
      onProgress && onProgress(i + 1, ad.units);
      if (count >= MAX_HITS) return { capped: true, count };
      await new Promise((r) => setTimeout(r, 0));   // let taps / scrolling through between units
    }
    return { count };
  })();
  return { cancel: () => { cancelled = true; }, promise, get cancelled() { return cancelled; } };
}

export const searchSession = () => session;
export function resetSearch(key) { if (!key || (session && session.key === key)) { if (active) active.cancel(); active = null; hideBar(); clearAllFlashes(); session = null; } }

/** The search sheet. `query` (optional) starts a search straight away (the Search button of the selection bar / word bubble). */
export function openSearch(ad, query) {
  if (!ad) return null;
  if (!session || session.key !== ad.key) { if (active) active.cancel(); active = null; session = { key: ad.key, q: '', hits: [], idx: -1, done: true }; }
  let job = null; let timer = 0; let jumping = false;
  const input = h('input', { type: 'search', class: 'field', id: 'bs-input', placeholder: 'Search in this book', enterkeyhint: 'search', autocomplete: 'off', value: query != null ? query : session.q });
  const status = h('div', { class: 'bs-status muted small', id: 'bs-status', 'aria-live': 'polite' });
  const cancelBtn = h('button', { class: 'btn small', id: 'bs-cancel', hidden: true, onclick: () => stop(true) }, 'Cancel');
  const list = h('div', { class: 'list bs-results', id: 'bs-results' });
  const row = (hit, i) => h('button', { class: 'list-item bs-hit' + (i === session.idx ? ' current' : ''), 'data-i': i, onclick: () => { jumping = true; w.close(); goto(ad, i); } },
    h('span', { class: 'grow' }, h('small', { class: 'bs-ch muted' }, hit.label || ''), h('span', { class: 'bs-snip' }, hit.snip.before, h('mark', null, hit.snip.match), hit.snip.after)));
  const statusText = (extra) => { const n = session.hits.length; status.textContent = (n ? n + (n >= MAX_HITS ? '+' : '') + (n === 1 ? ' result' : ' results') : (session.done ? (session.q ? 'No results for “' + session.q + '”' : '') : '')) + (extra ? (n ? ' · ' : '') + extra : ''); };
  function stop(user) { if (active) { active.cancel(); active = null; } job = null; cancelBtn.hidden = true; if (user) { session.done = true; statusText('Search cancelled'); } }
  function start(q) {
    stop(false); q = String(q || '').trim(); session.q = q; session.hits = []; session.idx = -1; session.done = false; list.replaceChildren(); hideBar();
    if (foldQuery(q).length < 2) { session.done = true; status.textContent = q ? 'Type at least 2 letters' : ''; return; }
    cancelBtn.hidden = false; statusText('Searching…');
    const me = job = runSearch(ad, q, {
      onHits: (hs) => { if (active !== me) return; const base = session.hits.length; session.hits.push(...hs); if (live && live.list.isConnected) live.list.append(...hs.map((x, k) => live.row(x, base + k))); paintBar(); },
      onProgress: (d, t) => { if (active === me && live) live.statusText('Searching… ' + Math.round(d / t * 100) + '%'); },
    });
    active = me;
    me.promise.then((r) => { if (active !== me) return; active = null; session.done = true; paintBar(); if (live) { live.cancelBtn.hidden = true; live.statusText(r.capped ? 'showing the first ' + MAX_HITS : ''); } });
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => start(input.value), 450); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); start(input.value); } });
  live = { list, row, statusText, cancelBtn };
  const w = sheet('Search', () => h('div', { class: 'bs-wrap' }, h('div', { class: 'bs-row' }, input, cancelBtn), status, list), { tall: true, onClose: () => { clearTimeout(timer); if (active && !jumping) stop(true); } });   // tapping a result lets a running search finish in the background
  if (query != null && query !== '') start(query);
  else if (session.hits.length || active) { list.append(...session.hits.map(row)); cancelBtn.hidden = !active; statusText(active ? 'Searching…' : ''); const cur = list.querySelector('.bs-hit.current'); if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: 'center' })); }
  setTimeout(() => { try { if (!query) input.focus(); } catch { /* ignore */ } }, 50);
  return { close: w.close, input, start, stop };
}

/** Jump to result i, flash it, show the ‹ n / N › bar. */
export async function goto(ad, i) {
  if (!session || !session.hits.length) return;
  i = (i + session.hits.length) % session.hits.length; session.idx = i;
  showBar(ad);
  try { await ad.show(session.hits[i]); } catch (e) { console.warn('search jump', e); }
}

let bar = null;
function showBar(ad) {
  const root = ad.root(); if (!root) return;
  if (!bar || !bar.el.isConnected) {
    hideBar();
    const lab = h('button', { class: 'bs-bar-n', id: 'bs-bar-n', onclick: () => openSearch(ad) }, '');
    const el = h('div', { class: 'bs-bar', id: 'bs-bar', role: 'toolbar', 'aria-label': 'Search results' },
      h('button', { class: 'btn-icon', id: 'bs-prev', 'aria-label': 'Previous result', onclick: () => goto(ad, session.idx - 1) }, '‹'), lab,
      h('button', { class: 'btn-icon', id: 'bs-next', 'aria-label': 'Next result', onclick: () => goto(ad, session.idx + 1) }, '›'),
      h('button', { class: 'btn-icon', id: 'bs-close', 'aria-label': 'Close search', onclick: () => { try { ad.clearFlash(); } catch { /* ignore */ } hideBar(); } }, '✕'));
    root.append(el); bar = { el, lab, unlayer: pushLayer(() => { try { ad.clearFlash(); } catch { /* ignore */ } hideBar(); }) };
  }
  paintBar();
}
function paintBar() { if (!bar || !session) return; bar.lab.textContent = '“' + (session.q.length > 18 ? session.q.slice(0, 17) + '…' : session.q) + '” ' + (session.idx + 1) + ' / ' + session.hits.length + (session.hits.length >= MAX_HITS ? '+' : session.done ? '' : '…'); }
export function hideBar() { if (bar) { const b = bar; bar = null; try { b.unlayer(); } catch { /* ignore */ } b.el.remove(); } }

/** Temporary highlight helper for a Range in any document (CSS Custom Highlight API); returns false when the engine lacks it. */
let flashTimer = 0;
export function flashRange(range, ms = 4000) {
  const w = range && range.startContainer && range.startContainer.ownerDocument && range.startContainer.ownerDocument.defaultView;
  clearTimeout(flashTimer); clearAllFlashes();
  if (!w || !w.CSS || !w.CSS.highlights || typeof w.Highlight !== 'function') return false;
  w.CSS.highlights.set('folio-search', new w.Highlight(range)); flashWins.add(w);
  flashTimer = setTimeout(clearAllFlashes, ms); return true;
}
const flashWins = new Set();
export function clearAllFlashes() { for (const w of flashWins) { try { w.CSS.highlights.delete('folio-search'); } catch { /* ignore */ } } flashWins.clear(); }

// Reader footer: "Page X of Y" and "N pages left in chapter" (EPUB, paginated + scrolled) and real page numbers for PDFs.
//
// EPUB pages are *rendered* pages, not fixed-size locations: each spine item's text length is counted once (cached per book in IndexedDB),
// and chars-per-page is calibrated from what the reader actually lays out (epub.js displayed pages, or scroll height / viewport height),
// starting from a layout model (font size, line spacing, margins, viewport) so the totals follow every appearance change immediately.
// Per book + layout the calibration is cached in IndexedDB ('pagecache'), so reopening shows numbers with no "Calculating pages…" wait.
import { h, $ } from './util.js';
import { settings } from './settings.js';
import * as S from './store.js';

/* ---------- footer element ---------- */
export const footerWanted = () => settings.get('footerPages') !== false || settings.get('footerLeft') !== false;
export function makeFooter() {
  return h('div', { id: 'r-foot', class: 'r-foot', role: 'status', 'aria-label': 'Reading position' },
    h('span', { id: 'r-foot-page', class: 'ft-page' }), h('span', { id: 'r-foot-sep', class: 'ft-sep', 'aria-hidden': 'true' }, '·'), h('span', { id: 'r-foot-left', class: 'ft-left' }));
}
/** Show/hide the footer and its two parts according to the settings (and whether the part has data). */
export function applyFooterSettings() {
  const el = $('#reader'); if (!el) return;
  const wantPage = settings.get('footerPages') !== false, wantLeft = settings.get('footerLeft') !== false;
  el.classList.toggle('has-foot', wantPage || wantLeft);
  const pg = $('#r-foot-page'), lf = $('#r-foot-left'), sep = $('#r-foot-sep'); if (!pg) return;
  pg.hidden = !wantPage || !pg.textContent; lf.hidden = !wantLeft || !lf.textContent; sep.hidden = pg.hidden || lf.hidden;
}
/** info: { page, total, left, unit, calculating } — any field may be missing. */
export function paintFooter(info = {}) {
  const pg = $('#r-foot-page'), lf = $('#r-foot-left'); if (!pg) return;
  pg.textContent = info.calculating ? 'Calculating pages…' : info.page && info.total ? `Page ${info.page} of ${info.total}` : info.percent != null ? Math.round(info.percent * 100) + '%' : '';   // percent when pages can't be worked out (e.g. mid-scroll between sections)
  const unit = info.unit || 'chapter';
  lf.textContent = info.left == null ? '' : info.left <= 0 ? `Last page of ${unit}` : `${info.left} page${info.left === 1 ? '' : 's'} left in ${unit}`;
  applyFooterSettings();
}
settings.onChange((p) => { if ('footerPages' in p || 'footerLeft' in p) applyFooterSettings(); if ('hideScrub' in p) applyScrub(); });
/** v0.5.8: hide only the progress slider (the % read, pages left and Page X of Y stay). Per book override, else the global setting. */
let scrubBook = null;
export function applyScrub(book) {
  if (book !== undefined) scrubBook = book; const el = $('#reader'); if (!el) return;
  el.classList.toggle('no-scrub', !!(scrubBook ? S.effectiveStyle(scrubBook).hideScrub : settings.get('hideScrub')));
}
/** The "hide progress bar" row: global (Settings) or, with `book`, a per-book choice next to a "use global" link (reader Appearance). */
export function scrubToggle({ book, onWrite, useGlobal } = {}) {
  const on = book ? !!S.effectiveStyle(book).hideScrub : !!settings.get('hideScrub');
  return h('label', { class: 'toggle-row', id: 'hide-scrub-row' }, h('input', { type: 'checkbox', id: 'hide-scrub', checked: on, onchange: (e) => { if (onWrite) onWrite(e.target.checked); else { settings.set({ hideScrub: e.target.checked }); applyScrub(); } } }), h('span', null, 'Hide the progress bar (slider)', h('small', { class: 'muted' }, ' — keeps % read, pages left and Page X of Y')), useGlobal || null);
}

/** Two checkboxes for the Appearance sheet / Settings page. */
export function footerToggles(onChange) {
  const box = (key, id, label) => h('label', { class: 'row-ctl' }, h('span', null, label), h('input', { type: 'checkbox', id, checked: settings.get(key) !== false, onchange: (e) => { settings.set({ [key]: e.target.checked }); onChange && onChange(); } }));
  return [box('footerPages', 'foot-pages', 'Show page numbers (Page X of Y)'), box('footerLeft', 'foot-left', 'Show pages left in chapter')];
}

/* ---------- layout model ---------- */
/** Rough characters per page for a layout (calibrated per book by a factor k). */
export function modelCpp(st, w, hgt) {
  const fpx = st.fontSizePt * 96 / 72; const cw = Math.max(80, w - 2 * st.margin);
  return Math.max(150, (cw / (fpx * 0.5)) * (hgt / (fpx * st.lineHeight)));
}
const MIN_CAL_CHARS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count the characters of every spine item (once per book; cached). Yields to the UI between sections. */
async function countChars(epub, isAlive) {
  const out = [];
  for (const item of epub.spine.spineItems) {
    if (!isAlive()) return null;
    let n = 0;
    try { const doc = await item.load(epub.load.bind(epub)); n = ((doc.querySelector ? doc.querySelector('body') : doc.body)?.textContent || '').replace(/\s+/g, ' ').trim().length; } catch { n = 0; }
    try { item.unload(); } catch { /* ignore */ }
    out.push(n);
    if (window.__pagesDelay) await sleep(window.__pagesDelay);   // test hook: slow the counting down so the placeholder can be observed
    else if (out.length % 4 === 0) await sleep(0);
  }
  return out;
}

/** EPUB footer controller for one reading session `c` (needs c.epub, c.rendition, c.viewer, c.book). */
export function createPager(c) {
  const P = { chars: null, cal: null, layoutKey: '', k: 0.8, actual: new Map(), settleAt: 0, dead: false };
  const alive = () => !P.dead && !c.closed;
  const style = () => S.effectiveStyle(c.book);
  // The area epub.js actually lays pages out in (its container), so toggling the toolbars doesn't look like a layout change.
  const dims = () => { const k = c.rendition && c.rendition.manager && c.rendition.manager.container; const e = k && k.clientWidth ? k : c.viewer; return { w: Math.round(e.clientWidth), h: Math.round(e.clientHeight) }; };
  const key = () => { const st = style(), d = dims(); return [st.fontSizePt, st.font, st.lineHeight, st.margin, settings.get('flow'), d.w + 'x' + d.h].join('|'); };
  const scrolled = () => settings.get('flow') === 'scrolled';
  const cpp = () => {
    const st = style(), d = dims(); const m = modelCpp(st, d.w, d.h);
    const secs = P.cal ? Object.values(P.cal.secs) : []; const sc = secs.reduce((a, x) => a + x[0], 0), sp = secs.reduce((a, x) => a + x[1], 0);
    return sp >= 2 && sc > 0 ? sc / sp : P.k * m;
  };
  async function loadLayout() {
    P.layoutKey = key(); P.actual = new Map();
    P.cal = (await S.getPageCache(c.book.id + '|cal|' + P.layoutKey)) || { secs: {} };
    P.k = (await S.getPageCache(c.book.id + '|k')) || P.k;
  }
  let saveT; const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
    if (!alive()) return; const m = modelCpp(style(), dims().w, dims().h); const secs = Object.values(P.cal.secs);
    const sp = secs.reduce((a, x) => a + x[1], 0), sc = secs.reduce((a, x) => a + x[0], 0);
    if (sp >= 2) { P.k = sc / sp / m; await S.putPageCache(c.book.id, c.book.id + '|k', P.k); }
    await S.putPageCache(c.book.id, c.book.id + '|cal|' + P.layoutKey, P.cal);
  }, 600); };
  const sample = (idx, charsN, pages) => { if (charsN >= MIN_CAL_CHARS && pages >= 1) { P.cal.secs[idx] = [charsN, pages]; saveSoon(); } };

  /** Current position in page terms: { page, total, left } (nulls while unknown). */
  function measure(loc) {
    if (!loc || !loc.start) return {};
    const idx = loc.start.index; const n = c.epub.spine.length || 1; const chars = P.chars;
    let curPage = 0, curTotal = 0, left = null, base = idx;
    const est = (i) => (P.actual.has(i) ? P.actual.get(i) : Math.max(1, Math.ceil((chars ? chars[i] : 0) / Math.max(1, cpp()))));
    if (!scrolled()) {
      const d = loc.start.displayed; if (!d || !d.total) return {};
      curPage = d.page; curTotal = d.total; left = Math.max(0, d.total - d.page);
      if (Date.now() >= P.settleAt) { P.actual.set(idx, d.total); if (chars) sample(idx, chars[idx], d.total - 0.5 >= 2.5 ? d.total - 0.5 : 0); }
    } else {
      const mgr = c.rendition.manager; const cont = mgr && mgr.container; if (!cont || !mgr.views) return {};
      const vh = cont.clientHeight || 1; const cr = cont.getBoundingClientRect(); let cv = null;
      for (const v of mgr.views.displayed()) {
        const r = v.element.getBoundingClientRect(); const top = r.top - cr.top, hh = r.height; const pages = Math.max(1, Math.ceil((hh - 2) / vh));
        if (Date.now() >= P.settleAt) { P.actual.set(v.section.index, pages); if (chars) sample(v.section.index, chars[v.section.index], hh / vh); }
        if (!cv && top <= 2 && top + hh > 2) cv = { idx: v.section.index, top, hh, pages };
      }
      if (!cv) return {};
      curTotal = cv.pages; curPage = Math.min(cv.pages, Math.floor(Math.max(0, -cv.top) / vh + 1e-3) + 1);
      left = Math.max(0, Math.ceil((cv.top + cv.hh - vh - 2) / vh));
      base = cv.idx;
    }
    const at = base; let before = 0; for (let i = 0; i < at; i++) before += est(i);
    let after = 0; for (let i = at + 1; i < n; i++) after += est(i);
    if (!chars) return { left, curPage, curTotal, unknown: true };
    return { page: before + curPage, total: before + curTotal + after, left };
  }
  function update(loc) {
    if (!alive()) return; loc = loc || c.rendition.currentLocation(); if (!loc) return;
    if (P.layoutKey && key() !== P.layoutKey) { relayout().then(() => update()); return; }
    const m = measure(loc);
    const n = c.epub.spine.length || 1, d = loc.start && loc.start.displayed; const percent = loc.start ? Math.min(1, Math.max(0, ((loc.start.index || 0) + (d && d.total ? (d.page - 1) / d.total : 0)) / n)) : null;
    paintFooter({ page: m.page, total: m.total, left: m.left, unit: 'chapter', calculating: !P.chars && !(m.page && m.total), percent });
    P.last = m; c.pageInfo = m;
  }
  async function relayout() { if (P.relaying) return P.relaying; P.relaying = (async () => { await loadLayout(); })().finally(() => { P.relaying = null; }); return P.relaying; }
  return Object.assign(P, {
    async init() {
      await loadLayout();
      const cached = await S.getPageCache(c.book.id + '|chars');
      if (cached && cached.length === c.epub.spine.length) P.chars = cached;
      update();
      if (!P.chars) { const r = await countChars(c.epub, alive); if (r && alive()) { P.chars = r; await S.putPageCache(c.book.id, c.book.id + '|chars', r); update(); } }
    },
    update, relayout, settle(ms = 600) { P.settleAt = Date.now() + ms; setTimeout(() => update(), ms + 60); },
    stop() { P.dead = true; clearTimeout(saveT); },
  });
}

// EPUB reader built on epub.js: paginated/scroll, tap zones, TOC, bookmarks, appearance (global + per-book overrides).
import { h, toast, sheet, debounce, $, fmtPct } from './util.js';
import { settings, THEMES, FONTS, FONT_MIN, FONT_MAX, FONT_STEP, clampPt } from './settings.js';
import * as S from './store.js';
import { fsButton } from './fullscreen.js';
import { openPdf, closePdf, pdfCurrent } from './pdfreader.js';
import { blockZoom } from './viewport.js';
import { attachPinch } from './pinch.js';
import { makeFooter, applyFooterSettings, paintFooter, createPager, footerToggles } from './pages.js';
import { makeLoading, withTimeout, patchBook } from './openguard.js';

let cur = null;   // active reading session

const root = () => $('#reader');

export async function openReader(id, opts = {}) {
  if (cur || pdfCurrent()) await closeReader();
  const book = await S.getBook(id); const blob = await S.getFile(id);
  if (!book || !blob) { toast('Book file not found'); return; }
  if (book.format === 'pdf') return openPdf(book, blob, opts);
  const el = root(); el.hidden = false; document.body.classList.add('reading');
  const viewer = h('div', { id: 'viewer' });
  const title = h('div', { class: 'r-title ellipsis' }, book.title);
  const ovr = h('span', { class: 'ovr-dot', id: 'r-ovr', hidden: !S.hasOverrides(book), title: 'This book has custom reading settings' }, 'Aa');
  const bmBtn = h('button', { class: 'btn-icon', id: 'r-bm', 'aria-label': 'Toggle bookmark', onclick: toggleBookmark }, '☆');
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: Math.round((book.progress || 0) * 1000), id: 'r-slider', 'aria-label': 'Reading position', disabled: true });
  const label = h('div', { class: 'r-label ellipsis' }, '');
  const top = h('div', { class: 'r-bar top' },
    h('button', { class: 'btn-icon', id: 'r-back', 'aria-label': 'Close book', onclick: closeReader }, '‹'),
    h('div', { class: 'grow r-titlewrap' }, title, ovr),
    h('button', { class: 'btn-icon', id: 'r-link', 'aria-label': 'Find my place (audiobook)', title: 'Find my place (audiobook)', hidden: true, onclick: () => import('./findplace.js').then((m) => m.openFindPlace({ bookId: book.id })) }, '🎧'),
    h('button', { class: 'btn-icon', id: 'r-toc', 'aria-label': 'Table of contents', onclick: showToc }, '☰'),
    bmBtn,
    fsButton({ class: 'btn-icon', id: 'r-fs' }, { icon: true }),
    h('button', { class: 'btn-icon', id: 'r-aa', 'aria-label': 'Appearance', onclick: showSettings }, 'Aa'));
  const bottom = h('div', { class: 'r-bar bottom' }, slider, label);
  const loading = makeLoading({ book, onBack: () => closeReader(), onRetry: async (safe) => { await closeReader(); openReader(id, { safe }); } });   // always has a Back button; after 15 s an error panel with Retry / Back / details
  const foot = makeFooter();
  el.replaceChildren(top, viewer, bottom, foot, loading.el); applyFooterSettings(); paintFooter({});

  import('./audiostore.js').then((A) => A.getAudiobooks()).then((l) => { const b = document.getElementById('r-link'); if (b && l.length) b.hidden = false; }).catch(() => {});   // the 🎧 button only appears once there is an audiobook to link
  cur = { book, viewer, slider, label, bmBtn, ovr, el, chrome: true, top, bottom, saveTimer: null, finishedThisSession: false, bookmarks: await S.getBookmarks(id), loc: null, ready: false };
  attachPinch(viewer, pinchHost);   // spread / pinch over the margins (inside the page it is attached per EPUB frame)
  const mine = cur; const alive = () => cur === mine && !mine.closed;
  try {
    loading.stage(book.size > 60 * 1048576 ? 'Reading a large book (' + Math.round(book.size / 1048576) + ' MB), this can take a while…' : 'Reading the book file…'); const buf = await withTimeout(blob.arrayBuffer(), 20000, 'reading the file from storage'); if (!alive()) return;
    loading.stage('Opening the EPUB package…'); mine.epub = patchBook(ePub(buf));
    // `epub.ready` and `loaded.navigation` never settle when the declared nav / NCX file is missing (the "stuck on Opening…" bug); `opened` and display() work.
    await withTimeout(mine.epub.opened, 15000, 'opening the EPUB package'); if (!alive()) return; patchBook(mine.epub);
    loading.stage('Reading the table of contents…'); mine.toc = await withTimeout(mine.epub.loaded.navigation.then((n) => (n && n.toc) || []), 3000, 'reading the table of contents').catch(() => []);
    if (!mine.toc.length) mine.toc = spineToc(mine.epub);   // empty / missing nav (scanned-page EPUBs): list the sections instead
    if (!opts.safe && book.locations) { try { mine.epub.locations.load(book.locations); mine.locReady = true; } catch { /* regenerate */ } }
    loading.stage('Laying out the first page…');
    try { await withTimeout(startRendition(opts.safe ? undefined : (book.cfi || undefined)), 12000, 'showing your place'); }
    catch (e) { if (!alive()) return; if (opts.safe || !book.cfi) throw e; console.warn('saved place failed, opening from the start', e); toast('Couldn’t return to your saved place; opened from the start.', 5000); loading.stage('Opening from the start…'); await withTimeout(startRendition(undefined), 12000, 'showing the first page'); }
    if (!alive()) return;
    loading.done(); mine.ready = true;
    slider.disabled = false;
    mine.pager = createPager(mine); mine.pager.init();
    if (!mine.locReady) generateLocations();
    S.saveBook(await touchOpened(book));
  } catch (e) {
    if (!alive()) return;
    console.error(e); loading.fail(e); return;   // stay on the loading screen, which now offers Retry / Back / details
  }
  slider.addEventListener('change', async () => {
    if (!cur.locReady) return;
    const cfi = cur.epub.locations.cfiFromPercentage(slider.value / 1000); if (cfi) await cur.rendition.display(cfi);
  });
  slider.addEventListener('input', () => { label.textContent = Math.round(slider.value / 10) + '%'; });
  window.addEventListener('keydown', keyNav); document.addEventListener('visibilitychange', onHide); window.addEventListener('resize', onResize);
  window.__reader = cur;
}

/** No usable table of contents: list the spine instead so the Contents sheet is not empty. */
function spineToc(epub) { try { return (epub.spine.spineItems || epub.spine.items || []).slice(0, 300).map((it, i) => ({ label: 'Section ' + (i + 1), href: it.href })); } catch { return []; } }

async function touchOpened(book) { const b = await S.getBook(book.id); b.lastOpened = Date.now(); return b; }

async function generateLocations() {
  const c = cur; if (!c) return;
  try {
    await c.epub.locations.generate(1600);
    if (cur !== c) return;
    c.locReady = true;
    const b = await S.getBook(c.book.id); b.locations = c.epub.locations.save(); b._noTouch = true; await S.saveBook(b);
    if (c.loc) updateProgress(c.loc);
    c.slider.disabled = false;
  } catch (e) { console.warn('locations failed', e); }
}

async function startRendition(cfi) {
  const c = cur; const scrolled = settings.get('flow') === 'scrolled';
  if (c.rendition) { try { c.rendition.destroy(); } catch { /* ignore */ } c.viewer.replaceChildren(); }
  applyMargin();
  const r = c.epub.renderTo(c.viewer, { width: '100%', height: '100%', flow: scrolled ? 'scrolled' : 'paginated', manager: scrolled ? 'continuous' : 'default', spread: 'none', allowScriptedContent: false, minSpreadWidth: 99999 });
  c.rendition = r;
  r.hooks.content.register((contents) => injectStyle(contents));
  r.on('relocated', (loc) => { if (c.rendition !== r) return; c.loc = loc; updateProgress(loc); c.pager && c.pager.update(loc); });
  r.on('click', onTap);
  let tx = null;
  r.on('touchstart', (e) => { tx = e.changedTouches ? [e.changedTouches[0].screenX, e.changedTouches[0].screenY] : null; });
  r.on('touchend', (e) => {
    if (!tx || settings.get('flow') === 'scrolled' || !e.changedTouches || justPinched()) return;
    const dx = e.changedTouches[0].screenX - tx[0], dy = e.changedTouches[0].screenY - tx[1];
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { dx < 0 ? r.next() : r.prev(); e.__swiped = true; swipedAt = Date.now(); }
  });
  await r.display(cfi);
  if (scrolled) {   // keep "Page X of Y" live while scrolling
    const k = r.manager && r.manager.container; let raf = 0;
    let settle = 0;
    if (k) k.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (c.rendition === r && c.pager) c.pager.update(); }); clearTimeout(settle); settle = setTimeout(() => { if (c.rendition === r) syncScrollLoc(); }, 250); }, { passive: true });
  }
  if (c.pager) c.pager.settle(300);
  if (cfi && !scrolled) {   // epub.js can land one page early when the saved CFI is the first character of a page
    try { const l = r.currentLocation(); const cmp = new ePub.CFI(); if (l && l.end && cmp.compare(cfi, l.end.cfi) > 0) await r.next(); } catch { /* ignore */ }
  }
}
let swipedAt = 0;
const onResize = () => { if (cur && cur.pager) cur.pager.settle(500); };

/* ----- tap zones ----- */
function onTap(e) {
  if (Date.now() - swipedAt < 400) return;
  try { if (e.view.getSelection().toString()) return; } catch { /* ignore */ }
  if (e.target && e.target.closest && e.target.closest('a[href]')) return;
  if (justPinched()) return;
  const c = cur; const frame = e.view.frameElement; const vr = c.viewer.getBoundingClientRect();
  const x = (frame ? frame.getBoundingClientRect().left : vr.left) + e.clientX; const ratio = (x - vr.left) / vr.width;
  const mode = settings.get('tapZones'); const scrolled = settings.get('flow') === 'scrolled';
  if (!scrolled && mode !== 'off') {
    const left = mode === 'inverted' ? 'next' : 'prev', right = mode === 'inverted' ? 'prev' : 'next';
    if (ratio < 0.28) { c.rendition[left](); return; }
    if (ratio > 0.72) { c.rendition[right](); return; }
  }
  toggleChrome();
}
function toggleChrome(force) {
  const c = cur; c.chrome = force != null ? force : !c.chrome;
  c.el.classList.toggle('chrome-hidden', !c.chrome);
}
function keyNav(e) {
  if (!cur || !cur.rendition || $('#overlay').children.length) return;
  if (e.key === 'ArrowRight') cur.rendition.next(); else if (e.key === 'ArrowLeft') cur.rendition.prev(); else if (e.key === 'Escape') closeReader();
}
function onHide() { if (document.hidden && cur) savePosition(true); }

/* ----- styles ----- */
function buildCss() {
  const c = cur; const st = { ...S.effectiveStyle(c.book) }; if (c.previewPt != null) st.fontSizePt = c.previewPt; const t = THEMES[settings.get('theme')] || THEMES.light;
  const ff = FONTS[st.font]?.css || '';
  return `
html, body { touch-action: manipulation; }
html { font-size: ${st.fontSizePt}pt !important; background: ${t.bg} !important; }
body { font-size: 1em !important; color: ${t.fg} !important; background: ${t.bg} !important; ${ff ? `font-family: ${ff} !important;` : ''} -webkit-text-size-adjust: 100% !important; }
p, li, dd, dt, blockquote, td, th, div, span, section, article, figcaption, cite, em, i, b, strong, small, sup, sub { font-size: inherit !important; ${ff ? 'font-family: inherit !important;' : ''} }
body, p, li, dd, dt, blockquote, td, th, div, span { line-height: ${st.lineHeight} !important; }
h1, h2, h3, h4, h5, h6 { ${ff ? `font-family: ${ff} !important;` : ''} line-height: 1.25 !important; }
h1 { font-size: 1.6em !important; } h2 { font-size: 1.35em !important; } h3 { font-size: 1.15em !important; } h4,h5,h6 { font-size: 1em !important; }
body *:not(img):not(svg):not(a) { color: ${t.fg} !important; background-color: transparent !important; }
a, a * { color: ${t.accent} !important; }
::selection { background: ${t.accent}55; }
img, svg, video { max-width: 100% !important; height: auto; ${t.dark ? 'opacity:.92;' : ''} }
pre, code, kbd, samp { font-family: Menlo, Consolas, monospace !important; font-size: .9em !important; }
`;
}
/** Pinch → text size: the same value the Aa panel would set (this book's own size if it has one, else the global size). */
const pinchHost = {
  getPt: () => (cur ? S.effectiveStyle(cur.book).fontSizePt : settings.get('fontSizePt')),
  pinched: () => { if (cur) cur.pinchedAt = Date.now(); },
  apply: (pt, final) => {
    const c = cur; if (!c) return;
    if (!final) {   // live preview: restyle the open pages only. A full re-layout / re-render mid-gesture would replace the iframe the fingers are on and cut the gesture off.
      c.previewPt = pt; try { c.rendition.getContents().forEach(injectStyle); } catch { /* ignore */ } return;
    }
    c.previewPt = null;
    if (c.book.overrides && c.book.overrides.fontSizePt != null) {
      c.book.overrides = { ...c.book.overrides, fontSizePt: pt }; applyAppearance();
      S.setOverride(c.book.id, { fontSizePt: pt }).then((b) => { if (cur === c) c.book = b; });
    } else settings.set({ fontSizePt: pt });
  },
};
const justPinched = () => cur && cur.pinchedAt && Date.now() - cur.pinchedAt < 600;
function injectStyle(contents) {
  try { blockZoom(contents.document); attachPinch(contents.document, pinchHost); } catch { /* ignore */ }
  try {
    const d = contents.document; let el = d.getElementById('folio-user-style');
    if (!el) { el = d.createElement('style'); el.id = 'folio-user-style'; d.head.appendChild(el); }
    el.textContent = buildCss();
  } catch (e) { console.warn(e); }
}
function applyMargin() {
  const st = S.effectiveStyle(cur.book);
  cur.viewer.style.paddingLeft = cur.viewer.style.paddingRight = st.margin + 'px';
}
let reflowTimer;
/** Re-apply appearance after any change, keeping the reading position. */
export function applyAppearance() {
  const c = cur; if (!c || !c.rendition) return;
  applyMargin();
  c.rendition.getContents().forEach(injectStyle);
  c.ovr.hidden = !S.hasOverrides(c.book);
  c.pager && c.pager.settle(800);
  clearTimeout(reflowTimer);
  reflowTimer = setTimeout(async () => {
    const cfi = c.loc?.start?.cfi;
    try { c.rendition.resize(); if (cfi && settings.get('flow') === 'paginated') await c.rendition.display(cfi); } catch { /* ignore */ }
  }, 120);
}
settings.onChange((p) => { if (cur && ('theme' in p || 'fontSizePt' in p || 'font' in p || 'lineHeight' in p || 'margin' in p)) applyAppearance(); });

/* ----- progress ----- */
function chapterOf(loc) {
  try { const it = cur.epub.navigation.get(loc.start.href); if (it) return (it.label || '').trim(); } catch { /* ignore */ }
  return '';
}
function updateProgress(loc, noSave) {
  const c = cur; if (!c) return;
  let p = 0;
  if (c.locReady) p = c.epub.locations.percentageFromCfi(loc.start.cfi) || 0;
  else { const n = c.epub.spine.length || 1; const d = loc.start.displayed; p = (loc.start.index + (d && d.total ? (d.page - 1) / d.total : 0)) / n; }
  if (loc.atEnd) p = 1;
  c.progress = p;
  c.slider.value = Math.round(p * 1000);
  const chap = chapterOf(loc);
  c.label.textContent = fmtPct(p) + (chap ? ' · ' + chap : '');
  c.curChapter = chap;
  refreshBookmarkStar();
  if (!noSave) savePositionSoon(loc);
}
/** Continuous scroll: epub.js does not always report `relocated` while the reader scrolls, so read the position from the rendition ourselves. */
function syncScrollLoc(noSave) {
  const c = cur; if (!c || !c.rendition || c.closed || c.rendition.settings.flow !== 'scrolled') return;
  try { const l = c.rendition.currentLocation(); if (l && l.start && l.start.cfi) { c.loc = l; updateProgress(l, noSave); c.pager && c.pager.update(l); } } catch { /* ignore */ }
}
const savePositionSoon = debounce(() => savePosition(), 500);
async function savePosition() {
  syncScrollLoc(true);
  const c = cur; if (!c || !c.loc) return;
  const b = await S.getBook(c.book.id); if (!b) return;
  b.cfi = c.loc.start.cfi; b.progress = c.progress; b.lastOpened = Date.now();
  let moved = null;
  if (!c.finishedThisSession && (c.loc.atEnd || c.progress >= 0.985) && b.status !== 'finished') { b.status = 'finished'; b.finishedAt = Date.now(); c.finishedThisSession = true; moved = 'Finished'; }
  else if (b.status !== 'finished' && b.status !== 'reading' && c.progress > 0.002) { b.status = 'reading'; }
  c.book.status = b.status;
  await S.saveBook(b);
  if (moved) toast('Finished — moved to the Finished shelf');
}

/* ----- bookmarks ----- */
function pageBookmarks() {
  const c = cur; if (!c || !c.loc) return [];
  const cmp = new ePub.CFI();
  return c.bookmarks.filter((bm) => { try { return cmp.compare(bm.cfi, c.loc.start.cfi) >= 0 && cmp.compare(bm.cfi, c.loc.end.cfi) <= 0; } catch { return false; } });
}
function refreshBookmarkStar() { const on = pageBookmarks().length > 0; cur.bmBtn.textContent = on ? '★' : '☆'; cur.bmBtn.classList.toggle('on', on); }
async function toggleBookmark() {
  const c = cur; if (!c || !c.loc) return;
  const here = pageBookmarks();
  if (here.length) { for (const bm of here) await S.removeBookmark(bm.id); c.bookmarks = c.bookmarks.filter((b) => !here.includes(b)); toast('Bookmark removed'); }
  else { const bm = await S.addBookmark({ bookId: c.book.id, cfi: c.loc.start.cfi, progress: c.progress, label: c.curChapter || ('Page at ' + fmtPct(c.progress)) }); c.bookmarks.push(bm); toast('Bookmarked'); }
  refreshBookmarkStar();
}

/* ----- TOC & bookmarks sheet ----- */
function showToc() {
  const c = cur;
  const flat = (items, depth = 0) => items.flatMap((it) => [{ it, depth }, ...flat(it.subitems || [], depth + 1)]);
  let tab = 'toc';
  const w = sheet('Contents', () => build(), { tall: true });
  function build() {
    const wrap = h('div');
    wrap.append(h('div', { class: 'seg wide' }, ['toc', 'bookmarks'].map((t) => h('button', { class: tab === t ? 'on' : '', 'data-tab': t, onclick: () => { tab = t; w.body.replaceChildren(build()); } }, t === 'toc' ? 'Chapters' : 'Bookmarks (' + c.bookmarks.length + ')'))));
    if (tab === 'toc') wrap.append(h('div', { class: 'list' }, flat(c.toc).length ? flat(c.toc).map(({ it, depth }) => h('button', { class: 'list-item toc-item', style: { paddingLeft: (14 + depth * 16) + 'px' }, onclick: async () => { w.close(); await c.rendition.display(it.href); } }, (it.label || '').trim())) : h('p', { class: 'muted pad' }, 'This book has no table of contents.')));
    else wrap.append(h('div', { class: 'list' }, c.bookmarks.length ? [...c.bookmarks].sort((a, b) => a.progress - b.progress).map((bm) => h('div', { class: 'list-item' },
      h('span', { class: 'grow', onclick: async () => { w.close(); await c.rendition.display(bm.cfi); } }, bm.label, h('small', { class: 'muted' }, ' · ' + fmtPct(bm.progress))),
      h('button', { class: 'btn-icon', 'aria-label': 'Delete bookmark', onclick: async () => { await S.removeBookmark(bm.id); c.bookmarks = c.bookmarks.filter((x) => x.id !== bm.id); refreshBookmarkStar(); w.body.replaceChildren(build()); } }, '✕'))) : h('p', { class: 'muted pad' }, 'No bookmarks yet. Tap ☆ in the top bar.')));
    return wrap;
  }
  return w;
}

/* ----- appearance panel ----- */
export function showSettings() {
  const c = cur; let scope = S.hasOverrides(c.book) ? 'book' : 'global';
  const ui = { clear: {}, reset: null, tab: null };
  const w = sheet('Appearance', () => build(), { noDim: true, tall: false });
  function val(k) { return S.effectiveStyle(c.book)[k]; }
  async function write(k, v) {
    if (scope === 'book') { c.book = await S.setOverride(c.book.id, { [k]: v }); if (ui.clear[k]) ui.clear[k].hidden = false; if (ui.reset) ui.reset.hidden = false; if (ui.tab) ui.tab.textContent = 'This book only •'; }
    else settings.set({ [k]: v });
    applyAppearance();
  }
  function build() {
    const wrap = h('div', { class: 'appearance' });
    const overridden = (k) => scope === 'book' && c.book.overrides && c.book.overrides[k] != null;
    ui.clear = {};
    const useGlobal = (k, text) => { if (scope !== 'book') return null; const b = h('button', { class: 'btn-text small', 'data-clear': k, hidden: !overridden(k), onclick: async () => { c.book = await S.setOverride(c.book.id, { [k]: null }); applyAppearance(); w.body.replaceChildren(build()); } }, text); ui.clear[k] = b; return b; };
    wrap.append(h('div', { class: 'seg wide' },
      h('button', { class: scope === 'global' ? 'on' : '', id: 'scope-global', onclick: () => { scope = 'global'; w.body.replaceChildren(build()); } }, 'All books'),
      (ui.tab = h('button', { class: scope === 'book' ? 'on' : '', id: 'scope-book', onclick: () => { scope = 'book'; w.body.replaceChildren(build()); } }, 'This book only' + (S.hasOverrides(c.book) ? ' •' : '')))));
    if (scope === 'book') wrap.append(h('p', { class: 'hint' }, S.hasOverrides(c.book) ? 'This book has custom settings. They override the global defaults and the book’s own styling.' : 'Changes below apply only to this book and override its built-in styling. Untouched options follow your global defaults.'));

    // Font size: number input + −/+ + slider, all synced
    const num = h('input', { type: 'number', id: 'fs-num', class: 'num', min: FONT_MIN, max: FONT_MAX, step: FONT_STEP, inputmode: 'decimal', value: val('fontSizePt') });
    const range = h('input', { type: 'range', id: 'fs-range', min: FONT_MIN, max: FONT_MAX, step: FONT_STEP, value: val('fontSizePt') });
    const setSize = (v, fromInput) => { v = clampPt(v); range.value = v; if (!fromInput || document.activeElement !== num) num.value = v; write('fontSizePt', v); };
    num.addEventListener('change', () => { setSize(num.value); num.value = clampPt(num.value); });
    range.addEventListener('input', () => setSize(range.value));
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Text size ', h('small', { class: 'muted' }, 'pt')), useGlobal('fontSizePt', 'Use global size'),
      h('div', { class: 'stepper' }, h('button', { class: 'btn', id: 'fs-minus', 'aria-label': 'Smaller', onclick: () => setSize(+num.value - FONT_STEP) }, '−'), num, h('button', { class: 'btn', id: 'fs-plus', 'aria-label': 'Larger', onclick: () => setSize(+num.value + FONT_STEP) }, '+'))), range);

    const fontSel = h('select', { class: 'field', id: 'font-sel', onchange: (e) => { write('font', e.target.value); } }, Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: k === val('font') }, f.name)));
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Font'), useGlobal('font', 'Use global font')), fontSel);

    const lh = h('input', { type: 'range', id: 'lh-range', min: 1, max: 2.4, step: 0.05, value: val('lineHeight') }); const lhv = h('span', { class: 'muted' }, (+val('lineHeight')).toFixed(2));
    lh.addEventListener('input', () => { lhv.textContent = (+lh.value).toFixed(2); write('lineHeight', +lh.value); });
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Line spacing ', lhv), useGlobal('lineHeight', 'Use global spacing')), lh);

    const mg = h('input', { type: 'range', id: 'mg-range', min: 0, max: 80, step: 2, value: val('margin') }); const mgv = h('span', { class: 'muted' }, val('margin') + ' px');
    mg.addEventListener('input', () => { mgv.textContent = mg.value + ' px'; write('margin', +mg.value); });
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Margins ', mgv), useGlobal('margin', 'Use global margins')), mg);

    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Theme')),
      h('div', { class: 'themes' }, Object.entries(THEMES).map(([k, t]) => h('button', { class: 'swatch' + (settings.get('theme') === k ? ' on' : ''), 'data-theme-pick': k, style: { background: t.bg, color: t.fg, borderColor: t.accent }, onclick: () => { settings.set({ theme: k }); w.body.replaceChildren(build()); } }, 'Aa', h('small', null, t.name)))),
      h('div', { class: 'row-ctl' }, h('label', null, 'Layout')),
      h('div', { class: 'seg wide' }, ['paginated', 'scrolled'].map((f) => h('button', { class: settings.get('flow') === f ? 'on' : '', 'data-flow': f, onclick: async () => { settings.set({ flow: f }); w.body.replaceChildren(build()); const cfi = c.loc?.start?.cfi; await startRendition(cfi); } }, f === 'paginated' ? 'Pages' : 'Scroll'))),
      h('div', { class: 'row-ctl' }, h('label', null, 'Tap zones')),
      h('div', { class: 'seg wide' }, [['on', 'Left = back'], ['inverted', 'Left = next'], ['off', 'Off']].map(([v, n]) => h('button', { class: settings.get('tapZones') === v ? 'on' : '', onclick: () => { settings.set({ tapZones: v }); w.body.replaceChildren(build()); } }, n))));
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Footer')), ...footerToggles());
    ui.reset = h('button', { class: 'btn block', id: 'reset-book', hidden: !S.hasOverrides(c.book), onclick: async () => { c.book = await S.resetOverrides(c.book.id); scope = 'global'; applyAppearance(); w.body.replaceChildren(build()); toast('This book now uses the global defaults'); } }, 'Reset this book to defaults');
    wrap.append(ui.reset);
    return wrap;
  }
  return w;
}

/* ----- close ----- */
export async function closeReader() {
  if (pdfCurrent()) return closePdf();
  const c = cur; if (!c) return; cur = null;
  window.removeEventListener('keydown', keyNav); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('resize', onResize);
  c.closed = true; c.pager && c.pager.stop();
  cur = c; try { await savePosition(); } catch { /* ignore */ } cur = null;
  try { c.rendition && c.rendition.destroy(); } catch { /* ignore */ }
  try { c.epub && c.epub.destroy(); } catch { /* ignore */ }
  const el = root(); el.hidden = true; el.replaceChildren(); el.classList.remove('chrome-hidden'); document.body.classList.remove('reading');
  $('#overlay').replaceChildren(); $('#overlay').hidden = true;
  const { refreshLibrary } = await import('./library.js'); refreshLibrary();
}
export const currentReader = () => cur || pdfCurrent();

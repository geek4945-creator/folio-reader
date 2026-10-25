// EPUB reader built on epub.js: paginated/scroll, tap zones, TOC, bookmarks, appearance (global + per-book overrides).
import { h, toast, sheet, debounce, $, fmtPct } from './util.js';
import { settings, THEMES, FONTS, FONT_MIN, FONT_MAX, FONT_STEP, clampPt } from './settings.js';
import * as S from './store.js';
import { fsButton } from './fullscreen.js';
import { openPdf, closePdf, pdfCurrent, flushPdfPosition } from './pdfreader.js';
import { blockZoom } from './viewport.js';
import { attachPinch } from './pinch.js';
import { makeFooter, applyFooterSettings, paintFooter, createPager, footerToggles, applyScrub, scrubToggle } from './pages.js';
import { makeLoading, withTimeout, patchBook } from './openguard.js';
import { beforeOpen, registerOpenCheck } from './positions.js';
import { attachWordHold, applyHighlights, closeBubble, wordBubbleOpen } from './wordbubble.js';
import * as G from './glossary.js';
import { openGlossary, openTermEditor } from './glossaryui.js';
import * as AN from './annotui.js';

let cur = null;   // active reading session
registerOpenCheck((kind, id) => kind === 'book' && !!cur && cur.book.id === id);

const root = () => $('#reader');

export async function openReader(id, opts = {}) {
  if (cur || pdfCurrent()) await closeReader();
  await beforeOpen('book', id);   // v0.5.5: pull the latest position from other devices ("Continue from <device>?") before anything reads it
  const book = await S.getBook(id); const blob = await S.getFile(id);
  if (!book || !blob) { toast('Book file not found'); return; }
  if (book.format === 'pdf') return openPdf(book, blob, opts);
  const el = root(); el.hidden = false; document.body.classList.add('reading'); window.dispatchEvent(new Event('reader-opened'));
  const viewer = h('div', { id: 'viewer' });
  const title = h('div', { class: 'r-title ellipsis' }, book.title);
  const ovr = h('span', { class: 'ovr-dot', id: 'r-ovr', hidden: !S.hasOverrides(book), title: 'This book has custom reading settings' }, 'Aa');
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: Math.round((book.progress || 0) * 1000), id: 'r-slider', 'aria-label': 'Reading position', disabled: true });
  const label = h('div', { class: 'r-label ellipsis' }, '');
  const top = h('div', { class: 'r-bar top' },
    h('button', { class: 'btn-icon', id: 'r-back', 'aria-label': 'Close book', onclick: closeReader }, '‹'),
    h('div', { class: 'grow r-titlewrap' }, title, ovr),
    h('button', { class: 'btn-icon', id: 'r-hl', 'aria-label': 'Highlight selected text (or turn on select mode)', title: 'Highlight', onclick: () => { const a = annotHost(); if (a) AN.toolbarHighlight(a); } }, '🖍'),
    h('button', { class: 'btn-icon', id: 'r-search', 'aria-label': 'Search in this book', title: 'Search', onclick: () => openBookSearch(AN.searchTextFromSelection(annotHost()) || undefined) }, '🔍'),   // v0.5.19: a word selected (or just selected — iOS collapses the selection on the tap) is searched at once
    h('button', { class: 'btn-icon', id: 'r-toc', 'aria-label': 'Table of contents', onclick: showToc }, '☰'),
    fsButton({ class: 'btn-icon', id: 'r-fs' }, { icon: true }),
    h('button', { class: 'btn-icon', id: 'r-aa', 'aria-label': 'Appearance', onclick: showSettings }, 'Aa'));
  const bottom = h('div', { class: 'r-bar bottom' }, slider, label);
  const loading = makeLoading({ book, onBack: () => closeReader(), onRetry: async (safe) => { await closeReader(); openReader(id, { safe }); } });   // always has a Back button; after 15 s an error panel with Retry / Back / details
  const foot = makeFooter();
  el.replaceChildren(top, viewer, bottom, foot, loading.el); applyFooterSettings(); paintFooter({}); applyScrub(book);

  cur = { book, viewer, slider, label, ovr, el, chrome: true, top, bottom, saveTimer: null, finishedThisSession: false, bookmarks: await S.getBookmarks(id), loc: null, ready: false };
  attachPinch(viewer, pinchHost);   // spread / pinch over the margins (inside the page it is attached per EPUB frame)
  const mine = cur; import('./audiostore.js').then((A) => A.getAudiobooks()).then((l) => { mine.hasAudio = l.length > 0; }).catch(() => {});   // v0.5.19: "Audiobook sync" lives in the ☰ menu (no 🎧 in the top bar); shown once there is an audiobook to link
  const alive = () => cur === mine && !mine.closed;
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
  try { c.fixed = (c.epub.packaging && c.epub.packaging.metadata && c.epub.packaging.metadata.layout) === 'pre-paginated'; } catch { c.fixed = false; }
  if (c.grabResize) { window.removeEventListener('resize', c.grabResize, true); window.removeEventListener('orientationchange', c.grabResize, true); c.grabResize = null; }
  if (c.rendition) { try { c.rendition.destroy(); } catch { /* ignore */ } c.viewer.replaceChildren(); }
  applyMargin();
  const r = c.epub.renderTo(c.viewer, { width: '100%', height: '100%', flow: scrolled ? 'scrolled' : 'paginated', manager: scrolled ? 'continuous' : 'default', spread: 'none', allowScriptedContent: false, minSpreadWidth: 99999 });
  c.rendition = r;
  if (scrolled) {
    // v0.5.17: when the stage size changes (iOS address bar / keyboard / rotation / zoom guard) epub.js clears every view and then display()s the last location IT reported. During a touch scroll that location
    // lags behind the finger, so the page "jumped back" a few screens at random. Read the live position just BEFORE the clear and re-display that instead.
    r.onResized = function (size, ecfi) {
      this.emit('resized', { width: size.width, height: size.height }, ecfi);
      const cfi = this.__fresh || (this.location && this.location.start && this.location.start.cfi); this.__fresh = null;
      if (cfi) this.display(cfi);
    };
    // epub.js debounces the resize, so this runs first: remember where the reader really is right now (see above)
    if (c.grabResize) window.removeEventListener('resize', c.grabResize, true);
    c.grabResize = () => { try { const l = r.currentLocation(); if (l && l.start && l.start.cfi) r.__fresh = l.start.cfi; } catch { /* ignore */ } };
    window.addEventListener('resize', c.grabResize, true); window.addEventListener('orientationchange', c.grabResize, true);
  }
  r.hooks.content.register((contents) => injectStyle(contents));
  r.hooks.content.register((contents) => wordSetup(contents));
  r.on('relocated', (loc) => { if (c.rendition !== r) return; c.loc = loc; AN.reposition(); updateProgress(loc); c.pager && c.pager.update(loc); });
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

/* ----- word lookup + glossary (v0.5.6) ----- */
function glossaryCtx() {
  const c = cur; return { book: c.book, epub: c.epub, toc: c.toc, goto: (x) => { if (x.cfi) c.rendition.display(x.cfi); },
    getSelection: () => { try { for (const k of c.rendition.getContents()) { const t = k.window.getSelection().toString(); if (t.trim()) return t; } } catch { /* ignore */ } return ''; } };
}
const wordActions = () => ({
  editEntry: (entry, term, _ctx, def) => openTermEditor(cur.book, { entry, term, def: entry ? undefined : def, onDone: () => {} }),
  openWords: () => openGlossary(glossaryCtx(), 'words'),
  search: (text) => openBookSearch(text),
  highlight: (range) => { const c = cur; if (!c) return; const k = c.rendition.getContents().find((x) => x.document === range.startContainer.ownerDocument); if (k) AN.quickHighlight(annotHost(), k, range); },
  select: (range) => { const c = cur; if (!c) return; const k = c.rendition.getContents().find((x) => x.document === range.startContainer.ownerDocument); if (k) AN.selectRange(annotHost(), k, range); },
});
function wordSetup(contents) {
  if (!cur) return;
  attachWordHold(contents.document, { book: () => (cur && cur.book), ready: () => !!(cur && cur.ready) && !justPinched(), cfi: (range) => contents.cfiFromRange(range), actions: wordActions() });
  refreshHighlights(contents);
  AN.attach(contents, annotHost);
}
/* ----- highlights & notes (v0.5.8) ----- */
function annotHost() {
  const c = cur; if (!c) return null;
  const secOff = (doc, range) => { try { const pre = doc.createRange(); pre.selectNodeContents(doc.body); pre.setEnd(range.startContainer, range.startOffset); return pre.toString().length; } catch { return 0; } };
  return {
    book: () => c.book, ready: () => cur === c && c.ready !== false && !c.closed, root: () => c.el, annotations: c.rendition && c.rendition.annotations,
    contents: () => { try { return c.rendition.getContents(); } catch { return []; } },
    viewerRect: () => c.viewer.getBoundingClientRect(), paginated: () => settings.get('flow') !== 'scrolled',
    pageInfo: () => { try { const l = c.rendition.currentLocation(); return l && l.start ? { page: l.end.displayed.page, total: l.end.displayed.total, startPage: l.start.displayed.page } : null; } catch { return null; } },
    next: () => c.rendition.next(), prev: () => c.rendition.prev(), scroller: () => c.rendition.manager && c.rendition.manager.container,
    describe: (contents, range) => ({ fmt: 'epub', cfiRange: contents.cfiFromRange(range), chapter: (() => { try { const href = c.epub.spine.get(contents.sectionIndex).href; const it = c.epub.navigation.get(href); return it ? (it.label || '').trim() : chapterOf({ start: { href } }); } catch { return ''; } })(), sec: contents.sectionIndex || 0, off: secOff(contents.document, range), progress: c.loc && c.loc.start ? c.loc.start.percentage || 0 : 0 }),
    jump: (a) => c.rendition.display(a.cfiRange),
    search: (text) => openBookSearch(text),
    define: (word, text, rect, range) => { import('./wordbubble.js').then((m) => m.openBubble({ word, text, offset: Math.max(0, text.indexOf(word)), rect, cfi: '', page: 0, book: c.book, range }, wordActions())); },
  };
}
window.addEventListener('folio-annots', () => { const hst = annotHost(); if (hst) AN.repaintAll(hst); });
async function refreshHighlights(contents) {
  const c = cur; if (!c) return;
  try { const f = await G.forBook(c.book); if (cur !== c) return; applyHighlights(contents.document, f.terms, !!settings.get('glossaryHighlight') && !c.fixed); } catch { /* ignore */ }
}
const refreshAllHighlights = () => { const c = cur; if (c && c.rendition) try { c.rendition.getContents().forEach(refreshHighlights); } catch { /* ignore */ } };
window.addEventListener('folio-glossary', refreshAllHighlights);
settings.onChange((p) => { if ('glossaryHighlight' in p) refreshAllHighlights(); });

/* ----- tap zones ----- */
function onTap(e) {
  if (Date.now() - swipedAt < 400) return;
  try { if (e.view.getSelection().toString()) return; } catch { /* ignore */ }
  if (cur && AN.selectModeTap(annotHost(), e)) return;
  if (cur && AN.annotTap(annotHost(), e)) return;
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
  if (!cur || !cur.rendition || $('#overlay').children.length || wordBubbleOpen()) return;
  if (e.key === 'ArrowRight') cur.rendition.next(); else if (e.key === 'ArrowLeft') cur.rendition.prev(); else if (e.key === 'Escape') closeReader();
}
function onHide() { if (document.hidden && cur) savePosition(true); }

/* ----- styles ----- */
// Every rule below carries the same specificity booster (two :not(#_) = two id-weights) so a book's own `.cls { font-size: 30px !important }` or `#id { … !important }` cannot beat it.
const BOOST = ':not(#_):not(#_)';
const SPECIAL = 'h1,h2,h3,h4,h5,h6,small,big,sub,sup,pre,code,kbd,samp,font,svg,svg *,math,math *,rt,rp,img,video,audio';
function buildCss() {
  const c = cur; const st = { ...S.effectiveStyle(c.book) }; if (c.previewPt != null) st.fontSizePt = c.previewPt; const t = THEMES[settings.get('theme')] || THEMES.light;
  const HL = `::highlight(folio-word) { background-color: ${t.accent}55; color: inherit; }\n::highlight(folio-gl) { text-decoration: underline dotted ${t.accent}; text-decoration-thickness: 2px; text-underline-offset: 3px; }\n` + AN.hlCss();
  if (c.fixed) return 'html, body { touch-action: manipulation; }\n::selection { background: ' + t.accent + '55; }\n' + HL;   // fixed-layout books keep the publisher's design (absolute positions, px sizes)
  const ff = FONTS[st.font]?.css || ''; const B = 'html body'; const ALL = `${B} ${BOOST}:not(${SPECIAL})`;
  return `
html, body { touch-action: manipulation; }
html { font-size: ${st.fontSizePt}pt !important; background: ${t.bg} !important; }
html body { font-size: 1em !important; color: ${t.fg} !important; background: ${t.bg} !important; ${ff ? `font-family: ${ff} !important;` : ''} -webkit-text-size-adjust: 100% !important; line-height: ${st.lineHeight} !important; }
/* every element follows the base size, whatever px / pt / rem / !important / id-rule the book uses (inline !important is stripped by script) */
${ALL} { font-size: inherit !important; line-height: ${st.lineHeight} !important; ${ff ? 'font-family: inherit !important;' : ''} }
/* proportional exceptions: headings, small print, sub/superscripts, <font size>, code */
${B} h1${BOOST} { font-size: 1.6em !important; } ${B} h2${BOOST} { font-size: 1.35em !important; } ${B} h3${BOOST} { font-size: 1.15em !important; } ${B} h4${BOOST}, ${B} h5${BOOST}, ${B} h6${BOOST} { font-size: 1em !important; }
${B} h1${BOOST}, ${B} h2${BOOST}, ${B} h3${BOOST}, ${B} h4${BOOST}, ${B} h5${BOOST}, ${B} h6${BOOST} { ${ff ? `font-family: ${ff} !important;` : ''} line-height: 1.25 !important; }
${B} small${BOOST} { font-size: .85em !important; } ${B} big${BOOST} { font-size: 1.2em !important; } ${B} sub${BOOST}, ${B} sup${BOOST} { font-size: .75em !important; }
${B} font${BOOST}[size="1"] { font-size: .8em !important; } ${B} font${BOOST}[size="2"] { font-size: .9em !important; } ${B} font${BOOST}[size="3"], ${B} font${BOOST}:not([size]) { font-size: 1em !important; } ${B} font${BOOST}[size="4"] { font-size: 1.1em !important; }
${B} font${BOOST}[size="5"] { font-size: 1.25em !important; } ${B} font${BOOST}[size="6"] { font-size: 1.5em !important; } ${B} font${BOOST}[size="7"] { font-size: 1.8em !important; }
${B} pre${BOOST}, ${B} code${BOOST}, ${B} kbd${BOOST}, ${B} samp${BOOST} { font-family: Menlo, Consolas, monospace !important; font-size: .9em !important; }
${B} pre${BOOST} code${BOOST} { font-size: 1em !important; }
body *${BOOST}:not(img):not(svg):not(a) { color: ${t.fg} !important; background-color: transparent !important; }
a${BOOST}, a${BOOST} * { color: ${t.accent} !important; }
::selection { background: ${t.accent}55; }
img, svg, video { max-width: 100% !important; height: auto; ${t.dark ? 'opacity:.92;' : ''} }
${HL}`;
}
/** Pinch → text size: the same value the Aa panel would set (this book's own size if it has one, else the global size). */
const pinchHost = {
  disabled: () => !!(cur && cur.fixed),
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
    if (!cur || !cur.fixed) stripInlineImportant(d);
  } catch (e) { console.warn(e); }
}
/** An inline `style="font-size:8px !important"` outranks any stylesheet rule, so the properties we own are removed from such elements. */
function stripInlineImportant(d) {
  for (const e of d.querySelectorAll('[style]')) { const sy = e.style; for (const k of ['font-size', 'line-height', 'font-family', 'color']) if (sy.getPropertyPriority(k) === 'important') sy.removeProperty(k); }
}
function applyMargin() {
  const st = S.effectiveStyle(cur.book);
  cur.viewer.style.paddingLeft = cur.viewer.style.paddingRight = st.margin + 'px';
}
let reflowTimer;
/** Re-apply appearance after any change, keeping the reading position. */
export function applyAppearance() {
  const c = cur; if (!c || !c.rendition) return;
  applyScrub(c.book); applyMargin();
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
// v0.5.19: the ☆ bookmark button is gone from the top bar (highlights cover it). Bookmarks saved earlier stay listed (and syncable / deletable) in Contents → Bookmarks.
function refreshBookmarkStar() { void pageBookmarks; }

/* ----- TOC & bookmarks sheet ----- */
/** v0.5.18: index (in the flattened TOC) of the entry the reader is in now — the last entry that starts at or before the current position (deepest wins on ties). -1 when unknown. */
/* v0.5.18: in continuous-scroll flow epub.js sometimes lands one section late after display(href) (neighbouring sections are prepended / trimmed
   and the scroll offset is not compensated), e.g. a short chapter near the end opened from Contents showed the next chapter. Re-align the target to the top. */
export function settleScrolled(c, href) {
  if (settings.get('flow') !== 'scrolled' || !href) return;
  const [file, frag] = String(href).split('#'); let sec = null; try { sec = c.epub.spine.get(file); } catch { /* bad href */ } if (!sec) return;
  const fix = () => { try {
    const m = c.rendition.manager; const sc = m && m.container; if (!sc || cur !== c) return; const views = m.views.all ? m.views.all() : m.views._views || [];
    const v = views.find((x) => x.section && x.section.index === sec.index); if (!v) return;
    let y = v.element.getBoundingClientRect().top;
    if (frag) { const doc = v.contents && v.contents.document; const el = doc && (doc.getElementById(decodeURIComponent(frag)) || doc.getElementsByName(frag)[0]); if (el) y = (v.iframe || v.element).getBoundingClientRect().top + el.getBoundingClientRect().top; }
    const d = y - sc.getBoundingClientRect().top; if (Math.abs(d) > 4) sc.scrollTop += d;
  } catch { /* ignore */ } };
  fix(); [120, 300, 600, 1000].forEach((ms) => setTimeout(fix, ms));
}
function scrolledTop(c) {
  try {
    if (settings.get('flow') !== 'scrolled') return null; const m = c.rendition.manager; const box = m && m.container && m.container.getBoundingClientRect(); if (!box) return null;
    const y = box.top + 8; const views = (m.views && (m.views.all ? m.views.all() : m.views._views)) || [];
    for (const v of views) { const r = v.element.getBoundingClientRect(); if (r.top <= y && r.bottom > y && v.section) return { index: v.section.index, frameTop: (v.iframe || v.element).getBoundingClientRect().top, y: box.top, h: box.height }; }
  } catch { /* fall back to loc */ }
  return null;
}
export function currentTocIndex(c, list) {
  const loc = c.loc; if (!loc || !loc.start || !list.length) return -1;
  // scrolled flow: epub.js reports a short section's *neighbour* as loc.start, so read what is actually at the top of the viewer instead
  const top = scrolledTop(c); const ci = top ? top.index : loc.start.index; let bestIdx = -1; let group = [];
  list.forEach(({ it }, i) => {
    let sec = null; try { sec = c.epub.spine.get((it.href || '').split('#')[0]) || c.epub.spine.get(it.href); } catch { /* bad href */ }
    const idx = sec ? sec.index : -1; if (idx < 0 || idx > ci) return;
    if (idx > bestIdx) { bestIdx = idx; group = []; } if (idx === bestIdx) group.push(i);
  });
  if (!group.length) return -1; if (group.length === 1 || bestIdx < ci) return group[group.length - 1];
  // several entries in the current file: compare each anchor's position with the start of the page
  let best = group[0]; let contents = null; try { contents = c.rendition.getContents().find((x) => x.sectionIndex === ci); } catch { /* none */ }
  const sec = c.epub.spine.get(ci);
  for (const i of group) {
    const frag = (list[i].it.href || '').split('#')[1]; if (!frag) { best = i; continue; }
    const el = contents && contents.document && (contents.document.getElementById(decodeURIComponent(frag)) || contents.document.getElementsByName(frag)[0]); if (!el || !sec) continue;
    if (top) { if (el.getBoundingClientRect().top + top.frameTop <= top.y + top.h * 0.33) best = i; continue; }   // heading at/above the upper third of the screen
    try { const cfi = new ePub.CFI(el, sec.cfiBase).toString(); if (new ePub.CFI().compare(cfi, loc.start.cfi) <= 0) best = i; } catch { /* ignore */ }
  }
  return best;
}
/** True when entry i is a TOC ancestor of entry k (nested entries: its depth is smaller and nothing shallower sits in between). */
function isAncestor(list, i, k) { if (i >= k) return false; let d = list[k].depth; for (let j = k - 1; j >= i; j--) { if (list[j].depth < d) { if (j === i) return true; d = list[j].depth; } } return false; }
/** Scroll the open Contents list so the current entry is in view (centred). */
export function scrollTocToCurrent(root) {
  const go = () => { const el = root.querySelector('.toc-item.current'); if (el && el.isConnected) { el.scrollIntoView({ block: 'center' }); return true; } return false; };
  requestAnimationFrame(() => { if (!go()) setTimeout(go, 60); });
}
function openBookSearch(query) { closeBubble(); AN.closeSelectionUI(true); import('./booksearch.js').then((m) => m.openSearch(searchHost(), query)).catch((e) => toast('Search failed to load: ' + e.message)); }
/** v0.5.18: search adapter for EPUB (and MOBI / KF8, which open as converted EPUB): one unit per spine section, loaded straight from the book archive. */
function searchHost() {
  const c = cur; if (!c || !c.epub) return null; if (c.__search) return c.__search;
  const items = c.epub.spine.spineItems || []; const flat = (xs, d = 0) => xs.flatMap((it) => [{ it, depth: d }, ...flat(it.subitems || [], d + 1)]);
  const toc = flat(c.toc || []); const labels = new Array(items.length).fill('');
  const starts = toc.map(({ it }) => { try { const sec = c.epub.spine.get((it.href || '').split('#')[0]); return sec ? sec.index : -1; } catch { return -1; } });
  for (let i = 0; i < items.length; i++) { let best = -1, bi = -1; starts.forEach((x, k) => { if (x >= 0 && x <= i && x >= best) { if (x > best || bi < 0) { best = x; bi = k; } } }); labels[i] = bi >= 0 ? (toc[bi].it.label || '').trim() : ''; }
  let SB = null; const B = () => SB || import('./booksearch.js').then((m) => (SB = m));
  const flashOld = { cfi: null };
  const ad = {
    key: c.book.id, units: items.length, root: () => c.el, label: (i) => labels[i] || ('Section ' + (i + 1)),
    async scan(i, q) {
      const sec = items[i]; if (!sec) return []; const M = await B();
      const doc = await c.epub.load(sec.url); const body = doc && (doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement); if (!body) return [];
      const nodes = []; let text = ''; const w = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/^(script|style)$/i.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) }); let n;
      while ((n = w.nextNode())) { nodes.push([n, text.length]); text += n.data; }
      const at = (pos, end) => { let lo = 0, hi = nodes.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid][1] < pos || (!end && nodes[mid][1] === pos)) lo = mid; else hi = mid - 1; } const [node, base] = nodes[lo]; return [node, Math.min(node.data.length, pos - base)]; };
      // entries with #anchors inside this file (e.g. Chapter 2 › Section 2.2): label each hit with the deepest one before it
      const anchors = []; toc.forEach(({ it }, k) => { const [f, frag] = (it.href || '').split('#'); if (!frag || starts[k] !== i) return; const el = doc.getElementById(decodeURIComponent(frag)) || doc.getElementsByName(frag)[0]; if (el) anchors.push({ el, label: (it.label || '').trim() }); });
      const labelAt = (node) => { let l = null; for (const a of anchors) if (a.el === node || (a.el.compareDocumentPosition(node) & 4 /* FOLLOWING */) || a.el.contains(node)) l = a.label; return l; };
      return M.findAll(text, q).map((m) => { let cfi = null; const lab = anchors.length ? labelAt(at(m.start, false)[0]) : null; try { const r = doc.createRange(); r.setStart(...at(m.start, false)); r.setEnd(...at(m.end, true)); cfi = new ePub.CFI(r, sec.cfiBase).toString(); } catch { /* odd markup */ } return { target: { cfi, index: i, href: sec.href }, text, start: m.start, end: m.end, label: lab || undefined }; });
    },
    async show(hit) {
      const M = await B(); ad.clearFlash(); const t = hit.target;
      await c.rendition.display(t.cfi || t.href);
      if (!t.cfi) return;
      for (let k = 0; k < 20; k++) {
        const contents = (() => { try { return c.rendition.getContents().find((x) => x.sectionIndex === t.index); } catch { return null; } })();
        if (contents) { let r = null; try { r = new ePub.CFI(t.cfi).toRange(contents.document); } catch { /* ignore */ }
          if (r) { if (!M.flashRange(r)) { try { c.rendition.annotations.highlight(t.cfi, {}, () => {}, 'bs-flash', { fill: '#ffb300', 'fill-opacity': '0.5', 'mix-blend-mode': 'multiply' }); flashOld.cfi = t.cfi; setTimeout(() => ad.clearFlash(), 4000); } catch { /* ignore */ } }
            if (settings.get('flow') === 'scrolled') { const fix = () => { try { if (!r.startContainer.isConnected) return; const rect = r.getBoundingClientRect(); const sc = c.rendition.manager && c.rendition.manager.container; const fr = contents.document.defaultView.frameElement; if (sc && fr) { const top = fr.getBoundingClientRect().top + rect.top - sc.getBoundingClientRect().top; if (top < 40 || top > sc.clientHeight - 60) sc.scrollTop += top - sc.clientHeight * 0.3; } } catch { /* ignore */ } }; fix(); [120, 300, 600, 1000].forEach((ms) => setTimeout(fix, ms)); }   // epub.js may add/trim neighbouring sections (shifting the scroll) right after display()
            return; } }
        await new Promise((res) => setTimeout(res, 100));
      }
    },
    clearFlash() { if (SB) SB.clearAllFlashes(); if (flashOld.cfi) { try { c.rendition.annotations.remove(flashOld.cfi, 'highlight'); } catch { /* ignore */ } flashOld.cfi = null; } },
  };
  c.__search = ad; return ad;
}
function showToc() {
  const c = cur;
  const flat = (items, depth = 0) => items.flatMap((it) => [{ it, depth }, ...flat(it.subitems || [], depth + 1)]);
  let tab = 'toc';
  const w = sheet('Contents', () => build(), { tall: true });
  const rebuild = () => { w.body.replaceChildren(build()); AN_count().then((changed) => { if (changed && !w.closed) w.body.replaceChildren(build()); }); };   // synchronous tab switch; the count in the tab label catches up
  AN_count().then((changed) => { if (changed) w.body.replaceChildren(build()); });
  async function AN_count() { try { const n = (await (await import('./annots.js')).forBook(c.book)).length; if (n !== c.annotCount) { c.annotCount = n; return true; } } catch { /* ignore */ } return false; }
  function build() {
    const wrap = h('div');
    if (tab === 'bookmarks' && !c.bookmarks.length) tab = 'toc';
    wrap.append(h('div', { class: 'seg wide' }, ['toc', ...(c.bookmarks.length ? ['bookmarks'] : []), 'notes'].map((t) => h('button', { class: tab === t ? 'on' : '', 'data-tab': t, onclick: () => { tab = t; rebuild(); } }, t === 'toc' ? 'Chapters' : t === 'bookmarks' ? 'Bookmarks (' + c.bookmarks.length + ')' : 'Highlights & Notes' + (c.annotCount ? ' (' + c.annotCount + ')' : ''))).concat(h('button', { id: 'toc-words', 'data-tab': 'words', onclick: () => { w.close(); openGlossary(glossaryCtx()); } }, 'Words'))));
    if (tab === 'notes') { const holder = h('div', { id: 'an-pane' }); wrap.append(holder); AN.listTab(annotHost(), rebuild, () => w.close()).then((el) => holder.replaceChildren(el)); }
    else if (tab === 'toc') {
      const list = flat(c.toc); const now = currentTocIndex(c, list);
      wrap.append(h('button', { class: 'list-item bs-open', id: 'toc-search', onclick: () => { w.close(); openBookSearch(); } }, h('span', null, '🔍'), h('span', { class: 'grow muted' }, 'Search in this book…')));
      if (c.hasAudio) wrap.append(h('button', { class: 'list-item bs-open', id: 'toc-audiosync', onclick: () => { w.close(); import('./findplace.js').then((m) => m.openFindPlace({ bookId: c.book.id })); } }, h('span', null, '🎧'), h('span', { class: 'grow' }, 'Audiobook sync'), h('small', { class: 'muted' }, 'Find my place')));
      wrap.append(h('div', { class: 'list', id: 'toc-list' }, list.length ? list.map(({ it, depth }, i) => h('button', { class: 'list-item toc-item' + (i === now ? ' current' : '') + (now >= 0 && isAncestor(list, i, now) ? ' current-parent' : ''), 'aria-current': i === now ? 'true' : null, style: { paddingLeft: (14 + depth * 16) + 'px' }, onclick: async () => { w.close(); await c.rendition.display(it.href); settleScrolled(c, it.href); } }, h('span', { class: 'grow' }, (it.label || '').trim()), i === now ? h('small', { class: 'toc-now' }, 'Current') : null)) : h('p', { class: 'muted pad' }, 'This book has no table of contents.')));
      scrollTocToCurrent(wrap);
    }
    else wrap.append(h('div', { class: 'list' }, c.bookmarks.length ? [...c.bookmarks].sort((a, b) => a.progress - b.progress).map((bm) => h('div', { class: 'list-item' },
      h('span', { class: 'grow', onclick: async () => { w.close(); await c.rendition.display(bm.cfi); } }, bm.label, h('small', { class: 'muted' }, ' · ' + fmtPct(bm.progress))),
      h('button', { class: 'btn-icon', 'aria-label': 'Delete bookmark', onclick: async () => { await S.removeBookmark(bm.id); c.bookmarks = c.bookmarks.filter((x) => x.id !== bm.id); refreshBookmarkStar(); rebuild(); } }, '✕'))) : h('p', { class: 'muted pad' }, 'No bookmarks.')));
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
    if (c.fixed) wrap.append(h('p', { class: 'hint', id: 'fixed-note' }, 'This is a fixed-layout book: the publisher’s page design (absolute positions and sizes) is kept, so text size, font and line spacing can’t change it. Theme, margins and Pages/Scroll still work.'));
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
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Footer')), ...footerToggles(), scrubToggle({ book: c.book, onWrite: (v) => write('hideScrub', v), useGlobal: useGlobal('hideScrub', 'Use global') }));
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Word lookup')), h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', id: 'aa-wordlookup', checked: !!settings.get('wordLookup'), onchange: (e) => settings.set({ wordLookup: e.target.checked }) }), h('span', null, 'Press and hold a word for its definition')), h('button', { class: 'btn block', id: 'aa-glossary', onclick: () => { w.close(); openGlossary(glossaryCtx()); } }, 'Words & glossary'));
    ui.reset = h('button', { class: 'btn block', id: 'reset-book', hidden: !S.hasOverrides(c.book), onclick: async () => { c.book = await S.resetOverrides(c.book.id); scope = 'global'; applyAppearance(); w.body.replaceChildren(build()); toast('This book now uses the global defaults'); } }, 'Reset this book to defaults');
    wrap.append(ui.reset);
    return wrap;
  }
  return w;
}

/* ----- close ----- */
export async function closeReader() {
  if (pdfCurrent()) return closePdf();
  const c = cur; if (!c) return; cur = null; closeBubble(); AN.closeSelectionUI(true); AN.disarm(); import('./booksearch.js').then((m) => m.resetSearch()).catch(() => {});
  window.removeEventListener('keydown', keyNav); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('resize', onResize);
  c.closed = true; c.pager && c.pager.stop(); if (c.grabResize) { window.removeEventListener('resize', c.grabResize, true); window.removeEventListener('orientationchange', c.grabResize, true); }
  cur = c; try { await savePosition(); } catch { /* ignore */ } cur = null;
  try { c.rendition && c.rendition.destroy(); } catch { /* ignore */ }
  try { c.epub && c.epub.destroy(); } catch { /* ignore */ }
  const el = root(); el.hidden = true; el.replaceChildren(); el.classList.remove('chrome-hidden'); document.body.classList.remove('reading');
  $('#overlay').replaceChildren(); $('#overlay').hidden = true;
  const { refreshLibrary } = await import('./library.js'); refreshLibrary();
  window.dispatchEvent(new Event('reader-closed'));
}
/** Save the exact reading position right now (before an app update reloads the page). */
export async function flushPosition() { if (pdfCurrent()) return flushPdfPosition(); if (cur) await savePosition(); }
export const currentReader = () => cur || pdfCurrent();

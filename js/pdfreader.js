// PDF reader (pdf.js): paged + continuous-scroll modes, pinch / buttons zoom, fit-width, page jump, per-book position + zoom,
// theme via viewer background (optionally inverting pages for dark themes). Font / margin / line-spacing don't apply to PDFs.
import { h, toast, sheet, debounce, $, fmtPct } from './util.js';
import { settings, THEMES, FONTS, FONT_MIN, FONT_MAX, FONT_STEP, clampPt } from './settings.js';
import { pageBlocks } from './pdftext.js';
import { attachPinch } from './pinch.js';
import * as S from './store.js';
import { openPdfDocument } from './pdf.js';
import { fsButton } from './fullscreen.js';
import { makeLoading, withTimeout } from './openguard.js';
import { makeFooter, applyFooterSettings, paintFooter, footerToggles, applyScrub, scrubToggle } from './pages.js';
import { registerOpenCheck } from './positions.js';
import { attachWordHold, closeBubble } from './wordbubble.js';
import { openGlossary, openTermEditor } from './glossaryui.js';
import * as AN from './annotui.js';

let cur = null;
registerOpenCheck((kind, id) => kind === 'book' && !!cur && cur.book.id === id);
export const pdfCurrent = () => cur;
const ZMIN = 0.5, ZMAX = 5;
const root = () => $('#reader');

export async function openPdf(book, blob, opts = {}) {
  const el = root(); el.hidden = false; document.body.classList.add('reading'); el.classList.add('pdf-mode');
  const viewer = h('div', { id: 'viewer', class: 'pdf-viewer' });
  const slider = h('input', { type: 'range', min: 1, max: 1, value: 1, id: 'r-slider', 'aria-label': 'Page', disabled: true });
  const pageNum = h('input', { type: 'number', id: 'pdf-page-num', class: 'num', min: 1, inputmode: 'numeric', 'aria-label': 'Go to page', disabled: true });
  const total = h('span', null, ' of –'); const pct = h('span', { class: 'muted' }, '');
  const label = h('div', { class: 'r-label pdf-jump' }, 'Page ', pageNum, total, pct);
  const tocBtn = h('button', { class: 'btn-icon', id: 'r-toc', 'aria-label': 'Outline', hidden: true, onclick: showOutline }, '☰');
  const top = h('div', { class: 'r-bar top' },
    h('button', { class: 'btn-icon', id: 'r-back', 'aria-label': 'Close book', onclick: closePdf }, '‹'),
    h('div', { class: 'grow r-titlewrap' }, h('div', { class: 'r-title ellipsis' }, book.title), h('span', { class: 'ovr-dot', hidden: false, style: { background: 'var(--accent)', color: '#fff' } }, 'PDF')),
    h('button', { class: 'btn-icon', id: 'pdf-zout', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.25) }, '−'),
    h('button', { class: 'btn-icon', id: 'pdf-zin', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.25) }, '+'),
    h('button', { class: 'btn-icon', id: 'pdf-fit', 'aria-label': 'Fit width', title: 'Fit width', onclick: () => setZoom(1) }, '⤢'),
    h('button', { class: 'btn-icon', id: 'r-notes', 'aria-label': 'Highlights and notes', hidden: true, onclick: showPdfNotes }, '✎'),
    tocBtn,
    fsButton({ class: 'btn-icon', id: 'r-fs' }, { icon: true }),
    h('button', { class: 'btn-icon', id: 'r-aa', 'aria-label': 'Appearance', onclick: showSettings }, 'Aa'));
  const bottom = h('div', { class: 'r-bar bottom' }, slider, label);
  const loading = makeLoading({ book: { ...book, format: 'pdf' }, onBack: () => closePdf(), onRetry: async () => { await closePdf(); const { openReader } = await import('./reader.js'); openReader(book.id); } });
  el.replaceChildren(top, viewer, bottom, makeFooter(), loading.el); applyFooterSettings(); paintFooter({}); applyScrub(book);
  cur = { isPdf: true, book, viewer, slider, pageNum, total, pct, el, top, bottom, chrome: true, page: 1, n: 0, zoom: book.pdfZoom || 1, textMode: !!book.pdfText, pages: [], finishedThisSession: false, progress: book.progress || 0, ready: false };
  const c = cur;
  const gctx = () => ({ book: cur.book, epub: null, toc: [], getSelection: () => (window.getSelection ? window.getSelection().toString() : ''), goto: (x) => { if (x.page) goTo(x.page); } });
  attachWordHold(viewer, { book: () => (cur && cur.book), ready: () => !!(cur && cur.textMode && cur.ready), page: (node) => +((node.parentElement && node.parentElement.closest('.pdf-tpage'))?.dataset.page || 0),
    actions: { editEntry: (entry, term, _ctx, def) => openTermEditor(cur.book, { entry, term, def: entry ? undefined : def }), openWords: () => openGlossary(gctx(), 'words'), select: (range) => { if (cur && cur.textMode) AN.selectRange(pdfAnnotHost(), pdfAnnotHost().contents()[0], range); } } });   // word lookup works in the Text (reflow) view
  AN.attachPdf(pdfAnnotHost(), viewer);
  c.glossaryCtx = gctx;
  try {
    loading.stage('Reading the file…'); const buf = await withTimeout(blob.arrayBuffer(), 20000, 'reading the file from storage'); if (cur !== c) return;
    loading.stage('Loading the PDF…'); c.pdf = await withTimeout(openPdfDocument(buf), 25000, 'loading the PDF'); if (cur !== c) return;
    c.n = c.pdf.numPages; slider.max = c.n; slider.disabled = false; pageNum.max = c.n; pageNum.disabled = false; total.textContent = ' of ' + c.n;
    loading.stage('Drawing the first page…'); const p1 = await withTimeout(c.pdf.getPage(1), 15000, 'reading the first page'); c.ar = p1.getViewport({ scale: 1 }); 
    c.page = Math.min(c.n, Math.max(1, book.pdfPage || 1));
    if (cur !== c) return; loading.done(); c.ready = true; draw(true); S.saveBook(await touchOpened(book));
    c.pdf.getOutline().then(async (o) => { c.outline = o; tocBtn.hidden = !(o && o.length); await resolveSections(c); syncUI(); }).catch(() => {});
  } catch (e) { if (cur !== c) return; console.error(e); loading.fail(e); return; }
  slider.addEventListener('input', () => { pageNum.value = slider.value; });
  slider.addEventListener('change', () => goTo(+slider.value));
  pageNum.addEventListener('change', () => goTo(+pageNum.value));
  viewer.addEventListener('click', onTap);
  setupTouch(c); attachPinch(viewer, pinchHost);
  window.addEventListener('keydown', keyNav); document.addEventListener('visibilitychange', onHide); window.addEventListener('resize', onResize);
  window.__pdf = c;
}
async function touchOpened(book) { const b = await S.getBook(book.id); b.lastOpened = Date.now(); return b; }

/* ---------- layout / rendering ---------- */
const themeNow = () => THEMES[settings.get('theme')] || THEMES.light;
const modeNow = () => (settings.get('flow') === 'scrolled' ? 'scroll' : 'paged');
function pageSize(c) {
  const avail = c.viewer.clientWidth - 16; const w = Math.max(80, avail * c.zoom);
  return { w, h: w * (c.ar.height / c.ar.width) };
}
function styleViewer(c) {
  const t = themeNow(); const inv = t.dark && settings.get('pdfInvert') !== false;
  c.viewer.style.background = t.bg; c.viewer.classList.toggle('pdf-inv', inv); c.viewer.classList.toggle('pdf-dark', t.dark && !inv); c.viewer.classList.toggle('pdf-multiply', !t.dark);
}
function draw(first) {
  const c = cur; if (!c || !c.ready) return;
  styleViewer(c); c.mode = c.textMode ? 'scroll' : modeNow();
  c.io && c.io.disconnect(); c.pages.forEach(cancelRender); c.pages = []; c.viewer.replaceChildren();
  c.viewer.classList.toggle('pdf-text-mode', !!c.textMode); updateZoomUI();
  if (c.textMode) return drawText(c);
  c.viewer.classList.toggle('scroll-mode', c.mode === 'scroll'); c.viewer.classList.toggle('paged-mode', c.mode === 'paged');
  const sz = pageSize(c);
  if (c.mode === 'paged') {
    const slot = pageEl(c, c.page, sz); c.viewer.append(h('div', { class: 'pdf-stage' }, slot)); c.pages = [slot]; renderPage(c, slot);
    c.viewer.scrollTo(0, 0);
  } else {
    const stage = h('div', { class: 'pdf-stage col' }); c.viewer.append(stage);
    for (let i = 1; i <= c.n; i++) { const s = pageEl(c, i, sz); stage.append(s); c.pages.push(s); }
    c.io = new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting) renderPage(c, e.target); else cancelRender(e.target, true); } }, { root: c.viewer, rootMargin: '100% 0px' });
    c.pages.forEach((p) => c.io.observe(p));
    c.viewer.onscroll = onScroll;
    const target = c.pages[c.page - 1]; if (target) c.viewer.scrollTop = target.offsetTop - 8;
  }
  syncUI();
}
/* ---------- Text view (reflow): the text size / font / line spacing / margins settings apply here ---------- */
const stl = (c) => S.effectiveStyle(c.book);
function styleText(c, ptOverride) {
  const t = themeNow(); const st = stl(c); const v = c.viewer; const ff = FONTS[st.font]?.css || '';
  v.style.background = t.bg; v.style.color = t.fg; v.style.fontSize = (ptOverride ?? st.fontSizePt) + 'pt'; v.style.lineHeight = st.lineHeight; v.style.fontFamily = ff || 'Georgia, "Times New Roman", serif';
  v.style.setProperty('--pdf-tm', st.margin + 'px'); v.style.setProperty('--pdf-accent', t.accent); v.classList.remove('pdf-inv', 'pdf-dark', 'pdf-multiply');
}
function drawText(c) {
  styleText(c);
  const stage = h('div', { class: 'pdf-tstage' }); c.viewer.append(stage);
  c.textCache = c.textCache || new Map();
  for (let i = 1; i <= c.n; i++) { const s = h('section', { class: 'pdf-tpage', dataset: { page: i } }, h('div', { class: 'pdf-tp-n' }, 'Page ' + i)); stage.append(s); c.pages.push(s); }
  c.io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) fillText(c, e.target); }, { root: c.viewer, rootMargin: '150% 0px' });
  c.pages.forEach((p) => c.io.observe(p));
  c.viewer.onscroll = onScroll;
  const target = c.pages[c.page - 1]; if (target) { fillText(c, target); c.viewer.scrollTop = target.offsetTop - 4; }
  syncUI();
}
/* ----- highlights & notes in the Text (reflow) view (v0.5.8) ----- */
const BLOCKS = ':scope > p, :scope > h3';
const pseudo = { document, window, __pdf: true };
function pdfAnnotHost() {
  const c = cur; if (!c) return null; if (c.__ah) return c.__ah;
  const blocksOf = (slot) => [...slot.querySelectorAll(BLOCKS)].filter((x) => !x.classList.contains('pdf-empty'));
  const pos = (node, off, end) => {   // a boundary point of the selection → { page, idx, off } inside a text block
    let el = node.nodeType === 1 ? node : node.parentElement; let blk = el && el.closest('.pdf-tpage > p, .pdf-tpage > h3');
    if (blk) { const r = document.createRange(); r.selectNodeContents(blk); r.setEnd(node, off); const slot = blk.parentElement; return { page: +slot.dataset.page, idx: blocksOf(slot).indexOf(blk), off: r.toString().length }; }
    const slotOf = (x) => x.closest && x.closest('.pdf-tpage'); const sl = slotOf(el);
    if (sl && el === sl) { const bs = blocksOf(sl); const kids = [...sl.children]; const cand = end ? kids.slice(0, off).filter((k) => bs.includes(k)).pop() : kids.slice(off).find((k) => bs.includes(k)); if (cand) return { page: +sl.dataset.page, idx: bs.indexOf(cand), off: end ? cand.textContent.length : 0 }; }
    if (el.classList && el.classList.contains('pdf-tstage')) { const slot = el.children[Math.max(0, end ? off - 1 : off)]; if (slot) { const bs = blocksOf(slot); const b = end ? bs[bs.length - 1] : bs[0]; if (b) return { page: +slot.dataset.page, idx: bs.indexOf(b), off: end ? b.textContent.length : 0 }; } }
    return null;
  };
  c.__ah = {
    pdf: true, book: () => c.book, ready: () => cur === c && c.textMode && c.ready, root: () => c.el, annotations: null, contents: () => [pseudo], viewerRect: () => c.viewer.getBoundingClientRect(),
    paginated: () => false, pageInfo: () => null, next() {}, prev() {}, scroller: () => c.viewer, viewer: c.viewer,
    describe: (contents, range) => {
      const sp = pos(range.startContainer, range.startOffset, false), ep = pos(range.endContainer, range.endOffset, true); if (!sp || !ep) throw new Error('select text inside the page text');
      return { fmt: 'pdf', cfiRange: '', loc: { sp, ep }, chapter: '', sec: sp.page, off: sp.idx * 100000 + sp.off, progress: c.n ? (sp.page - 1) / c.n : 0 };
    },
    locate: ({ page, idx, off }) => {
      const slot = c.pages[page - 1]; if (!slot || !slot.dataset.filled) return null; const blk = blocksOf(slot)[idx]; if (!blk) return null;
      const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT); let n, acc = 0, last = null; while ((n = w.nextNode())) { last = n; if (off <= acc + n.data.length) return { n, o: off - acc }; acc += n.data.length; }
      return last ? { n: last, o: last.data.length } : null;
    },
    jump: async (a) => {
      if (!c.textMode) { goTo(a.loc.sp.page); return; } goTo(a.loc.sp.page);
      for (let i = 0; i < 30; i++) { const l = pdfAnnotHost().locate(a.loc.sp); if (l) { const el = l.n.parentElement; c.viewer.scrollTo({ top: Math.max(0, el.offsetTop + (el.offsetParent ? el.offsetParent.offsetTop : 0) - c.viewer.clientHeight * 0.3) }); return; } await new Promise((r) => setTimeout(r, 100)); }
    },
    define: (word, text, rect) => { import('./wordbubble.js').then((m) => m.openBubble({ word, text, offset: Math.max(0, text.indexOf(word)), rect, cfi: '', page: 0, book: c.book }, { editEntry: (entry, term, _ctx, def) => openTermEditor(c.book, { entry, term, def: entry ? undefined : def }), openWords: () => openGlossary(c.glossaryCtx(), 'words') })); },
  };
  return c.__ah;
}
window.addEventListener('folio-annots', () => { if (cur && cur.textMode) AN.repaintAll(pdfAnnotHost()); });
function showPdfNotes() {
  const c = cur; if (!c) return; const host = pdfAnnotHost(); let w;
  const rebuild = async () => { w.body.replaceChildren(await AN.listTab(host, rebuild, () => w.close())); };
  w = sheet('Highlights & Notes', () => h('div', { id: 'an-pane' }), { tall: true }); rebuild();
}
async function fillText(c, slot) {
  if (slot._filled) return; slot._filled = true; const n = +slot.dataset.page;
  try {
    let blocks = c.textCache.get(n); if (!blocks) { const page = await c.pdf.getPage(n); blocks = await pageBlocks(page); page.cleanup(); c.textCache.set(n, blocks); }
    if (cur !== c) return;
    if (!blocks.length) slot.append(h('p', { class: 'pdf-empty' }, 'No selectable text on this page (a scanned image?). Switch to Original pages to see it.'));
    else slot.append(...blocks.map((b) => h(b.k === 'h' ? 'h3' : 'p', null, b.text)));
    slot.dataset.filled = '1'; if (c.__ah) AN.repaintAll(c.__ah);
  } catch (e) { slot._filled = false; console.warn('text', n, e); }
}
/** Write one style value like the EPUB Aa panel does: to this book if it has its own, else to the global setting. */
async function writeStyle(k, v) {
  const c = cur; if (!c) return;
  if (c.scopeBook) c.book = await S.setOverride(c.book.id, { [k]: v }); else settings.set({ [k]: v });
  if (c.textMode) styleText(c);
  applyScrub(c.book);
}
const pinchHost = {
  disabled: () => !(cur && cur.textMode),
  getPt: () => (cur ? S.effectiveStyle(cur.book).fontSizePt : settings.get('fontSizePt')),
  pinched: () => { if (cur) cur.gestureAt = Date.now(); },
  apply: (pt, final) => { const c = cur; if (!c || !c.textMode) return; if (!final) { styleText(c, pt); return; } c.scopeBook = !!(c.book.overrides && c.book.overrides.fontSizePt != null); writeStyle('fontSizePt', pt); },
};
export function setTextMode(on) {
  const c = cur; if (!c) return; c.textMode = !!on; c.textCache = c.textCache || new Map();
  c.viewer.style.cssText = ''; draw(); saveSoon();
}
function pageEl(c, n, sz) { return h('div', { class: 'pdf-page', dataset: { page: n }, style: { width: sz.w + 'px', height: sz.h + 'px' } }); }
function cancelRender(slot, clear) {
  try { slot._task && slot._task.cancel(); } catch { /* ignore */ }
  slot._task = null; if (clear) { slot.replaceChildren(); slot._key = null; }
}
async function renderPage(c, slot) {
  const n = +slot.dataset.page; const key = n + ':' + Math.round(c.viewer.clientWidth * c.zoom);
  if (slot._key === key) return; slot._key = key; cancelRender(slot);
  try {
    const page = await c.pdf.getPage(n); if (cur !== c) return;
    const v1 = page.getViewport({ scale: 1 }); const w = Math.max(80, (c.viewer.clientWidth - 16) * c.zoom); const scale = w / v1.width;
    const vp = page.getViewport({ scale }); const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = h('canvas', { class: 'pdf-canvas' }); canvas.width = Math.round(vp.width * dpr); canvas.height = Math.round(vp.height * dpr);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    slot.style.width = vp.width + 'px'; slot.style.height = vp.height + 'px';
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, background: 'rgb(255,255,255)' });
    slot._task = task; await task.promise; if (cur !== c || slot._key !== key) return;
    slot.replaceChildren(canvas); slot.dataset.rendered = '1'; page.cleanup();
  } catch (e) { if (!(e && e.name === 'RenderingCancelledException')) { console.warn('render', n, e); slot._key = null; } }
}

/* ---------- navigation ---------- */
function goTo(n) {
  const c = cur; if (!c) return; n = Math.min(c.n, Math.max(1, Math.round(n) || 1));
  c.page = n;
  if (c.mode === 'paged') draw(); else { const p = c.pages[n - 1]; if (p) c.viewer.scrollTo({ top: p.offsetTop - 8 }); syncUI(); }
  saveSoon();
}
const next = () => { const c = cur; if (c.mode === 'paged') { if (c.page < c.n) goTo(c.page + 1); } else c.viewer.scrollBy({ top: c.viewer.clientHeight * 0.9, behavior: 'smooth' }); };
const prev = () => { const c = cur; if (c.mode === 'paged') { if (c.page > 1) goTo(c.page - 1); } else c.viewer.scrollBy({ top: -c.viewer.clientHeight * 0.9, behavior: 'smooth' }); };
function onScroll() {
  const c = cur; if (!c || c.mode !== 'scroll') return;
  const mid = c.viewer.scrollTop + c.viewer.clientHeight * 0.3; let p = 1;
  for (const s of c.pages) { if (s.offsetTop <= mid) p = +s.dataset.page; else break; }
  if (c.viewer.scrollTop + c.viewer.clientHeight >= c.viewer.scrollHeight - 4) p = c.n;
  if (p !== c.page) { c.page = p; syncUI(); saveSoon(); }
}
/** Outline entries → sorted 1-based start pages (for "pages left in section"). Empty when the PDF has no usable outline. */
async function resolveSections(c) {
  const starts = new Set(); const walk = async (items) => { for (const it of items || []) {
    try { let dest = it.dest; if (typeof dest === 'string') dest = await c.pdf.getDestination(dest); if (dest) { const ref = dest[0]; const idx = typeof ref === 'object' ? await c.pdf.getPageIndex(ref) : ref; if (Number.isInteger(idx)) starts.add(idx + 1); } } catch { /* unresolved entry */ }
    await walk(it.items); } };
  await walk(c.outline); c.sections = [...starts].filter((p) => p >= 1 && p <= c.n).sort((a, b) => a - b);
}
/** Pages remaining until the next outline section starts (null without an outline). */
export function pdfPagesLeft(c) {
  if (!c.sections || !c.sections.length) return null;
  const nextStart = c.sections.find((p) => p > c.page); return (nextStart ? nextStart : c.n + 1) - 1 - c.page;
}
function syncUI() {
  const c = cur; if (!c) return;
  paintFooter({ page: c.page, total: c.n, left: pdfPagesLeft(c), unit: 'section' });
  c.slider.value = c.page; if (document.activeElement !== c.pageNum) c.pageNum.value = c.page;
  c.progress = c.n > 1 ? (c.page - 1) / (c.n - 1) : 1; c.pct.textContent = ' · ' + fmtPct(c.progress);
}
function onTap(e) {
  const c = cur; if (!c || Date.now() - (c.gestureAt || 0) < 450) return;
  const r = c.viewer.getBoundingClientRect(); const ratio = (e.clientX - r.left) / r.width; const mode = settings.get('tapZones');
  if (c.mode === 'paged' && mode !== 'off') {
    const left = mode === 'inverted' ? next : prev, right = mode === 'inverted' ? prev : next;
    if (ratio < 0.25) return left(); if (ratio > 0.75) return right();
  }
  c.chrome = !c.chrome; c.el.classList.toggle('chrome-hidden', !c.chrome);
}
function keyNav(e) {
  if (!cur || $('#overlay').children.length || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') next(); else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev(); else if (e.key === 'Escape') closePdf();
  else if (e.key === '+' || e.key === '=') zoomBy(1.25); else if (e.key === '-') zoomBy(1 / 1.25); else if (e.key === '0') setZoom(1);
}
const onHide = () => { if (document.hidden && cur) savePosition(); };
let rzT; const onResize = () => { clearTimeout(rzT); rzT = setTimeout(() => { if (cur && cur.ready) draw(); }, 200); };

/* ---------- zoom (buttons, fit width, pinch) + swipe ---------- */
export function setZoom(z) { const c = cur; if (!c || c.textMode) return; z = Math.min(ZMAX, Math.max(ZMIN, z)); c.zoom = Math.round(z * 100) / 100; c.stageScale = 1; c.viewer.querySelectorAll('.pdf-stage').forEach((s) => { s.style.transform = ''; });
  const keep = c.mode === 'scroll' ? (c.viewer.scrollTop - (c.pages[c.page - 1]?.offsetTop || 0)) / (c.pages[c.page - 1]?.offsetHeight || 1) : 0;
  draw(); if (c.mode === 'scroll') { const p = c.pages[c.page - 1]; if (p) c.viewer.scrollTop = p.offsetTop + keep * p.offsetHeight; }
  updateZoomUI(); saveSoon(); }
const zoomBy = (f) => setZoom((cur?.zoom || 1) * f);
function updateZoomUI() { const c = cur; if (!c) return; const tm = !!c.textMode; for (const id of ['pdf-zout', 'pdf-zin', 'pdf-fit']) { const e = $('#' + id); if (e) e.hidden = tm; } const nb = $('#r-notes'); if (nb) nb.hidden = !tm; $('#pdf-fit') && ($('#pdf-fit').classList.toggle('on', c.zoom === 1 && !tm), $('#pdf-fit').disabled = tm); $('#pdf-zout').disabled = tm || c.zoom <= ZMIN; $('#pdf-zin').disabled = tm || c.zoom >= ZMAX; }
function setupTouch(c) {
  const v = c.viewer; let p0 = null, sx = 0, sy = 0, st = 0, swiping = false;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  v.addEventListener('touchstart', (e) => {
    if (c.textMode) return;
    if (e.touches.length === 2) { p0 = dist(e.touches); c.pinch = 1; c.gestureAt = Date.now(); }
    else if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); swiping = true; }
  }, { passive: true });
  v.addEventListener('touchmove', (e) => {
    if (c.textMode) return;
    if (e.touches.length === 2 && p0) { e.preventDefault(); c.pinch = Math.min(ZMAX / c.zoom, Math.max(ZMIN / c.zoom, dist(e.touches) / p0)); const s = v.querySelector('.pdf-stage'); if (s) { s.style.transformOrigin = 'center top'; s.style.transform = `scale(${c.pinch})`; } c.gestureAt = Date.now(); swiping = false; }
    else if (e.touches.length > 1) swiping = false;
  }, { passive: false });
  v.addEventListener('touchend', (e) => {
    if (c.textMode) return;
    if (p0 && e.touches.length < 2) { const f = c.pinch || 1; p0 = null; c.pinch = 1; c.gestureAt = Date.now(); if (Math.abs(f - 1) > 0.03) setZoom(c.zoom * f); else { const s = v.querySelector('.pdf-stage'); if (s) s.style.transform = ''; } return; }
    if (swiping && e.changedTouches.length === 1 && c.mode === 'paged' && c.zoom <= 1.05) {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800) { c.gestureAt = Date.now(); dx < 0 ? next() : prev(); }
    }
    swiping = false;
  }, { passive: true });
  // ctrl+wheel / trackpad pinch on desktop
  v.addEventListener('wheel', (e) => { if (e.ctrlKey && !c.textMode) { e.preventDefault(); clearTimeout(c._wz); c._wf = (c._wf || 1) * Math.exp(-e.deltaY * 0.01); c._wz = setTimeout(() => { const f = c._wf; c._wf = 1; setZoom(c.zoom * f); }, 120); } }, { passive: false });
}

/* ---------- progress ---------- */
const saveSoon = debounce(() => savePosition(), 500);
async function savePosition() {
  const c = cur; if (!c || !c.ready) return;
  const b = await S.getBook(c.book.id); if (!b) return;
  b.pdfPage = c.page; b.pdfZoom = c.zoom; b.pdfText = !!c.textMode; b.progress = c.progress; b.lastOpened = Date.now();
  let moved = false;
  if (!c.finishedThisSession && c.n > 1 && c.page >= c.n && b.status !== 'finished') { b.status = 'finished'; b.finishedAt = Date.now(); c.finishedThisSession = true; moved = true; }
  else if (b.status !== 'finished' && b.status !== 'reading' && c.page > 1) b.status = 'reading';
  c.book.status = b.status; await S.saveBook(b);
  if (moved) toast('Finished — moved to the Finished shelf');
}

/* ---------- outline + appearance ---------- */
function showOutline() {
  const c = cur; if (!c || !c.outline) return;
  const flat = (items, d = 0) => items.flatMap((it) => [{ it, d }, ...flat(it.items || [], d + 1)]);
  const go = async (it) => {
    try { let dest = it.dest; if (typeof dest === 'string') dest = await c.pdf.getDestination(dest); if (!dest) return; const ref = dest[0]; const idx = typeof ref === 'object' ? await c.pdf.getPageIndex(ref) : ref; w.close(); goTo(idx + 1); } catch { toast('Couldn’t jump to that section'); }
  };
  const w = sheet('Outline', () => h('div', { class: 'list' }, flat(c.outline).map(({ it, d }) => h('button', { class: 'list-item toc-item', style: { paddingLeft: (14 + d * 16) + 'px' }, onclick: () => go(it) }, (it.title || '').trim() || 'Untitled'))), { tall: true });
}
export function showSettings() {
  const c = cur; c.scopeBook = S.hasOverrides(c.book); const w = sheet('Appearance', () => build(), { noDim: true });
  const redo = () => w.body.replaceChildren(build());
  function build() {
    const wrap = h('div', { class: 'appearance' });
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'View')),
      h('div', { class: 'seg wide', id: 'pdf-view-seg' }, [[false, 'Original pages'], [true, 'Text (reflow)']].map(([v, n]) => h('button', { class: !!c.textMode === v ? 'on' : '', 'data-pdfview': v ? 'text' : 'pages', onclick: () => { setTextMode(v); redo(); } }, n))));
    if (c.textMode) {
      const st = stl(c);
      wrap.append(h('div', { class: 'seg wide' },
        h('button', { class: !c.scopeBook ? 'on' : '', id: 'scope-global', onclick: () => { c.scopeBook = false; redo(); } }, 'All books'),
        h('button', { class: c.scopeBook ? 'on' : '', id: 'scope-book', onclick: () => { c.scopeBook = true; redo(); } }, 'This book only' + (S.hasOverrides(c.book) ? ' •' : ''))));
      const num = h('input', { type: 'number', id: 'fs-num', class: 'num', min: FONT_MIN, max: FONT_MAX, step: FONT_STEP, inputmode: 'decimal', value: st.fontSizePt });
      const range = h('input', { type: 'range', id: 'fs-range', min: FONT_MIN, max: FONT_MAX, step: FONT_STEP, value: st.fontSizePt });
      const setSize = (v) => { v = clampPt(v); range.value = v; if (document.activeElement !== num) num.value = v; writeStyle('fontSizePt', v); };
      num.addEventListener('change', () => { setSize(num.value); num.value = clampPt(num.value); }); range.addEventListener('input', () => setSize(range.value));
      wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Text size ', h('small', { class: 'muted' }, 'pt')),
        h('div', { class: 'stepper' }, h('button', { class: 'btn', id: 'fs-minus', 'aria-label': 'Smaller', onclick: () => setSize(+num.value - FONT_STEP) }, '−'), num, h('button', { class: 'btn', id: 'fs-plus', 'aria-label': 'Larger', onclick: () => setSize(+num.value + FONT_STEP) }, '+'))), range);
      wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Font')), h('select', { class: 'field', id: 'font-sel', onchange: (e) => writeStyle('font', e.target.value) }, Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: k === st.font }, f.name))));
      const lh = h('input', { type: 'range', id: 'lh-range', min: 1, max: 2.4, step: 0.05, value: st.lineHeight }); const lhv = h('span', { class: 'muted' }, (+st.lineHeight).toFixed(2));
      lh.addEventListener('input', () => { lhv.textContent = (+lh.value).toFixed(2); writeStyle('lineHeight', +lh.value); });
      wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Line spacing ', lhv)), lh);
      const mg = h('input', { type: 'range', id: 'mg-range', min: 0, max: 80, step: 2, value: st.margin }); const mgv = h('span', { class: 'muted' }, st.margin + ' px');
      mg.addEventListener('input', () => { mgv.textContent = mg.value + ' px'; writeStyle('margin', +mg.value); });
      wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Margins ', mgv)), mg);
      if (S.hasOverrides(c.book)) wrap.append(h('button', { class: 'btn block', id: 'reset-book', onclick: async () => { c.book = await S.resetOverrides(c.book.id); c.scopeBook = false; styleText(c); redo(); toast('This book now uses the global defaults'); } }, 'Reset this book to defaults'));
      wrap.append(h('p', { class: 'hint' }, 'Text view re-flows the PDF’s text (pictures, tables and columns are not kept). Pinch to change the text size. Switch back to Original pages for the real layout.'));
    } else {
      wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Zoom ', h('span', { class: 'muted', id: 'pdf-zoom-val' }, Math.round(c.zoom * 100) + '%'))),
        h('div', { class: 'stepper' }, h('button', { class: 'btn', id: 'pdf-zout2', onclick: () => { zoomBy(1 / 1.25); redo(); } }, '−'), h('button', { class: 'btn', id: 'pdf-fit2', onclick: () => { setZoom(1); redo(); } }, 'Fit width'), h('button', { class: 'btn', id: 'pdf-zin2', onclick: () => { zoomBy(1.25); redo(); } }, '+')),
        h('p', { class: 'hint', id: 'pdf-note' }, 'Original pages keep the PDF’s own layout, so the Text size setting (' + S.effectiveStyle(c.book).fontSizePt + ' pt) doesn’t change them — use Zoom / Fit width, or switch View to “Text (reflow)”, where Text size, font, line spacing and margins apply.'),
        h('div', { class: 'row-ctl' }, h('label', null, 'Layout')),
        h('div', { class: 'seg wide' }, ['paginated', 'scrolled'].map((f) => h('button', { class: settings.get('flow') === f ? 'on' : '', 'data-flow': f, onclick: () => { settings.set({ flow: f }); redo(); draw(); } }, f === 'paginated' ? 'Pages' : 'Scroll'))));
    }
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Word lookup')), h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', id: 'aa-wordlookup', checked: !!settings.get('wordLookup'), onchange: (e) => settings.set({ wordLookup: e.target.checked }) }), h('span', null, c.textMode ? 'Press and hold a word for its definition' : 'Press and hold a word (Text view only)')), h('button', { class: 'btn block', id: 'aa-glossary', onclick: () => { w.close(); openGlossary(c.glossaryCtx()); } }, 'Words & glossary'));
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Theme')),
      h('div', { class: 'themes' }, Object.entries(THEMES).map(([k, t]) => h('button', { class: 'swatch' + (settings.get('theme') === k ? ' on' : ''), 'data-theme-pick': k, style: { background: t.bg, color: t.fg, borderColor: t.accent }, onclick: () => { settings.set({ theme: k }); redo(); } }, 'Aa', h('small', null, t.name)))));
    if (!c.textMode && themeNow().dark) wrap.append(h('label', { class: 'row-ctl' }, h('span', null, 'Invert page colors (dark mode)'), h('input', { type: 'checkbox', id: 'pdf-invert', checked: settings.get('pdfInvert') !== false, onchange: (e) => { settings.set({ pdfInvert: e.target.checked }); styleViewer(c); } })));
    const pdfScope = () => (c.scopeBook && c.textMode ? c.book : null);
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Footer')), ...footerToggles(), scrubToggle({ book: pdfScope(), onWrite: async (v) => { if (pdfScope()) c.book = await S.setOverride(c.book.id, { hideScrub: v }); else settings.set({ hideScrub: v }); applyScrub(c.book); } }));
    return wrap;
  }
  return w;
}
settings.onChange((p) => { const c = cur; if (!c || !c.ready) return; if (c.textMode) { if ('theme' in p || 'fontSizePt' in p || 'font' in p || 'lineHeight' in p || 'margin' in p) { styleViewer(c); styleText(c); } } else if ('theme' in p || 'pdfInvert' in p) styleViewer(c); });

/* ---------- close ---------- */
export async function closePdf() {
  const c = cur; if (!c) return; closeBubble(); AN.closeSelectionUI(true);
  window.removeEventListener('keydown', keyNav); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('resize', onResize);
  try { await savePosition(); } catch { /* ignore */ }
  cur = null; c.io && c.io.disconnect(); c.pages.forEach(cancelRender); try { await withTimeout(Promise.resolve(c.pdf?.destroy()), 2000, 'closing the PDF'); } catch { /* ignore */ }
  const el = root(); el.hidden = true; el.replaceChildren(); el.classList.remove('chrome-hidden', 'pdf-mode'); document.body.classList.remove('reading');
  $('#overlay').replaceChildren(); $('#overlay').hidden = true; window.__pdf = null;
  const { refreshLibrary } = await import('./library.js'); refreshLibrary();
}

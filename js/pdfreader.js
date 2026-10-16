// PDF reader (pdf.js): paged + continuous-scroll modes, pinch / buttons zoom, fit-width, page jump, per-book position + zoom,
// theme via viewer background (optionally inverting pages for dark themes). Font / margin / line-spacing don't apply to PDFs.
import { h, toast, sheet, debounce, $, fmtPct } from './util.js';
import { settings, THEMES } from './settings.js';
import * as S from './store.js';
import { openPdfDocument } from './pdf.js';
import { fsButton } from './fullscreen.js';
import { makeFooter, applyFooterSettings, paintFooter, footerToggles } from './pages.js';

let cur = null;
export const pdfCurrent = () => cur;
const ZMIN = 0.5, ZMAX = 5;
const root = () => $('#reader');

export async function openPdf(book, blob) {
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
    tocBtn,
    fsButton({ class: 'btn-icon', id: 'r-fs' }, { icon: true }),
    h('button', { class: 'btn-icon', id: 'r-aa', 'aria-label': 'Appearance', onclick: showSettings }, 'Aa'));
  const bottom = h('div', { class: 'r-bar bottom' }, slider, label);
  const loading = h('div', { class: 'r-loading' }, h('div', { class: 'spinner' }), 'Opening…');
  el.replaceChildren(top, viewer, bottom, makeFooter(), loading); applyFooterSettings(); paintFooter({});
  cur = { isPdf: true, book, viewer, slider, pageNum, total, pct, el, top, bottom, chrome: true, page: 1, n: 0, zoom: book.pdfZoom || 1, pages: [], finishedThisSession: false, progress: book.progress || 0, ready: false };
  const c = cur;
  try {
    c.pdf = await openPdfDocument(await blob.arrayBuffer());
    c.n = c.pdf.numPages; slider.max = c.n; slider.disabled = false; pageNum.max = c.n; pageNum.disabled = false; total.textContent = ' of ' + c.n;
    const p1 = await c.pdf.getPage(1); c.ar = p1.getViewport({ scale: 1 }); 
    c.page = Math.min(c.n, Math.max(1, book.pdfPage || 1));
    loading.remove(); c.ready = true; draw(true); S.saveBook(await touchOpened(book));
    c.pdf.getOutline().then(async (o) => { c.outline = o; tocBtn.hidden = !(o && o.length); await resolveSections(c); syncUI(); }).catch(() => {});
  } catch (e) { console.error(e); toast(e.message || 'Could not open this PDF', 6000); await closePdf(); return; }
  slider.addEventListener('input', () => { pageNum.value = slider.value; });
  slider.addEventListener('change', () => goTo(+slider.value));
  pageNum.addEventListener('change', () => goTo(+pageNum.value));
  viewer.addEventListener('click', onTap);
  setupTouch(c);
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
  styleViewer(c); c.mode = modeNow();
  c.io && c.io.disconnect(); c.pages.forEach(cancelRender); c.pages = []; c.viewer.replaceChildren();
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
export function setZoom(z) { const c = cur; if (!c) return; z = Math.min(ZMAX, Math.max(ZMIN, z)); c.zoom = Math.round(z * 100) / 100; c.stageScale = 1; c.viewer.querySelectorAll('.pdf-stage').forEach((s) => { s.style.transform = ''; });
  const keep = c.mode === 'scroll' ? (c.viewer.scrollTop - (c.pages[c.page - 1]?.offsetTop || 0)) / (c.pages[c.page - 1]?.offsetHeight || 1) : 0;
  draw(); if (c.mode === 'scroll') { const p = c.pages[c.page - 1]; if (p) c.viewer.scrollTop = p.offsetTop + keep * p.offsetHeight; }
  updateZoomUI(); saveSoon(); }
const zoomBy = (f) => setZoom((cur?.zoom || 1) * f);
function updateZoomUI() { const c = cur; if (!c) return; $('#pdf-fit') && ($('#pdf-fit').classList.toggle('on', c.zoom === 1)); $('#pdf-zout').disabled = c.zoom <= ZMIN; $('#pdf-zin').disabled = c.zoom >= ZMAX; }
function setupTouch(c) {
  const v = c.viewer; let p0 = null, sx = 0, sy = 0, st = 0, swiping = false;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  v.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { p0 = dist(e.touches); c.pinch = 1; c.gestureAt = Date.now(); }
    else if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); swiping = true; }
  }, { passive: true });
  v.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && p0) { e.preventDefault(); c.pinch = Math.min(ZMAX / c.zoom, Math.max(ZMIN / c.zoom, dist(e.touches) / p0)); const s = v.querySelector('.pdf-stage'); if (s) { s.style.transformOrigin = 'center top'; s.style.transform = `scale(${c.pinch})`; } c.gestureAt = Date.now(); swiping = false; }
    else if (e.touches.length > 1) swiping = false;
  }, { passive: false });
  v.addEventListener('touchend', (e) => {
    if (p0 && e.touches.length < 2) { const f = c.pinch || 1; p0 = null; c.pinch = 1; c.gestureAt = Date.now(); if (Math.abs(f - 1) > 0.03) setZoom(c.zoom * f); else { const s = v.querySelector('.pdf-stage'); if (s) s.style.transform = ''; } return; }
    if (swiping && e.changedTouches.length === 1 && c.mode === 'paged' && c.zoom <= 1.05) {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 800) { c.gestureAt = Date.now(); dx < 0 ? next() : prev(); }
    }
    swiping = false;
  }, { passive: true });
  // ctrl+wheel / trackpad pinch on desktop
  v.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); clearTimeout(c._wz); c._wf = (c._wf || 1) * Math.exp(-e.deltaY * 0.01); c._wz = setTimeout(() => { const f = c._wf; c._wf = 1; setZoom(c.zoom * f); }, 120); } }, { passive: false });
}

/* ---------- progress ---------- */
const saveSoon = debounce(() => savePosition(), 500);
async function savePosition() {
  const c = cur; if (!c || !c.ready) return;
  const b = await S.getBook(c.book.id); if (!b) return;
  b.pdfPage = c.page; b.pdfZoom = c.zoom; b.progress = c.progress; b.lastOpened = Date.now();
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
  const c = cur; const w = sheet('Appearance', () => build(), { noDim: true });
  function build() {
    const wrap = h('div', { class: 'appearance' });
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Zoom ', h('span', { class: 'muted', id: 'pdf-zoom-val' }, Math.round(c.zoom * 100) + '%'))),
      h('div', { class: 'stepper' }, h('button', { class: 'btn', id: 'pdf-zout2', onclick: () => { zoomBy(1 / 1.25); w.body.replaceChildren(build()); } }, '−'), h('button', { class: 'btn', id: 'pdf-fit2', onclick: () => { setZoom(1); w.body.replaceChildren(build()); } }, 'Fit width'), h('button', { class: 'btn', id: 'pdf-zin2', onclick: () => { zoomBy(1.25); w.body.replaceChildren(build()); } }, '+')),
      h('div', { class: 'row-ctl' }, h('label', null, 'Layout')),
      h('div', { class: 'seg wide' }, ['paginated', 'scrolled'].map((f) => h('button', { class: settings.get('flow') === f ? 'on' : '', 'data-flow': f, onclick: () => { settings.set({ flow: f }); w.body.replaceChildren(build()); draw(); } }, f === 'paginated' ? 'Pages' : 'Scroll'))),
      h('div', { class: 'row-ctl' }, h('label', null, 'Theme')),
      h('div', { class: 'themes' }, Object.entries(THEMES).map(([k, t]) => h('button', { class: 'swatch' + (settings.get('theme') === k ? ' on' : ''), 'data-theme-pick': k, style: { background: t.bg, color: t.fg, borderColor: t.accent }, onclick: () => { settings.set({ theme: k }); w.body.replaceChildren(build()); } }, 'Aa', h('small', null, t.name)))));
    if (themeNow().dark) wrap.append(h('label', { class: 'row-ctl' }, h('span', null, 'Invert page colors (dark mode)'), h('input', { type: 'checkbox', id: 'pdf-invert', checked: settings.get('pdfInvert') !== false, onchange: (e) => { settings.set({ pdfInvert: e.target.checked }); styleViewer(c); } })));
    wrap.append(h('div', { class: 'row-ctl' }, h('label', null, 'Footer')), ...footerToggles());
    wrap.append(h('p', { class: 'hint' }, 'Text size, margins and line spacing apply to EPUB books only; a PDF keeps its own page layout. Use zoom or Fit width instead.'));
    return wrap;
  }
  return w;
}
settings.onChange((p) => { const c = cur; if (c && c.ready && ('theme' in p || 'pdfInvert' in p)) { styleViewer(c); } });

/* ---------- close ---------- */
export async function closePdf() {
  const c = cur; if (!c) return;
  window.removeEventListener('keydown', keyNav); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('resize', onResize);
  try { await savePosition(); } catch { /* ignore */ }
  cur = null; c.io && c.io.disconnect(); c.pages.forEach(cancelRender); try { await c.pdf?.destroy(); } catch { /* ignore */ }
  const el = root(); el.hidden = true; el.replaceChildren(); el.classList.remove('chrome-hidden', 'pdf-mode'); document.body.classList.remove('reading');
  $('#overlay').replaceChildren(); $('#overlay').hidden = true; window.__pdf = null;
  const { refreshLibrary } = await import('./library.js'); refreshLibrary();
}

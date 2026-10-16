// Highlights & notes UI (v0.5.8): selection menu (colours / Note / Define / Copy), draggable selection handles that extend a selection over any range
// (phrase, paragraphs, across page boundaries in paginated mode, auto-scroll in scroll mode), painting with the CSS Custom Highlight API (epub.js annotations
// as a fallback), tap-a-highlight editor, and the "Highlights & Notes" list for the Contents sheet.
import { h, toast, sheet, pushLayer } from './util.js';
import * as A from './annots.js';
import { highlightSupported, lastWordHold, wordBubbleOpen } from './wordbubble.js';

let ui = null;      // { host, contents, range, text, menu, hs, he, drag }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const BLOCK = 'p,div,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,pre,section,article,figcaption,tr';
/** The visible text of a range with a space where one block ends and the next begins (Range.toString() would glue paragraphs together); page labels of the PDF text view are skipped. */
export function rangeText(range) {
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode; const doc = root.ownerDocument;
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT); let out = '', last = null, n;
  const first = range.startContainer.nodeType === 3 ? range.startContainer : null; if (first) w.currentNode = first;
  for (n = first || w.nextNode(); n; n = w.nextNode()) {
    if (!range.intersectsNode(n)) { if (n === first) continue; if (out) break; continue; }
    const p = n.parentElement; if (!p || p.closest('script,style,.pdf-tp-n')) continue;
    let a = n === range.startContainer ? range.startOffset : 0, b = n === range.endContainer ? range.endOffset : n.data.length; if (b <= a) { if (n === range.endContainer) break; continue; }
    const blk = p.closest(BLOCK); if (last && blk !== last) out += ' '; last = blk; out += n.data.slice(a, b);
    if (n === range.endContainer) break;
  }
  return norm(out);
}
export const hlCss = () => A.COLORS.map((c) => `::highlight(folio-hl-${c.id}) { background-color: ${c.hex}8c; color: inherit; }`).join('\n') + '\n::highlight(folio-hl-noted) { text-decoration: underline; text-decoration-color: currentColor; text-decoration-thickness: 2px; text-underline-offset: 3px; }\n';

/* ------------------------------------------------------------------ painting */
const nameOf = (id) => 'folio-hl-' + id;
function rangeFor(contents, a) {
  try { const r = new ePub.CFI(a.cfiRange).toRange(contents.document); return r && !r.collapsed ? r : null; } catch { return null; }
}
const inSection = (contents, a) => a.fmt !== 'pdf' && a.cfiRange && a.cfiRange.indexOf((contents.cfiBase || '') + '!') === 8;
/** Paint every highlight of this book that lives in this section; remembers the ranges for tap hit-testing. */
export function paint(contents, list, host) {
  const w = contents.window, doc = contents.document; contents.__hl = [];
  const by = new Map(); const noted = [];
  for (const a of list) { if (!inSection(contents, a)) continue; const r = rangeFor(contents, a); if (!r) continue; contents.__hl.push({ a, r }); (by.get(a.color) || by.set(a.color, []).get(a.color)).push(r); if (a.note) noted.push(r); }
  if (highlightSupported(w)) {
    for (const c of A.COLORS) { try { w.CSS.highlights.delete(nameOf(c.id)); } catch { /* ignore */ } if (by.has(c.id)) w.CSS.highlights.set(nameOf(c.id), new w.Highlight(...by.get(c.id))); }
    try { w.CSS.highlights.delete('folio-hl-noted'); } catch { /* ignore */ } if (noted.length) w.CSS.highlights.set('folio-hl-noted', new w.Highlight(...noted));
    contents.__hlMode = 'css';
  } else if (host && host.annotations) {   // old engines: epub.js draws SVG marks over the text
    const an = host.annotations; for (const o of contents.__hlDrawn || []) { try { an.remove(o.cfi, 'highlight'); } catch { /* ignore */ } }
    contents.__hlDrawn = contents.__hl.map(({ a }) => { try { an.highlight(a.cfiRange, { id: a.id }, () => {}, 'folio-hl', { fill: A.colorHex(a.color), 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' }); } catch { /* ignore */ } return { cfi: a.cfiRange }; });
    contents.__hlMode = 'svg';
  }
  void doc;
}
export async function repaintAll(host) {
  if (!host) return; const list = await A.forBook(host.book());
  for (const c of host.contents()) (host.pdf ? paintPdf : paint)(c, list, host);
}

/** PDF Text (reflow) view: ranges are located by page + block index + character offset (the blocks of a page are stable for a given PDF). */
export function paintPdf(contents, list, host) {
  const w = contents.window; contents.__hl = []; const by = new Map(); const noted = [];
  for (const a of list) {
    if (a.fmt !== 'pdf' || !a.loc) continue; const s = host.locate(a.loc.sp), e = host.locate(a.loc.ep); if (!s || !e) continue;
    try { const r = document.createRange(); r.setStart(s.n, s.o); r.setEnd(e.n, e.o); if (r.collapsed) continue; contents.__hl.push({ a, r }); (by.get(a.color) || by.set(a.color, []).get(a.color)).push(r); if (a.note) noted.push(r); } catch { /* ignore */ }
  }
  ensureTopCss();
  if (!highlightSupported(w)) return;
  for (const c of A.COLORS) { try { w.CSS.highlights.delete(nameOf(c.id)); } catch { /* ignore */ } if (by.has(c.id)) w.CSS.highlights.set(nameOf(c.id), new w.Highlight(...by.get(c.id))); }
  try { w.CSS.highlights.delete('folio-hl-noted'); } catch { /* ignore */ } if (noted.length) w.CSS.highlights.set('folio-hl-noted', new w.Highlight(...noted));
}
function ensureTopCss() { if (document.getElementById('an-top-css')) return; const st = document.createElement('style'); st.id = 'an-top-css'; st.textContent = hlCss(); document.head.append(st); }
/** Wire selection + tap-a-highlight for a PDF text view (the viewer lives in the app document, so the contents object is the app window). */
export function attachPdf(host, viewer) {
  const contents = host.contents()[0]; let t = 0;
  document.addEventListener('selectionchange', () => { clearTimeout(t); t = setTimeout(() => { if (!host.ready()) return; const s = window.getSelection(); if (s && s.rangeCount && !s.isCollapsed && viewer.contains(s.anchorNode)) onSelectionChange(host, contents); else if (ui && ui.contents === contents && !(s && s.rangeCount && !s.isCollapsed)) onSelectionChange(host, contents); }, 220); });
  viewer.addEventListener('click', (e) => { if (!host.ready()) return; const s = window.getSelection(); if (s && !s.isCollapsed && s.toString().trim()) return; const a = hitTest(contents, e.clientX, e.clientY); if (a) { e.stopPropagation(); e.preventDefault(); openEditor(host, a, {}); } }, true);
  repaintAll(host);
}

/* ------------------------------------------------------------------ geometry */
const frameOff = (doc) => { try { const f = doc.defaultView.frameElement; if (f) { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; } } catch { /* ignore */ } return { x: 0, y: 0 }; };
function rectsOf(contents, range) {
  const off = frameOff(contents.document); const vr = ui.host.viewerRect();
  return [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0).map((r) => ({ left: r.left + off.x, right: r.right + off.x, top: r.top + off.y, bottom: r.bottom + off.y }))
    .filter((r) => r.right > vr.left - 2 && r.left < vr.right + 2 && r.bottom > vr.top - 2 && r.top < vr.bottom + 2);
}
function caretAt(doc, x, y) {
  try {
    if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (p && p.offsetNode) return { n: p.offsetNode, o: p.offset }; }
    if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); if (r) return { n: r.startContainer, o: r.startOffset }; }
  } catch { /* ignore */ }
  return null;
}

/* ------------------------------------------------------------------ selection menu + handles */
export function closeSelectionUI(clear) {
  if (!ui) return; const u = ui; ui = null; clearInterval(u.edge); try { u.unlayer(); } catch { /* ignore */ }
  u.menu.remove(); u.hs.remove(); u.he.remove();
  if (clear) { try { u.contents.window.getSelection().removeAllRanges(); } catch { /* ignore */ } }
}
const isOpen = () => !!ui;
export const selectionActive = () => !!ui;

function showUi(host, contents, range, opts = {}) {
  const text = rangeText(range); if (!text) { closeSelectionUI(); return; }
  if (ui && ui.contents !== contents) closeSelectionUI(false);
  if (!ui) {
    const root = host.root();
    const menu = h('div', { class: 'an-menu', id: 'an-menu', role: 'toolbar', 'aria-label': 'Selection' },
      ...A.COLORS.map((c) => h('button', { class: 'an-dot', 'data-color': c.id, 'aria-label': 'Highlight ' + c.name.toLowerCase(), style: { background: c.hex }, onclick: () => createFrom(c.id, false) })),
      h('button', { class: 'an-btn', id: 'an-note', onclick: () => createFrom(A.lastColor(), true) }, '✎ Note'),
      h('button', { class: 'an-btn', id: 'an-define', onclick: () => define() }, 'Define'),
      h('button', { class: 'an-btn', id: 'an-copy', onclick: () => copy() }, 'Copy'),
      h('button', { class: 'an-btn', id: 'an-x', 'aria-label': 'Close', onclick: () => closeSelectionUI(true) }, '✕'));
    menu.addEventListener('pointerdown', (e) => e.preventDefault());   // keep the selection alive
    const mkHandle = (which) => { const el = h('div', { class: 'an-handle ' + which, id: 'an-h-' + which, role: 'slider', 'aria-label': which === 'start' ? 'Selection start' : 'Selection end' }); el.addEventListener('pointerdown', (e) => beginDrag(e, which)); return el; };
    ui = { host, contents, range, text, menu, hs: mkHandle('start'), he: mkHandle('end'), drag: null, edge: 0 };
    root.append(menu, ui.hs, ui.he); ui.unlayer = pushLayer(() => closeSelectionUI(true));   // Back closes the menu first
  }
  ui.host = host; ui.contents = contents; ui.range = range; ui.text = text; if (opts.focus !== false) place();
}
function place() {
  if (!ui) return; const { contents, range, menu, hs, he } = ui;
  let rs = []; try { rs = rectsOf(contents, range); } catch { /* ignore */ }
  const root = ui.host.root().getBoundingClientRect();
  if (!rs.length) { menu.style.visibility = 'hidden'; hs.style.visibility = he.style.visibility = 'hidden'; return; }
  menu.style.visibility = ''; hs.style.visibility = he.style.visibility = 'hidden';
  const first = rs[0], last = rs[rs.length - 1]; const vr = ui.host.viewerRect();
  const startIn = range.getClientRects().length && contents.__startVisible !== false;
  // the handles only exist where the range's real start / end are on screen
  const all = [...range.getClientRects()]; const off = frameOff(contents.document);
  const sr = all[0], er = all[all.length - 1];
  const vis = (r) => r && r.left + off.x >= vr.left - 2 && r.right + off.x <= vr.right + 2 && r.top + off.y >= vr.top - 2 && r.bottom + off.y <= vr.bottom + 2;
  void startIn;
  if (vis(sr)) { hs.style.visibility = ''; hs.style.left = (sr.left + off.x - root.left) + 'px'; hs.style.top = (sr.bottom + off.y - root.top) + 'px'; }
  if (vis(er)) { he.style.visibility = ''; he.style.left = (er.right + off.x - root.left) + 'px'; he.style.top = (er.bottom + off.y - root.top) + 'px'; }
  const mw = menu.offsetWidth || 300, mh = menu.offsetHeight || 44; const cx = (first.left + Math.min(first.right, last.right)) / 2 || first.left;
  let top = first.top - mh - 12; if (top < root.top + 56) top = last.bottom + 34;   // no room above: below the selection (past the handles)
  top = Math.max(root.top + 4, Math.min(root.bottom - mh - 4, top));
  const left = Math.max(root.left + 6, Math.min(root.right - mw - 6, (first.left + last.right) / 2 - mw / 2 + (cx - cx)));
  menu.style.left = (left - root.left) + 'px'; menu.style.top = (top - root.top) + 'px';
}
export const reposition = () => { if (ui && !ui.drag) place(); };

function beginDrag(e, which) {
  if (!ui) return; e.preventDefault(); e.stopPropagation(); const u = ui; const el = e.currentTarget;
  try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const r = u.range;
  u.drag = { which, fixed: which === 'start' ? { n: r.endContainer, o: r.endOffset } : { n: r.startContainer, o: r.startOffset }, lastTurn: 0, px: e.clientX, py: e.clientY };
  el.classList.add('drag'); u.menu.style.opacity = '0.35';
  const move = (ev) => { if (ui !== u || !u.drag) return; u.drag.px = ev.clientX; u.drag.py = ev.clientY; dragTo(); };
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('drag'); clearInterval(u.edge); if (ui === u) { u.drag = null; u.menu.style.opacity = ''; u.range = currentRange(u) || u.range; u.text = rangeText(u.range); place(); } };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  u.edge = setInterval(() => edgeScroll(u), 140);
}
const currentRange = (u) => { try { const s = u.contents.window.getSelection(); return s.rangeCount && !s.isCollapsed ? s.getRangeAt(0).cloneRange() : null; } catch { return null; } };
function dragTo() {
  const u = ui; if (!u || !u.drag) return; const d = u.drag; const doc = u.contents.document; const off = frameOff(doc);
  // the finger is on the handle (below the line): aim at the text line just above it
  const c = caretAt(doc, d.px - off.x, d.py - off.y - 14); if (!c) return;
  try { const s = u.contents.window.getSelection(); s.setBaseAndExtent(d.fixed.n, d.fixed.o, c.n, c.o); const r = currentRange(u); if (r) { u.range = r; u.text = rangeText(r); } } catch { /* ignore */ }
  place();
}
async function edgeScroll(u) {
  if (ui !== u || !u.drag) return; const d = u.drag; const host = u.host; const vr = host.viewerRect(); const now = Date.now();
  if (host.paginated()) {
    if (now - d.lastTurn < 650) return; const pi = host.pageInfo(); if (!pi) return;
    if (d.px > vr.right - 34 && pi.page < pi.total) { d.lastTurn = now; await host.next(); await sleep(120); dragTo(); }
    else if (d.px < vr.left + 34 && pi.startPage > 1) { d.lastTurn = now; await host.prev(); await sleep(120); dragTo(); }
  } else {
    const sc = host.scroller(); if (!sc) return;
    if (d.py > vr.bottom - 56) { sc.scrollTop += 36; dragTo(); } else if (d.py < vr.top + 56) { sc.scrollTop -= 36; dragTo(); }
  }
}

/** Open the selection menu + handles on a range (used by the word bubble's "Highlight…" and by tests). */
export function selectRange(host, contents, range) {
  try { const s = contents.window.getSelection(); s.removeAllRanges(); s.addRange(range); } catch { /* ignore */ }
  showUi(host, contents, range);
}
/** A native selection changed inside this section document. */
export function onSelectionChange(host, contents) {
  if (!host.ready()) return;
  const dragging = ui && ui.drag; if (dragging) return;
  let s; try { s = contents.window.getSelection(); } catch { return; }
  if (!s || !s.rangeCount || s.isCollapsed) { if (ui && ui.contents === contents) closeSelectionUI(false); return; }
  if (wordBubbleOpen() || Date.now() - lastWordHold() < 1400) return;
  const range = s.getRangeAt(0).cloneRange(); if (!rangeText(range)) return;
  showUi(host, contents, range);
}

async function createFrom(color, withNote) {
  const u = ui; if (!u) return; const { host, contents } = u; const range = u.range;
  try {
    const info = host.describe(contents, range);
    const rec = await A.add(host.book(), { ...info, text: u.text, color });
    closeSelectionUI(true); await repaintAll(host);
    if (withNote) openEditor(host, rec, { focusNote: true });
  } catch (e) { toast('Couldn’t save that highlight: ' + (e.message || e)); }
}
async function copy() {
  const u = ui; if (!u) return; const t = u.text;
  try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { try { const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = t; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); } catch { toast('Couldn’t copy'); } }
  closeSelectionUI(true);
}
function define() {
  const u = ui; if (!u) return; const { host } = u; const word = u.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').split(/\s+/)[0];
  const r = u.range; const rects = rectsOf(u.contents, r); const f = rects[0] || { left: 40, right: 80, top: 80, bottom: 100 };
  const rect = { left: f.left, right: f.right, top: f.top, bottom: f.bottom, width: f.right - f.left, height: f.bottom - f.top };
  const ctxText = u.text; closeSelectionUI(true); if (word) host.define(word, ctxText, rect);
}

/* ------------------------------------------------------------------ tap a highlight */
/** Is the click at a painted highlight? Returns its record. */
export function hitTest(contents, x, y) {
  const list = contents.__hl || []; if (!list.length) return null;
  const c = caretAt(contents.document, x, y); if (!c) return null; let best = null;
  for (const { a, r } of list) {
    try {
      if (!r.isPointInRange(c.n, c.o)) continue;
      const hit = [...r.getClientRects()].some((q) => x >= q.left - 2 && x <= q.right + 2 && y >= q.top - 2 && y <= q.bottom + 2); if (!hit) continue;
      const len = r.toString().length; if (!best || len < best.len) best = { a, len };
    } catch { /* ignore */ }
  }
  return best && best.a;
}
export function attach(contents, host) {
  const doc = contents.document; if (doc.__an) return; doc.__an = true;
  let t = 0; doc.addEventListener('selectionchange', () => { clearTimeout(t); t = setTimeout(() => { const hh = host(); if (hh) onSelectionChange(hh, contents); }, 220); });
  const hh = host(); if (hh) paintLater(contents, hh);
}
async function paintLater(contents, host) { try { paint(contents, await A.forBook(host.book()), host); } catch { /* ignore */ } }
/** Called from the reader's tap handler: opens the editor when a highlight was tapped. */
export function annotTap(host, e) {
  try {
    const contents = host.contents().find((c) => c.window === e.view); if (!contents) return false;
    const a = hitTest(contents, e.clientX, e.clientY); if (!a) return false;
    openEditor(host, a, {}); return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ editor + list */
const excerpt = (text, max, open) => (open || text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + '…');
export function openEditor(host, rec, opts = {}) {
  let color = rec.color, open = false; let w;
  const note = h('textarea', { id: 'an-note-text', class: 'an-note-in', rows: 4, maxlength: A.NOTE_MAX, placeholder: 'Add a note…' }); note.value = rec.note || '';
  const body = h('div', { class: 'an-ed' });
  const paintBody = () => {
    const long = rec.text.length > 280;
    body.replaceChildren(
      h('blockquote', { class: 'an-quote', id: 'an-quote', style: { borderLeftColor: A.colorHex(color) } }, excerpt(rec.text, 280, open)),
      long ? h('button', { class: 'btn-text small', id: 'an-expand', onclick: () => { open = !open; paintBody(); } }, open ? 'Show less' : 'Show full excerpt (' + rec.text.length + ' characters)') : null,
      h('div', { class: 'an-colors' }, A.COLORS.map((c) => h('button', { class: 'an-dot' + (c.id === color ? ' on' : ''), 'data-color': c.id, 'aria-label': c.name, style: { background: c.hex }, onclick: () => { color = c.id; paintBody(); } }))),
      note,
      h('div', { class: 'row' },
        h('button', { class: 'btn', id: 'an-save', onclick: async () => { await A.update(rec.id, { note: note.value, color }); w.close(); await repaintAll(host); if (opts.onDone) opts.onDone(); } }, 'Save'),
        host.jump ? h('button', { class: 'btn', id: 'an-jump', onclick: () => { w.close(); host.jump(rec); } }, 'Go to') : null,
        h('button', { class: 'btn danger', id: 'an-del', onclick: async () => { await A.remove(rec.id); w.close(); await repaintAll(host); if (opts.onDone) opts.onDone(); toast('Highlight removed'); } }, 'Delete')));
  };
  w = sheet(rec.note ? 'Note' : 'Highlight', () => { paintBody(); return body; }, {});
  if (opts.focusNote) setTimeout(() => { try { note.focus(); } catch { /* ignore */ } }, 60);
  return w;
}

let filter = 'all';
const fmtDownload = (name, text) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); };
/** The Highlights & Notes tab of the Contents sheet. `rebuild` re-renders the sheet body; `closeSheet` closes the Contents sheet. */
export async function listTab(host, rebuild, closeSheet) {
  const book = host.book(); const all = await A.forBook(book); const list = await A.forBook(book, filter);
  const expanded = listTab.open || (listTab.open = new Set());
  const bar = h('div', { class: 'an-bar' },
    h('div', { class: 'seg small' }, [['all', 'All (' + all.length + ')'], ['hl', 'Highlights'], ['notes', 'Notes']].map(([k, l]) => h('button', { class: filter === k ? 'on' : '', 'data-filter': k, onclick: () => { filter = k; rebuild(); } }, l))),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn-text small', id: 'an-copy-all', disabled: !list.length, onclick: async () => { const t = A.toMarkdown(list, book); try { await navigator.clipboard.writeText(t); toast('Copied ' + list.length + ' highlight' + (list.length === 1 ? '' : 's')); } catch { toast('Couldn’t copy'); } } }, 'Copy'),
    h('button', { class: 'btn-text small', id: 'an-export', disabled: !list.length, onclick: () => fmtDownload((book.title || 'book').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) + ' - highlights.md', A.toMarkdown(list, book)) }, 'Export'));
  const items = list.map((a) => {
    const open = expanded.has(a.id); const long = a.text.length > 220;
    return h('div', { class: 'list-item an-item', 'data-id': a.id, 'data-color': a.color, style: { borderLeft: '5px solid ' + A.colorHex(a.color) } },
      h('div', { class: 'grow an-main', role: 'button', tabindex: 0, onclick: () => { closeSheet(); host.jump(a); } },
        h('div', { class: 'an-text' }, excerpt(a.text, 220, open)),
        a.note ? h('div', { class: 'an-notebox' }, '✎ ' + a.note) : null,
        h('small', { class: 'muted' }, [a.chapter, a.fmt === 'pdf' && a.loc ? 'p. ' + a.loc.sp.page : ''].filter(Boolean).join(' · '))),
      h('div', { class: 'an-side' },
        long ? h('button', { class: 'btn-text small an-more', onclick: () => { open ? expanded.delete(a.id) : expanded.add(a.id); rebuild(); } }, open ? 'Less' : 'More') : null,
        h('button', { class: 'btn-icon an-edit', 'aria-label': 'Edit highlight', onclick: () => openEditor(host, a, { onDone: rebuild }) }, '✎'),
        h('button', { class: 'btn-icon an-rm', 'aria-label': 'Delete highlight', onclick: async () => { await A.remove(a.id); await repaintAll(host); rebuild(); } }, '✕')));
  });
  return h('div', null, bar, h('div', { class: 'list', id: 'an-list' }, items.length ? items : h('p', { class: 'muted pad' }, all.length ? 'Nothing in this filter.' : 'No highlights yet. Select some text — or hold a word and tap Highlight — then pick a colour.')));
}

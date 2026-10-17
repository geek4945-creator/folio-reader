// Press-and-hold a word in the reader → a bubble with the book's glossary entry (checked first) and the dictionary definition (v0.5.6).
//   attachWordHold(doc, host)  – call for every EPUB section document (and the PDF text view). host = { book(), view?, offset?, cfi?(range), page?(node), ready?() }
//   The bubble: Save to book · Add to / Edit glossary entry · Saved words · Search the web. Back, Escape or a tap outside close it; a book that is open is never navigated.
import { h, toast, pushLayer } from './util.js';
import { settings } from './settings.js';
import * as D from './dict.js';
import * as G from './glossary.js';

export const HOLD_MIN = 0.3, HOLD_MAX = 3, HOLD_DEFAULT = 0.7, MOVE_PX = 10;
export const wordHoldSeconds = () => { const v = Number(settings.get('wordHoldSec')); return Math.min(HOLD_MAX, Math.max(HOLD_MIN, Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : HOLD_DEFAULT)); };

const WORD_CH = /[\p{L}\p{M}\p{N}'’-]/u;
/** The word under a point of `doc` (client coordinates), with its Range, its block's text and the offset inside it. null when the point isn't on a word. */
export function wordAt(doc, x, y) {
  let r = null;
  try { if (doc.caretRangeFromPoint) r = doc.caretRangeFromPoint(x, y); else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); if (p) { r = doc.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); } } } catch { r = null; }
  if (!r || r.startContainer.nodeType !== 3) return null;
  const node = r.startContainer, text = node.data; let i = r.startOffset;
  if (!(i < text.length && WORD_CH.test(text[i]))) { if (i > 0 && WORD_CH.test(text[i - 1])) i--; else return null; }
  let s = i, e = i + 1; while (s > 0 && WORD_CH.test(text[s - 1])) s--; while (e < text.length && WORD_CH.test(text[e])) e++;
  while (s < e && /['’-]/.test(text[s])) s++; while (e > s && /['’-]/.test(text[e - 1])) e--;
  if (e <= s || !/[\p{L}\p{N}]/u.test(text.slice(s, e))) return null;
  const range = doc.createRange(); range.setStart(node, s); range.setEnd(node, e);
  const rects = [...range.getClientRects()]; if (rects.length && !rects.some((q) => x >= q.left - 8 && x <= q.right + 8 && y >= q.top - 8 && y <= q.bottom + 8)) return null;   // the point was in the margin next to the line
  const block = node.parentElement && node.parentElement.closest('p,li,div,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,section,body') || node.parentElement;
  let ctx = '', offset = -1;
  if (block) { try { const pre = doc.createRange(); pre.selectNodeContents(block); pre.setEnd(node, s); offset = pre.toString().length; ctx = block.textContent || ''; } catch { /* ignore */ } }
  return { word: text.slice(s, e), range, text: ctx, offset, rect: range.getBoundingClientRect() };
}
/** The sentence of `text` that contains `offset`. */
export function sentenceAt(text, offset) {
  const t = String(text || ''); if (!t) return ''; const parts = []; const re = /[^.!?…]+(?:[.!?…]+["”’')\]]*|$)\s*/g; let m;
  while ((m = re.exec(t))) { parts.push({ s: m.index, e: m.index + m[0].length, t: m[0] }); if (!m[0]) break; }
  const p = parts.find((x) => offset >= x.s && offset < x.e) || parts[parts.length - 1]; return (p ? p.t : t).replace(/\s+/g, ' ').trim().slice(0, 300);
}

let bubble = null;   // { el, backdrop, unlayer, close }
export const wordBubbleOpen = () => !!bubble;
let heldAt = 0;
export const lastWordHold = () => heldAt;   // when a word hold last fired (the selection menu stays out of the way)
export function closeBubble() { if (bubble) { const b = bubble; bubble = null; b.close(); } }

const esc = (s) => String(s || '');
function place(el, anchor) {
  const vw = window.innerWidth, vh = window.innerHeight; const w = Math.min(380, vw - 16);
  el.style.width = w + 'px'; el.style.maxHeight = Math.round(vh * 0.5) + 'px';
  const left = Math.max(8, Math.min(vw - w - 8, anchor.left + anchor.width / 2 - w / 2)); el.style.left = left + 'px';
  const roomBelow = vh - anchor.bottom, roomAbove = anchor.top; const hh = el.offsetHeight || 220;
  if (roomBelow >= Math.min(hh, 200) + 12 || roomBelow >= roomAbove) { el.style.top = Math.max(8, Math.min(anchor.bottom + 10, vh - hh - 8)) + 'px'; el.style.bottom = ''; el.classList.remove('above'); }
  else { el.style.top = Math.max(8, anchor.top - hh - 10) + 'px'; el.classList.add('above'); }
}

/** Open the bubble for a word. `info` = { word, text, offset, rect (viewport coordinates), cfi, page, book } and `host` = { book(), editEntry(entry|null, word, ctx), openWords() }. */
export async function openBubble(info, host) {
  closeBubble();
  const book = info.book; const ctx = sentenceAt(info.text, info.offset); const display = info.word;
  const st = { glossary: null, dict: null, saved: null }; let dead = false;
  const backdrop = h('div', { class: 'wl-backdrop', onpointerdown: (e) => { e.preventDefault(); e.stopPropagation(); closeBubble(); }, onclick: (e) => { e.preventDefault(); e.stopPropagation(); } });
  const el = h('div', { class: 'wl-bubble', role: 'dialog', 'aria-label': 'Word lookup', id: 'wl-bubble' });
  const close = () => { dead = true; unlayer(); backdrop.remove(); el.remove(); if (host.onClose) host.onClose(); };
  const unlayer = pushLayer(() => closeBubble());
  bubble = { el, backdrop, close };
  document.body.append(backdrop, el); place(el, info.rect);

  const defOf = () => { const m = st.dict && st.dict.entry && st.dict.entry.meanings[0]; return m ? { def: m.defs[0].d, pos: m.pos } : { def: '', pos: '' }; };
  async function toggleSave() {
    if (st.saved) { await G.removeEntry(st.saved.id); st.saved = null; toast('Removed from saved words'); }
    else { const d = defOf(); st.saved = await G.saveWord(book, { term: display, def: d.def, pos: d.pos, phonetic: st.dict?.entry?.phonetic || '', ctx, cfi: info.cfi || '', page: info.page || 0 }); toast('Saved to this book'); }
    render();
  }
  function render() {
    if (dead) return;
    const g = st.glossary, d = st.dict; const kids = [];
    kids.push(h('div', { class: 'wl-head' }, h('strong', { class: 'wl-word', id: 'wl-word' }, g ? g.term : display), d && d.status === 'ok' && d.entry.phonetic ? h('span', { class: 'wl-phon' }, d.entry.phonetic) : null,
      h('button', { class: 'wl-x', id: 'wl-close', 'aria-label': 'Close', onclick: closeBubble }, '✕')));
    if (g) kids.push(h('div', { class: 'wl-gloss', id: 'wl-gloss' }, h('div', { class: 'wl-tag' }, 'Glossary' + (g.bookKey !== G.keyOf(book) ? ' · ' + (g.bookTitle || 'series') : '')), h('div', { class: 'wl-def' }, g.def || '—'), g.note ? h('div', { class: 'wl-note' }, g.note) : null));
    if (!d) kids.push(h('div', { class: 'wl-load', id: 'wl-loading' }, 'Looking up…'));
    else if (d.status === 'ok') {
      const ms = d.entry.meanings; const box = h('div', { class: 'wl-dict', id: 'wl-dict' });
      let n = 0; const MAX = st.more ? 99 : 3;
      for (const m of ms) { const defs = m.defs.slice(0, st.more ? 6 : 2).filter(() => n++ < MAX); if (!defs.length) continue; box.append(h('div', { class: 'wl-pos' }, m.pos || ''), h('ol', { class: 'wl-defs' }, defs.map((x) => h('li', null, x.d, x.ex ? h('div', { class: 'wl-ex' }, '“' + x.ex + '”') : null)))); }
      kids.push(box);
      const total = ms.reduce((a, m) => a + m.defs.length, 0);
      if (!st.more && total > 3) kids.push(h('button', { class: 'btn-text small', id: 'wl-more', onclick: () => { st.more = true; render(); } }, 'More definitions'));
      kids.push(h('div', { class: 'wl-src' }, (d.asWord && d.asWord !== D.normWord(display) ? 'Showing “' + d.asWord + '” · ' : '') + (d.cached ? 'Saved copy (works offline) · ' : '') + (D.SOURCES.find((s) => s.id === d.src)?.name || d.src)));
    } else kids.push(h('div', { class: 'wl-miss', id: 'wl-miss' }, d.status === 'missing' ? 'No dictionary entry for “' + display + '”.' : d.status === 'offline' ? 'You’re offline and this word isn’t saved on this device yet.' : 'Couldn’t reach the dictionary just now.',
      d.status === 'missing' ? null : h('button', { class: 'btn-text small', id: 'wl-retry', onclick: () => run(true) }, 'Try again')));
    kids.push(h('div', { class: 'wl-actions', id: 'wl-actions' },
      host.highlight && info.range ? h('button', { class: 'btn small wl-hl', id: 'wl-hl', onclick: () => { const r = info.range; closeBubble(); host.highlight(r); } }, '🖍 Highlight') : null,
      h('button', { class: 'btn small' + (st.saved ? ' on' : ''), id: 'wl-save', onclick: toggleSave }, st.saved ? '★ Saved' : '☆ Save to book'),
      h('button', { class: 'btn small', id: 'wl-gadd', onclick: () => { closeBubble(); host.editEntry(g && g.bookKey === G.keyOf(book) ? g : null, g ? g.term : display, ctx, defOf().def); } }, g && g.bookKey === G.keyOf(book) ? '✎ Edit entry' : '＋ Glossary'),
      h('a', { class: 'btn small', id: 'wl-web', href: D.webUrl(display), target: '_blank', rel: 'noopener noreferrer' }, 'Search the web ↗'),
      h('button', { class: 'btn small', id: 'wl-words', onclick: () => { closeBubble(); host.openWords(); } }, '📚 Words')));
    el.replaceChildren(...kids); place(el, info.rect);
  }
  async function run(refresh) {
    st.dict = null; render();
    st.dict = await D.lookup(display, { refresh }); render();
    if (st.saved && st.dict.status === 'ok' && !st.saved.def) { const d = defOf(); st.saved = await G.saveWord(book, { term: st.saved.term, def: d.def, pos: d.pos, phonetic: st.dict.entry.phonetic || '', ctx: st.saved.ctx, cfi: st.saved.cfi, page: st.saved.page }); }
  }
  const f = await G.forBook(book);
  st.glossary = G.matchTerm(f.terms, display, info.text, info.offset); st.saved = await G.savedWord(book, display);
  if (dead) return;
  render();
  run(false);
}

/** Highlight the held word (CSS Custom Highlight API inside the page; native selection as a fallback). */
function markWord(doc, range) {
  try { const w = doc.defaultView; if (w.CSS && w.CSS.highlights && w.Highlight) { w.CSS.highlights.set('folio-word', new w.Highlight(range)); return () => { try { w.CSS.highlights.delete('folio-word'); } catch { /* ignore */ } }; } } catch { /* ignore */ }
  try { const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range); return () => { try { sel.removeAllRanges(); } catch { /* ignore */ } }; } catch { return () => {}; }
}

/** Wire press-and-hold on a document (EPUB section iframe) or an element (PDF text view). */
export function attachWordHold(target, host) {
  const doc = target.ownerDocument || target; if (target.__wl) return; target.__wl = true;
  let st = null, swallowUntil = 0, armedUntil = 0;
  const cancel = () => { if (st) { clearTimeout(st.timer); st = null; } };
  const frameOffset = () => { try { const f = doc.defaultView.frameElement; if (f) { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; } } catch { /* ignore */ } return { x: 0, y: 0 }; };
  const fire = async () => {
    if (!st) return; const { x, y } = st; cancel();
    if (!settings.get('wordLookup') || (host.ready && !host.ready())) return;
    try { const sl = doc.defaultView.getSelection(); if (sl && sl.rangeCount && !sl.isCollapsed) return; } catch { /* ignore */ }   // something is selected: the selection bar is in charge
    const w = wordAt(doc, x, y); if (!w) return;
    swallowUntil = Date.now() + 900; armedUntil = Date.now() + 900; heldAt = Date.now();
    try { if (navigator.vibrate) navigator.vibrate(15); } catch { /* unsupported */ }
    const off = frameOffset(); const r = w.rect; const rect = { left: r.left + off.x, right: r.right + off.x, top: r.top + off.y, bottom: r.bottom + off.y, width: r.width, height: r.height };
    const unmark = markWord(doc, w.range);
    let cfi = ''; try { cfi = host.cfi ? host.cfi(w.range) : ''; } catch { /* ignore */ }
    let page = 0; try { page = host.page ? host.page(w.range.startContainer) : 0; } catch { /* ignore */ }
    const book = host.book(); if (!book) { unmark(); return; }
    await openBubble({ word: w.word, text: w.text, offset: w.offset, rect, cfi, page, book, range: w.range }, { ...host.actions, onClose: () => { unmark(); if (host.afterClose) host.afterClose(); } });
  };
  const down = (e) => {
    if (e.button > 0) return;
    if (!e.isPrimary) { cancel(); return; }   // second finger: a pinch, not a hold
    cancel(); if (!settings.get('wordLookup')) return;
    if (e.target.closest && e.target.closest('a[href], button, input, textarea, select, img, svg, video, audio')) return;
    st = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, t0: Date.now(), timer: setTimeout(fire, wordHoldSeconds() * 1000) };
  };
  const move = (e) => { if (st && e.pointerId === st.id && Math.hypot(e.clientX - st.x, e.clientY - st.y) > MOVE_PX) cancel(); };
  const up = (e) => { if (st && e.pointerId === st.id) cancel(); };
  target.addEventListener('pointerdown', down, true); target.addEventListener('pointermove', move, true);
  target.addEventListener('pointerup', up, true); target.addEventListener('pointercancel', up, true);
  target.addEventListener('touchmove', cancel, { passive: true, capture: true }); target.addEventListener('scroll', cancel, true);
  doc.addEventListener('visibilitychange', cancel);
  // while a hold is pending (and just after it fired) no native text selection / callout may start; the release must not turn the page or toggle the toolbars
  // (v0.5.8: only a touch press that has lasted long enough to be a native long-press selection is suppressed; mouse drags and double-taps select normally, so highlights can start anywhere)
  // v0.5.12: a touch long-press now starts the NATIVE text selection (the OS handles + our docked bar with 🖍 Highlight); only the moment right after a bubble opened is quiet
  const quiet = (e) => { if (Date.now() < armedUntil) e.preventDefault(); };
  for (const t of ['selectstart', 'contextmenu']) target.addEventListener(t, quiet, true);
  target.addEventListener('selectstart', () => { if (st && st.type === 'touch') cancel(); }, true);   // selection began first: it wins over the hold
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bubble) { e.preventDefault(); closeBubble(); } }, true);
  target.addEventListener('click', (e) => { if (Date.now() < swallowUntil) { e.stopPropagation(); e.preventDefault(); swallowUntil = 0; } }, true);
}

/* ------------------------------------------------------------------ glossary highlight (no DOM changes: CSS Custom Highlight API) */
export const highlightSupported = (w) => !!(w && w.CSS && w.CSS.highlights && w.Highlight);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function applyHighlights(doc, terms, on) {
  const w = doc.defaultView; if (!highlightSupported(w)) return 0;
  try { w.CSS.highlights.delete('folio-gl'); } catch { /* ignore */ }
  if (!on || !terms.length) return 0;
  const list = [...new Set(terms.map((t) => t.term).filter((t) => t && t.length > 1))].sort((a, b) => b.length - a.length).slice(0, 400); if (!list.length) return 0;
  const re = new RegExp('(?<![\\p{L}\\p{N}])(?:' + list.map(escRe).join('|') + ")(?:['’]s|s)?(?![\\p{L}\\p{N}])", 'giu');
  const ranges = []; const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  let n; while ((n = walker.nextNode()) && ranges.length < 4000) { re.lastIndex = 0; let m; while ((m = re.exec(n.data)) && ranges.length < 4000) { const r = doc.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); ranges.push(r); if (!m[0]) re.lastIndex++; } }
  if (ranges.length) w.CSS.highlights.set('folio-gl', new w.Highlight(...ranges));
  return ranges.length;
}

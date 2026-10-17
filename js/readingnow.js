// "Reading now" tab (v0.5.8): the books being read right now — status Currently Reading, or started and not finished — newest read first,
// each with its cover, progress and a Resume button. Tap the row (or Resume) to continue where you left off.
import { h, put, fmtPct, toast, sheet, actionSheet } from './util.js';
import * as S from './store.js';
import { coverUrl } from './library.js';
import { openReader } from './reader.js';

const hue = (s) => { let x = 0; for (const ch of String(s || '')) x = (x * 31 + ch.charCodeAt(0)) % 360; return x; };
const reading = (b) => S.isReadingNow(b) && !S.isHiddenFromNow(b);
let chain = Promise.resolve();
export function renderReadingNow(view) { const run = chain.then(() => draw(view)); chain = run.catch((e) => console.warn('reading-now render failed', e)); return run; }
async function draw(view) {
  const books = await S.getBooks();
  const hidden = books.filter((b) => S.isReadingNow(b) && S.isHiddenFromNow(b));
  const list = books.filter(reading).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  const redraw = () => renderReadingNow(view);
  const remove = async (ids) => { const prev = await S.setNowHidden(ids, true); toast(ids.length > 1 ? 'Removed ' + ids.length + ' books from Reading now' : 'Removed from Reading now', 7000, { label: 'Undo', onClick: async () => { await S.restoreNowHidden(prev); redraw(); } }); redraw(); };
  const menu = (b) => actionSheet(b.title, [
    { label: 'Resume', onClick: () => openReader(b.id) },
    { label: 'Remove from Reading now', id: 'rn-menu-remove', onClick: () => remove([b.id]) },
  ]);
  const row = (b) => {
    const u = coverUrl(b); const go = () => openReader(b.id);
    const el = h('div', { class: 'rn-row', dataset: { id: b.id }, tabindex: 0, role: 'button', onclick: go, oncontextmenu: (e) => { e.preventDefault(); menu(b); }, onkeydown: (e) => { if (e.key === 'Enter') go(); else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove([b.id]); } } },
      h('div', { class: 'rn-cover' }, u ? h('img', { src: u, alt: '', draggable: 'false' }) : h('div', { class: 'cover-ph', style: { background: `hsl(${hue(b.title)} 40% 34%)` } }, h('span', null, b.title))),
      h('div', { class: 'rn-meta' }, h('div', { class: 'rn-title clamp2' }, b.title), h('div', { class: 'rn-author ellipsis muted' }, b.author || ''),
        h('div', { class: 'rn-bar' }, h('i', { style: { width: Math.round((b.progress || 0) * 100) + '%' } })),
        h('div', { class: 'rn-sub' }, h('span', { class: 'rn-pct' }, fmtPct(b.progress)), h('span', { class: 'muted small' }, b.lastOpened ? ' · ' + ago(b.lastOpened) : ' · not opened yet'))),
      h('div', { class: 'rn-actions' },
        h('button', { class: 'btn primary small rn-resume', onclick: (e) => { e.stopPropagation(); go(); } }, 'Resume'),
        h('button', { class: 'btn-icon rn-x', 'aria-label': 'Remove “' + b.title + '” from Reading now', title: 'Remove from Reading now', onclick: (e) => { e.stopPropagation(); remove([b.id]); } }, '✕')));
    el.__onHold = () => menu(b);   // press and hold (same 4 s / Settings time as the Library tiles) opens the menu
    return el;
  };
  const showHidden = () => {
    let w; const build = async () => { const bs = (await S.getBooks()).filter((b) => S.isReadingNow(b) && S.isHiddenFromNow(b)); if (!bs.length) { w && w.close(); redraw(); return h('div'); }
      return h('div', null, h('div', { class: 'list', id: 'rn-hidden-list' }, bs.map((b) => h('div', { class: 'list-item rn-hid', dataset: { id: b.id } }, h('span', { class: 'grow ellipsis' }, b.title), h('button', { class: 'btn small rn-show', onclick: async () => { await S.setNowHidden([b.id], false); redraw(); w.body.replaceChildren(await build()); } }, 'Show')))),
        h('div', { class: 'row' }, h('button', { class: 'btn primary block', id: 'rn-restore-all', onclick: async () => { await S.setNowHidden(bs.map((b) => b.id), false); toast('Restored ' + bs.length + (bs.length === 1 ? ' book' : ' books')); w.close(); redraw(); } }, 'Restore all'))); };
    w = sheet('Hidden from Reading now', () => h('div', { id: 'rn-hidden' }), { tall: false }); build().then((c) => w.body.replaceChildren(c));
  };
  view.replaceChildren();
  put(view, h('header', { class: 'topbar' }, h('h1', null, 'Reading now')),
    list.length ? h('div', { class: 'rn-list pad', id: 'rn-list' }, list.map(row))
      : h('div', { class: 'empty pad center' }, h('p', null, 'Nothing in progress right now.'), h('p', { class: 'muted small' }, 'Open a book from your Library and it will appear here, newest first, with a Resume button.')),
    (list.length > 1 || hidden.length) ? h('div', { class: 'rn-foot pad center' },
      list.length > 1 ? h('button', { class: 'btn-text small', id: 'rn-clear', onclick: () => remove(list.map((b) => b.id)) }, 'Clear all') : null,
      hidden.length ? h('button', { class: 'btn-text small', id: 'rn-restore', onclick: showHidden }, 'Restore hidden (' + hidden.length + ')') : null,
      h('div', { class: 'muted small rn-note' }, 'Removing only hides a book here — it stays in your Library with its progress, and comes back when you open it again.')) : null);
}
function ago(t) {
  const d = Date.now() - t, m = Math.round(d / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const hh = Math.round(m / 60); if (hh < 24) return hh + ' h ago'; const dd = Math.round(hh / 24); return dd + (dd === 1 ? ' day ago' : ' days ago');
}

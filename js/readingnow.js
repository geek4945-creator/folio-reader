// "Reading now" tab (v0.5.8): the books being read right now — status Currently Reading, or started and not finished — newest read first,
// each with its cover, progress and a Resume button. Tap the row (or Resume) to continue where you left off.
import { h, put, fmtPct } from './util.js';
import * as S from './store.js';
import { coverUrl } from './library.js';
import { openReader } from './reader.js';

const hue = (s) => { let x = 0; for (const ch of String(s || '')) x = (x * 31 + ch.charCodeAt(0)) % 360; return x; };
const reading = (b) => b.status === 'reading' || (b.status !== 'finished' && (b.progress || 0) > 0.005);
let chain = Promise.resolve();
export function renderReadingNow(view) { const run = chain.then(() => draw(view)); chain = run.catch((e) => console.warn('reading-now render failed', e)); return run; }
async function draw(view) {
  const books = await S.getBooks();
  const list = books.filter(reading).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  const row = (b) => {
    const u = coverUrl(b); const go = () => openReader(b.id);
    return h('div', { class: 'rn-row', dataset: { id: b.id }, tabindex: 0, role: 'button', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
      h('div', { class: 'rn-cover' }, u ? h('img', { src: u, alt: '', draggable: 'false' }) : h('div', { class: 'cover-ph', style: { background: `hsl(${hue(b.title)} 40% 34%)` } }, h('span', null, b.title))),
      h('div', { class: 'rn-meta' }, h('div', { class: 'rn-title clamp2' }, b.title), h('div', { class: 'rn-author ellipsis muted' }, b.author || ''),
        h('div', { class: 'rn-bar' }, h('i', { style: { width: Math.round((b.progress || 0) * 100) + '%' } })),
        h('div', { class: 'rn-sub' }, h('span', { class: 'rn-pct' }, fmtPct(b.progress)), h('span', { class: 'muted small' }, b.lastOpened ? ' · ' + ago(b.lastOpened) : ' · not opened yet'))),
      h('button', { class: 'btn primary small rn-resume', onclick: (e) => { e.stopPropagation(); go(); } }, 'Resume'));
  };
  view.replaceChildren();
  put(view, h('header', { class: 'topbar' }, h('h1', null, 'Reading now')),
    list.length ? h('div', { class: 'rn-list pad', id: 'rn-list' }, list.map(row))
      : h('div', { class: 'empty pad center' }, h('p', null, 'Nothing in progress right now.'), h('p', { class: 'muted small' }, 'Open a book from your Library and it will appear here, newest first, with a Resume button.')));
}
function ago(t) {
  const d = Date.now() - t, m = Math.round(d / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const hh = Math.round(m / 60); if (hh < 24) return hh + ' h ago'; const dd = Math.round(hh / 24); return dd + (dd === 1 ? ' day ago' : ' days ago');
}

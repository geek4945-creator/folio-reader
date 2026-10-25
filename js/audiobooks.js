// Audiobooks tab: library-style grid/list with covers, shelves, sort (incl. custom drag order), multi-select, import (files, folders, zips, drop, Drive).
import { registerBack } from './nav.js';
import { h, toast, sheet, actionSheet, confirmDlg, promptDlg, fmtPct, hashHue, $, put } from './util.js';
import { settings, AUDIO_SORT_FIELDS, getSort, setSort, clearSort, dirWord } from './settings.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import { enableDragSort } from './dragsort.js';
import { loadBook, openPlayer, unloadIf, fmtLong, downloadWithToast, getState } from './audioplayer.js';
import { openDriveBrowser } from './drive.js';
import { markEdits } from './metasync.js';
import { openCoverEditor } from './covers.js';
import { openFixMissing } from './enrich.js';
import { openAudioSources } from './audiosources.js';
import * as Loans from './loans.js';
import { openChirpForm, openChirpEntry, chirpLinkEl, openChirp } from './chirp.js';

let view; const covers = new Map();
let local = { q: '', sel: null, visible: [] };
const norm = (s) => (s || '').toLowerCase().replace(/^(the|a|an)\s+/, '');
const recent = (b) => b.lastOpened || b.addedAt || 0;
const coverUrl = (b) => { if (!b.coverBlob) return null; const k = b.id + ':' + b.coverBlob.size; if (!covers.has(k)) covers.set(k, URL.createObjectURL(b.coverBlob)); return covers.get(k); };
const forgetCovers = (ids) => { for (const [k, u] of [...covers]) if (ids.some((id) => k.startsWith(id + ':'))) { URL.revokeObjectURL(u); covers.delete(k); } };

let renderChain = Promise.resolve();   // queued renders: overlapping ones used to interleave and draw tiles twice
export function renderAudiobooks(v) { if (v) view = v; const run = renderChain.then(() => drawAudiobooks()); renderChain = run.catch((e) => console.warn('render failed', e)); return run; }
async function drawAudiobooks() {
  if (!view) return;   // an import finished before this tab was ever shown
  const [books, shelves] = await Promise.all([A.getAudiobooks(), S.getShelves()]);
  const scroll = view.scrollTop; view.replaceChildren();
  view.classList.toggle('selecting', !!local.sel);
  if (local.sel) for (const id of [...local.sel]) if (!books.some((b) => b.id === id)) local.sel.delete(id);
  await renderMain({ books, shelves });
  view.scrollTop = scroll;
}
const rerender = () => renderAudiobooks();
registerBack('audiobooks', () => { if (local.sel) { local.sel = null; rerender(); return true; } return false; });   // Back leaves select mode

async function renderMain(ctx) {
  const { shelves } = ctx; const allBooks = ctx.books; const books = Loans.owned(allBooks), borrowedBooks = Loans.borrowedOf(allBooks);   // library loans stay out of the owned list and its counts
  let chip = settings.get('audioChip') || 'all'; if (chip !== 'all' && !(chip === 'borrowed' && borrowedBooks.length) && !A.AUDIO_STATUSES.some((s) => s.id === chip) && !shelves.some((s) => s.id === chip)) chip = 'all';
  const sortKey = 'audio:' + chip; const spec = getSort(sortKey); const sort = spec.field; const viewMode = settings.get('view');
  const search = h('input', { type: 'search', class: 'field search', id: 'audio-search', placeholder: 'Search title or author', value: local.q, enterkeyhint: 'search' });
  search.addEventListener('input', () => { local.q = search.value; drawBody(); });
  const chips = [{ id: 'all', name: 'All' }, ...A.AUDIO_STATUSES, ...shelves.map((s) => ({ id: s.id, name: s.name, custom: true })), ...(borrowedBooks.length ? [{ id: 'borrowed', name: 'Borrowed' }] : [])];
  const banner = await Loans.loanBanner('audio', rerender);
  const count = (c) => c.id === 'all' ? null : c.id === 'borrowed' ? borrowedBooks.length : A.AUDIO_STATUSES.some((s) => s.id === c.id) ? books.filter((b) => b.status === c.id).length : books.filter((b) => b.shelves?.includes(c.id)).length;
  put(view,
    h('header', { class: 'topbar' }, h('h1', null, 'Audiobooks'),
      h('div', { class: 'top-actions' },
        allBooks.length ? h('button', { class: 'btn-text' + (local.sel ? ' on' : ''), id: 'audio-select', onclick: () => { local.sel = local.sel ? null : new Set(); rerender(); } }, local.sel ? 'Done' : 'Select') : null,
        chirpLinkEl(null, { id: 'audio-open-chirp', label: 'Chirp ↗', cls: 'btn-text', title: 'Open Chirp (the app if it’s installed, otherwise chirpbooks.com)' }),
        h('button', { class: 'btn-icon', id: 'audio-add', 'aria-label': 'Add audiobooks', title: 'Import audio files', onclick: pickAudio }, '＋'),
        h('button', { class: 'btn-icon', id: 'audio-menu', 'aria-label': 'Audiobooks menu', onclick: () => audioMenu(ctx) }, '⋯'))),
    h('div', { class: 'pad' }, search), banner,
    h('div', { class: 'chips', role: 'tablist' }, chips.map((c) => h('button', { class: 'chip' + (chip === c.id ? ' on' : ''), role: 'tab', 'data-chip': c.id, onclick: () => { settings.set({ audioChip: c.id }); rerender(); } }, c.name, count(c) != null ? h('small', null, ' ' + count(c)) : null)),
      h('button', { class: 'chip add', onclick: newShelf, 'aria-label': 'New shelf' }, '＋ Shelf')),
    h('div', { class: 'toolbar pad' },
      h('label', { class: 'sort' }, 'Sort ', h('select', { id: 'audio-sort-sel', onchange: (e) => { setSort(sortKey, { field: e.target.value }); rerender(); } }, AUDIO_SORT_FIELDS.map(([v, n]) => h('option', { value: v, selected: v === sort }, n)))),
      sort !== 'custom' ? h('button', { class: 'btn small dir', id: 'audio-sort-dir', 'data-dir': spec.dir, title: dirWord(spec.field, spec.dir), onclick: () => { setSort(sortKey, { dir: spec.dir === 'asc' ? 'desc' : 'asc' }); rerender(); } }, (spec.dir === 'asc' ? '↑ ' : '↓ ') + dirWord(spec.field, spec.dir)) : null,
      sort === 'custom' ? h('button', { class: 'btn small', id: 'audio-reset-order', onclick: async () => { await S.clearOrder(sortKey); clearSort(sortKey); toast('Order reset to automatic sort'); rerender(); } }, 'Reset to automatic') : null,
      h('span', { class: 'grow' }),
      h('div', { class: 'seg' }, h('button', { class: viewMode === 'grid' ? 'on' : '', 'aria-label': 'Grid view', id: 'audio-view-grid', onclick: () => { settings.set({ view: 'grid' }); rerender(); } }, '▦'),
        h('button', { class: viewMode === 'list' ? 'on' : '', 'aria-label': 'List view', id: 'audio-view-list', onclick: () => { settings.set({ view: 'list' }); rerender(); } }, '☰'))),
    sort === 'custom' ? h('p', { class: 'hint pad' }, 'Press and hold an audiobook, then drag to reorder.') : null);
  const body = h('div', { id: 'audio-body' }); put(view, body);
  if (local.sel) { put(view, selectBar()); refreshSelection(); }

  async function drawBody() {
    body.replaceChildren(); const q = local.q.trim().toLowerCase();
    const src = chip === 'borrowed' ? borrowedBooks : books;
    const ofChip = (b) => chip === 'all' ? true : chip === 'borrowed' ? !!b.borrowed : A.AUDIO_STATUSES.some((s) => s.id === chip) ? b.status === chip : !!b.shelves?.includes(chip);
    let pool = src.filter((b) => ofChip(b) && (!q || [b.title, b.author].some((x) => (x || '').toLowerCase().includes(q))));
    local.visible = pool.map((b) => b.id);
    if (!allBooks.length) { body.append(emptyState()); return; }
    if (!pool.length) { body.append(h('p', { class: 'muted pad center' }, q ? 'No matches.' : 'Nothing on this shelf yet.')); return; }
    const m = spec.dir === 'desc' ? -1 : 1; const byTitle = (a, b) => norm(a.title).localeCompare(norm(b.title)); const prog = (b) => (b.status === 'finished' ? 1 : b.progress || 0);
    if (sort === 'title') pool.sort((a, b) => m * byTitle(a, b));
    else if (sort === 'author') pool.sort((a, b) => { const x = norm(a.author), y = norm(b.author); if (!x !== !y) return !x ? 1 : -1; return m * x.localeCompare(y) || byTitle(a, b); });
    else if (sort === 'added') pool.sort((a, b) => m * ((a.addedAt || 0) - (b.addedAt || 0)) || byTitle(a, b));
    else if (sort === 'progress') pool.sort((a, b) => m * (prog(a) - prog(b)) || byTitle(a, b));
    else if (sort === 'duration') pool.sort((a, b) => m * ((a.duration || 0) - (b.duration || 0)) || byTitle(a, b));
    else if (sort === 'recent') pool.sort((a, b) => m * (recent(a) - recent(b)) || byTitle(a, b));
    else { pool.sort((a, b) => recent(a) - recent(b)); const saved = await S.getOrder(sortKey); pool = S.applyOrder(pool.map((b) => ({ key: 'b:' + b.id, b })), saved).map((t) => t.b); }
    const grid = h('div', { class: 'tiles ' + viewMode, dataset: { ctx: sortKey } }, pool.map((b) => tileEl(b, ctx, viewMode)));
    body.append(grid);
    if (sort === 'custom' && !q && !local.sel) enableDragSort(grid, { itemSel: '.tile', vertical: viewMode === 'list', onDrop: async (keys) => { const prev = await S.getOrder(sortKey); await S.saveOrder(sortKey, [...keys, ...prev.filter((k) => !keys.includes(k))]); } });
  }
  await drawBody();
}

/* ---------- tiles ---------- */
function badge(b) {
  if (b.status === 'finished') return h('span', { class: 'pbadge done', title: 'Finished' }, '✓');
  if (b.progress > 0.005) return h('span', { class: 'pbadge' }, fmtPct(b.progress));
  return h('span', { class: 'pbadge new' }, 'NEW');
}
function tileEl(b, ctx, mode) {
  const u = coverUrl(b); const hue = hashHue(b.title);
  const more = h('button', { class: 'tile-more', 'aria-label': 'Audiobook options', onclick: (e) => { e.stopPropagation(); audioBookMenu(b, ctx); } }, '⋯');
  const act = () => { if (local.sel) { toggleSel([b.id]); } else open(b.id); };
  const bar = h('div', { class: 'bar' }, h('i', { style: { width: Math.round((b.status === 'finished' ? 1 : b.progress || 0) * 100) + '%' } }));
  const chirp = b.external ? h('span', { class: 'pill-pdf pill-chirp', title: 'Chirp audiobook: plays in the Chirp app' }, 'Chirp') : null;
  const cloud = A.hasUrls(b) ? h('span', { class: 'pill-pdf pill-cloud', title: A.isDownloaded(b) ? 'Saved offline' : 'Streams from the internet' }, A.isDownloaded(b) ? '⬇' : '☁') : null;
  const el = h('div', { class: 'tile book audio' + (local.sel && local.sel.has(b.id) ? ' sel' : ''), dataset: { key: 'b:' + b.id, id: b.id }, tabindex: 0, role: 'button', onclick: act, onkeydown: (e) => { if (e.key === 'Enter') act(); } },
    h('div', { class: 'cover' },
      h('div', { class: 'cover-ph', style: { background: `linear-gradient(135deg,hsl(${hue} 45% 38%),hsl(${(hue + 40) % 360} 45% 28%))` } }, h('span', null, b.title), h('small', null, b.author)),
      u ? h('img', { class: 'cover-img', src: u, alt: '', draggable: 'false' }) : null, badge(b), b.borrowed ? Loans.dueBadge(b) : null, cloud, chirp, h('span', { class: 'selmark' }, '✓'), mode === 'grid' ? more : null),
    h('div', { class: 'meta' }, h('div', { class: 't clamp2' }, b.title), h('div', { class: 'a ellipsis muted' }, b.author || 'Unknown author'),
      h('div', { class: 'muted small ellipsis' }, fmtLong(b.duration) + (b.tracks.length > 1 ? ` · ${b.tracks.length} files` : '')), mode === 'list' ? bar : null),
    mode === 'list' ? more : null);
  el.__onHold = () => audioBookMenu(b, ctx);   // press-and-hold = the ⋯ menu
  return el;
}
export async function open(id) { const ab = await A.getAudiobook(id); if (ab && ab.external) { openChirpEntry(id, { onChange: rerender }); return getState(); } const st = getState(); await loadBook(id, { play: true }); openPlayer(); return st; }

/* ---------- multi-select ---------- */
function toggleSel(ids) { const all = ids.every((id) => local.sel.has(id)); for (const id of ids) all ? local.sel.delete(id) : local.sel.add(id); refreshSelection(); }
function refreshSelection() {
  if (!local.sel) return;
  view.querySelectorAll('.tile.audio').forEach((el) => el.classList.toggle('sel', local.sel.has(el.dataset.id)));
  const n = local.sel.size; const c = $('#audio-sel-count'); if (c) c.textContent = n ? `${n} selected` : 'Tap audiobooks to select';
  view.querySelectorAll('#audio-select-bar [data-needs-sel]').forEach((b) => { b.disabled = !n; });
}
function selectBar() {
  const need = { 'data-needs-sel': '1', disabled: true };
  return h('div', { id: 'audio-select-bar', class: 'select-bar', role: 'toolbar', 'aria-label': 'Selected audiobooks' },
    h('span', { class: 'grow', id: 'audio-sel-count' }, 'Tap audiobooks to select'),
    h('button', { class: 'btn small', id: 'audio-sel-all', onclick: () => { local.visible.forEach((id) => local.sel.add(id)); refreshSelection(); } }, 'Select all'),
    h('button', { class: 'btn small', id: 'audio-sel-clear', onclick: () => { local.sel.clear(); refreshSelection(); } }, 'Clear'),
    h('button', { class: 'btn small', id: 'audio-sel-move', ...need, onclick: () => moveSelected() }, 'Move to shelf'),
    h('button', { class: 'btn small', id: 'audio-sel-finish', ...need, onclick: async () => { const ids = [...local.sel]; await A.setAudioStatusMany(ids, 'finished'); toast(`Marked ${ids.length} finished`); local.sel = null; rerender(); } }, 'Mark finished'),
    h('button', { class: 'btn small danger', id: 'audio-sel-delete', ...need, onclick: () => deleteFlow([...local.sel]) }, 'Delete'));
}
async function moveSelected() {
  const ids = [...local.sel]; const shelves = await S.getShelves();
  const done = async (fn, msg) => { await fn(); toast(msg); local.sel = null; w.close(); rerender(); };
  const w = sheet(`Move ${ids.length} audiobook${ids.length > 1 ? 's' : ''} to…`, () => [h('div', { class: 'list' }, [
    ...A.AUDIO_STATUSES.map((st) => h('button', { class: 'list-item', 'data-status': st.id, onclick: () => done(() => A.setAudioStatusMany(ids, st.id), `Moved to ${st.name}`) }, h('span', null, st.name))),
    ...(shelves.length ? [h('div', { class: 'sep' }, 'Add to custom shelf')] : []),
    ...shelves.map((sh) => h('button', { class: 'list-item', 'data-shelf': sh.id, onclick: () => done(() => A.addAudioToShelfMany(ids, sh.id), `Added to ${sh.name}`) }, h('span', null, sh.name)))])]);
}

/* ---------- deleting ---------- */
export async function deleteFlow(ids) {
  const books = (await Promise.all(ids.map((id) => A.getAudiobook(id)))).filter(Boolean); const n = books.length; if (!n) return false;
  const what = n === 1 ? `“${books[0].title}”` : `${n} audiobooks`;
  const ok = await confirmDlg(n === 1 ? 'Delete audiobook?' : `Delete ${n} audiobooks?`, `${what} will be removed from Folio on this device: the audio files, cover and listening position. Your original files are not touched.`, n === 1 ? 'Delete' : `Delete ${n}`, true);
  if (!ok) return false;
  await unloadIf(ids); const snap = await A.deleteAudiobooks(ids); forgetCovers(ids); local.sel = null; await rerender();
  toast(n === 1 ? `Deleted “${books[0].title}”` : `Deleted ${n} audiobooks`, 7000, { label: 'Undo', onClick: async () => { await A.restoreAudiobooks(snap); await rerender(); toast(n === 1 ? 'Audiobook restored' : `${n} audiobooks restored`); } });
  return true;
}
async function deleteAllFlow() {
  const n = (await A.getAudiobooks()).length; if (!n) { toast('No audiobooks to delete'); return; }
  const ok = await new Promise((resolve) => {
    let done = false; const input = h('input', { class: 'field typed-confirm', id: 'audio-delete-all-input', placeholder: 'Type DELETE to confirm', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
    const go = h('button', { class: 'btn danger', id: 'audio-delete-all-confirm', disabled: true, onclick: () => { done = true; w.close(); resolve(true); } }, `Delete all ${n} audiobooks`);
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'DELETE'; });
    const w = sheet('Delete ALL audiobooks?', () => [h('p', null, `This permanently removes all ${n} audiobook${n > 1 ? 's' : ''} (files, covers, positions) from Folio on this device. Your ebooks are not affected. This can’t be undone.`), input,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: () => { done = true; w.close(); resolve(false); } }, 'Cancel'), go)], { closeLabel: 'Cancel', onClose: () => { if (!done) resolve(false); } });
    setTimeout(() => input.focus(), 50);
  });
  if (!ok) return;
  const ids = (await A.getAudiobooks()).map((b) => b.id); await unloadIf(ids); await A.deleteAllAudiobooks(); forgetCovers(ids); local.sel = null; await rerender(); toast(`Deleted ${n} audiobook${n > 1 ? 's' : ''}`);
}

/* ---------- menus ---------- */
function emptyState() {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '🎧'), h('h2', null, 'No audiobooks yet'),
    h('p', { class: 'muted' }, 'Import MP3, M4A, M4B, AAC or OGG files (or a folder / zip of chapters), or find free public-domain audiobooks from LibriVox and the Internet Archive.'),
    h('div', { class: 'row-actions center' }, h('button', { class: 'btn primary', id: 'audio-empty-import', onclick: pickAudio }, 'Import audio files'), h('button', { class: 'btn', id: 'audio-empty-online', onclick: () => openAudioSources() }, 'Find free audiobooks'), h('button', { class: 'btn', id: 'audio-empty-chirp', onclick: () => openChirpForm(null, { onDone: rerender }) }, 'Add Chirp audiobook')));
}
function audioMenu(ctx) {
  actionSheet('Audiobooks', [
    { label: '🔎  Free audiobooks (LibriVox, Internet Archive)…', id: 'audio-menu-online', primary: true, onClick: () => openAudioSources() },
    { label: '🎧  Add Chirp audiobook…', id: 'audio-menu-chirp', onClick: () => openChirpForm(null, { onDone: rerender }) },
    { label: 'Import audio files…', id: 'audio-menu-files', onClick: pickAudio },
    { label: 'Import a folder…', id: 'audio-menu-folder', onClick: () => $('#audio-folder-input').click() },
    { label: 'Import from Google Drive…', id: 'audio-menu-drive', onClick: () => openDriveBrowser({ audio: true }) },
    { label: '📖  Audiobook ↔ ebook pairs…', id: 'audio-menu-pairs', onClick: () => import('./findplace.js').then((m) => m.openPairs()) },
    ctx.books.length ? { label: '✨  Fix missing info…', id: 'audio-menu-fix-missing', onClick: () => openFixMissing({ kind: 'audio' }) } : null,
    { label: 'Manage shelves…', onClick: () => manageShelves(ctx) },
    ctx.books.length ? { label: 'Select audiobooks…', id: 'audio-menu-select', onClick: () => { local.sel = new Set(); rerender(); } } : null,
    ctx.books.length ? { label: 'Delete all audiobooks…', id: 'audio-menu-delete-all', danger: true, onClick: () => deleteAllFlow() } : null,
  ].filter(Boolean));
}
async function newShelf() { const n = await promptDlg('New shelf', '', 'e.g. Road trip'); if (n) { const s = await S.createShelf(n); settings.set({ audioChip: s.id }); rerender(); } }
function manageShelves(ctx) {
  sheet('Shelves', (close) => [h('p', { class: 'muted small' }, 'Shelves are shared with your ebook library: one shelf can hold both.'), h('div', { class: 'list' }, ctx.shelves.length ? ctx.shelves.map((s) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, s.name),
    h('button', { class: 'btn small', onclick: async () => { const n = await promptDlg('Rename shelf', s.name); if (n) { await S.renameShelf(s.id, n); close(); rerender(); } } }, 'Rename'),
    h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDlg('Delete shelf?', 'Books and audiobooks stay in your library.', 'Delete', true)) { await S.deleteShelf(s.id); if (settings.get('audioChip') === s.id) settings.set({ audioChip: 'all' }); close(); rerender(); } } }, 'Delete'))) : h('p', { class: 'muted' }, 'No custom shelves yet.')),
    h('button', { class: 'btn primary block', onclick: async () => { close(); newShelf(); } }, 'New shelf')]);
}
export function audioBookMenu(b, ctx) {
  actionSheet(b.title, [
    ...(b.external ? [
      { label: 'Open in Chirp', id: 'audio-menu-open-chirp', primary: true, onClick: () => { openChirp(A.chirpLink(b)); } },
      { label: 'Update where I am…', id: 'audio-menu-chirp-pos', onClick: () => openChirpEntry(b.id, { onChange: rerender }) },
      { label: 'Edit details…', id: 'audio-menu-edit', onClick: () => openChirpForm(b, { onDone: rerender }) },
    ] : [
      { label: 'Play', id: 'audio-menu-play', onClick: () => open(b.id) },
      { label: 'Edit details…', id: 'audio-menu-edit', onClick: () => editBook(b) },
    ]),
    { label: 'Change cover…', id: 'audio-menu-cover', onClick: () => openCoverEditor('audio', b.id, { onDone: rerender }) },
    { label: 'Move to shelf…', id: 'audio-menu-shelf', onClick: () => shelfSheet(b, ctx) },
    { label: '📖  Find my place (ebook)…', id: 'audio-menu-findplace', onClick: () => import('./findplace.js').then((m) => m.openFindPlace({ audioId: b.id })) },
    ...Loans.loanMenuItems('audio', b, rerender),
    A.hasUrls(b) ? (A.isDownloaded(b) ? { label: 'Remove offline copy', id: 'audio-menu-rmdl', onClick: async () => { await A.removeDownload(b.id); toast('Offline copy removed'); rerender(); } } : { label: 'Download for offline', id: 'audio-menu-dl', onClick: async () => { await downloadWithToast(b.id); rerender(); } }) : null,
    { label: 'Delete audiobook', danger: true, id: 'audio-menu-delete', onClick: () => deleteFlow([b.id]) },
  ].filter(Boolean));
}
function shelfSheet(b, ctx) {
  const ui = () => [h('div', { class: 'list' }, [
    ...A.AUDIO_STATUSES.map((st) => h('button', { class: 'list-item', 'data-status': st.id, onclick: async () => { await A.setAudioStatus(b.id, st.id); b.status = st.id; w.close(); rerender(); } }, h('span', null, st.name), h('span', { class: 'check' }, b.status === st.id ? '✓' : ''))),
    ...(ctx.shelves.length ? [h('div', { class: 'sep' }, 'Custom shelves')] : []),
    ...ctx.shelves.map((sh) => h('button', { class: 'list-item', 'data-shelf': sh.id, onclick: async () => { await A.toggleAudioShelf(b.id, sh.id); b.shelves = (await A.getAudiobook(b.id)).shelves; w.close(); shelfSheet(b, ctx); rerender(); } }, h('span', null, sh.name), h('span', { class: 'check' }, b.shelves?.includes(sh.id) ? '✓' : '')))])];
  const w = sheet('Shelves for “' + b.title + '”', ui);
}
function editBook(b) {
  const title = h('input', { class: 'field', id: 'audio-edit-title', value: b.title }); const author = h('input', { class: 'field', id: 'audio-edit-author', value: b.author });
  const desc = h('textarea', { class: 'field', id: 'audio-edit-description', rows: 4 }, b.description || ''); const year = h('input', { class: 'field', id: 'audio-edit-year', type: 'number', min: '0', max: '2100', value: b.year ?? '' }); const lang = h('input', { class: 'field', id: 'audio-edit-language', value: b.language || '' });
  sheet('Edit audiobook', (close) => [h('label', null, 'Title', title), h('label', null, 'Author', author), h('label', null, 'Description', desc), h('div', { class: 'row-fields' }, h('label', null, 'Year', year), h('label', null, 'Language', lang)),
    h('button', { class: 'btn primary block', id: 'audio-save', onclick: async () => { const bk = await A.getAudiobook(b.id); bk.title = title.value.trim() || bk.title; markEdits(bk, { author: author.value, description: desc.value, year: year.value, language: lang.value }); await A.saveAudiobook(bk); S.emitChange(); close(); rerender(); } }, 'Save')]);
}

/* ---------- import ---------- */
export function pickAudio() { $('#audio-input').click(); }
const isAudioLike = (f) => A.isAudioName(f.name) || A.isDrmName(f.name) || /^audio\//.test(f.type) || /\.zip$/i.test(f.name);
/** Files from the picker / a drop. Several loose audio files: ask whether they're one book (ordered by file name) or separate books. */
export async function handleAudioFiles(files, { ask = true } = {}) {
  files = files.filter((f) => isAudioLike(f) || f.webkitRelativePath || f._rel); if (!files.length) { toast('No audio files found'); return; }
  const loose = files.filter((f) => !/\.zip$/i.test(f.name) && !(f.webkitRelativePath || f._rel || '').includes('/') && !A.isDrmName(f.name));
  let mode = 'auto';
  if (ask && loose.length > 1 && loose.length === files.length) mode = await chooseMode(loose.length);
  if (mode == null) return;
  toast('Importing audio…', 60000);
  const res = await A.importAudioFiles(files, mode);
  if (res.drm.length) sheet('Copy-protected audiobook' + (res.drm.length > 1 ? 's' : ''), () => [h('p', { id: 'audio-drm-msg' }, res.drm.length === 1 ? '“' + res.drm[0] + '” is copy-protected, so Folio can’t import it.' : res.drm.length + ' items are copy-protected, so Folio can’t import them:'),
    ...(res.drm.length > 1 ? [h('ul', null, ...res.drm.map((n) => h('li', null, n)))] : []), h('p', { class: 'muted' }, A.COPY_PROTECTED_MSG), h('button', { class: 'btn primary block', onclick: () => { $('#overlay').replaceChildren(); $('#overlay').hidden = true; openAudioSources(); } }, 'Find free audiobooks')]);
  if (res.ok.length) toast(`Imported ${res.ok.length} audiobook${res.ok.length > 1 ? 's' : ''}` + (res.errs.length ? `, ${res.errs.length} failed` : ''), 3500);
  else if (res.errs.length) toast(res.errs[0], 6000); else if (!res.drm.length) toast('Nothing to import', 3000); else $('#toast').hidden = true;
  if (res.errs.length && res.ok.length) toast(res.errs[0], 5200);
  rerender(); return res;
}
function chooseMode(n) {
  return new Promise((resolve) => {
    let done = false; const pick = (v, w) => () => { done = true; w.close(); resolve(v); };
    const w = sheet(`${n} audio files`, () => [h('p', { class: 'muted' }, 'Are these chapters of one audiobook, or separate audiobooks?'),
      h('button', { class: 'btn primary block', id: 'audio-one', onclick: () => pick('one', w)() }, `One audiobook (ordered by file name)`),
      h('button', { class: 'btn block', id: 'audio-each', onclick: () => pick('each', w)() }, `${n} separate audiobooks`)], { closeLabel: 'Cancel', onClose: () => { if (!done) resolve(null); } });
  });
}
/** Dropped files + folders → File[] (folder files carry _rel). Returns null when the drop has nothing audio-like. */
export async function collectDropped(dt) {
  const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  const out = []; const walk = async (en, path) => {
    if (en.isFile) { const f = await new Promise((res, rej) => en.file(res, rej)); if (path) f._rel = path + f.name; out.push(f); }
    else if (en.isDirectory) { const rd = en.createReader(); let batch; do { batch = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const c of batch) await walk(c, path + en.name + '/'); } while (batch.length); }
  };
  if (entries.some((e) => e.isDirectory)) for (const e of entries) await walk(e, ''); else out.push(...(dt.files || []));
  return out;
}
export const dropLooksAudio = (dt) => [...(dt.files || [])].some((f) => A.isAudioName(f.name) || A.isDrmName(f.name) || /^audio\//.test(f.type) || /\.zip$/i.test(f.name) || f.type === '') && ![...(dt.files || [])].some((f) => /\.(epub|pdf|mobi|azw3?|kf8)$/i.test(f.name));

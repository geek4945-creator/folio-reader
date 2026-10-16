// Library tab: shelves, sets (series), grid/list, sort incl. custom drag order, search, import.
import { h, toast, sheet, actionSheet, confirmDlg, promptDlg, fmtPct, hashHue, $, put } from './util.js';
import { settings, GROUP_OPTIONS, SORT_FIELDS, SET_SORT_FIELDS, getSort, setSort, clearSort, dirWord, DEFAULT_DIR } from './settings.js';
import * as S from './store.js';
import { enableDragSort } from './dragsort.js';
import { registerBack } from './nav.js';
import { openReader } from './reader.js';
import { openDriveBrowser } from './drive.js';
import { openPublicLibraryGuide, openDrmFreeHelp } from './publib.js';
import { markEdits } from './metasync.js';
import { openCoverEditor, hasCustomCover } from './covers.js';
import { openFixMissing } from './enrich.js';
import * as Loans from './loans.js';
import { installMode, installLabel, startInstall } from './install.js';

let view; const covers = new Map();
let local = { setId: null, q: '', sel: null, visible: [] };   // sel: Set of selected book ids while in multi-select mode

export function coverUrl(b) {
  if (!b.coverBlob) return null;
  const k = b.id + ':' + b.coverBlob.size;
  if (!covers.has(k)) covers.set(k, URL.createObjectURL(b.coverBlob));
  return covers.get(k);
}
const recent = (b) => b.lastOpened || b.addedAt || 0;
const norm = (s) => (s || '').toLowerCase().replace(/^(the|a|an)\s+/, '');

/** Renders are queued one after another: two overlapping renders (typing in search, an import finishing) used to interleave and draw tiles twice. */
let renderChain = Promise.resolve();
export function renderLibrary(v) { if (v) view = v; const run = renderChain.then(() => drawLibrary()); renderChain = run.catch((e) => console.warn('render failed', e)); return run; }
async function drawLibrary() {
  if (!view) return;   // an import finished before this tab was ever shown
  const [books, sets, shelves] = await Promise.all([S.getBooks(), S.getSets(), S.getShelves()]);
  const scroll = view.scrollTop;
  view.replaceChildren();
  const ctx = { books, sets, shelves, setMap: new Map(sets.map((s) => [s.id, s])) };
  if (local.setId && ctx.setMap.has(local.setId)) local.sel = null;
  view.classList.toggle('selecting', !!local.sel);
  if (local.sel) for (const id of [...local.sel]) if (!ctx.books.some((b) => b.id === id)) local.sel.delete(id);
  if (local.setId && ctx.setMap.has(local.setId)) await renderSetPage(ctx); else { local.setId = null; await renderMain(ctx); }
  view.scrollTop = scroll;
}
const rerender = () => renderLibrary();

/* ---------- main ---------- */
async function renderMain(ctx) {
  const { shelves } = ctx; sortCtx = ctx;
  const allBooks = ctx.books; const books = Loans.owned(allBooks), borrowedBooks = Loans.borrowedOf(allBooks);   // Borrowed (library loans) stay out of the owned library, its chips and its counts
  let chip = settings.get('chip'); if (chip === 'borrowed' && !borrowedBooks.length) chip = 'all'; const sortKey = 'shelf:' + chip; const gb = chip === 'all' ? (settings.get('groupBy') || 'status') : null;
  const orderKey = sortKey + (gb === 'none' ? ':flat' : '');   // the flat list keeps its own custom order
  const spec = getSort(sortKey); const sort = spec.field; const viewMode = settings.get('view');
  const search = h('input', { type: 'search', class: 'field search', placeholder: 'Search title, author or series', value: local.q, enterkeyhint: 'search' });
  search.addEventListener('input', () => { local.q = search.value; drawBody(); });

  const chips = [{ id: 'all', name: 'All' }, ...S.STATUSES, ...shelves.map((s) => ({ id: s.id, name: s.name, custom: true })), ...(borrowedBooks.length ? [{ id: 'borrowed', name: 'Borrowed', borrowed: true }] : [])];
  const banner = await Loans.loanBanner('book', rerender);
  put(view, 
    h('header', { class: 'topbar' }, h('h1', null, 'Library'),
      h('div', { class: 'top-actions' },
        allBooks.length ? h('button', { class: 'btn-text' + (local.sel ? ' on' : ''), id: 'btn-select', 'aria-label': local.sel ? 'Done selecting' : 'Select books', onclick: toggleSelect }, local.sel ? 'Done' : 'Select') : null,
        h('button', { class: 'btn-icon', 'aria-label': 'Import books', title: 'Import books (EPUB, MOBI, AZW3, PDF)', onclick: pickFiles }, '＋'),
        h('button', { class: 'btn-icon', 'aria-label': 'Library menu', id: 'lib-menu', onclick: () => libMenu(ctx) }, '⋯'))),
    h('div', { class: 'pad' }, search), banner,
    h('div', { class: 'chips', role: 'tablist' }, chips.map((c) => h('button', { class: 'chip' + (chip === c.id ? ' on' : ''), role: 'tab', 'data-chip': c.id, onclick: () => { settings.set({ chip: c.id }); rerender(); } }, c.name,
      c.borrowed ? h('small', null, ' ' + borrowedBooks.length) : c.id !== 'all' && !c.custom ? h('small', null, ' ' + books.filter((b) => b.status === c.id).length) : (c.custom ? h('small', null, ' ' + books.filter((b) => b.shelves?.includes(c.id)).length) : null))),
      h('button', { class: 'chip add', onclick: newShelf, 'aria-label': 'New shelf' }, '＋ Shelf')),
    h('div', { class: 'toolbar pad' },
      h('label', { class: 'sort' }, 'Sort ', h('select', { id: 'sort-sel', onchange: (e) => { setSort(sortKey, { field: e.target.value }); rerender(); } },
        SORT_FIELDS.map(([v, n]) => h('option', { value: v, selected: v === sort }, n)))),
      gb ? h('label', { class: 'sort' }, 'Group ', h('select', { id: 'group-sel', onchange: (e) => { settings.set({ groupBy: e.target.value }); rerender(); } }, GROUP_OPTIONS.map(([v, n]) => h('option', { value: v, selected: v === gb }, n.replace(/ \(.*/, ''))))) : null,
      sort !== 'custom' ? dirButton(spec, () => { setSort(sortKey, { dir: spec.dir === 'asc' ? 'desc' : 'asc' }); rerender(); }) : null,
      sort === 'custom' ? h('button', { class: 'btn small', id: 'reset-order', onclick: () => resetOrder(orderKey, false, sortKey) }, 'Reset to automatic') : null,
      h('span', { class: 'grow' }),
      h('div', { class: 'seg' },
        h('button', { class: viewMode === 'grid' ? 'on' : '', 'aria-label': 'Grid view', id: 'view-grid', onclick: () => { settings.set({ view: 'grid' }); rerender(); } }, '▦'),
        h('button', { class: viewMode === 'list' ? 'on' : '', 'aria-label': 'List view', id: 'view-list', onclick: () => { settings.set({ view: 'list' }); rerender(); } }, '☰'))),
    sort === 'custom' ? h('p', { class: 'hint pad' }, 'Press and hold a book, then drag to reorder. New books are added to the end.') : null);
  const body = h('div', { id: 'lib-body' }); put(view, body);
  if (local.sel) put(view, selectBar());

  async function drawBody() {
    body.replaceChildren();
    const q = local.q.trim().toLowerCase();
    const match = (b) => !q || [b.title, b.author, ctx.setMap.get(b.setId)?.name].some((x) => (x || '').toLowerCase().includes(q));
    const src = chip === 'borrowed' ? borrowedBooks : books;
    const ofChip = (b) => chip === 'all' ? true : chip === 'borrowed' ? !!b.borrowed : S.STATUSES.some((s) => s.id === chip) ? b.status === chip : !!b.shelves?.includes(chip);
    let pool = src.filter((b) => ofChip(b) && match(b));
    if (chip === 'all' && !settings.get('showFinished')) pool = pool.filter((b) => b.status !== 'finished');   // toggle off: finished books are hidden from All
    local.visible = pool.map((b) => b.id);
    const scopeN = src.filter(ofChip).length;
    const footer = () => h('div', { class: 'lib-count', id: 'lib-count', dataset: { shown: String(pool.length), total: String(scopeN) } }, `${pool.length}${pool.length !== scopeN ? ' of ' + scopeN : ''} book${(pool.length !== scopeN ? scopeN : pool.length) === 1 ? '' : 's'}`);   // "N books", or "N of M books" when a search / hidden Finished narrows the shelf
    if (!allBooks.length) { body.append(emptyState()); return; }
    if (!pool.length) { body.append(h('p', { class: 'muted pad center' }, q ? 'No matches.' : chip === 'all' && borrowedBooks.length ? 'Nothing here — your library only has borrowed books (see the Borrowed filter).' : 'Nothing on this shelf yet.'), footer()); return; }
    const saved = sort === 'custom' ? await S.getOrder(orderKey) : [];
    let sections;
    if (chip !== 'all') sections = [{ id: chip, title: null, books: pool }];
    else if (gb === 'status') sections = S.STATUSES.filter((s) => s.id !== 'finished' || settings.get('showFinished')).map((s) => ({ id: s.id, title: s.name, books: pool.filter((b) => b.status === s.id), collapsible: true, ckey: s.id }));
    else if (gb === 'none') sections = [{ id: 'flat', title: null, books: pool }];
    else sections = groupSections(gb, pool, ctx);
    const flatTiles = !!q || ['series', 'author', 'type'].includes(gb);   // one book can only sit in one group, so no set tiles there
    sections = sections.map((s) => ({ ...s, tiles: sortTiles(buildTiles(s.books, ctx, flatTiles), sort, saved, spec.dir) }));
    for (const sec of sections) {
      if (!sec.tiles.length) continue;
      const ck = 'folio.collapse.' + (sec.ckey || gb + ':' + sec.id);
      const collapsed = sec.collapsible && localStorage.getItem(ck) === '1';
      const grid = h('div', { class: 'tiles ' + viewMode, dataset: { ctx: orderKey, group: sec.id } }, collapsed ? null : sec.tiles.map((t) => tileEl(t, ctx, viewMode)));
      if (sec.title) body.append(h('h3', { class: 'sec-title group-hdr' + (sec.collapsible ? ' tap' : ''), dataset: { group: sec.id, collapsed: collapsed ? '1' : '0' }, onclick: sec.collapsible ? () => { localStorage.setItem(ck, collapsed ? '0' : '1'); drawBody(); } : null }, (sec.collapsible ? (collapsed ? '▸ ' : '▾ ') : '') + sec.title, h('small', null, ' ' + sec.books.length)));
      body.append(grid);
      if (sort === 'custom' && !q && !collapsed && !local.sel) enableDragSort(grid, { itemSel: '.tile', vertical: viewMode === 'list', onDrop: () => persistOrder(orderKey) });
    }
    body.append(footer());
  }
  await drawBody();
}

const TYPE_ORDER = ['EPUB', 'MOBI', 'AZW3', 'PDF'];
/** "Group by" sections for the All view (series / author / file type). Unknowns go last. */
function groupSections(gb, pool, ctx) {
  const map = new Map();
  const add = (id, title, b, rank) => { if (!map.has(id)) map.set(id, { id, title, books: [], collapsible: true, rank }); map.get(id).books.push(b); };
  for (const b of pool) {
    if (gb === 'series') { const set = b.setId && ctx.setMap.get(b.setId); if (set) add('s:' + set.id, set.name, b, 0); else add('none', 'No series', b, 1e6); }
    else if (gb === 'author') { const a = (b.author || '').trim(); if (!a || /^unknown author$/i.test(a)) add('a:', 'Unknown author', b, 1e6); else add('a:' + norm(a), a, b, 0); }
    else { const t = fileType(b); add('t:' + t, t, b, TYPE_ORDER.indexOf(t)); }
  }
  return [...map.values()].sort((x, y) => x.rank - y.rank || (gb === 'type' ? 0 : norm(x.title).localeCompare(norm(y.title))));
}

/* ---------- multi-select ---------- */
registerBack('library', () => { if (local.sel) { local.sel = null; rerender(); return true; } if (local.setId) { local.setId = null; rerender(); return true; } return false; });   // Back: leave select mode, then the set page
function toggleSelect() { local.sel = local.sel ? null : new Set(); rerender(); }
function toggleSel(ids) {
  const all = ids.every((id) => local.sel.has(id));
  for (const id of ids) all ? local.sel.delete(id) : local.sel.add(id);
  refreshSelection();
}
function refreshSelection() {
  if (!local.sel) return;
  view.querySelectorAll('.tile.book').forEach((el) => el.classList.toggle('sel', local.sel.has(el.dataset.id)));
  view.querySelectorAll('.tile.set').forEach((el) => { const ids = (el.dataset.books || '').split(',').filter(Boolean); el.classList.toggle('sel', ids.length > 0 && ids.every((id) => local.sel.has(id))); });
  const n = local.sel.size; const c = $('#sel-count'); if (c) c.textContent = n ? `${n} selected` : 'Tap books to select';
  view.querySelectorAll('#select-bar [data-needs-sel]').forEach((b) => { b.disabled = !n; });
}
function selectBar() {
  const need = { 'data-needs-sel': '1', disabled: true };
  return h('div', { id: 'select-bar', role: 'toolbar', 'aria-label': 'Selected books' },
    h('span', { class: 'grow', id: 'sel-count' }, 'Tap books to select'),
    h('button', { class: 'btn small', id: 'sel-all', onclick: () => { local.visible.forEach((id) => local.sel.add(id)); refreshSelection(); } }, 'Select all'),
    h('button', { class: 'btn small', id: 'sel-clear', onclick: () => { local.sel.clear(); refreshSelection(); } }, 'Clear'),
    h('button', { class: 'btn small', id: 'sel-move', ...need, onclick: () => moveSelected() }, 'Move to shelf'),
    h('button', { class: 'btn small', id: 'sel-finish', ...need, onclick: async () => { const ids = [...local.sel]; await S.setStatusMany(ids, 'finished'); toast(`Marked ${ids.length} book${ids.length > 1 ? 's' : ''} finished`); local.sel = null; rerender(); } }, 'Mark finished'),
    h('button', { class: 'btn small danger', id: 'sel-delete', ...need, onclick: () => deleteBooksFlow([...local.sel]) }, 'Delete'));
}
async function moveSelected() {
  const ids = [...local.sel]; const shelves = await S.getShelves();
  const done = async (fn, msg) => { await fn(); toast(msg); local.sel = null; w.close(); rerender(); };
  const w = sheet(`Move ${ids.length} book${ids.length > 1 ? 's' : ''} to…`, () => [h('div', { class: 'list' }, [
    ...S.STATUSES.map((st) => h('button', { class: 'list-item', 'data-status': st.id, onclick: () => done(() => S.setStatusMany(ids, st.id), `Moved to ${st.name}`) }, h('span', null, st.name))),
    ...(shelves.length ? [h('div', { class: 'sep' }, 'Add to custom shelf')] : []),
    ...shelves.map((sh) => h('button', { class: 'list-item', 'data-shelf': sh.id, onclick: () => done(() => S.addToShelfMany(ids, sh.id), `Added to ${sh.name}`) }, h('span', null, sh.name))),
  ])]);
}

/* ---------- deleting ---------- */
function forgetCovers(ids) { for (const [k, u] of [...covers]) if (ids.some((id) => k.startsWith(id + ':'))) { URL.revokeObjectURL(u); covers.delete(k); } }
const ORIGINALS = 'The original files on your device or in Google Drive are not touched.';
export async function deleteBooksFlow(ids) {
  const books = (await Promise.all(ids.map((id) => S.getBook(id)))).filter(Boolean); const n = books.length; if (!n) return false;
  const what = n === 1 ? `“${books[0].title}”` : `${n} books`;
  const ok = await confirmDlg(n === 1 ? 'Delete book?' : `Delete ${n} books?`, `${what} will be removed from Folio on this device: the book file, cover, reading position, bookmarks and per-book settings. If you use Google sync, the deletion syncs to your other devices. ${ORIGINALS}`, n === 1 ? 'Delete' : `Delete ${n}`, true);
  if (!ok) return false;
  const snap = await S.deleteBooks(books.map((b) => b.id)); forgetCovers(books.map((b) => b.id));
  local.sel = null; await rerender();
  toast(n === 1 ? `Deleted “${books[0].title}”` : `Deleted ${n} books`, 7000, { label: 'Undo', onClick: async () => { await S.restoreBooks(snap); await rerender(); toast(n === 1 ? 'Book restored' : `${n} books restored`); } });
  return true;
}
/** Strong confirm: the user has to type DELETE. */
export async function deleteAllBooksFlow() {
  const n = (await S.getBooks()).length; if (!n) { toast('Your library is already empty'); return false; }
  const ok = await new Promise((resolve) => {
    let done = false; const input = h('input', { class: 'field typed-confirm', id: 'delete-all-input', placeholder: 'Type DELETE to confirm', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' });
    const go = h('button', { class: 'btn danger', id: 'delete-all-confirm', disabled: true, onclick: () => { done = true; w.close(); resolve(true); } }, `Delete all ${n} books`);
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== 'DELETE'; });
    const w = sheet('Delete ALL books?', () => [
      h('p', null, `This permanently removes all ${n} book${n > 1 ? 's' : ''} from Folio on this device: files, covers, reading positions, bookmarks, per-book settings, sets and custom order. Your shelves and app settings stay. If you use Google sync, the deletion syncs to your other devices.`),
      h('p', { class: 'muted' }, `${ORIGINALS} This can’t be undone.`), input,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: () => { done = true; w.close(); resolve(false); } }, 'Cancel'), go)], { closeLabel: 'Cancel', onClose: () => { if (!done) resolve(false); } });
    setTimeout(() => input.focus(), 50);
  });
  if (!ok) return false;
  const count = await S.deleteAllBooks(); forgetCovers([...covers.keys()].map((k) => k.split(':')[0])); local.setId = null; local.sel = null; await rerender();
  toast(`Deleted ${count} book${count > 1 ? 's' : ''}`); return true;
}

function emptyState() {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '📖'), h('h2', null, 'Your library is empty'),
    h('p', { class: 'muted' }, 'Import EPUB, MOBI, AZW3 or PDF files from your device, or browse the Catalogs tab to download free books.'),
    h('div', { class: 'row-actions center' }, h('button', { class: 'btn primary', onclick: pickFiles }, 'Import books'),
      h('button', { class: 'btn', onclick: () => document.querySelector('[data-tab=catalogs]').click() }, 'Browse catalogs')),
    h('div', { class: 'row-actions center' }, h('button', { class: 'btn plib-empty-btn', id: 'empty-public-library', onclick: () => openPublicLibraryGuide() }, '🏛️ Public library: borrow with Libby')));
}

/* ---------- tiles / sorting ---------- */
function groupable(set, ctx) { return set && (!set.auto || ctx.books.filter((b) => b.setId === set.id).length >= 2); }

function buildTiles(bs, ctx, flat) {
  if (flat || !settings.get('groupSets')) return bs.map((b) => ({ type: 'book', key: 'b:' + b.id, book: b }));
  const out = []; const seen = new Map();
  for (const b of bs) {
    const set = b.setId && ctx.setMap.get(b.setId);
    if (set && groupable(set, ctx)) {
      let t = seen.get(set.id);
      if (!t) { t = { type: 'set', key: 's:' + set.id, set, books: [] }; seen.set(set.id, t); out.push(t); }
      t.books.push(b);
    } else out.push({ type: 'book', key: 'b:' + b.id, book: b });
  }
  for (const t of out) if (t.type === 'set') t.books.sort(volumeSort);
  return out;
}
const volumeSort = (a, b) => (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9) || norm(a.title).localeCompare(norm(b.title));
const tileTitle = (t) => t.type === 'set' ? t.set.name : t.book.title;
const tileAuthor = (t) => (t.type === 'set' ? t.books[0] : t.book).author || '';
const tileRecent = (t) => t.type === 'set' ? Math.max(...t.books.map(recent)) : recent(t.book);
const tileSeries = (t, ctx) => t.type === 'set' ? t.set.name : (t.book.setId && ctx && ctx.setMap.get(t.book.setId)?.name) || '';
const tileIndex = (t) => (t.type === 'set' ? t.books[0] : t.book).seriesIndex ?? 1e9;
const tileAdded = (t) => t.type === 'set' ? Math.max(...t.books.map((b) => b.addedAt || 0)) : (t.book.addedAt || 0);
const tileProgress = (t) => { const p = (b) => (b.status === 'finished' ? 1 : b.progress || 0); return t.type === 'set' ? t.books.reduce((a, b) => a + p(b), 0) / t.books.length : p(t.book); };
export const fileType = (b) => (b.format === 'pdf' ? 'PDF' : b.origFormat ? (b.origFormat === 'kf8' ? 'AZW3' : 'MOBI') : 'EPUB');
const tileType = (t) => fileType(t.type === 'set' ? t.books[0] : t.book);
const byTitle = (a, b) => norm(tileTitle(a)).localeCompare(norm(tileTitle(b)));
function sortTiles(tiles, sort, saved, dir = 'asc', ctx = sortCtx) {
  const t = [...tiles]; const m = dir === 'desc' ? -1 : 1;
  if (sort === 'title') t.sort((a, b) => m * byTitle(a, b));
  else if (sort === 'author') t.sort((a, b) => { const x = norm(tileAuthor(a)), y = norm(tileAuthor(b)); if (!x !== !y) return !x ? 1 : -1; return m * x.localeCompare(y) || byTitle(a, b); });
  else if (sort === 'recent') t.sort((a, b) => m * (tileRecent(a) - tileRecent(b)) || byTitle(a, b));
  else if (sort === 'added') t.sort((a, b) => m * (tileAdded(a) - tileAdded(b)) || byTitle(a, b));
  else if (sort === 'progress') t.sort((a, b) => m * (tileProgress(a) - tileProgress(b)) || byTitle(a, b));
  else if (sort === 'type') t.sort((a, b) => m * tileType(a).localeCompare(tileType(b)) || byTitle(a, b));
  else if (sort === 'series') t.sort((a, b) => { const x = tileSeries(a, ctx), y = tileSeries(b, ctx); if (!x !== !y) return !x ? 1 : -1; return m * x.localeCompare(y, undefined, { sensitivity: 'base' }) || (tileIndex(a) - tileIndex(b)) || byTitle(a, b); });
  else { t.sort((a, b) => tileRecent(a) - tileRecent(b)); return S.applyOrder(t, saved); }   // custom: new items append in added order
  return t;
}
function dirButton(spec, onClick) {
  const asc = spec.dir === 'asc';
  return h('button', { class: 'btn small dir', id: 'sort-dir', 'data-dir': spec.dir, 'aria-label': 'Sort direction: ' + (asc ? 'ascending' : 'descending') + ' (' + dirWord(spec.field, spec.dir) + '). Tap to reverse.', title: dirWord(spec.field, spec.dir), onclick: onClick }, (asc ? '↑ ' : '↓ ') + dirWord(spec.field, spec.dir));
}
let sortCtx = null;

async function persistOrder(ctxKey) {
  // Read the arrangement from what is on screen NOW (all grids of this context), never from the render that built the page: a second drag in another
  // section would otherwise write the first section's old order back. Keys of tiles that are hidden (collapsed, filtered) keep their saved relative order, after.
  const shown = [...view.querySelectorAll('.tiles')].filter((g) => g.dataset.ctx === ctxKey).flatMap((g) => [...g.querySelectorAll('.tile')].map((t) => t.dataset.key)).filter(Boolean);
  const prev = await S.getOrder(ctxKey); const have = new Set(shown);
  await S.saveOrder(ctxKey, [...shown, ...prev.filter((k) => !have.has(k))]);
}
async function resetOrder(ctxKey, setKind, sortKey = ctxKey) {
  await S.clearOrder(ctxKey);
  clearSort(sortKey);   // back to the default sort for this shelf / set
  toast('Order reset to automatic sort'); rerender();
}

/* ---------- tile elements ---------- */
function badge(b) {
  if (b.status === 'finished') return h('span', { class: 'pbadge done', title: 'Finished' }, '✓');
  if (b.progress > 0.005) return h('span', { class: 'pbadge' }, fmtPct(b.progress));
  return h('span', { class: 'pbadge new' }, 'NEW');
}
function coverEl(b, extra) {
  const u = coverUrl(b); const hue = hashHue(b.title);
  return h('div', { class: 'cover' },
    h('div', { class: 'cover-ph', style: { background: `linear-gradient(135deg,hsl(${hue} 45% 38%),hsl(${(hue + 40) % 360} 45% 28%))` } }, h('span', null, b.title), h('small', null, b.author)),
    u ? h('img', { class: 'cover-img', src: u, alt: '', draggable: 'false' }) : null, extra);
}
function tileEl(t, ctx, mode) {
  if (t.type === 'set') return setTile(t, ctx, mode);
  const b = t.book;
  const more = h('button', { class: 'tile-more', 'aria-label': 'Book options', onclick: (e) => { e.stopPropagation(); bookMenu(b, ctx); } }, '⋯');
  const ov = b.format !== 'pdf' && S.hasOverrides(b) ? h('span', { class: 'ovr', title: 'Custom reading settings for this book' }, 'Aa') : null;
  const vol = b.seriesIndex != null && b.setId ? h('span', { class: 'vol' }, '#' + b.seriesIndex) : null;
  const bar = h('div', { class: 'bar' }, h('i', { style: { width: Math.round((b.status === 'finished' ? 1 : b.progress) * 100) + '%' } }));
  const act = () => (local.sel ? toggleSel([b.id]) : openReader(b.id));
  const el = h('div', { class: 'tile book' + (local.sel && local.sel.has(b.id) ? ' sel' : ''), dataset: { key: t.key, id: b.id }, tabindex: 0, role: 'button', onclick: act, onkeydown: (e) => { if (e.key === 'Enter') act(); } },
    coverEl(b, [badge(b), ov, vol, b.borrowed ? Loans.dueBadge(b) : null, b.format === 'pdf' ? h('span', { class: 'pill-pdf' }, 'PDF') : null, h('span', { class: 'selmark' }, '✓'), mode === 'grid' ? more : null]),
    h('div', { class: 'meta' }, h('div', { class: 't clamp2' }, b.title), h('div', { class: 'a ellipsis muted' }, b.author),
      mode === 'list' ? [b.setId && ctx.setMap.get(b.setId) ? h('div', { class: 'muted small ellipsis' }, ctx.setMap.get(b.setId).name + (b.seriesIndex != null ? ' · #' + b.seriesIndex : '')) : null, bar] : null),
    mode === 'list' ? more : null);
  el.__onHold = () => bookMenu(b, ctx);   // press-and-hold = the ⋯ menu
  return el;
}
function setTile(t, ctx, mode) {
  const top = t.books.slice(0, 3);
  const stack = h('div', { class: 'cover stack' }, top.map((b, i) => { const u = coverUrl(b); const hue = hashHue(b.title);
    return h('div', { class: 'stk s' + i }, u ? h('img', { class: 'cover-img', src: u, alt: '', draggable: 'false' }) : h('div', { class: 'cover-ph', style: { background: `hsl(${hue} 40% 36%)` } }, h('span', null, b.title))); }).reverse(),
    h('span', { class: 'pbadge set' }, t.books.length + ' books'));
  const done = t.books.filter((b) => b.status === 'finished').length;
  const ids = t.books.map((b) => b.id);
  const el = h('div', { class: 'tile set' + (local.sel && ids.every((id) => local.sel.has(id)) ? ' sel' : ''), dataset: { key: t.key, books: ids.join(',') }, tabindex: 0, role: 'button', onclick: () => { if (local.sel) toggleSel(ids); else { local.setId = t.set.id; rerender(); } } },
    h('span', { class: 'selmark' }, '✓'), stack, h('div', { class: 'meta' }, h('div', { class: 't clamp2' }, t.set.name), h('div', { class: 'a muted ellipsis' }, (t.books[0].author || '') + (done ? ` · ${done}/${t.books.length} read` : ''))));
  el.__onHold = () => setMenu(t.set, ctx);
  return el;
}

/* ---------- set page ---------- */
async function renderSetPage(ctx) {
  const set = ctx.setMap.get(local.setId);
  const all = ctx.books.filter((b) => b.setId === set.id);
  const sortKey = 'set:' + set.id; const spec = getSort(sortKey); const sortMode = spec.field; const viewMode = settings.get('view');
  const key = 'set:' + set.id; const saved = sortMode === 'custom' ? await S.getOrder(key) : [];
  const mul = spec.dir === 'desc' ? -1 : 1; let tiles;
  if (sortMode === 'custom') tiles = S.applyOrder(all.map((b) => ({ type: 'book', key: 'b:' + b.id, book: b })).sort((a, b) => a.book.addedAt - b.book.addedAt), saved);
  else tiles = all.sort(sortMode === 'title' ? (a, b) => mul * norm(a.title).localeCompare(norm(b.title)) : sortMode === 'added' ? (a, b) => mul * ((a.addedAt || 0) - (b.addedAt || 0)) || volumeSort(a, b) : (a, b) => mul * volumeSort(a, b)).map((b) => ({ type: 'book', key: 'b:' + b.id, book: b }));
  put(view, 
    h('header', { class: 'topbar' }, h('button', { class: 'btn-text', id: 'set-back', onclick: () => { local.setId = null; rerender(); } }, '‹ Library'), h('h2', { class: 'grow ellipsis' }, set.name),
      h('button', { class: 'btn-icon', onclick: () => setMenu(set, ctx) }, '⋯')),
    h('div', { class: 'toolbar pad' },
      h('label', { class: 'sort' }, 'Order ', h('select', { id: 'set-sort-sel', onchange: (e) => { setSort(sortKey, { field: e.target.value }); rerender(); } },
        SET_SORT_FIELDS.map(([v, n]) => h('option', { value: v, selected: v === sortMode }, n)))),
      sortMode !== 'custom' ? dirButton(spec, () => { setSort(sortKey, { dir: spec.dir === 'asc' ? 'desc' : 'asc' }); rerender(); }) : null,
      sortMode === 'custom' ? h('button', { class: 'btn small', id: 'reset-order', onclick: () => resetOrder(key, true) }, 'Reset to automatic') : null, h('span', { class: 'grow' }),
      h('div', { class: 'seg' }, h('button', { class: viewMode === 'grid' ? 'on' : '', onclick: () => { settings.set({ view: 'grid' }); rerender(); } }, '▦'), h('button', { class: viewMode === 'list' ? 'on' : '', onclick: () => { settings.set({ view: 'list' }); rerender(); } }, '☰'))),
    sortMode === 'custom' ? h('p', { class: 'hint pad' }, 'Press and hold a book, then drag to reorder within this set.') : null);
  if (!all.length) { put(view, h('p', { class: 'muted pad center' }, 'This set is empty. Use ⋯ → Add books, or assign a set when editing a book.')); return; }
  const grid = h('div', { class: 'tiles ' + viewMode, dataset: { ctx: key } }, tiles.map((t) => tileEl(t, ctx, viewMode)));
  put(view, grid);
  if (sortMode === 'custom') enableDragSort(grid, { itemSel: '.tile', vertical: viewMode === 'list', onDrop: () => persistOrder(key) });
}
function setMenu(set, ctx) {
  actionSheet(set.name, [
    { label: 'Rename set', onClick: async () => { const n = await promptDlg('Rename set', set.name); if (n) { await S.renameSet(set.id, n); rerender(); } } },
    { label: 'Add books…', onClick: () => addBooksToSet(set, ctx) },
    { label: 'Delete set (keeps books)', danger: true, onClick: async () => { if (await confirmDlg('Delete set?', 'Books stay in your library but are no longer grouped.', 'Delete', true)) { await S.deleteSet(set.id); local.setId = null; rerender(); } } },
  ]);
}
function addBooksToSet(set, ctx) {
  const others = ctx.books.filter((b) => b.setId !== set.id).sort((a, b) => norm(a.title).localeCompare(norm(b.title)));
  sheet('Add books to ' + set.name, (close) => h('div', { class: 'list' }, others.length ? others.map((b) => h('button', { class: 'list-item', onclick: async () => { await S.assignSet(b.id, set.id, b.seriesIndex ?? (ctx.books.filter((x) => x.setId === set.id).length + 1)); close(); rerender(); } },
    h('span', null, b.title, h('small', { class: 'muted' }, ' — ' + b.author)))) : h('p', { class: 'muted pad' }, 'All books are already in this set.')), { tall: true });
}

/* ---------- menus & dialogs ---------- */
function libMenu(ctx) {
  const sheetObj = actionSheet('Library', [
    { label: '🏛️  Public library (borrow with Libby)…', onClick: () => openPublicLibraryGuide(), primary: true, id: 'menu-public-library' },
    { label: 'Import EPUB / MOBI / AZW3 / PDF files (Files app)…', onClick: pickFiles },
    { label: '🎧  Audiobook ↔ ebook pairs…', id: 'menu-pairs', onClick: () => import('./findplace.js').then((m) => m.openPairs()) },
    { label: 'Import from Google Drive…', onClick: openDriveBrowser },
    { label: 'Group series into sets', checked: settings.get('groupSets'), keepOpen: true, onClick: () => { settings.set({ groupSets: !settings.get('groupSets') }); sheetObj.close(); rerender(); } },
    { label: 'Group by: ' + (GROUP_OPTIONS.find(([v]) => v === (settings.get('groupBy') || 'status'))?.[1].replace(/ \(.*/, '')) + '…', id: 'menu-group', onClick: () => groupSheet() },
    { label: (settings.get('groupBy') || 'status') === 'status' ? 'Show Finished as a separate section' : 'Show finished books in All', id: 'menu-show-finished', checked: settings.get('showFinished'), keepOpen: true, onClick: () => { settings.set({ showFinished: !settings.get('showFinished') }); sheetObj.close(); rerender(); } },
    ctx.books.length ? { label: '✨  Fix missing info…', id: 'menu-fix-missing', onClick: () => openFixMissing({ kind: 'book' }) } : null,
    { label: 'Where to get DRM-free books…', onClick: () => openDrmFreeHelp() },
    installMode() ? { label: (installMode() === 'ios' ? '📲  ' : '⬇️  ') + installLabel() + '…', onClick: startInstall, id: 'menu-install' } : null,
    { label: 'Manage shelves…', onClick: () => manageShelves(ctx) },
    { label: 'Manage sets…', onClick: () => manageSets(ctx) },
    ctx.books.length ? { label: 'Select books…', id: 'menu-select', onClick: () => { local.sel = new Set(); rerender(); } } : null,
    ctx.books.length ? { label: 'Delete all books…', id: 'menu-delete-all', danger: true, onClick: () => deleteAllBooksFlow() } : null,
  ].filter(Boolean));
}
function groupSheet() {
  const cur = settings.get('groupBy') || 'status';
  const w = sheet('Group All Books by', () => [h('div', { class: 'list' }, GROUP_OPTIONS.map(([v, n]) => h('button', { class: 'list-item', id: 'group-opt-' + v, onclick: () => { settings.set({ groupBy: v, chip: 'all' }); w.close(); rerender(); } }, h('span', null, n), h('span', { class: 'check' }, v === cur ? '✓' : '')))),
    h('p', { class: 'muted small pad' }, 'Sorting and drag order apply inside each group. The “show Finished” switch in this menu hides finished books from All.')]);
}
async function newShelf() { const n = await promptDlg('New shelf', '', 'e.g. Favorites'); if (n) { const s = await S.createShelf(n); settings.set({ chip: s.id }); rerender(); } }

function manageShelves(ctx) {
  sheet('Shelves', (close) => [h('div', { class: 'list' }, ctx.shelves.length ? ctx.shelves.map((s) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, s.name),
    h('button', { class: 'btn small', onclick: async () => { const n = await promptDlg('Rename shelf', s.name); if (n) { await S.renameShelf(s.id, n); close(); rerender(); } } }, 'Rename'),
    h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDlg('Delete shelf?', 'Books stay in your library.', 'Delete', true)) { await S.deleteShelf(s.id); if (settings.get('chip') === s.id) settings.set({ chip: 'all' }); close(); rerender(); } } }, 'Delete'))) : h('p', { class: 'muted' }, 'No custom shelves yet.')),
    h('button', { class: 'btn primary block', onclick: async () => { close(); newShelf(); } }, 'New shelf')]);
}
function manageSets(ctx) {
  sheet('Sets (series)', (close) => [h('div', { class: 'list' }, ctx.sets.length ? ctx.sets.map((s) => h('div', { class: 'list-item' },
    h('span', { class: 'grow', onclick: () => { close(); local.setId = s.id; rerender(); } }, s.name, h('small', { class: 'muted' }, ' · ' + ctx.books.filter((b) => b.setId === s.id).length + (s.auto ? ' · auto' : ''))),
    h('button', { class: 'btn small', onclick: async () => { const n = await promptDlg('Rename set', s.name); if (n) { await S.renameSet(s.id, n); close(); rerender(); } } }, 'Rename'),
    h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDlg('Delete set?', 'Books stay in your library.', 'Delete', true)) { await S.deleteSet(s.id); close(); rerender(); } } }, 'Delete'))) : h('p', { class: 'muted' }, 'No sets yet. Books with series metadata are grouped automatically.')),
    h('button', { class: 'btn primary block', onclick: async () => { const n = await promptDlg('New set', '', 'Series name'); if (n) { await S.createSet(n); close(); rerender(); } } }, 'Create set')]);
}

export function bookMenu(b, ctx) {
  const s = actionSheet(b.title, [
    { label: 'Open', onClick: () => openReader(b.id) },
    { label: 'Edit details & set…', onClick: () => editBook(b, ctx) },
    { label: 'Change cover…', id: 'menu-change-cover', onClick: () => openCoverEditor('book', b.id, { onDone: rerender }) },
    { label: 'Move to shelf…', onClick: () => shelfSheet(b, ctx) },
    b.format !== 'pdf' ? { label: '🎧  Find my place (audiobook)…', id: 'menu-findplace', onClick: () => import('./findplace.js').then((m) => m.openFindPlace({ bookId: b.id })) } : null,
    ...Loans.loanMenuItems('book', b, rerender),
    b.format !== 'pdf' && S.hasOverrides(b) ? { label: 'Reset this book’s reading settings', onClick: async () => { await S.resetOverrides(b.id); toast('Using global reading settings'); rerender(); } } : null,
    { label: 'Delete from library', danger: true, id: 'menu-delete-book', onClick: () => deleteBooksFlow([b.id]) },
  ].filter(Boolean));
  return s;
}
function shelfSheet(b, ctx) {
  const ui = () => [h('div', { class: 'list' }, [
    ...S.STATUSES.map((st) => h('button', { class: 'list-item', 'data-status': st.id, onclick: async () => { await S.setStatus(b.id, st.id); b.status = st.id; w.close(); rerender(); } }, h('span', null, st.name), h('span', { class: 'check' }, b.status === st.id ? '✓' : ''))),
    ...(ctx.shelves.length ? [h('div', { class: 'sep' }, 'Custom shelves')] : []),
    ...ctx.shelves.map((sh) => h('button', { class: 'list-item', onclick: async () => { await S.toggleShelf(b.id, sh.id); b.shelves = (await S.getBook(b.id)).shelves; w.close(); shelfSheet(b, ctx); rerender(); } }, h('span', null, sh.name), h('span', { class: 'check' }, b.shelves?.includes(sh.id) ? '✓' : ''))),
  ])];
  const w = sheet('Shelves for “' + b.title + '”', ui);
}
function editBook(b, ctx) {
  const title = h('input', { class: 'field', value: b.title }); const author = h('input', { class: 'field', value: b.author });
  const sel = h('select', { class: 'field' }, h('option', { value: '' }, '— No set —'), ...ctx.sets.map((s) => h('option', { value: s.id, selected: s.id === b.setId }, s.name)), h('option', { value: '__new' }, '＋ New set…'));
  const vol = h('input', { class: 'field', type: 'number', step: '0.5', min: '0', placeholder: 'Volume # (optional)', value: b.seriesIndex ?? '' });
  const newName = h('input', { class: 'field', placeholder: 'New set name', hidden: true });
  sel.addEventListener('change', () => { newName.hidden = sel.value !== '__new'; });
  const desc = h('textarea', { class: 'field', id: 'edit-description', rows: 4 }, b.description || ''); const year = h('input', { class: 'field', id: 'edit-year', type: 'number', min: '0', max: '2100', placeholder: 'e.g. 1997', value: b.year ?? '' }); const lang = h('input', { class: 'field', id: 'edit-language', placeholder: 'e.g. en', value: b.language || '' });
  sheet('Edit book', (close) => [h('label', null, 'Title', title), h('label', null, 'Author', author), h('label', null, 'Set (series)', sel, newName), h('label', null, 'Volume', vol), h('label', null, 'Description', desc), h('div', { class: 'row-fields' }, h('label', null, 'Year', year), h('label', null, 'Language', lang)),
    h('button', { class: 'btn primary block', id: 'save-book', onclick: async () => {
      const bk = await S.getBook(b.id); bk.title = title.value.trim() || bk.title; markEdits(bk, { author: author.value.trim() || bk.author, description: desc.value, year: year.value, language: lang.value });
      const prevSet = bk.setId || '', prevIdx = bk.seriesIndex ?? null;
      let setId = sel.value;
      if (setId === '__new') { const n = newName.value.trim(); setId = n ? (await S.createSet(n)).id : ''; }
      bk.setId = setId || null; bk.seriesIndex = setId && vol.value !== '' ? parseFloat(vol.value) : (setId ? bk.seriesIndex : null);
      if ((bk.setId || '') !== prevSet || bk.seriesIndex !== prevIdx) { bk.userSet = { ...(bk.userSet || {}), series: true }; }
      await S.saveBook(bk); await S.pruneSets(); close(); rerender();
    } }, 'Save')]);
}

/* ---------- import ---------- */
export function pickFiles() { $('#file-input').click(); }
export async function importFiles(files) {
  let ok = 0; const errs = []; const drm = [];
  for (const f of files) {
    try { await S.addBookFromBuffer(await f.arrayBuffer(), { source: 'import', filename: f.name }); ok++; }
    catch (e) { if (e.code === 'drm') drm.push(f.name); else errs.push(f.name + ': ' + (e.message || e)); }
  }
  if (drm.length) sheet('Copy-protected book' + (drm.length > 1 ? 's' : ''), () => [
    h('p', null, drm.length === 1 ? '“' + drm[0] + '” is copy-protected (DRM), so Folio can’t import it.' : drm.length + ' files are copy-protected (DRM), so Folio can’t import them:'),
    ...(drm.length > 1 ? [h('ul', null, ...drm.map((n) => h('li', null, n)))] : []),
    h('p', { class: 'muted' }, 'Folio only opens DRM-free books. Look for a DRM-free copy (EPUB, MOBI or AZW3) from where you got the book. The “Where to get DRM-free books” page lists some places to start.'),
    h('button', { class: 'btn', onclick: () => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; openDrmFreeHelp(); } }, 'Where to get DRM-free books')]);
  if (ok) toast(`Imported ${ok} book${ok > 1 ? 's' : ''}` + (errs.length ? `, ${errs.length} failed` : ''));
  if (errs.length) toast(errs[0], 5200);
  rerender();
}
export function refreshLibrary() { try { window.dispatchEvent(new Event('folio-library-refresh')); } catch { /* not in a window */ } return view && view.dataset.screen && view.dataset.screen !== 'library' ? Promise.resolve() : rerender(); }   // another tab (Reading now) is on screen: don't paint the library over it

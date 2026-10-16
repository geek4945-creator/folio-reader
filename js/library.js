// Library tab: shelves, sets (series), grid/list, sort incl. custom drag order, search, import.
import { h, toast, sheet, actionSheet, confirmDlg, promptDlg, fmtPct, hashHue, $, put } from './util.js';
import { settings } from './settings.js';
import * as S from './store.js';
import { enableDragSort } from './dragsort.js';
import { openReader } from './reader.js';
import { openDriveBrowser } from './drive.js';

let view; const covers = new Map();
let local = { setId: null, q: '' };

function coverUrl(b) {
  if (!b.coverBlob) return null;
  const k = b.id + ':' + b.coverBlob.size;
  if (!covers.has(k)) covers.set(k, URL.createObjectURL(b.coverBlob));
  return covers.get(k);
}
const recent = (b) => b.lastOpened || b.addedAt || 0;
const norm = (s) => (s || '').toLowerCase().replace(/^(the|a|an)\s+/, '');

export async function renderLibrary(v) {
  view = v || view;
  const [books, sets, shelves] = await Promise.all([S.getBooks(), S.getSets(), S.getShelves()]);
  const scroll = view.scrollTop;
  view.replaceChildren();
  const ctx = { books, sets, shelves, setMap: new Map(sets.map((s) => [s.id, s])) };
  if (local.setId && ctx.setMap.has(local.setId)) await renderSetPage(ctx); else { local.setId = null; await renderMain(ctx); }
  view.scrollTop = scroll;
}
const rerender = () => renderLibrary();

/* ---------- main ---------- */
async function renderMain(ctx) {
  const { books, shelves } = ctx;
  const chip = settings.get('chip'); const sort = settings.get('sort'); const viewMode = settings.get('view');
  const search = h('input', { type: 'search', class: 'field search', placeholder: 'Search title, author or series', value: local.q, enterkeyhint: 'search' });
  search.addEventListener('input', () => { local.q = search.value; drawBody(); });

  const chips = [{ id: 'all', name: 'All' }, ...S.STATUSES, ...shelves.map((s) => ({ id: s.id, name: s.name, custom: true }))];
  put(view, 
    h('header', { class: 'topbar' }, h('h1', null, 'Library'),
      h('div', { class: 'top-actions' },
        h('button', { class: 'btn-icon', 'aria-label': 'Import EPUB', title: 'Import EPUB', onclick: pickFiles }, '＋'),
        h('button', { class: 'btn-icon', 'aria-label': 'Library menu', id: 'lib-menu', onclick: () => libMenu(ctx) }, '⋯'))),
    h('div', { class: 'pad' }, search),
    h('div', { class: 'chips', role: 'tablist' }, chips.map((c) => h('button', { class: 'chip' + (chip === c.id ? ' on' : ''), role: 'tab', 'data-chip': c.id, onclick: () => { settings.set({ chip: c.id }); rerender(); } }, c.name,
      c.id !== 'all' && !c.custom ? h('small', null, ' ' + books.filter((b) => b.status === c.id).length) : (c.custom ? h('small', null, ' ' + books.filter((b) => b.shelves?.includes(c.id)).length) : null))),
      h('button', { class: 'chip add', onclick: newShelf, 'aria-label': 'New shelf' }, '＋ Shelf')),
    h('div', { class: 'toolbar pad' },
      h('label', { class: 'sort' }, 'Sort ', h('select', { id: 'sort-sel', onchange: (e) => { const v = e.target.value; settings.set(v === 'custom' ? { sort: v } : { sort: v, lastAutoSort: v }); rerender(); } },
        [['recent', 'Recent'], ['title', 'Title'], ['author', 'Author'], ['custom', 'Custom order']].map(([v, n]) => h('option', { value: v, selected: v === sort }, n)))),
      sort === 'custom' ? h('button', { class: 'btn small', id: 'reset-order', onclick: () => resetOrder('shelf:' + chip) }, 'Reset to automatic') : null,
      h('span', { class: 'grow' }),
      h('div', { class: 'seg' },
        h('button', { class: viewMode === 'grid' ? 'on' : '', 'aria-label': 'Grid view', id: 'view-grid', onclick: () => { settings.set({ view: 'grid' }); rerender(); } }, '▦'),
        h('button', { class: viewMode === 'list' ? 'on' : '', 'aria-label': 'List view', id: 'view-list', onclick: () => { settings.set({ view: 'list' }); rerender(); } }, '☰'))),
    sort === 'custom' ? h('p', { class: 'hint pad' }, 'Press and hold a book, then drag to reorder. New books are added to the end.') : null);
  const body = h('div', { id: 'lib-body' }); put(view, body);

  async function drawBody() {
    body.replaceChildren();
    const q = local.q.trim().toLowerCase();
    const match = (b) => !q || [b.title, b.author, ctx.setMap.get(b.setId)?.name].some((x) => (x || '').toLowerCase().includes(q));
    const ofChip = (b) => chip === 'all' ? true : S.STATUSES.some((s) => s.id === chip) ? b.status === chip : !!b.shelves?.includes(chip);
    const pool = books.filter((b) => ofChip(b) && match(b));
    if (!books.length) { body.append(emptyState()); return; }
    if (!pool.length) { body.append(h('p', { class: 'muted pad center' }, q ? 'No matches.' : 'Nothing on this shelf yet.')); return; }
    const ctxKey = 'shelf:' + chip; const saved = sort === 'custom' ? await S.getOrder(ctxKey) : [];
    let sections;
    if (chip === 'all') {
      sections = S.STATUSES.filter((s) => s.id !== 'finished' || settings.get('showFinished')).map((s) => ({ id: s.id, title: s.name, books: pool.filter((b) => b.status === s.id), collapsible: s.id === 'finished' }));
    } else sections = [{ id: chip, title: null, books: pool }];
    sections = sections.map((s) => ({ ...s, tiles: sortTiles(buildTiles(s.books, ctx, !!q), sort, saved) }));
    const fullKeys = applyFull(sections, saved, sort);
    for (const sec of sections) {
      if (!sec.tiles.length) continue;
      const collapsed = sec.collapsible && localStorage.getItem('folio.collapse.' + sec.id) === '1';
      const grid = h('div', { class: 'tiles ' + viewMode, dataset: { ctx: ctxKey } }, collapsed ? null : sec.tiles.map((t) => tileEl(t, ctx, viewMode)));
      if (sec.title) body.append(h('h3', { class: 'sec-title' + (sec.collapsible ? ' tap' : ''), onclick: sec.collapsible ? () => { localStorage.setItem('folio.collapse.' + sec.id, collapsed ? '0' : '1'); drawBody(); } : null }, (sec.collapsible ? (collapsed ? '▸ ' : '▾ ') : '') + sec.title, h('small', null, ' ' + sec.books.length)));
      body.append(grid);
      if (sort === 'custom' && !q && !collapsed) enableDragSort(grid, { itemSel: '.tile', vertical: viewMode === 'list', onDrop: (keys) => persistOrder(ctxKey, fullKeys, keys) });
    }
  }
  await drawBody();
}

function emptyState() {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, '📖'), h('h2', null, 'Your library is empty'),
    h('p', { class: 'muted' }, 'Import EPUB files from your device, or browse the Catalogs tab to download free books.'),
    h('div', { class: 'row-actions center' }, h('button', { class: 'btn primary', onclick: pickFiles }, 'Import EPUB'),
      h('button', { class: 'btn', onclick: () => document.querySelector('[data-tab=catalogs]').click() }, 'Browse catalogs')));
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
function sortTiles(tiles, sort, saved) {
  const t = [...tiles];
  if (sort === 'title') t.sort((a, b) => norm(tileTitle(a)).localeCompare(norm(tileTitle(b))));
  else if (sort === 'author') t.sort((a, b) => norm(tileAuthor(a)).localeCompare(norm(tileAuthor(b))) || norm(tileTitle(a)).localeCompare(norm(tileTitle(b))));
  else if (sort === 'recent') t.sort((a, b) => tileRecent(b) - tileRecent(a));
  else { t.sort((a, b) => tileRecent(a) - tileRecent(b)); return S.applyOrder(t, saved); }   // custom: new items append in added order
  return t;
}
function applyFull(sections, saved, sort) { return sort === 'custom' ? sections.flatMap((s) => s.tiles.map((t) => t.key)) : []; }

async function persistOrder(ctxKey, fullKeys, newSection) {
  // Re-use the slots the section's tiles occupied in the full list, in the new order.
  const sectionSet = new Set(newSection); const out = []; let i = 0;
  const merged = fullKeys.map((k) => (sectionSet.has(k) ? newSection[i++] : k));
  // Include keys of tiles not in fullKeys (shouldn't happen) and keep previously saved but currently filtered-out keys.
  const prev = await S.getOrder(ctxKey);
  const rest = prev.filter((k) => !merged.includes(k));
  out.push(...merged, ...rest);
  await S.saveOrder(ctxKey, out);
}
async function resetOrder(ctxKey, setKind) {
  await S.clearOrder(ctxKey);
  if (setKind) settings.set({ setSort: 'volume' }); else settings.set({ sort: settings.get('lastAutoSort') || 'recent' });
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
  const ov = S.hasOverrides(b) ? h('span', { class: 'ovr', title: 'Custom reading settings for this book' }, 'Aa') : null;
  const vol = b.seriesIndex != null && b.setId ? h('span', { class: 'vol' }, '#' + b.seriesIndex) : null;
  const bar = h('div', { class: 'bar' }, h('i', { style: { width: Math.round((b.status === 'finished' ? 1 : b.progress) * 100) + '%' } }));
  const el = h('div', { class: 'tile book', dataset: { key: t.key, id: b.id }, tabindex: 0, role: 'button', onclick: () => openReader(b.id), onkeydown: (e) => { if (e.key === 'Enter') openReader(b.id); } },
    coverEl(b, [badge(b), ov, vol, mode === 'grid' ? more : null]),
    h('div', { class: 'meta' }, h('div', { class: 't clamp2' }, b.title), h('div', { class: 'a ellipsis muted' }, b.author),
      mode === 'list' ? [b.setId && ctx.setMap.get(b.setId) ? h('div', { class: 'muted small ellipsis' }, ctx.setMap.get(b.setId).name + (b.seriesIndex != null ? ' · #' + b.seriesIndex : '')) : null, bar] : null),
    mode === 'list' ? more : null);
  return el;
}
function setTile(t, ctx, mode) {
  const top = t.books.slice(0, 3);
  const stack = h('div', { class: 'cover stack' }, top.map((b, i) => { const u = coverUrl(b); const hue = hashHue(b.title);
    return h('div', { class: 'stk s' + i }, u ? h('img', { class: 'cover-img', src: u, alt: '', draggable: 'false' }) : h('div', { class: 'cover-ph', style: { background: `hsl(${hue} 40% 36%)` } }, h('span', null, b.title))); }).reverse(),
    h('span', { class: 'pbadge set' }, t.books.length + ' books'));
  const done = t.books.filter((b) => b.status === 'finished').length;
  return h('div', { class: 'tile set', dataset: { key: t.key }, tabindex: 0, role: 'button', onclick: () => { local.setId = t.set.id; rerender(); } },
    stack, h('div', { class: 'meta' }, h('div', { class: 't clamp2' }, t.set.name), h('div', { class: 'a muted ellipsis' }, (t.books[0].author || '') + (done ? ` · ${done}/${t.books.length} read` : ''))));
}

/* ---------- set page ---------- */
async function renderSetPage(ctx) {
  const set = ctx.setMap.get(local.setId);
  const all = ctx.books.filter((b) => b.setId === set.id);
  const sortMode = settings.get('setSort') || 'volume'; const viewMode = settings.get('view');
  const key = 'set:' + set.id; const saved = sortMode === 'custom' ? await S.getOrder(key) : [];
  let tiles = all.sort(volumeSort).map((b) => ({ type: 'book', key: 'b:' + b.id, book: b }));
  if (sortMode === 'custom') tiles = S.applyOrder([...tiles].sort((a, b) => a.book.addedAt - b.book.addedAt), saved);
  put(view, 
    h('header', { class: 'topbar' }, h('button', { class: 'btn-text', id: 'set-back', onclick: () => { local.setId = null; rerender(); } }, '‹ Library'), h('h2', { class: 'grow ellipsis' }, set.name),
      h('button', { class: 'btn-icon', onclick: () => setMenu(set, ctx) }, '⋯')),
    h('div', { class: 'toolbar pad' },
      h('label', { class: 'sort' }, 'Order ', h('select', { id: 'set-sort-sel', onchange: (e) => { settings.set({ setSort: e.target.value }); rerender(); } },
        [['volume', 'Volume order'], ['custom', 'Custom order']].map(([v, n]) => h('option', { value: v, selected: v === sortMode }, n)))),
      sortMode === 'custom' ? h('button', { class: 'btn small', id: 'reset-order', onclick: () => resetOrder(key, true) }, 'Reset to automatic') : null, h('span', { class: 'grow' }),
      h('div', { class: 'seg' }, h('button', { class: viewMode === 'grid' ? 'on' : '', onclick: () => { settings.set({ view: 'grid' }); rerender(); } }, '▦'), h('button', { class: viewMode === 'list' ? 'on' : '', onclick: () => { settings.set({ view: 'list' }); rerender(); } }, '☰'))),
    sortMode === 'custom' ? h('p', { class: 'hint pad' }, 'Press and hold a book, then drag to reorder within this set.') : null);
  if (!all.length) { put(view, h('p', { class: 'muted pad center' }, 'This set is empty. Use ⋯ → Add books, or assign a set when editing a book.')); return; }
  const grid = h('div', { class: 'tiles ' + viewMode, dataset: { ctx: key } }, tiles.map((t) => tileEl(t, ctx, viewMode)));
  put(view, grid);
  if (sortMode === 'custom') enableDragSort(grid, { itemSel: '.tile', vertical: viewMode === 'list', onDrop: (keys) => S.saveOrder(key, keys) });
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
    { label: 'Import EPUB files (Files app)…', onClick: pickFiles },
    { label: 'Import from Google Drive…', onClick: openDriveBrowser },
    { label: 'Group series into sets', checked: settings.get('groupSets'), keepOpen: true, onClick: () => { settings.set({ groupSets: !settings.get('groupSets') }); sheetObj.close(); rerender(); } },
    { label: 'Show Finished as a separate section', checked: settings.get('showFinished'), keepOpen: true, onClick: () => { settings.set({ showFinished: !settings.get('showFinished') }); sheetObj.close(); rerender(); } },
    { label: 'Manage shelves…', onClick: () => manageShelves(ctx) },
    { label: 'Manage sets…', onClick: () => manageSets(ctx) },
  ]);
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
    { label: 'Move to shelf…', onClick: () => shelfSheet(b, ctx) },
    S.hasOverrides(b) ? { label: 'Reset this book’s reading settings', onClick: async () => { await S.resetOverrides(b.id); toast('Using global reading settings'); rerender(); } } : null,
    { label: 'Delete from library', danger: true, onClick: async () => { if (await confirmDlg('Delete book?', `“${b.title}” and its reading progress will be removed from this device.`, 'Delete', true)) { await S.deleteBook(b.id); await S.pruneSets(); rerender(); } } },
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
  sheet('Edit book', (close) => [h('label', null, 'Title', title), h('label', null, 'Author', author), h('label', null, 'Set (series)', sel, newName), h('label', null, 'Volume', vol),
    h('button', { class: 'btn primary block', id: 'save-book', onclick: async () => {
      const bk = await S.getBook(b.id); bk.title = title.value.trim() || bk.title; bk.author = author.value.trim() || bk.author;
      let setId = sel.value;
      if (setId === '__new') { const n = newName.value.trim(); setId = n ? (await S.createSet(n)).id : ''; }
      bk.setId = setId || null; bk.seriesIndex = setId && vol.value !== '' ? parseFloat(vol.value) : (setId ? bk.seriesIndex : null);
      await S.saveBook(bk); await S.pruneSets(); close(); rerender();
    } }, 'Save')]);
}

/* ---------- import ---------- */
export function pickFiles() { $('#file-input').click(); }
export async function importFiles(files) {
  let ok = 0; const errs = [];
  for (const f of files) {
    try { await S.addBookFromBuffer(await f.arrayBuffer(), { source: 'import' }); ok++; }
    catch (e) { errs.push(f.name + ': ' + (e.message || e)); }
  }
  if (ok) toast(`Imported ${ok} book${ok > 1 ? 's' : ''}` + (errs.length ? `, ${errs.length} failed` : ''));
  if (errs.length) toast(errs[0], 5200);
  rerender();
}
export function refreshLibrary() { return rerender(); }

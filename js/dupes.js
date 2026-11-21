// v0.5.24: find duplicate books and remove extras from the Folio library (never from Google Drive).
// Detection reads the already-loaded library metadata only — never file blobs (a 450-book iPhone crash in v0.5.23).
import { h, toast, sheet, confirmDlg, fmtPct, hashHue } from './util.js';
import * as S from './store.js';
import { DB } from './db.js';
import { forceUo } from './bookinfo.js';
import { markImported } from './drivebatch.js';

const bannerHidden = { on: false };   // this session only: she can still open Review from Settings

/** Lowercase, strip punctuation, a leading "the/a/an", a file extension, and a "(1)" / "copy" suffix. */
export function normText(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\.(epub|pdf|mobi|azw3?|kf8|cbz|cbr)$/i, '')
    .replace(/\s*[([]\s*(copy|\d+)\s*[\])]\s*$/i, '').replace(/[\s._-]+copy\s*$/i, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/,?\s+(the|a|an)$/, '').replace(/\s+/g, ' ').trim();
}
export const normTitle = (s) => normText(s);
export const normAuthor = (s) => normText(s).split(' ').filter(Boolean).sort().join(' ');
export const normFile = (s) => normText(s);
export const hasManualEdits = (b) => !!(b && (b.uo && Object.keys(b.uo).length || b.userSet && Object.keys(b.userSet).length || b.coverSource === 'user' || b.coverSource === 'custom'));
export const isDownloaded = (b) => !b.inDrive && !b.stub;
export const bytes = (n) => (!n ? '—' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const formatOf = (b) => (b.origFormat || b.format || '').toUpperCase() || 'FILE';

const pairKey = (a, b) => [S.bookSyncKey(a), S.bookSyncKey(b)].sort().join('\t');
export function isNotDupe(a, b) {
  const ka = S.bookSyncKey(a), kb = S.bookSyncKey(b);
  return (a.notDupeOf || []).includes(kb) || (b.notDupeOf || []).includes(ka);
}

/** Prefer the copy with her manual edits, then the most reading progress, then the one downloaded on this device. */
export function suggestKeep(books) {
  const score = (b) => [hasManualEdits(b) ? 1 : 0, b.progress || 0, isDownloaded(b) ? 1 : 0, -(b.addedAt || 0)];
  return [...books].sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return String(a.id).localeCompare(String(b.id)); })[0];
}

function unionFind(n) { const p = [...Array(n).keys()]; const f = (i) => (p[i] === i ? i : (p[i] = f(p[i]))); const u = (a, b) => { a = f(a); b = f(b); if (a !== b) p[a] = b; }; return { f, u }; }

/** Group books that look like the same file (exact) or the same title + author (likely). `books` is metadata only — never file blobs. */
export function findDuplicates(books) {
  const list = books || []; const uf = unionFind(list.length); const buckets = new Map();
  const join = (key, i) => { const prev = buckets.get(key); if (prev != null) uf.u(prev, i); else buckets.set(key, i); };
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.fileHash) join('h:' + b.fileHash, i);
    if (b.size > 0) {
      const fn = normFile(b.filename || ''); if (fn) join('sf:' + b.size + ':' + fn, i);
      if (b.identifier) join('si:' + b.size + ':' + String(b.identifier).toLowerCase(), i);
    }
    const t = normTitle(b.title); if (t) join('ta:' + t + '\t' + normAuthor(b.author), i);
  }
  const groups = new Map();
  for (let i = 0; i < list.length; i++) { const r = uf.f(i); (groups.get(r) || groups.set(r, []).get(r)).push(list[i]); }
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const part of connected(members)) {
      if (part.length < 2) continue;
      let isExact = false;
      for (let i = 0; i < part.length && !isExact; i++) for (let j = i + 1; j < part.length; j++) if (sameFile(part[i], part[j])) { isExact = true; break; }
      out.push({ kind: isExact ? 'exact' : 'likely', books: part, keepId: suggestKeep(part).id });
    }
  }
  out.sort((a, b) => (a.kind === 'exact' && b.kind !== 'exact' ? -1 : a.kind !== 'exact' && b.kind === 'exact' ? 1 : (a.books[0].title || '').localeCompare(b.books[0].title || '')));
  return out;
}
/** Split a component into subsets that she has not marked "Not duplicates". */
function connected(members) {
  const n = members.length; const uf = unionFind(n); let any = false;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (!isNotDupe(members[i], members[j])) { uf.u(i, j); any = true; }
  if (!any) return [];
  const m = new Map(); for (let i = 0; i < n; i++) (m.get(uf.f(i)) || m.set(uf.f(i), []).get(uf.f(i))).push(members[i]);
  return [...m.values()];
}
function sameFile(a, b) {
  if (a.fileHash && a.fileHash === b.fileHash) return true;
  if (!(a.size > 0 && a.size === b.size)) return false;
  const fa = normFile(a.filename || ''), fb = normFile(b.filename || '');
  if (fa && fa === fb) return true;
  if (a.identifier && b.identifier && String(a.identifier).toLowerCase() === String(b.identifier).toLowerCase()) return true;
  return false;
}

export async function markNotDuplicates(books) {
  const keys = books.map(S.bookSyncKey);
  for (const b of books) {
    const rec = await S.getBook(b.id); if (!rec) continue;
    rec.notDupeOf = [...new Set([...(rec.notDupeOf || []), ...keys.filter((k) => k !== S.bookSyncKey(rec))])];
    await S.saveBook(rec);
  }
}

/** Merge the removed copy's useful bits into the kept copy. The kept copy's own edits win on conflict. Furthest progress is kept. */
export async function mergeInto(keep0, drop) {
  const keep = await S.getBook(keep0.id) || keep0;
  const before = structuredClone({ ...keep, coverBlob: keep.coverBlob || null });
  keep.shelves = [...new Set([...(keep.shelves || []), ...(drop.shelves || [])])];
  if ((drop.progress || 0) > (keep.progress || 0) + 1e-6) {
    keep.progress = drop.progress; keep.cfi = drop.cfi || keep.cfi; keep.posAt = Math.max(keep.posAt || 0, drop.posAt || 0);
    if (drop.pdfPage) { keep.pdfPage = drop.pdfPage; keep.pdfZoom = drop.pdfZoom || keep.pdfZoom; keep.pdfText = drop.pdfText; }
    if (drop.lastOpened && drop.lastOpened > (keep.lastOpened || 0)) keep.lastOpened = drop.lastOpened;
    if (drop.posDev) { keep.posDev = drop.posDev; keep.posDevName = drop.posDevName; }
  }
  const rank = { want: 0, reading: 1, finished: 2 };
  if ((rank[drop.status] || 0) > (rank[keep.status] || 0)) { keep.status = drop.status; if (drop.finishedAt) keep.finishedAt = drop.finishedAt; }
  if (!keep.setId && drop.setId) { keep.setId = drop.setId; if (keep.seriesIndex == null) keep.seriesIndex = drop.seriesIndex ?? null; }
  if (drop.uo) {
    keep.uo = { ...(drop.uo || {}), ...(keep.uo || {}) };   // keep's edits overwrite drop's
    // fill book fields from drop only where keep has no edit of its own
    for (const [f, o] of Object.entries(drop.uo)) if (o && !keep0.uo?.[f]) { if (!(f === 'title' && !o.v)) keep[f] = o.v ?? keep[f]; }
    forceUo(keep);
  }
  if (!keep.overrides && drop.overrides) { keep.overrides = structuredClone(drop.overrides); keep.ovAt = structuredClone(drop.ovAt || {}); }
  if (!keep.coverBlob && drop.coverBlob) { keep.coverBlob = drop.coverBlob; keep.coverSource = drop.coverSource || keep.coverSource; }
  const srcs = [...new Set([...(keep.mergedSources || []), keep.sourceKey, drop.sourceKey, ...(drop.mergedSources || [])].filter(Boolean))];
  keep.mergedSources = srcs.filter((s) => s !== keep.sourceKey);
  const keys = [...new Set([...(keep.mergedSyncKeys || []), S.bookSyncKey(drop), ...(drop.mergedSyncKeys || [])].filter((k) => k && k !== S.bookSyncKey(keep)))];
  keep.mergedSyncKeys = keys;
  await S.saveBook(keep);
  const dropKey = S.bookSyncKey(drop), keepKey = S.bookSyncKey(keep);
  const glossCh = [];
  for (const x of await DB.all('glossary')) {
    if (x.bookKey !== dropKey || x.del) continue;
    glossCh.push({ ...x });
    if (x.kind === 'hl') {
      const exist = (await DB.all('glossary')).find((y) => y.bookKey === keepKey && y.kind === 'hl' && !y.del && y.cfiRange && y.cfiRange === x.cfiRange);
      if (exist) continue;
    }
    await DB.put('glossary', { ...x, bookKey: keepKey, bookTitle: keep.title || x.bookTitle });
  }
  const copiedBm = [];
  for (const bm of await DB.byIndex('bookmarks', 'bookId', drop.id)) {
    const rec = { ...bm, id: (self.crypto && crypto.randomUUID ? crypto.randomUUID() : 'bm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), bookId: keep.id };
    await DB.put('bookmarks', rec); copiedBm.push(rec.id);
  }
  const linkCh = [];
  for (const l of await DB.all('links')) {
    if (l.bookKey !== dropKey) continue;
    linkCh.push({ ...l });
    const other = (await DB.all('links')).some((x) => x.bookKey === keepKey && x.audioKey === l.audioKey && x.state === 'linked');
    if (l.state === 'linked' && !other) await DB.put('links', { ...l, bookKey: keepKey, id: keepKey + ' ⇄ ' + l.audioKey });
  }
  const driveIds = srcs.filter((s) => s.startsWith('gdrive:')).map((s) => s.slice(7));
  if (driveIds.length) markImported(driveIds);
  try {
    const p = S.getPending(); let ch = false;
    for (const k of [dropKey, ...(drop.mergedSyncKeys || [])]) if (p[k]) { delete p[k]; ch = true; }
    if (ch) S.setPending(p);
    const bm = S.getPendingBookmarks(); let bch = false;
    for (const k of [dropKey, ...(drop.mergedSyncKeys || [])]) if (bm[k]) { delete bm[k]; bch = true; }
    if (bch) S.setPendingBookmarks(bm);
  } catch { /* ignore */ }
  return { before, glossCh, copiedBm, linkCh, dropKey, keepKey };
}

async function undoMerge(u, keepId) {
  if (u.before) { const rec = { ...u.before, _noTouch: true }; await DB.put('books', rec); }
  for (const id of u.copiedBm || []) await DB.del('bookmarks', id);
  for (const x of u.glossCh || []) await DB.put('glossary', x);
  for (const x of u.linkCh || []) await DB.put('links', x);
}

/** Remove the non-kept copies in each selected group (library only). Returns an undo snapshot. */
export async function removeDuplicates(picks) {
  const undos = [], dropIds = [];
  for (const p of picks) {
    const keep = p.books.find((b) => b.id === p.keepId) || suggestKeep(p.books);
    for (const b of p.books) {
      if (b.id === keep.id) continue;
      const u = await mergeInto(keep, b);
      dropIds.push(b.id); undos.push(u);
    }
  }
  const snap = dropIds.length ? await S.deleteBooks(dropIds) : { books: [], files: [], bookmarks: [], orders: [], sets: [], keys: [] };
  try { (await import('./google.js')).scheduleSync(800); } catch { /* not signed in / not in a window */ }
  return { snap, undos, dropIds };
}

export async function undoRemove(pack) {
  if (!pack) return;
  for (const u of pack.undos || []) {
    const keepId = pack.snap?.books && (await S.getBooks()).find((b) => S.bookSyncKey(b) === u.keepKey)?.id;
    await undoMerge(u, keepId);
  }
  if (pack.snap) await S.restoreBooks(pack.snap);
  try { (await import('./google.js')).scheduleSync(800); } catch { /* ignore */ }
}

export function dupeBanner(books, onReview) {
  if (bannerHidden.on) return null;
  const groups = findDuplicates(books); if (!groups.length) return null;
  const n = groups.reduce((a, g) => a + g.books.length - 1, 0);
  return h('div', { class: 'loan-banner', id: 'dupe-banner', role: 'status' },
    h('div', { class: 'loan-head' },
      h('span', { id: 'dupe-banner-text' }, n + ' possible duplicate' + (n === 1 ? '' : 's') + ' found. Review'),
      h('button', { class: 'btn small primary', id: 'dupe-banner-review', onclick: () => onReview(groups) }, 'Review')));
}

export function hideDupeBanner() { bannerHidden.on = true; }

export async function openDupeReview(pre) {
  const books = await S.getBooks(); const groups = pre || findDuplicates(books);
  if (!groups.length) { toast('No duplicate books found'); return; }
  const urls = [];
  const thumb = (b) => {
    if (b.coverBlob) { const u = URL.createObjectURL(b.coverBlob); urls.push(u); return h('img', { class: 'dupe-cover', src: u, alt: '' }); }
    return h('div', { class: 'dupe-cover ph', style: { background: 'hsl(' + hashHue(b.title || '') + ' 40% 45%)' } }, (b.title || '?').slice(0, 1));
  };
  const state = groups.map((g) => ({ ...g, on: true, keepId: g.keepId, suggestedId: g.keepId }));
  const w = sheet('Possible duplicate books', (close) => {
    const body = h('div', { id: 'dupe-sheet' },
      h('p', { class: 'muted small' }, 'Folio only removes a copy from your library. The original file in Google Drive is never deleted. Highlights, notes, bookmarks, shelves and the furthest progress are kept on the copy you choose.'),
      ...state.map((g, i) => groupEl(g, i, thumb)),
      h('div', { class: 'row-actions', id: 'dupe-actions' },
        h('button', { class: 'btn', id: 'dupe-cancel', onclick: close }, 'Cancel'),
        h('button', { class: 'btn danger', id: 'dupe-remove', onclick: () => doRemove(state, close) }, 'Remove selected duplicates')));
    return [body];
  }, { tall: true, closeLabel: 'Cancel', onClose: () => { for (const u of urls) try { URL.revokeObjectURL(u); } catch { /* ignore */ } } });
  return w;
}

function groupEl(g, i, thumb) {
  const box = h('div', { class: 'dupe-group', id: 'dupe-group-' + i, dataset: { kind: g.kind } },
    h('label', { class: 'check-row dupe-inc' },
      h('input', { type: 'checkbox', id: 'dupe-include-' + i, checked: true, onchange: (e) => { g.on = e.target.checked; box.classList.toggle('off', !g.on); } }),
      h('strong', null, g.kind === 'exact' ? 'Same file' : 'Likely the same book')),
    ...g.books.map((b) => h('label', { class: 'dupe-row', id: 'dupe-row-' + b.id },
      h('input', { type: 'radio', name: 'dupe-keep-' + i, id: 'dupe-keep-' + b.id, value: b.id, checked: b.id === g.keepId, onchange: () => { g.keepId = b.id; } }),
      thumb(b),
      h('div', { class: 'dupe-meta' },
        h('div', { class: 'dupe-title' }, b.title || 'Untitled'),
        h('div', { class: 'muted small' }, [b.author, formatOf(b), bytes(b.size), fmtPct(b.progress), isDownloaded(b) ? 'On this device' : (b.inDrive ? 'In Drive' : null), hasManualEdits(b) ? 'Has your edits' : null].filter(Boolean).join(' · ')),
        b.id === g.suggestedId ? h('div', { class: 'muted small dupe-sug', id: 'dupe-sug-' + b.id }, 'Suggested keep') : null))),
    h('button', { class: 'btn-text small', id: 'dupe-not-' + i, onclick: async (e) => {
      await markNotDuplicates(g.books); g.on = false; box.classList.add('off', 'skipped');
      const inc = box.querySelector('#dupe-include-' + i); if (inc) inc.checked = false;
      e.target.disabled = true; e.target.textContent = 'Marked as not duplicates';
      toast('This group won’t be flagged again');
    } }, 'Not duplicates'));
  return box;
}

async function doRemove(state, close) {
  const picks = state.filter((g) => g.on && g.books.length > 1);
  const n = picks.reduce((a, g) => a + g.books.filter((b) => b.id !== g.keepId).length, 0);
  if (!n) { toast('Nothing selected to remove'); return; }
  if (!await confirmDlg('Remove ' + n + ' duplicate' + (n === 1 ? '' : 's') + '?',
    n + ' book' + (n === 1 ? '' : 's') + ' will be removed from your Folio library. Files in Google Drive are not deleted. You can undo this right afterwards.',
    'Remove ' + n, true)) return;
  close();
  const pack = await removeDuplicates(picks);
  hideDupeBanner();
  try { (await import('./library.js')).refreshLibrary(); } catch { /* ignore */ }
  toast('Removed ' + n + ' duplicate' + (n === 1 ? '' : 's'), 8000, {
    label: 'Undo',
    onClick: async () => { await undoRemove(pack); try { (await import('./library.js')).refreshLibrary(); } catch { /* ignore */ } toast(n === 1 ? 'Duplicate restored' : n + ' duplicates restored'); },
  });
}

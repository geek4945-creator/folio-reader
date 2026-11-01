// v0.5.20: books another device added that have no file on this device yet, and the big-conflict prompt.
// Sync carries each book's state (status, shelves, position…), never the book files. Books imported from Google Drive on another device can be
// fetched here from the same Drive file (needs read-only Drive access); books imported from local files have to be imported here too.
import { h, sheet, toast } from './util.js';
import * as G from './google.js';
import * as S from './store.js';
import { fmtSize } from './drivebatch.js';

/** { drive: [{ id, name, size, syncKey, title }], local: [{ title, author, name }] } */
export function missingBooks() {
  const p = S.getPending(); const drive = [], local = [];
  for (const [k, st] of Object.entries(p)) {
    if (!st || st.title === undefined) continue;
    if (st.src && st.src.kind === 'gdrive' && st.src.id) drive.push({ id: st.src.id, name: st.src.name || st.title || 'book', size: st.src.size || 0, syncKey: k, title: st.title || '' });
    else local.push({ title: st.title || st.src?.name || 'Untitled', author: st.author || '', name: st.src?.name || '' });
  }
  drive.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); local.sort((a, b) => a.title.localeCompare(b.title));
  return { drive, local, count: drive.length + local.length };
}

/** "N books from your other devices aren't on this device yet" (library banner + Settings → Sync). */
export function missingBanner(onDone) {
  if (!G.isSignedIn()) return null; const m = missingBooks(); if (!m.count) return null;
  return h('div', { class: 'loan-banner sync-missing', id: 'sync-missing', role: 'status' },
    h('span', null, `${m.count} book${m.count === 1 ? '' : 's'} from your other devices ${m.count === 1 ? 'isn’t' : 'aren’t'} on this device yet.`),
    h('button', { class: 'btn small primary', id: 'sync-missing-open', onclick: () => openMissing(onDone) }, 'Get them'));
}

export function openMissing(onDone = () => {}) {
  const m = missingBooks(); const total = m.drive.reduce((a, f) => a + (f.size || 0), 0);
  sheet('Books from your other devices', (close) => [h('div', { id: 'sync-missing-sheet' },
    h('p', null, 'Folio syncs your shelves, progress and settings, not the book files themselves. These books are in your synced library but their files are not on this device.'),
    m.drive.length ? h('div', { class: 'list-item' },
      h('p', null, h('strong', { id: 'sm-drive-count' }, `${m.drive.length} from Google Drive`), ' · ', fmtSize(total)),
      h('p', { class: 'muted small' }, G.canBrowseDrive() ? 'Downloaded one at a time from the same Drive files. Keep this screen open (large libraries take a while); you can stop and continue later.' : 'Folio needs read-only access to your Drive to download them (Google asks once).'),
      h('button', { class: 'btn primary', id: 'sm-download', onclick: async () => {
        try { if (!G.canBrowseDrive()) await G.enableDriveBrowse(); } catch (e) { toast(e.message, 5000); return; }
        close(); const DB = await import('./drivebatch.js'); const r = await DB.runWithUI('book', m.drive); onDone(r);
      } }, G.canBrowseDrive() ? `Download ${m.drive.length} book${m.drive.length === 1 ? '' : 's'}` : `Allow Drive access & download ${m.drive.length}`)) : null,
    m.local.length ? h('div', { class: 'list-item' },
      h('p', null, h('strong', { id: 'sm-local-count' }, `${m.local.length} imported from files`), ' on another device'),
      h('p', { class: 'muted small' }, 'Import the same files here (Library → ＋) and they link up with their shelves and progress automatically.'),
      h('details', null, h('summary', null, 'Show titles'), h('ul', { class: 'small', id: 'sm-local-list' }, m.local.slice(0, 300).map((x) => h('li', null, x.title + (x.author ? ' — ' + x.author : '')))))) : null)]);
}

/* ---------- big conflict ---------- */
const fmtWhen = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
let open = null, snoozed = 0;
/** Shown on the library screen / at app open, never while a book is open (it waits for the reader to close). */
export function maybeShowConflict(force = false) {
  const c = G.pendingConflict(); if (!c || open) return false;
  if (!force && Date.now() - snoozed < 30 * 60000) return false;   // "Decide later": not again for a while (Settings → Sync still offers it)
  if (document.body.classList.contains('reading')) return false;
  const rem = h('input', { type: 'checkbox', id: 'sc-remember' });
  let chosen = false;
  const choose = async (how, close) => {
    chosen = true; close(); try { await G.syncNow({ resolve: how, remember: rem.checked }); toast(how === 'merge' ? 'Merged both' : how === 'local' ? 'Kept this device’s version' : 'Using the other device’s version'); }
    catch (e) { toast(e.message, 5000); }
  };
  if (c.kind === 'meta') {   // v0.5.21: many of this device's book-info edits would be replaced
    const ex = (c.sample || []).map((x) => h('li', null, `“${x.title}” ${x.f === 'setId' ? 'set' : x.f === 'seriesIndex' ? 'order in set' : x.f}: here “${x.mine}” → ${c.other.name}: “${x.theirs}”`));
    open = sheet('Book info changed on both devices', (close) => [h('div', { id: 'sync-conflict', class: 'sc-meta' },
      h('p', null, `${c.books} book${c.books === 1 ? '' : 's'} you edited on this device since ${fmtWhen(c.me.lastSync)} have different info on ${c.other.name}. Nothing has been changed yet.`),
      ex.length ? h('ul', { class: 'small', id: 'sc-examples' }, ...ex) : null,
      h('div', { class: 'sc-choices' },
        h('button', { class: 'btn primary', id: 'sc-local', onclick: () => choose('local', close) }, 'Keep this device’s edits (recommended)'),
        h('p', { class: 'muted small' }, `Your edits here are kept and sent to ${c.other.name}. Its other changes still come in.`),
        h('button', { class: 'btn', id: 'sc-merge', onclick: () => choose('merge', close) }, 'Use the newest edit for each book'),
        h('button', { class: 'btn', id: 'sc-cloud', onclick: () => choose('cloud', close) }, 'Use the other device’s edits'),
        h('p', { class: 'muted small' }, 'Whatever you pick, Settings → Sync → “Restore book info from an earlier sync” can bring the previous info back.')),
      h('label', { class: 'check-row' }, rem, ' Remember my choice (change it in Settings → Sync)'))],
    { closeLabel: 'Decide later', onClose: () => { open = null; if (!chosen) snoozed = Date.now(); } });
    return true;
  }
  const what = [c.books ? `${c.books} book${c.books === 1 ? '' : 's'}` : '', c.settings ? `${c.settings} setting${c.settings === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  open = sheet('Your devices disagree', (close) => [h('div', { id: 'sync-conflict' },
    h('p', null, `Since this device last synced, ${what} were changed differently here and on ${c.other.name}. Nothing has been changed yet. How should Folio combine them?`),
    c.sample?.length ? h('p', { class: 'muted small' }, 'For example: ' + c.sample.join(', ') + (c.books > c.sample.length ? '…' : '')) : null,
    h('div', { class: 'sc-sides' },
      h('div', { class: 'list-item' }, h('strong', null, 'This device: ' + (c.me.name || 'this device')), h('div', { class: 'muted small' }, `${c.me.books} books · last synced ${fmtWhen(c.me.lastSync)}`)),
      h('div', { class: 'list-item' }, h('strong', null, 'Other device: ' + c.other.name), h('div', { class: 'muted small' }, `${c.other.books} books in the cloud · saved ${fmtWhen(c.other.at)}`))),
    h('div', { class: 'sc-choices' },
      h('button', { class: 'btn primary', id: 'sc-merge', onclick: () => choose('merge', close) }, 'Merge both (recommended)'),
      h('p', { class: 'muted small' }, 'Keeps every book from both; where both changed the same thing, the most recent change wins.'),
      h('button', { class: 'btn', id: 'sc-local', onclick: () => choose('local', close) }, 'Keep this device'),
      h('button', { class: 'btn', id: 'sc-cloud', onclick: () => choose('cloud', close) }, 'Use the other device (cloud)'),
      h('p', { class: 'muted small' }, 'Keep / Use decide only the things that differ. No book is removed by any choice.')),
    h('label', { class: 'check-row' }, rem, ' Remember my choice (change it in Settings → Sync)'))],
  { closeLabel: 'Decide later', onClose: () => { open = null; if (!chosen) snoozed = Date.now(); } });
  return true;
}
export function initConflictPrompt() {
  window.addEventListener('folio-sync-conflict', () => setTimeout(maybeShowConflict, 50));
  window.addEventListener('reader-closed', () => setTimeout(maybeShowConflict, 600));
  setTimeout(maybeShowConflict, 400);
}

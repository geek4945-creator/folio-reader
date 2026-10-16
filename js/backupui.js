// Settings → Backup & restore (v0.5.4): Export (optionally with the book files), Import (Merge / Replace) with summary, progress and Undo.
import { h, toast, sheet, confirmDlg, $ } from './util.js';
import * as B from './backup.js';

const mb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
function progressSheet(title) {
  const bar = h('progress', { id: 'bk-progress', max: 100, value: 0, style: { width: '100%' } }); const txt = h('p', { class: 'muted small', id: 'bk-phase' }, 'Starting…');
  const s = sheet(title, () => [bar, txt], { noFooter: true, noDim: false });
  return { close: s.close, set: ({ phase, pct, done, total, label }) => { if (pct != null) bar.value = Math.round(pct * 100); else if (total) bar.value = Math.round((done / total) * 100); txt.textContent = phase || (label ? `Adding files… ${done}/${total} · ${label}` : txt.textContent); } };
}

export function backupSettingsSection(rerender) {
  let include = false; const est = h('span', { class: 'muted small', id: 'bk-estimate' }, '');
  const refreshEstimate = async () => { const p = await B.backupPlan({ includeFiles: include }); est.textContent = `${p.books} books, ${p.audiobooks} audiobooks · about ${mb(p.estimate)}${include ? ' (with book files)' : ''}`; };
  refreshEstimate().catch(() => {});
  const undoRow = h('div', { id: 'bk-undo-row', hidden: true, class: 'row-actions' });
  const refreshUndo = async () => { const u = await B.undoInfo().catch(() => null); undoRow.hidden = !u; undoRow.replaceChildren(...(u ? [h('span', { class: 'muted small' }, 'Last import (' + u.label + ') · ' + when(u.at)), h('button', { class: 'btn', id: 'bk-undo', onclick: doUndo }, 'Undo it'), h('button', { class: 'btn-text small', id: 'bk-discard', onclick: async () => { await B.discardUndo(); toast('Undo snapshot removed'); refreshUndo(); } }, 'Keep, remove snapshot')] : [])); };
  refreshUndo();
  async function doUndo() { if (!await confirmDlg('Undo the last import?', 'Your library goes back to how it was just before the import.', 'Undo', true)) return; try { await B.undoImport(); toast('Import undone'); } catch (e) { toast(e.message); } refreshUndo(); rerender && rerender(); }

  async function doExport() {
    let handle = null;
    if (B.canPickSaveFile()) { try { handle = await window.showSaveFilePicker({ suggestedName: B.backupFileName(), types: [{ description: 'Library backup', accept: { 'application/zip': ['.zip'] } }] }); } catch (e) { if (e && e.name === 'AbortError') return; handle = null; } }
    const ps = progressSheet('Exporting your library…');
    try {
      const { stream } = await B.exportBackupStream({ includeFiles: include, onProgress: (p) => ps.set(p) }); ps.set({ phase: 'Writing the backup file…', pct: 0.05 });
      const res = await B.writeBackup(stream, B.backupFileName(), { handle }); ps.close();
      if (res.kind === 'native') { try { await res.share(); toast('Choose where to save ' + res.name); } catch (e) { if (!/cancel/i.test(String(e && e.message))) toast('Couldn’t open the share sheet: ' + (e.message || e)); } }
      else if (res.kind === 'picker') toast('Saved ' + res.name);
      else { window.__lastBackup = res; const s = sheet('Backup ready', () => [h('p', null, res.name + ' · ' + mb(res.blob.size)), h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'bk-save', onclick: async () => { const r = await B.deliverBlob(res.blob, res.name); if (r !== 'cancelled') { toast(r === 'shared' ? 'Shared' : 'Downloading ' + res.name); s.close(); } } }, 'Save backup'))], { closeLabel: 'Close' }); }
    } catch (e) { ps.close(); console.error(e); toast('Export failed: ' + (e.message || e), 6000); }
  }

  async function pickImport(file) {
    if (!file) return; let P;
    try { P = await B.readBackup(file); } catch (e) { sheet('Can’t import this file', () => [h('p', { id: 'bk-error', class: 'muted' }, e.message || String(e))], { closeLabel: 'OK' }); return; }
    const m = P.summary; let mode = 'merge';
    const rows = [['Books', m.books], ['…with files in the backup', m.files], ['Audiobooks', m.audiobooks], ['Shelves', m.shelves], ['Series sets', m.sets], ['Bookmarks', m.bookmarks], ['Audiobook ↔ ebook links', m.links], ['Catalog sources', m.sources], ['Settings', m.settings]];
    const s = sheet('Import backup', (close) => [
      h('p', { class: 'muted small', id: 'bk-from' }, `Made by ${m.app} on ${when(m.createdAt)} · ${mb(P.size)}` + (m.fromOtherApp ? ' — from the other app; it can be imported here.' : '')),
      h('div', { class: 'list', id: 'bk-summary' }, rows.map(([k, v]) => h('div', { class: 'list-item' }, h('span', { class: 'grow' }, k), h('strong', null, String(v))))),
      m.books > m.files ? h('p', { class: 'muted small' }, `${m.books - m.files} book(s) have no file in this backup: their progress, shelves and settings are kept and apply when you add the book itself.`) : null,
      h('div', { class: 'row-ctl' }, h('label', null, 'How to import')),
      h('div', { class: 'seg wide', id: 'bk-mode' }, [['merge', 'Merge'], ['replace', 'Replace']].map(([v, n]) => h('button', { class: v === mode ? 'on' : '', 'data-mode': v, onclick: (e) => { mode = v; e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); hint.textContent = HINT[v]; go.textContent = v === 'merge' ? 'Merge into my library' : 'Replace my library…'; go.classList.toggle('danger', v === 'replace'); } }, n))),
      h('p', { class: 'muted small', id: 'bk-hint' }, ''),
      (go = h('button', { class: 'btn primary block', id: 'bk-go', onclick: async () => { if (mode === 'replace' && !await confirmDlg('Replace your library?', 'Books, shelves, sets, order, positions and settings on this device become the backup’s. Books that aren’t in the backup are removed from the library. You can undo this right afterwards.', 'Replace', true)) return; close(); run(P, mode); } }, 'Merge into my library')),
    ], { closeLabel: 'Cancel' });
    const HINT = { merge: 'Keeps everything here and adds the backup’s. For anything both have, the newest change wins, and details you set yourself beat automatic ones.', replace: 'Makes this library match the backup (books already here are kept for matching titles).' };
    const hint = $('#bk-hint'); hint.textContent = HINT.merge; void s;
  }
  let go;
  async function run(P, mode) {
    const ps = progressSheet(mode === 'replace' ? 'Replacing your library…' : 'Merging the backup…');
    try {
      const rep = await B.importBackup(P, { mode, onProgress: (p) => ps.set(p) }); ps.close(); window.__lastImport = rep;
      const lines = [`${rep.booksMatched} books matched`, `${rep.filesImported} book files added`, `${rep.booksPending} waiting for their file`, `${rep.audiobooks} audiobooks updated`, rep.audiobooksPending ? `${rep.audiobooksPending} audiobooks waiting for their audio` : null, `${rep.shelves} shelves · ${rep.sets} sets`].filter(Boolean);
      sheet('Import finished', () => [h('p', { id: 'bk-result' }, lines.join(' · ')), rep.filesFailed.length ? h('p', { class: 'muted small', id: 'bk-failed' }, 'Couldn’t add: ' + rep.filesFailed.map((f) => f.title + ' (' + f.error + ')').join('; ')) : null, h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'bk-undo-now', onclick: async () => { await B.undoImport(); toast('Import undone'); rerender && rerender(); } }, 'Undo'))], { closeLabel: 'Done' });
      refreshUndo(); rerender && rerender();
    } catch (e) { ps.close(); sheet('Import failed', () => [h('p', { id: 'bk-error', class: 'muted' }, e.message || String(e))], { closeLabel: 'OK' }); }
  }
  const input = h('input', { type: 'file', id: 'backup-input', accept: '.zip,application/zip,application/x-zip-compressed', hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; pickImport(f); } });
  return h('section', { class: 'pad card-sec', id: 'sec-backup' }, h('h3', null, 'Backup & restore'),
    h('p', { class: 'muted small' }, 'One .zip with your settings, per-book text styles, reading positions, shelves, sets, custom order, metadata and covers, links, borrowed dates and catalog sources. Google sign-in tokens are never included. A backup from Folio Reader can be imported into Flimsy Read and the other way round.'),
    h('label', { class: 'row-ctl' }, h('span', null, 'Include book files'), h('input', { type: 'checkbox', id: 'bk-include', onchange: (e) => { include = e.target.checked; refreshEstimate(); } })), est,
    h('p', { class: 'muted small' }, 'Off by default: the backup stays small and books can be added again from their own files. Audiobook audio is never included (positions and links are).'),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'bk-export', onclick: doExport }, 'Export backup'), h('button', { class: 'btn', id: 'bk-import', onclick: () => input.click() }, 'Import backup…')), input, undoRow);
}

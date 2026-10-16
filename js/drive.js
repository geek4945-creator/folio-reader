// Browse your Google Drive for EPUB files and import them into the library (read-only access, requested on first use).
import { h, toast, sheet, put } from './util.js';
import * as G from './google.js';
import { addBookFromBuffer } from './store.js';
import * as A from './audiostore.js';

const fmtSize = (n) => (n ? (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB') : '');

import * as DB from './drivebatch.js';

export async function openDriveBrowser(opts = {}) {
  const audio = !!opts.audio, images = !!opts.images;
  if (!G.isSignedIn()) { toast('Sign in with Google first: Settings → Account & sync', 4500); return; }
  if (!G.canBrowseDrive()) {
    try { await G.enableDriveBrowse(); } catch (e) { toast(e.message, 5000); return; }
  }
  const path = [{ id: 'root', name: 'My Drive' }];
  let search = ''; let tok = ''; let busy = false;
  const list = h('div', { class: 'list', id: 'drive-list' }); const crumbs = h('div', { class: 'muted small', id: 'drive-crumbs' });
  const more = h('button', { class: 'btn block', hidden: true }, 'Load more');
  const q = h('input', { type: 'search', class: 'field search', id: 'drive-search', placeholder: images ? 'Search Drive for pictures' : audio ? 'Search Drive for audiobooks' : 'Search Drive for EPUBs' });
  const sel = new Map();   // id → file: individually ticked rows and results of "Select all…" (kept while you browse)
  const batchOK = !images; const kind = audio ? 'audio' : 'book';
  const countEl = h('span', { id: 'drive-sel-count' }); const bar = h('div', { class: 'drive-batch-bar', id: 'drive-batch-bar', hidden: true }, countEl,
    h('button', { class: 'btn primary small', id: 'drive-import-selected', onclick: () => confirmSelection() }, 'Import selected…'), h('button', { class: 'btn small', id: 'drive-sel-clear', onclick: () => { sel.clear(); syncSel(); } }, 'Clear'));
  const sub = h('input', { type: 'checkbox', id: 'drive-sub' });
  const tools = batchOK ? h('div', { class: 'drive-tools', id: 'drive-tools' },
    h('button', { class: 'btn small', id: 'drive-sel-folder', onclick: () => selectAll(false) }, 'Select all in this folder'), h('label', { class: 'check-inline' }, sub, ' Include subfolders'),
    h('button', { class: 'btn small', id: 'drive-sel-all', onclick: () => selectAll(true) }, audio ? 'Select all audio files in my whole Drive' : 'Select all book files in my whole Drive')) : null;
  const w = sheet(images ? 'Google Drive: pictures' : audio ? 'Google Drive: audiobooks' : 'Google Drive', () => [h('form', { onsubmit: (e) => { e.preventDefault(); search = q.value.trim(); load(true); } }, q), tools, crumbs, list, more, bar], { tall: true });

  const fsz = (n) => DB.fmtSize(n);
  function syncSel() {
    const n = sel.size; bar.hidden = !n; countEl.textContent = `${n} selected · ${fsz([...sel.values()].reduce((a, f) => a + (f.size || 0), 0))}`;
    list.querySelectorAll('.drive-check').forEach((c) => { c.checked = sel.has(c.closest('.file')?.dataset.id); });
  }
  async function selectAll(whole) {
    const cur = path[path.length - 1];
    const r = await DB.scanWithUI({ kind, folderId: whole ? null : cur.id, folderName: whole ? '' : cur.name, recursive: !whole && sub.checked });
    for (const f of r.files) sel.set(f.id, f); syncSel(); await confirmSelection(r);
  }
  async function confirmSelection(scanInfo = {}) {
    if (!sel.size) return; const files = [...sel.values()];
    const out = await DB.importFlow(kind, files, scanInfo); if (out) { sel.clear(); syncSel(); }
  }
  async function load(reset) {
    if (busy) return; busy = true;
    if (reset) { list.replaceChildren(h('div', { class: 'spinner-row' }, h('div', { class: 'spinner' }), 'Loading…')); tok = ''; }
    crumbs.textContent = search ? `Search: “${search}”` : path.map((p) => p.name).join(' › ');
    try {
      const d = await G.listDriveFiles({ folderId: path[path.length - 1].id, search, pageToken: tok, audio, images });
      if (reset) list.replaceChildren();
      if (!search && path.length > 1 && reset) list.append(row('‹ Back', '', () => { path.pop(); load(true); }));
      if (audio && reset && !search) { const audios = d.files.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder' && !/\.zip$/i.test(f.name)); if (audios.length > 1) list.append(folderBtn(audios)); }
      for (const f of d.files) {
        if (f.mimeType === 'application/vnd.google-apps.folder') list.append(row('📁 ' + f.name, '›', () => { search = ''; q.value = ''; path.push({ id: f.id, name: f.name }); load(true); }, 'folder'));
        else list.append(importRow(f));
      }
      if (reset && !d.files.length) list.append(h('p', { class: 'muted pad' }, '' + (images ? 'No folders or pictures (JPEG, PNG, WebP) here.' : audio ? 'No folders or audio files (MP3, M4B, M4A, AAC, OGG, zip) here.' : 'No folders or book files (EPUB, PDF, MOBI, AZW3) here.') + ''));
      tok = d.nextPageToken || ''; more.hidden = !tok;
    } catch (e) { list.replaceChildren(h('p', { class: 'err pad' }, e.message)); }
    busy = false;
  }
  more.onclick = () => load(false);
  function row(label, right, fn, cls = '') { return h('button', { class: 'list-item ' + cls, onclick: fn }, h('span', { class: 'grow' }, label), h('span', { class: 'chev' }, right)); }
  function folderBtn(files) {
    const btn = h('button', { class: 'btn primary block', id: 'drive-folder-import', onclick: async () => {
      btn.disabled = true; const got = [];
      try { for (const [i, f] of files.entries()) { btn.textContent = `Downloading ${i + 1} of ${files.length}…`; const blob = await G.downloadDriveFile(f.id); got.push(new File([blob], f.name, { type: blob.type })); }
        btn.textContent = 'Importing…'; const book = await A.importGroup({ name: path[path.length - 1].name, entries: got.map((f) => ({ name: f.name, blob: f })) }, { source: 'Google Drive' }); btn.textContent = '✓ Added'; toast('Imported “' + book.title + '”'); }
      catch (err) { btn.disabled = false; btn.textContent = `Import these ${files.length} files as one audiobook`; toast(err.code === 'drm' ? A.COPY_PROTECTED_MSG : err.message, 6000); }
    } }, `Import these ${files.length} files as one audiobook`);
    return btn;
  }
  function importRow(f) {
    if (images) {
      const use = h('button', { class: 'btn primary small dl', onclick: async (e) => { e.stopPropagation(); use.disabled = true; use.textContent = 'Downloading…';
        try { const blob = await G.downloadDriveFile(f.id); await opts.onPick(blob.type ? blob : new Blob([blob], { type: f.mimeType || 'image/jpeg' })); use.disabled = false; use.textContent = 'Use'; } catch (err) { use.disabled = false; use.textContent = 'Use'; toast(err.message, 5000); } } }, 'Use');
      return h('div', { class: 'list-item file', 'data-id': f.id }, h('span', { class: 'grow' }, f.name, h('div', { class: 'muted small' }, fmtSize(+f.size))), use);
    }
    const btn = h('button', { class: 'btn primary small dl', onclick: async (e) => {
      e.stopPropagation(); btn.disabled = true; btn.textContent = 'Downloading…';
      try { const blob = await G.downloadDriveFile(f.id); btn.textContent = 'Importing…'; if (audio) { const res = await A.importAudioFiles([new File([blob], f.name, { type: blob.type })]); if (res.drm.length) throw Object.assign(new Error(A.COPY_PROTECTED_MSG), { code: 'drm' }); if (res.errs.length) throw new Error(res.errs[0]); btn.textContent = '✓ Added'; DB.markImported([f.id]); toast('Imported “' + f.name + '”'); return; } await addBookFromBuffer(await blob.arrayBuffer(), { source: 'Google Drive', sourceKey: 'gdrive:' + f.id, filename: f.name }); btn.textContent = '✓ Added'; DB.markImported([f.id]); toast('Imported “' + f.name + '”'); }
      catch (err) { btn.disabled = false; btn.textContent = /Already|already/.test(err.message) ? '✓ In library' : 'Import'; toast(err.message, 5000); }
    } }, 'Import');
    const chk = h('input', { type: 'checkbox', class: 'drive-check', 'aria-label': 'Select ' + f.name, checked: sel.has(f.id), onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) sel.set(f.id, { id: f.id, name: f.name, size: +f.size || 0, mimeType: f.mimeType, parent: (f.parents || [])[0] || (path[path.length - 1].id !== 'root' ? path[path.length - 1].id : null), folder: path[path.length - 1].name }); else sel.delete(f.id); syncSel(); } });
    return h('div', { class: 'list-item file', 'data-id': f.id }, chk, h('span', { class: 'grow' }, f.name, h('div', { class: 'muted small' }, fmtSize(+f.size))), btn);
  }
  load(true);
  return w;
}

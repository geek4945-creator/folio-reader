// Batch import from Google Drive: scan (folder / subfolders / whole Drive) → confirm (count, total size, duplicates) → import with progress,
// cancel, duplicate skipping and retry of failures. The Drive calls (pagination, pacing, 429 / 5xx back-off) live in google.js.
import { h, sheet, toast } from './util.js';
import * as G from './google.js';
import * as S from './store.js';
import * as A from './audiostore.js';

export const BATCH = { gap: 150 };   // minimum ms between Drive requests while a batch runs (tests lower it)
const DKEY = 'folio.driveImported';
const imported = () => { try { return new Set(JSON.parse(localStorage.getItem(DKEY) || '[]')); } catch { return new Set(); } };
export const markImported = (ids) => { const s = imported(); ids.forEach((i) => s.add(i)); localStorage.setItem(DKEY, JSON.stringify([...s].slice(-20000))); };
export const fmtSize = (n) => (n ? (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB') : '0 KB');
const extOf = (n) => ((/\.([A-Za-z0-9]+)$/.exec(n) || [])[1] || 'file').toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Files already imported from Drive (by Drive id, or an existing book with this source key). */
export async function knownIds(kind) {
  const ids = imported(); if (kind !== 'audio') for (const b of await S.getBooks()) if (b.sourceKey?.startsWith('gdrive:')) ids.add(b.sourceKey.slice(7));
  return ids;
}

/** Scan with a progress sheet. Resolves { files, truncated, cancelled, folders }. */
export async function scanWithUI({ kind, folderId = null, folderName = '', recursive = false }) {
  const signal = { cancelled: false }; const txt = h('div', { id: 'dv-scan-text', class: 'muted' }, 'Scanning Google Drive…');
  const w = sheet(folderId ? (recursive ? 'Scanning folder and subfolders' : 'Scanning folder') : 'Scanning your whole Drive', () => [h('div', { class: 'spinner-row' }, h('div', { class: 'spinner' }), txt), h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'dv-scan-cancel', onclick: () => { signal.cancelled = true; txt.textContent = 'Stopping…'; } }, 'Stop scan'))], { closeLabel: 'Stop', onClose: () => { signal.cancelled = true; } });
  try {
    G.driveRate.gap = BATCH.gap;
    return await G.scanDrive({ kind, folderId, folderName, recursive, signal, onProgress: ({ found, folders }) => { txt.textContent = `${found} ${kind === 'audio' ? 'audio' : 'book'} file${found === 1 ? '' : 's'} found` + (folders ? ` · ${folders} folder${folders === 1 ? '' : 's'} scanned` : ''); } });
  } finally { G.driveRate.gap = 0; w.close(); }
}

/** Confirm step: count, total size, types, duplicates. Resolves { go, group } */
export async function confirmImport(kind, files, { truncated = false, cancelled = false } = {}) {
  const known = await knownIds(kind); const fresh = files.filter((f) => !known.has(f.id)); const dupes = files.length - fresh.length;
  const total = fresh.reduce((a, f) => a + (f.size || 0), 0); const types = {}; for (const f of fresh) types[extOf(f.name)] = (types[extOf(f.name)] || 0) + 1;
  const groups = kind === 'audio' ? new Set(fresh.filter((f) => f.parent).map((f) => f.parent)) : null; const multi = kind === 'audio' && [...(groups || [])].some((p) => fresh.filter((f) => f.parent === p).length > 1);
  return new Promise((resolve) => {
    let fin = false; const group = h('input', { type: 'checkbox', id: 'dv-group', checked: true });
    const out = (go) => { if (fin) return; fin = true; resolve({ go, group: group.checked }); };
    sheet('Import from Google Drive', (close) => [
      h('div', { id: 'dv-confirm' },
        h('p', null, h('strong', { id: 'dv-count' }, `${fresh.length} file${fresh.length === 1 ? '' : 's'}`), ' to import · ', h('span', { id: 'dv-size' }, fmtSize(total))),
        h('p', { class: 'muted small', id: 'dv-types' }, Object.entries(types).map(([t, n]) => `${n} .${t}`).join(' · ') || 'Nothing new to import.'),
        dupes ? h('p', { class: 'muted small', id: 'dv-dupes' }, `${dupes} already imported from Drive, will be skipped.`) : null,
        truncated ? h('p', { class: 'muted small', id: 'dv-truncated' }, 'Very large result: only the first files found are included. Run it again for the rest.') : null,
        cancelled ? h('p', { class: 'muted small' }, 'The scan was stopped early, so this list is partial.') : null,
        multi ? h('label', { class: 'check-row' }, group, ' Files from the same folder become one audiobook (ordered by file name)') : null,
        h('p', { class: 'muted small' }, 'Files are downloaded one at a time, so large selections can take a while. Books that are already in your library (same title / ID) are skipped, and you can cancel any time.')),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'dv-cancel', onclick: () => { out(false); close(); } }, 'Cancel'),
        h('button', { class: 'btn primary', id: 'dv-go', disabled: !fresh.length, onclick: () => { out(true); close(); } }, fresh.length ? `Import ${fresh.length} file${fresh.length === 1 ? '' : 's'}` : 'Nothing to import'))], { closeLabel: 'Cancel', onClose: () => out(false) });
  });
}

/* ---------- running ---------- */
const DUPE_RE = /already in your (library|audiobooks)/i;
async function importOne(kind, f) {
  const blob = await G.downloadDriveFile(f.id, { retries: 3 });
  if (kind === 'audio') { const res = await A.importAudioFiles([new File([blob], f.name, { type: blob.type })]); if (res.drm.length) throw Object.assign(new Error(A.COPY_PROTECTED_MSG), { code: 'drm' }); if (res.errs.length) throw new Error(res.errs[0]); return; }
  await S.addBookFromBuffer(await blob.arrayBuffer(), { source: 'Google Drive', sourceKey: 'gdrive:' + f.id, filename: f.name });
}
async function importGroupOf(files) {
  const name = (await G.driveFolderName(files[0].parent)) || files[0].folder || 'Audiobook'; const got = [];
  for (const f of files) { const blob = await G.downloadDriveFile(f.id, { retries: 3 }); got.push({ name: f.name, blob: new File([blob], f.name, { type: blob.type }) }); }
  await A.importGroup({ name, entries: got }, { source: 'Google Drive' });
}
/** Import files one by one. Returns { imported:[f], skipped:[{f,why}], failed:[{f,why,final}], cancelled, done, total } */
export async function runBatch(kind, files, { group = true, signal = { cancelled: false }, onProgress = () => {} } = {}) {
  const res = { imported: [], skipped: [], failed: [], cancelled: false, done: 0, total: files.length };
  const known = await knownIds(kind); const todo = [];
  for (const f of files) { if (known.has(f.id)) { res.skipped.push({ f, why: 'already imported' }); res.done++; } else todo.push(f); }
  const items = []; const byParent = new Map();
  if (kind === 'audio' && group) for (const f of todo) if (f.parent) (byParent.get(f.parent) || byParent.set(f.parent, []).get(f.parent)).push(f);
  const grouped = new Set(); for (const [, list] of byParent) if (list.length > 1) { list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); items.push(list); list.forEach((f) => grouped.add(f.id)); }
  for (const f of todo) if (!grouped.has(f.id)) items.push([f]);
  G.driveRate.gap = BATCH.gap;
  try {
    for (const it of items) {
      if (signal.cancelled) { res.cancelled = true; break; }
      onProgress({ done: res.done, total: res.total, name: it.length > 1 ? `${it.length} files from one folder` : it[0].name });
      try { if (it.length > 1) await importGroupOf(it); else await importOne(kind, it[0]); res.imported.push(...it); markImported(it.map((f) => f.id)); }
      catch (e) {
        if (e.code === 'dupe' || DUPE_RE.test(e.message || '')) { for (const f of it) res.skipped.push({ f, why: 'already in your library' }); markImported(it.map((f) => f.id)); }
        else for (const f of it) res.failed.push({ f, why: e.code === 'drm' ? 'copy-protected (DRM)' : (e.status === 404 ? 'not found in Drive' : e.status === 403 ? 'no permission to download it' : e.message || 'failed'), final: e.code === 'drm' });
      }
      res.done += it.length;
    }
  } finally { G.driveRate.gap = 0; }
  onProgress({ done: res.done, total: res.total, name: '' });
  return res;
}

/** Progress sheet + summary (with Retry failed). Resolves when the user is done. */
export async function runWithUI(kind, files, { group = true } = {}) {
  let all = { imported: 0, skipped: 0 }; let current = files; let last = null;
  for (;;) {
    const signal = { cancelled: false }; const bar = h('i', { id: 'dv-bar' }); const txt = h('div', { id: 'dv-progress-text', class: 'muted' }, 'Starting…');
    const w = sheet('Importing from Google Drive', () => [h('div', { class: 'bar fm-bar' }, bar), txt, h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'dv-cancel-run', onclick: () => { signal.cancelled = true; txt.textContent = 'Stopping after this file…'; } }, 'Cancel'))], { closeLabel: 'Cancel', onClose: () => { signal.cancelled = true; } });
    const res = await runBatch(kind, current, { group, signal, onProgress: ({ done, total, name }) => { bar.style.width = Math.round((done / Math.max(1, total)) * 100) + '%'; txt.textContent = name ? `Importing ${Math.min(done + 1, total)} of ${total}: ${name}` : `${done} of ${total}`; } });
    w.close(); all.imported += res.imported.length; all.skipped += res.skipped.length; last = res;
    const retryable = res.failed.filter((x) => !x.final);
    const again = await new Promise((resolve) => {
      let fin = false; const out = (v) => { if (!fin) { fin = true; resolve(v); } };
      sheet('Import finished', (close) => [h('div', { id: 'dv-summary' },
        h('p', null, h('strong', null, `Imported ${all.imported}`), all.skipped ? ` · skipped ${all.skipped} (already in your library)` : '', res.failed.length ? ` · failed ${res.failed.length}` : '', res.cancelled ? ` · cancelled with ${res.total - res.done} not started` : ''),
        res.failed.length ? h('ul', { class: 'small', id: 'dv-failed' }, res.failed.slice(0, 40).map((x) => h('li', null, `${x.f.name}: ${x.why}`))) : null),
        h('div', { class: 'row-actions' }, retryable.length ? h('button', { class: 'btn primary', id: 'dv-retry', onclick: () => { out(true); close(); } }, `Retry ${retryable.length} failed`) : null, h('button', { class: 'btn', id: 'dv-done', onclick: () => { out(false); close(); } }, 'Done'))], { closeLabel: 'Done', onClose: () => out(false) });
    });
    if (!again) break; current = retryable.map((x) => x.f);
  }
  return { ...all, failed: last.failed.length, cancelled: last.cancelled };
}

/** Whole flow for an already-collected file list. */
export async function importFlow(kind, files, scanInfo = {}) {
  const c = await confirmImport(kind, files, scanInfo); if (!c.go) return null;
  return runWithUI(kind, files, { group: c.group });
}

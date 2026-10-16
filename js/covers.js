// Cover images: downscale to ~400px JPEG, content hash (for Drive sync), crop / centre preview, and the "Change cover" flow
// (device picker, Google Drive image, pasted URL, search Open Library + Google Books, Google Images in a new tab, revert to automatic).
import { h, sheet, toast, $, put } from './util.js';
import { fetchSmart, SiteError } from './net.js';
import { DB } from './db.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import { parseEpub } from './epubmeta.js';
import { isPdf, parsePdf } from './pdf.js';
import { readAudioMeta } from './audiotags.js';
import { findCoverCandidates } from './enrich.js';

export const COVER_W = 400;
const isImg = (b) => b && /^image\//.test(b.type);

/** Re-encode any image as a JPEG at most 400 px wide (and 640 tall). Throws a friendly error when the image can't be decoded. */
export async function resizeCover(blob, maxW = COVER_W, maxH = 640) {
  let bmp; try { bmp = await createImageBitmap(blob); } catch { throw new Error('Couldn’t read that image. Try a JPEG or PNG.'); }
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height); const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t encode the image'))), 'image/jpeg', 0.85));
}
/** Short content hash used as the Drive file name of a synced cover. */
export async function hashBlob(blob) {
  const d = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
  return [...new Uint8Array(d)].slice(0, 10).map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Fetch an image URL (through the proxy if the browser blocks it). Returns a Blob or throws a friendly Error. */
export async function fetchImage(url, timeout = 20000) {
  let r;
  try { r = await fetchSmart(url, { timeout }); } catch (e) { throw e instanceof SiteError ? e : new Error(e.message || 'Couldn’t download that image'); }
  const b = await r.blob(); const head = new Uint8Array(await b.slice(0, 12).arrayBuffer());
  const sniff = head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg' : head[0] === 0x89 && head[1] === 0x50 ? 'image/png' : head[0] === 0x47 && head[1] === 0x49 ? 'image/gif' : (head[0] === 0x52 && head[8] === 0x57) ? 'image/webp' : '';
  if (!isImg(b) && !sniff) throw new Error('That address isn’t an image. Right-click the picture and copy the *image* address.');
  return isImg(b) ? b : new Blob([b], { type: sniff });
}

/* ---------- crop geometry (pure, also used by the tests) ---------- */
/** Frame is 2:3. zoom ≥ 1 (1 = cover the frame), cx / cy in 0..1 pick the visible window. Returns the source rectangle in image pixels. */
export function cropRect(w, h_, { zoom = 1, cx = 0.5, cy = 0.5 } = {}) {
  const FW = 2, FH = 3; const base = Math.max(FW / w, FH / h_) * zoom; const sw = FW / base, sh = FH / base;
  return { sx: (w - sw) * cx, sy: (h_ - sh) * cy, sw, sh };
}
export async function renderCrop(bmp, opts = {}) {
  const c = document.createElement('canvas'); const g = c.getContext('2d'); g.fillStyle = '#fff';
  if (opts.keep) { const s = Math.min(1, COVER_W / bmp.width, 640 / bmp.height); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height); }
  else { const r = cropRect(bmp.width, bmp.height, opts); c.width = COVER_W; c.height = Math.round(COVER_W * 1.5); g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height); }
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

/* ---------- apply / revert ---------- */
const adapt = (kind) => (kind === 'audio' ? { get: A.getAudiobook, save: async (b) => { await A.saveAudiobook(b); S.emitChange(); } } : { get: S.getBook, save: (b) => S.saveBook(b) });
export async function setUserCover(kind, id, blob) {
  const a = adapt(kind); const it = await a.get(id); if (!it) throw new Error('That item no longer exists');
  it.coverBlob = blob; it.coverSource = 'user'; it.coverId = null; it.userSet = { ...(it.userSet || {}), cover: true }; it.metaAt = { ...(it.metaAt || {}), cover: Date.now() };
  await a.save(it); return it;
}
/** The "automatic" cover = the one inside the file (EPUB / PDF / audio tags). Null when the file has none. */
export async function extractFileCover(kind, it) {
  try {
    if (kind === 'audio') { const f = await A.getTrackBlob(it, 0); if (!f) return null; return (await readAudioMeta(f, it.tracks[0]?.name || '')).cover; }
    const blob = await S.getFile(it.id); if (!blob) return null; const buf = await blob.arrayBuffer();
    const m = isPdf(buf) ? await parsePdf(buf, '') : await parseEpub(buf); return m.coverBlob || null;
  } catch { return null; }
}
export async function revertCover(kind, id, { at = Date.now(), quiet = false } = {}) {
  const a = adapt(kind); const it = await a.get(id); if (!it) return null;
  let cover = await extractFileCover(kind, it);
  if (!cover && it.coverUrl) { try { cover = await fetchImage(it.coverUrl); } catch { cover = null; } }   // online audiobooks: the catalog's own cover
  if (cover) cover = await resizeCover(cover);
  it.coverBlob = cover || null; it.coverSource = 'file'; it.coverId = null; if (it.userSet) delete it.userSet.cover; if (it.enriched) delete it.enriched.cover; it.enrichTried = 0;
  it.metaAt = { ...(it.metaAt || {}), cover: at }; it.revertedAt = at;
  if (quiet) { it._noTouch = true; await DB.put(kind === 'audio' ? 'audiobooks' : 'books', it); } else await a.save(it);
  return it;
}
export const hasCustomCover = (it) => !!(it.userSet?.cover || (it.coverSource && it.coverSource !== 'file'));

/* ---------- the "Change cover" sheet ---------- */
export async function openCoverEditor(kind, id, { onDone } = {}) {
  const a = adapt(kind); const it = await a.get(id); if (!it) return;
  const w = sheet('Change cover', () => []); const body = w.body; let stage = 'menu';
  const done = async (msg) => { w.close(); toast(msg); onDone && onDone(); };
  const finish = async (blob, source) => {   // blob → crop step → save
    stage = 'crop'; await cropStep(blob, source);
  };
  menu();

  function menu() {
    stage = 'menu';
    const file = h('input', { type: 'file', accept: 'image/*', id: 'cover-file', hidden: true });
    file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; if (f) { try { await finish(f, 'device'); } catch (e) { toast(e.message, 5000); } } });
    const status = h('p', { class: 'muted small', id: 'cover-status' });
    body.replaceChildren(
      h('p', { class: 'muted small' }, 'Pick an image, then centre and zoom it. It is saved as a ~400 px JPEG on this device (and in your Google Drive app data if you sync).'),
      h('div', { class: 'list' },
        h('button', { class: 'list-item', id: 'cover-opt-device', onclick: () => file.click() }, h('span', null, '📷  Choose from this device (photos / files)')),
        h('button', { class: 'list-item', id: 'cover-opt-drive', onclick: pickDrive }, h('span', null, '☁️  Choose from Google Drive')),
        h('button', { class: 'list-item', id: 'cover-opt-url', onclick: urlStep }, h('span', null, '🔗  Paste an image address')),
        h('button', { class: 'list-item', id: 'cover-opt-search', onclick: searchStep }, h('span', null, '🔎  Search covers (Open Library, Google Books)')),
        hasCustomCover(it) || it.coverBlob ? h('button', { class: 'list-item', id: 'cover-opt-revert', onclick: async () => { const r = await revertCover(kind, id); await done(r?.coverBlob ? 'Back to the automatic cover' : 'Removed the custom cover'); } }, h('span', null, '↩︎  Revert to automatic cover')) : null),
      status, file);
  }
  async function pickDrive() {
    const { openDriveBrowser } = await import('./drive.js'); let dw = null;
    dw = await openDriveBrowser({ images: true, onPick: async (blob) => { try { await finish(blob, 'drive'); dw?.close(); } catch (e) { toast(e.message, 5000); } } });
  }
  function urlStep() {
    stage = 'url'; const input = h('input', { class: 'field', id: 'cover-url', type: 'text', inputmode: 'url', placeholder: 'https://example.com/cover.jpg', autocapitalize: 'none', spellcheck: 'false' }); const err = h('p', { class: 'err small', id: 'cover-url-err' });
    const go = h('button', { class: 'btn primary block', id: 'cover-url-go', onclick: async () => {
      err.textContent = ''; let u = input.value.trim(); if (!u) return; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; go.disabled = true; go.textContent = 'Fetching…';
      try { await finish(await fetchImage(u), 'url'); } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Fetch image'; }
    } }, 'Fetch image');
    body.replaceChildren(h('button', { class: 'btn-text', onclick: menu }, '‹ Back'), h('label', null, 'Image address (URL)', input), err, go, h('p', { class: 'muted small' }, 'Tip: in your browser, right-click a picture → “Copy image address”. If the site blocks direct downloads Folio retries through your proxy.'));
    setTimeout(() => input.focus(), 40);
  }
  async function searchStep() {
    stage = 'search'; const grid = h('div', { class: 'cover-grid', id: 'cover-results' }); const note = h('p', { class: 'muted small', id: 'cover-search-note' }, 'Searching…');
    const q = `${it.title} ${it.author && !/^unknown/i.test(it.author) ? it.author : ''} book cover`.replace(/\s+/g, ' ').trim();
    const gi = h('a', { class: 'btn block', id: 'cover-google-images', href: 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q), target: '_blank', rel: 'noopener', onclick: (e) => { e.preventDefault(); window.open('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q), '_blank', 'noopener'); } }, '🖼️  Open Google Images in a new tab');
    const pasteBtn = h('button', { class: 'btn block', id: 'cover-search-paste', onclick: urlStep }, 'Paste the image address you copied');
    body.replaceChildren(h('button', { class: 'btn-text', onclick: menu }, '‹ Back'), note, grid, h('div', { class: 'muted small' }, 'Not here? Search Google Images for “' + q + '”, copy the image address, then paste it.'), gi, pasteBtn);
    try {
      const cands = await findCoverCandidates(it.title, it.author, it.isbn);
      note.textContent = cands.length ? 'Tap a cover to preview it.' : 'No covers found for this title.';
      for (const c of cands) grid.append(h('button', { class: 'cover-cand', 'data-src': c.source, title: c.label || c.source, onclick: async (e) => { const b = e.currentTarget; b.classList.add('busy'); try { await finish(await fetchImage(c.full || c.url), c.source); } catch (err) { b.classList.remove('busy'); toast(err.message, 5000); } } },
        h('img', { src: c.thumb || c.url, alt: '', loading: 'lazy', onerror: (e) => e.target.closest('.cover-cand').remove() }), h('small', null, c.label || c.source)));
    } catch (e) { note.textContent = 'Couldn’t search right now (' + (e.message || 'network') + '). You can still paste an image address.'; }
  }
  async function cropStep(blob, source) {
    let bmp; try { bmp = await createImageBitmap(blob); } catch { throw new Error('Couldn’t read that image. Try a JPEG or PNG.'); }
    stage = 'crop'; const st = { zoom: 1, cx: 0.5, cy: 0.5, keep: false }; const url = URL.createObjectURL(blob);
    const FW = 200, FH = 300; const img = h('img', { src: url, alt: '', draggable: 'false', id: 'crop-img' }); const frame = h('div', { class: 'crop-frame', id: 'crop-frame' }, img);
    const lay = () => {
      if (st.keep) { frame.classList.add('keep'); const s = Math.min(FW / bmp.width, FH / bmp.height); Object.assign(img.style, { width: bmp.width * s + 'px', height: bmp.height * s + 'px', left: (FW - bmp.width * s) / 2 + 'px', top: (FH - bmp.height * s) / 2 + 'px' }); return; }
      frame.classList.remove('keep'); const r = cropRect(bmp.width, bmp.height, st); const k = FW / r.sw;
      Object.assign(img.style, { width: bmp.width * k + 'px', height: bmp.height * k + 'px', left: -r.sx * k + 'px', top: -r.sy * k + 'px' });
    };
    const zoom = h('input', { type: 'range', id: 'crop-zoom', min: 1, max: 3, step: 0.01, value: 1 }); const px = h('input', { type: 'range', id: 'crop-x', min: 0, max: 100, step: 1, value: 50 }); const py = h('input', { type: 'range', id: 'crop-y', min: 0, max: 100, step: 1, value: 50 });
    const keep = h('input', { type: 'checkbox', id: 'crop-keep' });
    const upd = () => { st.zoom = +zoom.value; st.cx = +px.value / 100; st.cy = +py.value / 100; st.keep = keep.checked; for (const e of [zoom, px, py]) e.disabled = st.keep; lay(); };
    for (const e of [zoom, px, py, keep]) e.addEventListener('input', upd);
    let drag = null; frame.addEventListener('pointerdown', (e) => { if (st.keep) return; drag = { x: e.clientX, y: e.clientY, cx: st.cx, cy: st.cy }; frame.setPointerCapture(e.pointerId); });
    frame.addEventListener('pointermove', (e) => { if (!drag) return; const r = cropRect(bmp.width, bmp.height, st); const k = FW / r.sw; const ox = bmp.width * k - FW, oy = bmp.height * k - FH;
      if (ox > 1) st.cx = Math.min(1, Math.max(0, drag.cx - (e.clientX - drag.x) / ox)); if (oy > 1) st.cy = Math.min(1, Math.max(0, drag.cy - (e.clientY - drag.y) / oy)); px.value = Math.round(st.cx * 100); py.value = Math.round(st.cy * 100); lay(); });
    frame.addEventListener('pointerup', () => { drag = null; });
    const apply = h('button', { class: 'btn primary block', id: 'crop-apply', onclick: async () => {
      apply.disabled = true; apply.textContent = 'Saving…';
      try { const out = await renderCrop(bmp, st); await setUserCover(kind, id, out); URL.revokeObjectURL(url); await done('Cover updated'); } catch (e) { apply.disabled = false; apply.textContent = 'Use this cover'; toast(e.message, 5000); }
    } }, 'Use this cover');
    body.replaceChildren(h('button', { class: 'btn-text', id: 'crop-back', onclick: () => { URL.revokeObjectURL(url); menu(); } }, '‹ Back'),
      h('p', { class: 'muted small center' }, `${bmp.width}×${bmp.height}px · ${source}. Drag the picture or use the sliders.`), h('div', { class: 'crop-wrap' }, frame),
      h('label', null, 'Zoom', zoom), h('label', null, 'Left ↔ right', px), h('label', null, 'Up ↕ down', py), h('label', { class: 'check-row' }, keep, ' Keep the whole image (no crop)'), apply);
    lay();
  }
  return w;
}

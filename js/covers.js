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
import { hasAuthor } from './enrich.js';
import { coverSearch, searchLinks, fromClipboardItems, fromPasteEvent } from './coversearch.js';
import { isIOS, isAndroid } from './env.js';

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
export async function openCoverEditor(kind, id, { onDone, initialBlob = null, initialSource = 'shared' } = {}) {
  const a = adapt(kind); const it = await a.get(id); if (!it) return;
  const w = sheet('Change cover', () => [], { onClose: () => { for (const f of w.cleanups) f(); } }); w.cleanups = []; const body = w.body; let stage = 'menu';
  const done = async (msg) => { w.close(); toast(msg); onDone && onDone(); };
  const finish = async (blob, source) => {   // blob → crop step → save
    stage = 'crop'; await cropStep(blob, source);
  };
  if (initialBlob) finish(initialBlob, initialSource).catch((e) => { toast(e.message, 5000); menu(); }); else menu();

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
        h('button', { class: 'list-item', id: 'cover-opt-search', onclick: searchStep }, h('span', null, '🔎  Search covers (Open Library, Google Books, Internet Archive, Apple Books)')),
        h('button', { class: 'list-item', id: 'cover-opt-paste', onclick: pasteStep }, h('span', null, '📋  Paste an image (or its address)')),
        h('button', { class: 'list-item', id: 'cover-opt-browser', onclick: browserStep }, h('span', null, '🌐  Search in my browser (Google Images…), then paste')),
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
  /** ---- search: editable query, many sources, size filter / sort, load more ---- */
  async function searchStep() {
    stage = 'search'; const kindName = kind === 'audio' ? 'audio' : 'book';
    const f = { title: h('input', { class: 'field', id: 'cover-q-title', value: it.title || '', placeholder: 'Title' }), author: h('input', { class: 'field', id: 'cover-q-author', value: hasAuthor(it.author) ? it.author : '', placeholder: 'Author' }), isbn: h('input', { class: 'field', id: 'cover-q-isbn', value: it.isbn || '', placeholder: 'ISBN (optional)', inputmode: 'numeric' }) };
    const grid = h('div', { class: 'cover-grid', id: 'cover-results' }); const note = h('p', { class: 'muted small', id: 'cover-search-note' }, 'Searching…');
    const sort = h('select', { class: 'field', id: 'cover-sort', onchange: () => paint() }, [['size', 'Largest first'], ['match', 'Best match first']].map(([v, n]) => h('option', { value: v }, n)));
    const minSel = h('select', { class: 'field', id: 'cover-minsize', onchange: () => paint() }, [[0, 'Any size'], [200, 'Hide small (< 200 px tall)'], [400, 'Only ≥ 400 px tall'], [700, 'Only ≥ 700 px tall']].map(([v, n]) => h('option', { value: v, selected: v === 200 }, n)));
    const moreBtn = h('button', { class: 'btn block', id: 'cover-more', hidden: true, onclick: () => loadMore() }, 'Load more covers');
    let session = null, cands = [], busy = false; const nodes = new Map();
    const q = () => `${f.title.value} ${f.author.value}`.replace(/\s+/g, ' ').trim();
    const tile = (c) => {
      const dim = h('small', { class: 'cover-dim' }, '…');
      const img = h('img', { alt: '', decoding: 'async', src: c.thumb || c.full, onload: (e) => { c.w = e.target.naturalWidth; c.h = e.target.naturalHeight; dim.textContent = `${c.w}×${c.h}`; if (c.w < 5 || c.h < 5) { drop(c); return; } schedule(); }, onerror: () => drop(c) });
      return h('button', { class: 'cover-cand', 'data-src': c.source, 'data-id': c.id, title: (c.label || c.source) + ' — tap to use', onclick: async (e) => { const b = e.currentTarget; b.classList.add('busy'); try { await finish(await fetchImage(c.full || c.url), c.source); } catch (err) { b.classList.remove('busy'); toast(err.message, 5000); } } },
        img, h('small', { class: 'cover-lbl' }, c.label || c.source), dim, h('span', { class: 'cover-use' }, 'Use this'));
    };
    const drop = (c) => { cands = cands.filter((x) => x !== c); nodes.get(c)?.remove(); nodes.delete(c); note.textContent = summary(); };
    let timer = null; const schedule = () => { clearTimeout(timer); timer = setTimeout(paint, 150); };
    const summary = () => { const shown = [...nodes.values()].filter((n) => !n.hidden).length; return cands.length ? `${shown} cover${shown === 1 ? '' : 's'} shown${shown < nodes.size ? ` (${nodes.size - shown} hidden by the size filter)` : ''}. Tap one to preview it.` : 'No covers found for this search. Change the title / author / ISBN, or use Search in browser below.'; };
    function paint() {
      const min = +minSel.value; const order = [...cands].sort((a, b) => sort.value === 'size' ? ((b.h || 0) * (b.w || 0)) - ((a.h || 0) * (a.w || 0)) || (b.conf || 0) - (a.conf || 0) : (b.conf || 0) - (a.conf || 0));
      for (const c of order) { let n = nodes.get(c); if (!n) { n = tile(c); nodes.set(c, n); } n.hidden = !!(c.h && min && c.h < min); grid.append(n); }
      note.textContent = summary();
    }
    async function loadMore() {
      if (busy || !session) return; busy = true; moreBtn.disabled = true; moreBtn.textContent = 'Loading…';
      try { const batch = await session.next(); cands.push(...batch); paint(); } catch (e) { note.textContent = 'Couldn’t search right now (' + (e.message || 'network') + ').'; }
      busy = false; moreBtn.disabled = false; moreBtn.textContent = 'Load more covers'; moreBtn.hidden = !session.more;
    }
    async function run() {
      clearTimeout(timer); grid.replaceChildren(); nodes.clear(); cands = []; note.textContent = 'Searching…'; moreBtn.hidden = true;
      session = coverSearch({ title: f.title.value.trim(), author: f.author.value.trim(), isbn: f.isbn.value.trim(), kind: kindName }); await loadMore();
    }
    for (const e of Object.values(f)) e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') run(); });
    const go = h('button', { class: 'btn primary', id: 'cover-q-go', onclick: run }, 'Search');
    const gq = q().length ? q() + ' book cover' : 'book cover'; const links = searchLinks(gq);
    const gi = h('a', { class: 'btn block', id: 'cover-google-images', href: links.google, target: '_blank', rel: 'noopener', onclick: (e) => { e.preventDefault(); window.open(links.google, '_blank', 'noopener'); } }, '🔎  Search Google Images for “' + gq + '”');
    body.replaceChildren(h('button', { class: 'btn-text', id: 'cover-search-back', onclick: menu }, '‹ Back'),
      h('div', { class: 'cover-q' }, f.title, f.author, f.isbn, go),
      h('div', { class: 'cover-filters' }, h('label', null, 'Sort', sort), h('label', null, 'Size', minSel)), note, grid, moreBtn,
      h('div', { class: 'muted small' }, 'Sources: Open Library (all editions), Google Books, Internet Archive, Apple Books. Not here? Look on the web:'), gi,
      h('button', { class: 'btn block', id: 'cover-open-browser', onclick: browserStep }, '🌐  More ways to search in your browser…'),
      h('button', { class: 'btn block', id: 'cover-search-paste', onclick: pasteStep }, 'Paste the image or address you copied'));
    await run();
  }
  /** ---- search in the system browser, then come back with a copied / saved image ---- */
  function browserStep() {
    stage = 'browser'; const q0 = `${it.title} ${hasAuthor(it.author) ? it.author : ''} book cover`.replace(/\s+/g, ' ').trim(); const q = h('input', { class: 'field', id: 'cover-browser-q', value: q0 });
    const open = (u) => { window.open(u, '_blank', 'noopener'); };
    const L = () => searchLinks(q.value.trim() || q0);
    const ios = isIOS(), andr = isAndroid();
    const btn = (id, label, getUrl, cls = 'btn block') => h('a', { class: cls, id, href: getUrl(), target: '_blank', rel: 'noopener', onclick: (e) => { e.preventDefault(); const u = getUrl(); if (/^(googlechromes?|intent):/.test(u)) { location.href = u; } else open(u); } }, label);
    const clip = h('div', { id: 'cover-clip-slot' });
    body.replaceChildren(h('button', { class: 'btn-text', id: 'cover-browser-back', onclick: searchStep }, '‹ Back to results'),
      h('label', null, 'What to search for', q),
      btn('cover-google-images', ios ? '🔎  Google Images — open in Safari' : '🔎  Google Images', () => L().google, 'btn primary block'),
      ios ? btn('cover-chrome-ios', '🔎  Google Images — open in Chrome', () => L().chromeIOS) : null,
      andr ? btn('cover-chrome-android', '🔎  Google Images — open in Chrome', () => L().chromeAndroid) : null,
      h('div', { class: 'row-actions' }, btn('cover-bing', 'Bing Images', () => L().bing, 'btn small'), btn('cover-ddg', 'DuckDuckGo Images', () => L().ddg, 'btn small')),
      h('ol', { class: 'cover-steps', id: 'cover-steps' },
        h('li', null, h('strong', null, 'Find the picture. '), 'Tap an image in the results and open it full size.'),
        h('li', null, h('strong', null, 'Copy or save it. '), 'Touch and hold the image, then choose ', h('em', null, ios ? 'Copy' : 'Copy image'), ' or ', h('em', null, ios ? 'Save to Photos' : 'Download image'), '.'),
        h('li', null, h('strong', null, 'Come back to this app '), '(switch back, or open it from the Home Screen).'),
        h('li', null, h('strong', null, 'Use it: '), 'tap ', h('em', null, 'Paste image'), ' if you copied it, or ', h('em', null, 'Choose from Photos / Files'), ' if you saved it.')),
      clip, h('button', { class: 'btn primary block', id: 'cover-paste-image', onclick: () => pasteFromClipboard() }, '📋  Paste image'),
      h('button', { class: 'btn block', id: 'cover-choose-file', onclick: () => document.querySelector('#cover-file-2').click() }, '🖼️  Choose from Photos / Files'),
      pasteBox(), h('p', { class: 'muted small' }, 'You can also share an image to this app from Safari or Chrome (Share → this app) once it is installed on your Home Screen / Android.'), fileInput());
    watchClipboard(clip);
  }
  function fileInput() { const file = h('input', { type: 'file', accept: 'image/*', id: 'cover-file-2', hidden: true }); file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; if (f) { try { await finish(f, 'device'); } catch (e) { toast(e.message, 5000); } } }); return file; }
  /** A field you can long-press → Paste into (iOS Safari only allows pasting images that way); also catches Cmd/Ctrl-V anywhere on the sheet. */
  function pasteBox() {
    const box = h('div', { id: 'cover-paste-box', class: 'cover-paste-box', contenteditable: 'true', role: 'textbox', 'aria-label': 'Paste an image here', 'data-ph': 'Or touch and hold here, then choose Paste' });
    box.addEventListener('paste', (e) => { e.preventDefault(); useClip(fromPasteEvent(e)); }); box.addEventListener('input', () => { box.textContent = ''; }); return box;
  }
  async function useClip(c) {
    if (!c) { toast('Nothing usable was copied: copy an image (or its address) first.', 4500); return; }
    try { await finish(c.blob || await fetchImage(c.url), c.blob ? 'clipboard' : 'url'); } catch (e) { toast(e.message, 5000); }
  }
  async function readClipboard() { if (!navigator.clipboard?.read) throw new Error('This browser can’t read the clipboard directly: touch and hold the box below and choose Paste, or use Choose from Photos / Files.'); return fromClipboardItems(await navigator.clipboard.read()); }
  async function pasteFromClipboard() { try { await useClip(await readClipboard()); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Allow pasting when asked, or touch and hold the box below and choose Paste.' : e.message, 6000); } }
  /** Back from the browser: if the clipboard (already permitted) holds an image / address, offer it in one tap. */
  function watchClipboard(slot) {
    const check = async () => {
      if (document.hidden || stage !== 'browser' || !navigator.clipboard?.read) return;
      try { const p = await navigator.permissions?.query({ name: 'clipboard-read' }); if (p && p.state !== 'granted') return; const c = await readClipboard(); if (!c) return;
        slot.replaceChildren(h('button', { class: 'btn primary block', id: 'cover-clip-found', onclick: () => useClip(c) }, c.blob ? '📋  Use the image you copied' : '📋  Use the copied picture address')); } catch { /* not permitted: the Paste button still works */ }
    };
    const on = () => check(); document.addEventListener('visibilitychange', on); window.addEventListener('focus', on); w.cleanups.push(() => { document.removeEventListener('visibilitychange', on); window.removeEventListener('focus', on); }); check();
  }
  async function pasteStep() {
    stage = 'paste'; const input = h('input', { class: 'field', id: 'cover-url', type: 'text', inputmode: 'url', placeholder: 'https://example.com/cover.jpg', autocapitalize: 'none', spellcheck: 'false' }); const err = h('p', { class: 'err small', id: 'cover-url-err' });
    const go = h('button', { class: 'btn primary block', id: 'cover-url-go', onclick: async () => { err.textContent = ''; let u = input.value.trim(); if (!u) return; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; go.disabled = true; go.textContent = 'Fetching…'; try { await finish(await fetchImage(u), 'url'); } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Fetch image'; } } }, 'Fetch image');
    body.replaceChildren(h('button', { class: 'btn-text', onclick: menu }, '‹ Back'), h('button', { class: 'btn primary block', id: 'cover-paste-image', onclick: () => pasteFromClipboard() }, '📋  Paste image'), pasteBox(), h('label', null, 'or an image address (URL)', input), err, go,
      h('p', { class: 'muted small' }, 'Tip: in your browser touch and hold a picture → Copy (or Copy image address). If a site blocks direct downloads the app retries through your proxy.'));
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

/* ---------- Web Share Target: an image shared from Safari / Chrome to this app ---------- */
export async function takeShared() {
  const base = document.baseURI; const meta = await caches.match(new URL('__shared__/meta', base).href); if (!meta) return null;
  const info = await meta.json(); let blob = null; const img = await caches.match(new URL('__shared__/cover', base).href); if (img) blob = await img.blob();
  for (const k of await caches.keys()) { const c = await caches.open(k); await c.delete(new URL('__shared__/cover', base).href); await c.delete(new URL('__shared__/meta', base).href); }
  return blob || info.url ? { blob, url: info.url } : null;
}
/** Asks which book / audiobook the shared image is for, then goes straight to the crop preview. */
export async function handleSharedCover() {
  let sh = null; try { sh = await takeShared(); } catch { /* ignore */ }
  try { const u = new URL(location.href); if (u.searchParams.has('share')) { u.searchParams.delete('share'); history.replaceState(null, '', u.pathname + u.search + u.hash); } } catch { /* ignore */ }
  if (!sh) return false;
  let blob = sh.blob; if (!blob) { try { blob = await fetchImage(sh.url); } catch (e) { toast('Couldn’t download the shared picture: ' + e.message, 6000); return false; } }
  const [books, audios] = await Promise.all([S.getBooks(), A.getAudiobooks()]);
  const items = [...books.map((b) => ({ kind: 'book', b })), ...audios.map((b) => ({ kind: 'audio', b }))].sort((x, y) => x.b.title.localeCompare(y.b.title));
  const url = URL.createObjectURL(blob); const q = h('input', { class: 'field', id: 'share-q', type: 'search', placeholder: 'Find a book or audiobook' }); const list = h('div', { class: 'list', id: 'share-targets' });
  const w = sheet('Use this picture as a cover', () => [h('div', { class: 'center' }, h('img', { src: url, alt: '', id: 'share-preview', style: { maxHeight: '9rem', maxWidth: '100%', borderRadius: '6px' } })), h('p', { class: 'muted small' }, 'Which one is it for?'), q, list], { tall: true, onClose: () => URL.revokeObjectURL(url) });
  const paint = () => { const t = q.value.trim().toLowerCase(); list.replaceChildren(...items.filter((x) => !t || (x.b.title + ' ' + x.b.author).toLowerCase().includes(t)).slice(0, 60).map((x) => h('button', { class: 'list-item share-target', dataset: { kind: x.kind, id: x.b.id }, onclick: () => { w.close(); openCoverEditor(x.kind, x.b.id, { initialBlob: blob, initialSource: 'shared' }); } }, h('span', { class: 'grow' }, (x.kind === 'audio' ? '🎧 ' : '📖 ') + x.b.title, h('small', { class: 'muted' }, x.b.author ? ' · ' + x.b.author : ''))))); if (!list.children.length) list.append(h('p', { class: 'muted small' }, 'No match.')); };
  q.addEventListener('input', paint); paint(); return true;
}

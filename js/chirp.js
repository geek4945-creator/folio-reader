// v0.5.18: Chirp audiobooks. Chirp titles are DRM-protected, so Folio never imports or touches the audio: it keeps a
// library entry (title, author, cover, total length, where you are) that syncs, backs up and pairs with the ebook,
// and opens the Chirp app (or chirpbooks.com) to listen.
//  - iPhone (PWA / Safari): Chirp has no custom URL scheme; its iOS app claims https://www.chirpbooks.com/library* and
//    /player* as universal links, so a real tap on such a link opens the app when it's installed, else the website.
//  - Android app (APK): the native ExternalApp plugin hands the link to com.chirpbooks.chirp (or just launches it), else the browser.
import { h, toast, sheet } from './util.js';
import * as A from './audiostore.js';
import { fmtLong } from './audioplayer.js';

export const CHIRP_PKG = 'com.chirpbooks.chirp';
let plug = null;
function nativePlugin() {
  try { const C = window.Capacitor; if (!(C && C.isNativePlatform && C.isNativePlatform() && C.registerPlugin)) return null; return (plug ||= C.registerPlugin('ExternalApp')); } catch { return null; }
}
/** Open Chirp at url (a chirpbooks.com link). ev: the click on an <a href target=_blank>, whose own navigation is used on the web. */
export function openChirp(url, ev) {
  url = A.cleanChirpUrl(url) || A.CHIRP_HOME; window.__chirpOpened = url;
  const p = nativePlugin();
  if (p) {
    ev?.preventDefault?.();
    p.open({ package: CHIRP_PKG, url }).then((r) => { if (r && r.opened === 'browser') toast('Chirp isn’t installed here, so chirpbooks.com opened in the browser'); })
      .catch(() => { try { window.open(url, '_blank', 'noopener'); } catch { /* nothing else to try */ } });
    return 'native';
  }
  if (!ev) window.open(url, '_blank', 'noopener');   // no anchor: open it ourselves (still inside the tap)
  return 'web';
}
/** A real link (best for iOS universal links: the tap itself is the navigation). */
export function chirpLinkEl(url, { id, label = 'Open in Chirp', cls = 'btn primary block', title } = {}) {
  const u = A.cleanChirpUrl(url) || A.CHIRP_HOME;
  return h('a', { class: cls + ' chirp-link', id, href: u, target: '_blank', rel: 'noopener noreferrer', title: title || 'Opens the Chirp app if it’s installed, otherwise chirpbooks.com', onclick: (e) => openChirp(u, e) }, label);
}

const hm = (s) => ({ hh: Math.floor((s || 0) / 3600), mm: Math.round(((s || 0) % 3600) / 60) });
const pctTxt = (f) => Math.round((f || 0) * 100) + '%';

/** Add (no id) or edit a Chirp entry. */
export function openChirpForm(existing = null, { onDone } = {}) {
  const b = existing || {}; const d = hm(b.duration);
  const title = h('input', { class: 'field', id: 'chirp-title', value: b.title || '', placeholder: 'Title', autocomplete: 'off' });
  const author = h('input', { class: 'field', id: 'chirp-author', value: b.author || '', placeholder: 'Author', autocomplete: 'off' });
  const hh = h('input', { class: 'field', id: 'chirp-h', type: 'number', min: '0', max: '200', inputmode: 'numeric', value: b.duration ? String(d.hh) : '', placeholder: 'h' });
  const mm = h('input', { class: 'field', id: 'chirp-m', type: 'number', min: '0', max: '59', inputmode: 'numeric', value: b.duration ? String(d.mm) : '', placeholder: 'min' });
  const pos = h('input', { type: 'range', id: 'chirp-pos', min: '0', max: '1000', step: '1', value: String(Math.round((b.progress || 0) * 1000)), 'aria-label': 'Where you are' });
  const posTxt = h('span', { class: 'muted small', id: 'chirp-pos-txt' });
  const url = h('input', { class: 'field', id: 'chirp-url', type: 'url', value: b.chirpUrl || '', placeholder: 'https://www.chirpbooks.com/…  (optional)', autocomplete: 'off', inputmode: 'url' });
  const lookup = h('input', { type: 'checkbox', id: 'chirp-lookup', checked: !b.coverBlob });
  const err = h('p', { class: 'plib-warn', id: 'chirp-err', hidden: true });
  const total = () => (Math.max(0, parseInt(hh.value, 10) || 0) * 3600) + (Math.max(0, parseInt(mm.value, 10) || 0) * 60);
  const paint = () => { const t = total(); const f = +pos.value / 1000; posTxt.textContent = t ? `${fmtLong(f * t)} of ${fmtLong(t)} (${pctTxt(f)})` : pctTxt(f) + ' (enter the length to get a time)'; };
  for (const x of [hh, mm, pos]) x.addEventListener('input', paint); paint();
  const w = sheet(existing ? 'Edit Chirp audiobook' : 'Add Chirp audiobook', (close) => [
    h('p', { class: 'muted small' }, 'Chirp audiobooks are copy-protected, so they play in the Chirp app. Folio keeps the title, cover, length and where you are, syncs it, and pairs it with the ebook.'),
    h('label', null, 'Title', title), h('label', null, 'Author', author),
    h('div', { class: 'row-fields' }, h('label', null, 'Length (hours)', hh), h('label', null, 'Minutes', mm)),
    h('label', null, 'Where you are ', posTxt, pos),
    h('label', null, 'Chirp link', url),
    h('label', { class: 'check-row' }, lookup, ' Look up cover and details automatically'),
    err,
    h('button', { class: 'btn primary block', id: 'chirp-save', onclick: async () => {
      err.hidden = true; const t = total(); const p = Math.round((+pos.value / 1000) * t);
      try {
        let rec;
        if (existing) rec = await A.updateChirpAudiobook(existing.id, { title: title.value, author: author.value, duration: t, position: p, chirpUrl: url.value });
        else rec = await A.addChirpAudiobook({ title: title.value, author: author.value, duration: t, position: p, chirpUrl: url.value });
        if (!existing && !t && +pos.value) { rec.progress = +pos.value / 1000; await A.saveAudiobook(rec); }   // no length yet: keep the percentage
        close(); toast(existing ? 'Saved' : 'Added “' + rec.title + '”'); onDone && onDone(rec);
        if (lookup.checked) lookupCover(rec.id, onDone);
      } catch (e) { err.textContent = e.message || String(e); err.hidden = false; }
    } }, existing ? 'Save' : 'Add audiobook')]);
  return w;
}

/** Cover (and missing description / year / language) through the same lookup as "Fix missing info": medium+ confidence only. */
export async function lookupCover(id, onDone) {
  try {
    const E = await import('./enrich.js'); const p = await E.lookupItem({ kind: 'audio', id }); if (!p) return null;
    const accepted = {}; for (const [f, v] of Object.entries(p.fields || {})) if (v && v.conf >= E.MEDIUM) accepted[f] = true;
    if (!Object.keys(accepted).length) { toast('No cover found automatically. Use Change cover to pick one.'); return []; }
    const wrote = await E.applyProposal(p, accepted); if (wrote.includes('cover')) toast('Cover found'); onDone && onDone(); return wrote;
  } catch { return null; }
}

/** Tapping a Chirp entry: where you are, update it, open Chirp, find the spot in the ebook. */
export async function openChirpEntry(id, { onChange } = {}) {
  let b = await A.getAudiobook(id); if (!b) return;
  const cu = b.coverBlob ? URL.createObjectURL(b.coverBlob) : null;
  const pos = h('input', { type: 'range', id: 'chirp-d-pos', min: '0', max: '1000', step: '1', value: String(Math.round((b.status === 'finished' ? 1 : b.progress || 0) * 1000)), 'aria-label': 'Where you are' });
  const posTxt = h('p', { class: 'small', id: 'chirp-d-txt' }); const bar = h('i', { style: { width: '0%' } });
  const paint = () => { const f = +pos.value / 1000; posTxt.textContent = b.duration ? `${fmtLong(f * b.duration)} of ${fmtLong(b.duration)} · ${pctTxt(f)}` : pctTxt(f); bar.style.width = (f * 100).toFixed(1) + '%'; };
  pos.addEventListener('input', paint); paint();
  const w = sheet(b.title, (close) => [
    h('div', { class: 'chirp-entry' }, cu ? h('img', { class: 'chirp-cover', src: cu, alt: '' }) : null,
      h('div', { class: 'grow' }, h('strong', null, b.title), h('div', { class: 'muted' }, b.author || 'Unknown author'), h('span', { class: 'pill-chirp' }, 'Chirp'), ' ', h('span', { class: 'muted small' }, b.duration ? fmtLong(b.duration) : ''))),
    h('div', { class: 'bar chirp-bar' }, bar), posTxt,
    chirpLinkEl(b.chirpUrl, { id: 'chirp-d-open' }),
    h('label', null, 'I’m at…', pos),
    h('button', { class: 'btn block', id: 'chirp-d-save', onclick: async () => { const f = +pos.value / 1000; if (b.duration) b = await A.updateChirpAudiobook(b.id, { position: f * b.duration }); else { b.progress = f; b.lastOpened = Date.now(); if (b.status === 'want' && f) b.status = 'reading'; await A.saveAudiobook(b); } toast('Position saved: ' + pctTxt(f)); onChange && onChange(); } }, 'Save position'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', id: 'chirp-d-findplace', onclick: () => { close(); import('./findplace.js').then((m) => m.openFindPlace({ audioId: b.id })); } }, '📖 Find my place in the ebook'),
      h('button', { class: 'btn', id: 'chirp-d-edit', onclick: () => { close(); openChirpForm(b, { onDone: onChange }); } }, 'Edit…')),
    h('p', { class: 'muted small' }, 'Copy-protected (DRM): listen in the Chirp app, then set where you are here so the ebook can follow.')], { onClose: () => { if (cu) URL.revokeObjectURL(cu); } });
  return w;
}

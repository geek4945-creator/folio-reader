// Online audiobook sources, legal only: LibriVox (public-domain volunteer recordings; JSON API, routed through the proxy when the browser
// blocks it) and the Internet Archive's audio (LibriVox collection + openly licensed audio). Stream (add to library) or download for offline.
import { h, sheet, toast, hashHue, put } from './util.js';
import { fetchSmart, SiteError } from './net.js';
import * as A from './audiostore.js';
import { downloadWithToast, fmtLong } from './audioplayer.js';

const LV = 'https://librivox.org/api/feed/audiobooks';
const IA_SEARCH = 'https://archive.org/advancedsearch.php';
const PAGE = 20;
const strip = (s) => (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, '’').replace(/&nbsp;/g, ' ').trim();
/** LibriVox's listen_url points at www.archive.org, whose first redirect has no CORS headers; the apex host works for downloads. */
export const fixIaUrl = (u) => (u || '').replace(/^http:\/\//i, 'https://').replace(/^https:\/\/www\.archive\.org\//i, 'https://archive.org/');
export const parseLen = (v) => { if (v == null || v === '') return 0; const s = String(v); if (s.includes(':')) return s.split(':').reduce((a, x) => a * 60 + (+x || 0), 0); return +s || 0; };

/* ---------- LibriVox ---------- */
export function mapLibrivox(b) {
  const author = (b.authors || []).map((a) => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', ');
  return { source: 'librivox', sourceKey: 'librivox:' + b.id, title: strip(b.title), author, description: strip(b.description), coverUrl: fixIaUrl(b.coverart_jpg || b.coverart_thumbnail || ''), thumb: fixIaUrl(b.coverart_thumbnail || b.coverart_jpg || ''),
    pageUrl: b.url_librivox || '', license: 'Public domain (LibriVox)', language: b.language || '', totalSecs: +b.totaltimesecs || parseLen(b.totaltime),
    tracks: (b.sections || []).filter((s) => s.listen_url).map((s) => ({ title: strip(s.title) || 'Section ' + s.section_number, url: fixIaUrl(s.listen_url), duration: parseLen(s.playtime) })) };
}
/** LibriVox answers HTTP 404 (not an empty list) when nothing matches — that is "no results", not an error. */
export const isNoResults = (e) => !!e && (e.http === 404 || /Server returned 404/.test(e.message || ''));
export async function searchLibrivox({ q = '', by = 'title', offset = 0 } = {}) {
  const p = new URLSearchParams({ format: 'json', extended: '1', coverart: '1', limit: String(PAGE), offset: String(offset) });
  q = q.replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, ' '); if (q) { if (by === 'author') p.set('author', q.split(/\s+/).pop()); else p.set('title', '^' + q); }
  let r; try { r = await fetchSmart(LV + '?' + p, { timeout: 25000 }); } catch (e) { if (isNoResults(e)) return { items: [], more: false, empty: true }; throw e; }
  const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch { return { items: [], more: false, empty: true }; }   // non-JSON body = nothing matched
  const items = (d.books || []).map(mapLibrivox).filter((x) => x.tracks.length);
  return { items, more: (d.books || []).length >= PAGE, empty: !(d.books || []).length };
}

/* ---------- Internet Archive audio ---------- */
export const IA_AUDIO_QUERY = '(collection:librivoxaudio OR (collection:audio_bookspoetry AND licenseurl:*creativecommons*)) AND mediatype:audio AND -access-restricted-item:true AND -collection:inlibrary AND -collection:printdisabled';
export async function searchIaAudio({ q = '', page = 1 } = {}) {
  const t = q.trim().replace(/["\\]/g, ' ').replace(/[+\-&|!(){}\[\]^~*?:/]/g, ' ').trim();
  const query = t ? `(title:(${t}) OR creator:(${t})) AND ${IA_AUDIO_QUERY}` : IA_AUDIO_QUERY;
  const prm = { q: query, rows: String(PAGE), page: String(page), output: 'json' }; if (!t) prm.sort = 'addeddate desc';
  const u = IA_SEARCH + '?' + new URLSearchParams(prm) + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=runtime&fl[]=licenseurl';
  const d = await (await fetchSmart(u, { timeout: 25000 })).json(); const docs = d.response?.docs || [];
  return { items: docs.map((x) => ({ source: 'ia', sourceKey: 'ia:' + x.identifier, id: x.identifier, title: strip(Array.isArray(x.title) ? x.title[0] : x.title), author: strip(Array.isArray(x.creator) ? x.creator.join(', ') : x.creator || ''), totalSecs: parseLen(x.runtime), thumb: 'https://archive.org/services/img/' + x.identifier, coverUrl: 'https://archive.org/services/img/' + x.identifier, license: x.licenseurl ? 'Open license' : 'Public domain / open (LibriVox)', pageUrl: 'https://archive.org/details/' + x.identifier, tracks: null })),
    more: docs.length >= PAGE };
}
/** Fetch an Internet Archive item's MP3 files (one consistent bitrate, natural order). */
export async function loadIaTracks(item) {
  const d = await (await fetchSmart('https://archive.org/metadata/' + encodeURIComponent(item.id), { timeout: 25000 })).json();
  const md = d.metadata || {}; if (String(md['access-restricted-item']).toLowerCase() === 'true') throw new SiteError('This item is restricted (lending only), so it can’t be added.');
  const files = (d.files || []).filter((f) => /mp3/i.test(f.format || '') || /\.mp3$/i.test(f.name));
  const pick = (re) => files.filter((f) => re.test(f.format || ''));
  let set = pick(/^64kbps mp3$/i); if (!set.length) set = pick(/^vbr mp3$/i); if (!set.length) set = pick(/^128kbps mp3$/i); if (!set.length) set = files.filter((f) => !/_64kb|_128kb|_vbr/i.test(f.name) || true);
  set = set.sort((a, b) => A.naturalSort({ name: a.name }, { name: b.name }));
  if (!set.length) throw new SiteError('No MP3 files found in this item.');
  const lic = md.licenseurl || '';
  return { ...item, description: strip(Array.isArray(md.description) ? md.description.join(' ') : md.description || ''), license: lic ? 'License: ' + lic.replace(/^https?:\/\//, '') : item.license, author: item.author || strip(md.creator || ''),
    tracks: set.map((f, i) => ({ title: strip(f.title || '') || f.name.replace(/\.mp3$/i, '').replace(/_/g, ' '), url: 'https://archive.org/download/' + encodeURIComponent(item.id) + '/' + f.name.split('/').map(encodeURIComponent).join('/'), duration: parseLen(f.length), size: +f.size || 0 })) };
}

/* ---------- UI ---------- */
const fetchCover = async (u) => { const r = await fetchSmart(u, { timeout: 15000 }); const b = await r.blob(); return /^image\//.test(b.type) ? b : null; };
const addedKeys = async () => new Set((await A.getAudiobooks()).map((b) => b.sourceKey).filter(Boolean));

export function openAudioSources() {
  let src = localStorage.getItem('folio.audioSrc') || 'librivox'; let by = 'title'; let q = ''; let offset = 0; let page = 1; let busy = false; let fb = '';   const list = h('div', { class: 'list audio-results', id: 'audio-results' }); const more = h('button', { class: 'btn block', id: 'audio-more', hidden: true }, 'Load more'); const note = h('p', { class: 'muted small', id: 'audio-src-note' });
  const input = h('input', { type: 'search', class: 'field search', id: 'audio-src-q', placeholder: 'Search title or author (leave empty for newest)', enterkeyhint: 'search' });
  const seg = h('div', { class: 'seg wide', id: 'audio-src-seg' }); const bySeg = h('div', { class: 'seg wide', id: 'audio-by-seg' });
  const w = sheet('Free audiobooks', () => [seg, h('form', { onsubmit: (e) => { e.preventDefault(); q = input.value; run(true); } }, input), bySeg, note, list, more], { tall: true });
  const draw = () => {
    seg.replaceChildren(...[['librivox', 'LibriVox'], ['ia', 'Internet Archive']].map(([v, n]) => h('button', { class: src === v ? 'on' : '', 'data-src': v, onclick: () => { src = v; q = input.value; localStorage.setItem('folio.audioSrc', v); draw(); run(true); } }, n)));
    bySeg.hidden = src !== 'librivox'; bySeg.replaceChildren(...[['title', 'By title'], ['author', 'By author']].map(([v, n]) => h('button', { class: by === v ? 'on' : '', 'data-by': v, onclick: () => { by = v; q = input.value; draw(); if (q.trim()) run(true); } }, n)));
    if (!fb || src !== 'librivox') note.textContent = src === 'librivox' ? 'LibriVox: free public-domain audiobooks read by volunteers. Streams from the Internet Archive.' : 'Internet Archive: the LibriVox collection and openly licensed audio. Lending-only and restricted items are left out.';
  };
  async function run(reset) {
    if (busy) return; busy = true; if (reset) { offset = 0; page = 1; list.replaceChildren(h('div', { class: 'spinner-row' }, h('div', { class: 'spinner' }), 'Loading…')); }
    try {
      if (reset) fb = '';
      let r;
      if (src === 'librivox' && !fb) {
        try { r = await searchLibrivox({ q, by, offset }); } catch (e) { if (!reset) throw e; fb = 'down'; r = null; }   // LibriVox itself is down / unreachable: Internet Archive's LibriVox collection instead
        if (r && r.empty && reset && q.trim()) { fb = 'empty'; r = null; }   // nothing starts with that: look for it anywhere in title / author on the Internet Archive
        if (!r) { r = await searchIaAudio({ q, page: 1 }); page = 1; note.textContent = fb === 'down' ? 'LibriVox isn’t answering right now — showing matches from the Internet Archive’s LibriVox collection.' : 'No LibriVox title starts with that — showing Internet Archive matches (title or author contains it).'; }
      } else r = await searchIaAudio({ q, page });
      const have = await addedKeys(); if (reset) list.replaceChildren();
      for (const it of r.items) list.append(row(it, have.has(it.sourceKey)));
      if (reset && !r.items.length) list.append(h('p', { class: 'muted pad' }, 'No audiobooks found. Try a shorter title, or switch source.'));
      offset += PAGE; page += 1; more.hidden = !r.more;
    } catch (e) { if (reset) list.replaceChildren(); list.append(h('div', { class: 'pad' }, h('p', { class: 'err', id: 'audio-src-err' }, e instanceof SiteError ? e.message : 'Couldn’t reach ' + (src === 'librivox' ? 'LibriVox' : 'the Internet Archive') + '. ' + (e.message || '') + ' Check your connection, or the proxy in Settings → Network.'), h('button', { class: 'btn', onclick: () => run(true) }, 'Try again'))); }
    busy = false;
  }
  more.onclick = () => run(false);
  function row(it, already) {
    const hue = hashHue(it.title);
    const addBtn = h('button', { class: 'btn primary small add', 'data-act': 'add', onclick: (e) => { e.stopPropagation(); go(false); } }, already ? '✓ In library' : 'Add');
    const dlBtn = h('button', { class: 'btn small dl', 'data-act': 'offline', onclick: (e) => { e.stopPropagation(); go(true); } }, '⬇ Offline');
    addBtn.disabled = already;
    async function go(offline) {
      addBtn.disabled = dlBtn.disabled = true; const keep = dlBtn.textContent; if (offline) dlBtn.textContent = 'Preparing…'; else addBtn.textContent = 'Adding…';
      try {
        let full = it; if (!full.tracks) full = await loadIaTracks(it);
        let book = (await A.getAudiobooks()).find((b) => b.sourceKey === it.sourceKey);
        if (!book) book = await A.addRemoteAudiobook(full, fetchCover);
        addBtn.textContent = '✓ In library';
        if (offline) { dlBtn.textContent = 'Downloading…'; await downloadWithToast(book.id); dlBtn.textContent = '✓ Offline'; } else { dlBtn.disabled = false; dlBtn.textContent = keep; }
        toast(offline ? 'Added and saved for offline' : 'Added to Audiobooks', 2500);
      } catch (err) { addBtn.disabled = false; dlBtn.disabled = false; addBtn.textContent = 'Add'; dlBtn.textContent = keep; toast(err.message || 'Couldn’t add this audiobook', 6000); }
    }
    return h('div', { class: 'list-item aud-row', dataset: { key: it.sourceKey } },
      h('div', { class: 'aud-thumb', style: { background: `linear-gradient(135deg,hsl(${hue} 45% 38%),hsl(${(hue + 40) % 360} 45% 28%))` } }, it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null),
      h('div', { class: 'grow' }, h('div', { class: 'aud-t clamp2' }, it.title), h('div', { class: 'muted small ellipsis' }, it.author || 'Unknown author'),
        h('div', { class: 'muted small' }, [it.totalSecs ? fmtLong(it.totalSecs) : '', it.tracks ? it.tracks.length + ' parts' : '', it.license].filter(Boolean).join(' · ')), h('div', { class: 'aud-btns' }, addBtn, dlBtn)));
  }
  draw(); run(true); return w;
}

// Tiny, dependency-free audio metadata reader: ID3v2/v1 (+CHAP chapter frames, APIC cover), MP4/M4A/M4B atoms (©nam ©ART ©alb covr,
// Nero 'chpl' chapters and QuickTime chapter text tracks, mvhd duration), Ogg Vorbis/Opus comments + duration, MP3/ADTS duration.
// Everything reads through Blob.slice, so a multi-hundred-MB audiobook is never loaded whole. No DRM is touched: protected
// containers (Audible AAX/AA, iTunes M4P) are only *recognised* so the app can say they can't be imported.
export const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)$/i;
export const DRM_EXT = /\.(aax|aaxc|aa|m4p)$/i;
const dec = (enc, u8) => { try { return new TextDecoder(enc).decode(u8); } catch { return ''; } };
const rd = async (blob, off, len) => new Uint8Array(await blob.slice(off, Math.max(off, off + len)).arrayBuffer());
const be32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
const le32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const be16 = (u, o) => (u[o] << 8) | u[o + 1];
const be64 = (u, o) => be32(u, o) * 4294967296 + be32(u, o + 4);
const ascii = (u, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u[o + i]); return s; };
const synch = (u, o) => ((u[o] & 0x7f) << 21) | ((u[o + 1] & 0x7f) << 14) | ((u[o + 2] & 0x7f) << 7) | (u[o + 3] & 0x7f);
const clean = (s) => (s || '').replace(/\u0000+$/g, '').replace(/^\uFEFF/, '').trim();

/** Sniff the container from the first bytes (extension only as a last resort). */
export function sniffKind(head, name = '') {
  const s4 = ascii(head, 0, 4);
  if (s4 === 'ID3\u0003' || s4.startsWith('ID3')) return 'mp3';
  if (ascii(head, 4, 4) === 'ftyp') return 'mp4';
  if (s4 === 'OggS') return 'ogg'; if (s4 === 'fLaC') return 'flac'; if (s4 === 'RIFF') return 'wav';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return (head[1] & 0x06) === 0 ? 'aac' : 'mp3';
  if (head[4] === 0x57 && head[5] === 0x90 && head[6] === 0x75 && head[7] === 0x36) return 'aa';   // Audible .aa
  const e = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return ({ mp3: 'mp3', m4a: 'mp4', m4b: 'mp4', aac: 'aac', ogg: 'ogg', oga: 'ogg', opus: 'ogg', flac: 'flac', wav: 'wav' })[e] || null;
}

export async function readAudioMeta(blob, name = '') {
  const head = await rd(blob, 0, 16); const kind = sniffKind(head, name);
  const meta = { kind, title: '', artist: '', albumArtist: '', album: '', track: 0, cover: null, duration: null, chapters: [], drm: false };
  try {
    if (kind === 'aa') meta.drm = 'Audible';
    else if (kind === 'mp3') await readMp3(blob, meta);
    else if (kind === 'mp4') await readMp4(blob, meta);
    else if (kind === 'ogg') await readOgg(blob, meta);
    else if (kind === 'aac') meta.duration = await adtsDuration(blob);
  } catch (e) { meta.error = e.message; }
  meta.title = clean(meta.title); meta.artist = clean(meta.artist); meta.album = clean(meta.album); meta.albumArtist = clean(meta.albumArtist);
  return meta;
}

/* ============================== ID3 / MP3 ============================== */
const TEXT = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumArtist', TP2: 'albumArtist', TALB: 'album', TAL: 'album', TRCK: 'track', TRK: 'track', TLEN: 'tlen', TLE: 'tlen' };
function decodeText(enc, u) {
  if (enc === 1) { if (u[0] === 0xfe && u[1] === 0xff) return dec('utf-16be', u.subarray(2)); if (u[0] === 0xff && u[1] === 0xfe) return dec('utf-16le', u.subarray(2)); return dec('utf-16le', u); }
  if (enc === 2) return dec('utf-16be', u); if (enc === 3) return dec('utf-8', u); return dec('windows-1252', u);
}
/** index of the string terminator for encoding `enc` starting at `from` (2 bytes for UTF-16) and its width */
function term(u, from, enc) {
  if (enc === 1 || enc === 2) { for (let i = from; i + 1 < u.length; i += 2) if (u[i] === 0 && u[i + 1] === 0) return [i, 2]; return [u.length, 2]; }
  for (let i = from; i < u.length; i++) if (u[i] === 0) return [i, 1]; return [u.length, 1];
}
function unsync(u) { const o = []; for (let i = 0; i < u.length; i++) { o.push(u[i]); if (u[i] === 0xff && u[i + 1] === 0) i++; } return Uint8Array.from(o); }

/** Parse a run of ID3v2 frames (also used for the sub-frames inside CHAP). */
function frames(u, ver, out, chapters, depth = 0) {
  let p = 0; const idLen = ver === 2 ? 3 : 4; const hdr = ver === 2 ? 6 : 10;
  while (p + hdr <= u.length && u[p] !== 0) {
    const id = ascii(u, p, idLen);
    const size = ver === 2 ? (u[p + 3] << 16) | (u[p + 4] << 8) | u[p + 5] : ver === 4 ? synch(u, p + 4) : be32(u, p + 4);
    const flags = ver === 2 ? 0 : be16(u, p + 8);
    let body = u.subarray(p + hdr, p + hdr + size); p += hdr + size;
    if (size <= 0 || p > u.length + 0) { if (size <= 0) continue; }
    if (ver === 4) { if (flags & 0x01) body = body.subarray(4); if (flags & 0x02) body = unsync(body); }
    if (ver === 3 && (flags & 0x0080)) continue;   // compressed frames: skip
    if (TEXT[id] && body.length) {
      const t = decodeText(body[0], body.subarray(1)).split('\u0000').map(clean).filter(Boolean);
      const k = TEXT[id]; if (!t.length) continue;
      if (k === 'track') out.track = parseInt(t[0], 10) || 0; else if (k === 'tlen') out.tlen = (+t[0] || 0) / 1000; else if (!out[k]) out[k] = k === 'artist' ? t.join(', ') : t[0];
    } else if ((id === 'APIC' || id === 'PIC') && body.length > 4) {
      const enc = body[0]; let q = 1; let mime;
      if (id === 'PIC') { const f = ascii(body, 1, 3).toLowerCase(); mime = f === 'png' ? 'image/png' : 'image/jpeg'; q = 4; }
      else { const [e] = term(body, 1, 0); mime = ascii(body, 1, e - 1) || 'image/jpeg'; if (mime === 'image/jpg') mime = 'image/jpeg'; q = e + 1; }
      const type = body[q]; q++; const [de, dw] = term(body, q, enc); const data = body.subarray(de + dw);
      if (data.length > 16 && (!out.coverType || (type === 3 && out.coverType !== 3))) { out.cover = new Blob([data.slice()], { type: /^image\//.test(mime) ? mime : 'image/jpeg' }); out.coverType = type; }
    } else if (id === 'CHAP' && depth === 0 && body.length > 16) {
      const [e] = term(body, 0, 0); const start = be32(body, e + 1) / 1000; const sub = {};
      frames(body.subarray(e + 1 + 16), ver, sub, null, 1); chapters.push({ title: sub.title || '', start });
    }
  }
}
async function readId3(blob, meta) {
  const h = await rd(blob, 0, 10); if (ascii(h, 0, 3) !== 'ID3') return 0;
  const ver = h[3]; const flags = h[5]; const size = synch(h, 6); const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (ver < 2 || ver > 4) return total;
  let body = await rd(blob, 10, size);
  if (flags & 0x80 && ver < 4) body = unsync(body);
  if (flags & 0x40 && ver >= 3) { const ex = ver === 4 ? synch(body, 0) : be32(body, 0) + 4; body = body.subarray(ex); }
  const chapters = []; const out = {}; frames(body, ver, out, chapters);
  Object.assign(meta, { title: out.title || '', artist: out.artist || '', albumArtist: out.albumArtist || '', album: out.album || '', track: out.track || 0, cover: out.cover || null });
  if (out.tlen) meta.tlen = out.tlen;
  meta.chapters = chapters.sort((a, b) => a.start - b.start);
  return total;
}
const BR = { 11: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 12: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 13: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  21: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 22: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Frame(u, o) {
  if (u[o] !== 0xff || (u[o + 1] & 0xe0) !== 0xe0) return null;
  const v = (u[o + 1] >> 3) & 3, l = (u[o + 1] >> 1) & 3, bi = u[o + 2] >> 4, si = (u[o + 2] >> 2) & 3;
  if (v === 1 || l === 0 || bi === 0 || bi === 15 || si === 3) return null;
  const layer = 4 - l; const kbps = (BR[(v === 3 ? 1 : 2) * 10 + layer] || BR[22])[bi];
  const rate = SR[v][si]; const mono = (u[o + 3] >> 6) === 3;
  const spf = layer === 1 ? 384 : layer === 2 ? 1152 : (v === 3 ? 1152 : 576);
  return { v, layer, kbps, rate, mono, spf };
}
async function readMp3(blob, meta) {
  const start = await readId3(blob, meta);
  let tail = await rd(blob, Math.max(0, blob.size - 128), 128);
  let end = blob.size;
  if (tail.length === 128 && ascii(tail, 0, 3) === 'TAG') {
    end -= 128;
    if (!meta.title) { meta.title = dec('windows-1252', tail.subarray(3, 33)); meta.artist = meta.artist || dec('windows-1252', tail.subarray(33, 63)); meta.album = meta.album || dec('windows-1252', tail.subarray(63, 93)); }
  }
  const buf = await rd(blob, start, 65536); let o = 0; let f = null;
  for (; o < buf.length - 4; o++) { f = mp3Frame(buf, o); if (f) break; }
  if (!f) { if (meta.tlen) meta.duration = meta.tlen; return; }
  const side = f.v === 3 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
  const x = o + 4 + side; const tag = ascii(buf, x, 4);
  if ((tag === 'Xing' || tag === 'Info') && (buf[x + 7] & 1)) meta.duration = be32(buf, x + 8) * f.spf / f.rate;
  else if (ascii(buf, o + 4 + 32, 4) === 'VBRI') meta.duration = be32(buf, o + 4 + 32 + 14) * f.spf / f.rate;
  else meta.duration = (end - start - o) * 8 / (f.kbps * 1000);
  if (!(meta.duration > 0) && meta.tlen) meta.duration = meta.tlen;
}

/* ============================== ADTS AAC ============================== */
const ADTS_SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
async function adtsDuration(blob) {
  let off = 0; let frames = 0; let rate = 0; const CH = 4 * 1024 * 1024;
  while (off < blob.size) {
    const buf = await rd(blob, off, CH); let p = 0;
    while (p + 7 <= buf.length) {
      if (buf[p] !== 0xff || (buf[p + 1] & 0xf0) !== 0xf0) { p++; if (!frames && p > 4096) return null; continue; }
      const len = ((buf[p + 3] & 3) << 11) | (buf[p + 4] << 3) | (buf[p + 5] >> 5); if (len < 7) { p++; continue; }
      if (!rate) rate = ADTS_SR[(buf[p + 2] >> 2) & 15]; frames++; p += len;
    }
    off += p; if (p === 0) break;
  }
  return rate && frames ? frames * 1024 / rate : null;
}

/* ============================== MP4 / M4A / M4B ============================== */
function boxes(u, from = 0, to = u.length) {
  const out = []; let p = from;
  while (p + 8 <= to) {
    let size = be32(u, p); const type = ascii(u, p + 4, 4); let hdr = 8;
    if (size === 1) { size = be64(u, p + 8); hdr = 16; } else if (size === 0) size = to - p;
    if (size < hdr || p + size > to + 0) { if (size < hdr) break; size = to - p; }
    out.push({ type, start: p, body: p + hdr, end: p + size }); p += size;
  }
  return out;
}
const find = (u, list, ...path) => { let cur = list; let b = null; for (const t of path) { b = cur.find((x) => x.type === t); if (!b) return null; cur = boxes(u, b.body, b.end); } return b; };
const kids = (u, b, skip = 0) => boxes(u, b.body + skip, b.end);
const hasBytes = (u, str) => { const n = str.length; outer: for (let i = 0; i + n <= u.length; i++) { for (let j = 0; j < n; j++) if (u[i + j] !== str.charCodeAt(j)) continue outer; return true; } return false; };

async function readMp4(blob, meta) {
  const head = await rd(blob, 0, 32); const brand = ascii(head, 8, 4);
  if (/^aax/i.test(brand)) { meta.drm = 'Audible'; return; }
  if (brand === 'M4P ') { meta.drm = 'iTunes'; return; }
  // top-level box scan (headers only) to find moov
  let off = 0; let moov = null;
  while (off + 8 <= blob.size) {
    const h = await rd(blob, off, 16); let size = be32(h, 0); const type = ascii(h, 4, 4);
    if (size === 1) size = be64(h, 8); else if (size === 0) size = blob.size - off;
    if (type === 'moov') { moov = { start: off, size }; break; }
    if (size < 8) break; off += size;
  }
  if (!moov) return;
  const m = await rd(blob, moov.start, Math.min(moov.size, 64 * 1024 * 1024));
  if (hasBytes(m, 'drms') || hasBytes(m, 'aavd') || hasBytes(m, 'enca')) { meta.drm = 'copy-protected'; return; }
  const top = boxes(m, 8, m.length);
  const mvhd = top.find((b) => b.type === 'mvhd');
  let timescale = 1000;
  if (mvhd) { const v = m[mvhd.body]; timescale = v === 1 ? be32(m, mvhd.body + 20) : be32(m, mvhd.body + 12); meta.duration = (v === 1 ? be64(m, mvhd.body + 24) : be32(m, mvhd.body + 16)) / (timescale || 1000); }
  const ilst = find(m, top, 'udta', 'meta') && (() => { const meta2 = find(m, top, 'udta', 'meta'); return kids(m, meta2, 4).find((b) => b.type === 'ilst'); })();
  if (ilst) for (const it of kids(m, ilst)) {
    const d = kids(m, it).find((b) => b.type === 'data'); if (!d) continue; const flags = be32(m, d.body) & 0xffffff; const val = m.subarray(d.body + 8, d.end);
    if (it.type === '\u00a9nam') meta.title = dec('utf-8', val); else if (it.type === '\u00a9ART') meta.artist = dec('utf-8', val); else if (it.type === 'aART') meta.albumArtist = dec('utf-8', val);
    else if (it.type === '\u00a9alb') meta.album = dec('utf-8', val); else if (it.type === 'trkn' && val.length >= 4) meta.track = be16(val, 2);
    else if (it.type === 'covr' && val.length > 16 && !meta.cover) meta.cover = new Blob([val.slice()], { type: flags === 14 ? 'image/png' : 'image/jpeg' });
  }
  // chapters: Nero chpl first, then a QuickTime chapter text track
  const chpl = find(m, top, 'udta', 'chpl');
  if (chpl) {
    const ver = m[chpl.body]; let p = chpl.body + 4; if (ver === 1) p += 4; const n = m[p++];
    for (let i = 0; i < n && p + 9 <= chpl.end; i++) { const start = be64(m, p) / 1e7; const len = m[p + 8]; meta.chapters.push({ title: clean(dec('utf-8', m.subarray(p + 9, p + 9 + len))), start }); p += 9 + len; }
  }
  if (!meta.chapters.length) meta.chapters = await qtChapters(blob, m, top);
  meta.chapters.sort((a, b) => a.start - b.start);
  if (meta.duration) meta.chapters = meta.chapters.filter((c) => c.start < meta.duration);
}
async function qtChapters(blob, m, top) {
  const traks = top.filter((b) => b.type === 'trak'); const info = traks.map((t) => {
    const k = kids(m, t); const tkhd = k.find((b) => b.type === 'tkhd'); const id = tkhd ? be32(m, tkhd.body + (m[tkhd.body] === 1 ? 20 : 12)) : 0;
    const tref = k.find((b) => b.type === 'tref'); const chap = tref && kids(m, tref).find((b) => b.type === 'chap');
    return { t, k, id, chapRef: chap ? be32(m, chap.body) : 0 };
  });
  const ref = info.find((x) => x.chapRef); if (!ref) return [];
  const tx = info.find((x) => x.id === ref.chapRef); if (!tx) return [];
  const mdia = tx.k.find((b) => b.type === 'mdia'); if (!mdia) return [];
  const mk = kids(m, mdia); const mdhd = mk.find((b) => b.type === 'mdhd'); const minf = mk.find((b) => b.type === 'minf'); const stbl = minf && kids(m, minf).find((b) => b.type === 'stbl');
  if (!mdhd || !stbl) return [];
  const ts = be32(m, mdhd.body + (m[mdhd.body] === 1 ? 20 : 12)) || 1000; const sk = kids(m, stbl); const get = (t) => sk.find((b) => b.type === t);
  const stts = get('stts'), stsz = get('stsz'), stco = get('stco') || get('co64'), stsc = get('stsc'); if (!stts || !stsz || !stco || !stsc) return [];
  const n = be32(m, stsz.body + 8); const fixed = be32(m, stsz.body + 4); const sizes = []; for (let i = 0; i < n; i++) sizes.push(fixed || be32(m, stsz.body + 12 + 4 * i));
  const big = stco.type === 'co64'; const nco = be32(m, stco.body + 4); const cos = []; for (let i = 0; i < nco; i++) cos.push(big ? be64(m, stco.body + 8 + 8 * i) : be32(m, stco.body + 8 + 4 * i));
  const nsc = be32(m, stsc.body + 4); const sc = []; for (let i = 0; i < nsc; i++) sc.push({ first: be32(m, stsc.body + 8 + 12 * i), per: be32(m, stsc.body + 12 + 12 * i) });
  const offs = []; let s = 0;
  for (let c = 0; c < cos.length && s < n; c++) { let per = 1; for (const e of sc) if (e.first <= c + 1) per = e.per; let o = cos[c]; for (let j = 0; j < per && s < n; j++, s++) { offs.push(o); o += sizes[s]; } }
  const nt = be32(m, stts.body + 4); const starts = []; let t = 0;
  for (let i = 0; i < nt; i++) { const cnt = be32(m, stts.body + 8 + 8 * i), dur = be32(m, stts.body + 12 + 8 * i); for (let j = 0; j < cnt; j++) { starts.push(t / ts); t += dur; } }
  const out = [];
  for (let i = 0; i < Math.min(n, offs.length, starts.length, 5000); i++) {
    const raw = await rd(blob, offs[i], sizes[i]); if (raw.length < 2) continue; const len = be16(raw, 0); let b = raw.subarray(2, 2 + len);
    const title = clean((b[0] === 0xfe && b[1] === 0xff) ? dec('utf-16be', b.subarray(2)) : (b[0] === 0xff && b[1] === 0xfe) ? dec('utf-16le', b.subarray(2)) : dec('utf-8', b));
    out.push({ title, start: starts[i] });
  }
  return out;
}

/* ============================== Ogg ============================== */
async function readOgg(blob, meta) {
  const head = await rd(blob, 0, 65536); let rate = 0;
  const vi = (() => { for (let i = 0; i < Math.min(head.length - 20, 400); i++) if (head[i] === 1 && ascii(head, i + 1, 6) === 'vorbis') return i; return -1; })();
  if (vi >= 0) rate = le32(head, vi + 12);
  else if (hasBytes(head.subarray(0, 400), 'OpusHead')) rate = 48000;
  const ci = (() => { for (let i = 0; i < head.length - 20; i++) if (head[i] === 3 && ascii(head, i + 1, 6) === 'vorbis') return i + 7; if (hasBytes(head, 'OpusTags')) { for (let i = 0; i < head.length - 8; i++) if (ascii(head, i, 8) === 'OpusTags') return i + 8; } return -1; })();
  if (ci >= 0) {
    let p = ci; const vl = le32(head, p); p += 4 + vl; const n = le32(head, p); p += 4;
    for (let i = 0; i < n && p + 4 < head.length; i++) {
      const l = le32(head, p); p += 4; const kv = dec('utf-8', head.subarray(p, p + l)); p += l; const eq = kv.indexOf('='); if (eq < 0) continue;
      const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1);
      if (k === 'TITLE') meta.title = v; else if (k === 'ARTIST') meta.artist = v; else if (k === 'ALBUMARTIST') meta.albumArtist = v; else if (k === 'ALBUM') meta.album = v; else if (k === 'TRACKNUMBER') meta.track = parseInt(v, 10) || 0;
    }
  }
  const tail = await rd(blob, Math.max(0, blob.size - 65536), 65536); let last = -1;
  for (let i = tail.length - 14; i >= 0; i--) if (tail[i] === 0x4f && ascii(tail, i, 4) === 'OggS') { last = i; break; }
  if (last >= 0 && rate) { const g = le32(tail, last + 6) + le32(tail, last + 10) * 4294967296; if (g > 0) meta.duration = g / rate; }
}

/** Last resort: ask the browser. Resolves to seconds or null. */
export function probeDuration(blob, timeout = 8000) {
  return new Promise((res) => {
    const a = new Audio(); const url = URL.createObjectURL(blob); let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(url); res(v); };
    const t = setTimeout(() => fin(null), timeout);
    a.preload = 'metadata'; a.onloadedmetadata = () => fin(isFinite(a.duration) && a.duration > 0 ? a.duration : null); a.onerror = () => fin(null); a.src = url;
  });
}

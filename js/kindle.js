// Kindle-format import (.mobi / .azw / .azw3 / .kf8): DRM-free files are converted to EPUB in the browser, so every
// existing feature (themes, per-book font/margins, shelves, sets, sync) works unchanged. Parsing is done by the vendored
// foliate-js MOBI/KF8 parser (vendor/foliate-mobi.js, MIT). Copy-protected files are detected and REFUSED with a friendly
// message; there is no DRM handling of any kind in this app.
import { MOBI } from '../vendor/foliate-mobi.js';

export const KINDLE_EXT_RE = /\.(mobi|azw3?|kf8)$/i;
export const KINDLE_TYPE_RE = /mobipocket|x-mobi8|vnd\.amazon\.(ebook|mobi)|x-kindle/i;
export const KINDLE_ACCEPT = '.mobi,.azw,.azw3,.kf8,application/x-mobipocket-ebook,application/vnd.amazon.ebook';

export class KindleError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
export const DRM_MESSAGE = 'This Kindle book is copy-protected (DRM), so Folio can’t import it. Folio only opens DRM-free books. Look for a DRM-free copy (such as an EPUB) from where you got the book.';
const KFX_MESSAGE = 'This is Amazon’s newer KFX/Topaz format, which is copy-protected, so Folio can’t import it. A DRM-free EPUB, MOBI or AZW3 file will work.';

const ascii = (u8, a, b) => String.fromCharCode(...u8.subarray(a, b));

/** Cheap sniff of the raw bytes. Returns null (not a Kindle file) or { kind: 'mobi'|'kfx', drm }. */
export function detectKindle(buffer) {
  const u8 = new Uint8Array(buffer); if (u8.length < 80) return null;
  if (u8[0] === 0x50 && u8[1] === 0x4b) return null;            // zip → EPUB (or KFX-zip, handled by the caller)
  const head4 = ascii(u8, 0, 4);
  if (head4 === 'CONT' || head4 === 'TPZ0' || head4 === 'TPZ1' || head4 === 'TPZ2' || head4 === 'TPZ3' || head4 === '\xEA\xDD\xDE\xAD') return { kind: 'kfx', drm: true };
  if (ascii(u8, 60, 68) !== 'BOOKMOBI') return null;
  const dv = new DataView(buffer.buffer ? buffer.buffer : buffer, u8.byteOffset, u8.byteLength);
  const numRecords = dv.getUint16(76);
  const recOffset = (i) => (i < numRecords ? dv.getUint32(78 + i * 8) : 0xffffffff);
  const protectedAt = (off) => {
    if (off + 0xb4 > u8.length) return false;
    const encryption = dv.getUint16(off + 12);                    // PalmDOC header: 0 = none, 1/2 = Mobipocket encryption
    if (ascii(u8, off + 16, off + 20) !== 'MOBI') return false;
    const drmOffset = dv.getUint32(off + 0xa8), drmCount = dv.getUint32(off + 0xac);
    return encryption !== 0 || (drmOffset !== 0xffffffff && drmCount > 0);
  };
  const r0 = recOffset(0);
  let drm = protectedAt(r0);
  if (!drm) {   // combo MOBI + KF8 files carry a second header at the KF8 boundary record (EXTH 121)
    try {
      const mobiLen = dv.getUint32(r0 + 20), exthFlag = dv.getUint32(r0 + 128);
      if (exthFlag & 0x40) {
        let p = r0 + 16 + mobiLen; const count = dv.getUint32(p + 8); p += 12;
        for (let i = 0; i < count && p + 8 <= u8.length; i++) {
          const type = dv.getUint32(p), len = dv.getUint32(p + 4);
          if (type === 121 && len >= 12) { const b = dv.getUint32(p + 8); if (b < numRecords) drm = protectedAt(recOffset(b)); }
          p += Math.max(len, 8);
        }
      }
    } catch { /* ignore malformed EXTH */ }
  }
  return { kind: 'mobi', drm };
}

/** A zip that holds KFX/Topaz payloads instead of an EPUB. */
export async function looksLikeKfxZip(buffer) {
  try { const z = await JSZip.loadAsync(buffer); return !z.file('META-INF/container.xml') && Object.keys(z.files).some((n) => /\.(kfx|kdf|azw|prc)$|book\.kdf|\.sdr\//i.test(n)); } catch { return false; }
}
export const kfxError = () => new KindleError(KFX_MESSAGE, 'drm');

/* ---------- conversion ---------- */
const unzlib = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = (n) => String(n).padStart(4, '0');
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', bin: 'application/octet-stream' };
function sniff(u8) {
  const s4 = ascii(u8, 0, 4);
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'jpg';
  if (s4 === '\x89PNG') return 'png';
  if (s4 === 'GIF8') return 'gif';
  if (s4 === 'RIFF' && ascii(u8, 8, 12) === 'WEBP') return 'webp';
  if (s4 === 'OTTO') return 'otf';
  if (s4 === 'wOFF') return 'woff'; if (s4 === 'wOF2') return 'woff2';
  if (s4 === '\x00\x01\x00\x00' || s4 === 'true') return 'ttf';
  if (ascii(u8, 4, 8) === 'ftyp') return 'mp4';
  if (s4.startsWith('ID3') || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0)) return 'mp3';
  const t = new TextDecoder().decode(u8.subarray(0, 600));
  if (/<svg[\s>]/i.test(t)) return 'svg';
  if (/[{}]/.test(t) || /@(import|font-face|charset)/.test(t)) return 'css';
  return 'bin';
}
const sniffBlob = async (blob) => sniff(new Uint8Array(await blob.slice(0, 600).arrayBuffer()));

/** Parse as (forgiving) HTML, drop anything that XML can't represent, serialise as well-formed XHTML. */
function cleanDoc(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const okName = /^[A-Za-z_][\w.-]*$/;
  for (const el of [...doc.querySelectorAll('*')]) {
    if (el.namespaceURI === XHTML_NS && !okName.test(el.localName)) {   // <mbp:nu>, <o:p> … → unwrap
      el.replaceWith(...el.childNodes); continue;
    }
    for (const a of [...el.attributes]) {
      const n = a.name;
      if (!/^[A-Za-z_][\w.-]*$/.test(n) && !/^(xlink|xml):[A-Za-z]+$/.test(n)) el.removeAttribute(n);
      else if (/^on/i.test(n)) el.removeAttribute(n);
    }
  }
  for (const m of doc.querySelectorAll('meta[http-equiv]')) m.remove();
  for (const s of doc.querySelectorAll('script')) s.remove();
  if (!doc.head.querySelector('title')) { const t = doc.createElement('title'); t.textContent = ' '; doc.head.prepend(t); }
  return doc;
}

const SERIES_RES = [
  /\(\s*([^()]+?)\s*(?:,|:|-|–)?\s*(?:Book|Vol(?:ume)?\.?|Part|No\.?|#)\s*(\d+(?:\.\d+)?)\s*\)\s*$/i,
  /\(\s*([^()#]+?)\s*#\s*(\d+(?:\.\d+)?)\s*\)\s*$/,
];
/** Some stores bake the series into the title, e.g. "Dune (Dune Chronicles, Book 1)". */
export function guessSeries(title) {
  for (const re of SERIES_RES) { const m = String(title || '').match(re); if (m && m[1].length > 1) return { series: m[1].trim(), seriesIndex: parseFloat(m[2]), title: String(title).replace(re, '').trim() || title }; }
  return null;
}

/**
 * Convert a DRM-free MOBI/AZW/AZW3/KF8 file to an EPUB.
 * @returns {Promise<{ buffer: ArrayBuffer, title: string, kind: 'mobi'|'kf8' }>}
 */
export async function kindleToEpub(input, { filename = '' } = {}) {
  const buf0 = input instanceof ArrayBuffer ? input : await new Blob([input]).arrayBuffer();
  const det = detectKindle(buf0);
  if (!det) throw new KindleError('This is not a Kindle (MOBI/AZW3) file.', 'format');
  if (det.kind === 'kfx') throw kfxError();
  if (det.drm) throw new KindleError(DRM_MESSAGE, 'drm');

  let book;
  try { book = await new MOBI({ unzlib }).open(new Blob([buf0])); }
  catch (e) { throw new KindleError('Folio couldn’t read this Kindle file (' + (e.message || 'unsupported or damaged') + ').', 'parse'); }
  const kf8 = !!book.mobi.headers.kf8 && book.mobi.headers.mobi.version >= 8;
  try {
    return await build(book, filename, kf8);
  } finally { try { book.destroy(); } catch { /* ignore */ } }
}

async function build(book, filename, kf8) {
  const md = book.metadata || {};
  const baseName = filename.replace(/\.[^.]+$/, '');
  const rawTitle = (md.title || '').trim() || baseName || 'Untitled';
  const gs = guessSeries(rawTitle);
  const title = gs ? gs.title : rawTitle;
  const authors = [].concat(md.author || []).map((a) => String(a).trim()).filter(Boolean);

  /* 1. load + clean every section */
  const secs = [];   // { index, name, doc }
  const byIndex = new Map();
  for (let i = 0; i < book.sections.length; i++) {
    const s = book.sections[i]; if (!s.load) continue;
    const html = await (await fetch(await s.load())).text();
    const doc = cleanDoc(html);
    const rec = { index: i, name: 's' + pad(secs.length + 1) + '.xhtml', doc };
    secs.push(rec); byIndex.set(i, rec);
  }
  if (!secs.length) throw new KindleError('This Kindle file has no readable text.', 'parse');

  /* 2. internal links → relative EPUB links */
  let anchorN = 0;
  const resolve = async (href) => {
    try {
      const r = await book.resolveHref(href); if (!r || r.index == null || r.index < 0) return null;
      const tgt = byIndex.get(r.index); if (!tgt) return null;
      let el = null; try { el = r.anchor?.(tgt.doc); } catch { /* bad selector */ }
      if (el) { if (!el.getAttribute('id')) el.setAttribute('id', 'fo' + (++anchorN)); return tgt.name + '#' + el.getAttribute('id'); }
      return tgt.name;
    } catch { return null; }
  };
  for (const sec of secs) {
    for (const a of sec.doc.querySelectorAll('a[href], area[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^(filepos|kindle):/i.test(href)) { const t = await resolve(href); if (t) a.setAttribute('href', t); else a.removeAttribute('href'); }
      else if (!/^(https?:|mailto:|#)/i.test(href) && !/^blob:/.test(href)) a.removeAttribute('href');
    }
    for (const a of sec.doc.querySelectorAll('a[filepos]')) a.removeAttribute('filepos');
  }

  /* 3. table of contents */
  const tocItems = async (items) => {
    const out = [];
    for (const it of items || []) {
      const t = await resolve(it.href);
      const kids = await tocItems(it.subitems);
      if (t || kids.length) out.push({ label: String(it.label || '').trim() || 'Untitled', href: t || kids[0].href, kids });
    }
    return out;
  };
  let toc = await tocItems(book.toc);
  if (!toc.length) toc = [{ label: title, href: secs[0].name, kids: [] }];

  /* 4. collect blob: resources (images, css, fonts) into real files */
  const assets = new Map();   // blobUrl → { name, ext, mime, data(Blob|string) }
  const files = new Map();    // name → Blob | string
  const rewrite = async (text) => {
    const urls = [...new Set(text.match(/blob:[^\s"'()<>]+/g) || [])];
    for (const u of urls) {
      if (!assets.has(u)) {
        try {
          const blob = await (await fetch(u)).blob(); const ext = await sniffBlob(blob);
          const rec = { name: 'r' + pad(assets.size + 1) + '.' + ext, ext, mime: MIME_BY_EXT[ext] };
          assets.set(u, rec);
          files.set(rec.name, ext === 'css' ? await rewrite(await blob.text()) : blob);   // css may reference fonts / images
        } catch { assets.set(u, { name: 'missing.bin', ext: 'bin', mime: MIME_BY_EXT.bin, missing: true }); }
      }
    }
    return text.replace(/blob:[^\s"'()<>]+/g, (u) => assets.get(u)?.name || '');
  };
  const ser = new XMLSerializer();
  for (const sec of secs) {
    let xml = ser.serializeToString(sec.doc);
    xml = await rewrite(xml);
    if (!xml.includes('xmlns=')) xml = xml.replace(/<html/, `<html xmlns="${XHTML_NS}"`);
    sec.xml = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' + xml;
  }

  /* 5. cover */
  let coverName = null;
  try {
    const cb = await book.getCover?.();
    if (cb && cb.size > 200) { const ext = await sniffBlob(cb); if (['jpg', 'png', 'gif', 'webp'].includes(ext)) { coverName = 'cover.' + ext; files.set(coverName, cb); } }
  } catch { /* no cover */ }

  /* 6. package */
  const ident = md.identifier ? 'mobi:' + md.identifier : 'mobi:' + (title + authors.join()).toLowerCase().replace(/\W+/g, '-');
  const lang = (md.language && /^[A-Za-z-]{2,}$/.test(md.language)) ? md.language : 'en';
  const navLis = (items) => '<ol>' + items.map((t) => `<li><a href="${esc(t.href)}">${esc(t.label)}</a>${t.kids.length ? navLis(t.kids) : ''}</li>`).join('') + '</ol>';
  const nav = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1>${navLis(toc)}</nav></body></html>`;
  const usedAssets = new Set([...assets.values()].filter((a) => !a.missing).map((a) => a.name));
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...secs.map((s, i) => `<item id="s${i + 1}" href="${s.name}" media-type="application/xhtml+xml"${/<svg[\s>]/.test(s.xml) ? ' properties="svg"' : ''}/>`),
    ...[...usedAssets].map((n, i) => `<item id="a${i + 1}" href="${n}" media-type="${MIME_BY_EXT[n.split('.').pop()]}"/>`),
    ...(coverName ? [`<item id="cover-image" href="${coverName}" media-type="${MIME_BY_EXT[coverName.split('.').pop()]}" properties="cover-image"/>`] : []),
  ];
  const meta = [
    `<dc:identifier id="bookid">${esc(ident)}</dc:identifier>`, `<dc:title>${esc(title)}</dc:title>`,
    ...(authors.length ? authors.map((a) => `<dc:creator>${esc(a)}</dc:creator>`) : []),
    `<dc:language>${esc(lang)}</dc:language>`,
    ...(md.publisher ? [`<dc:publisher>${esc(md.publisher)}</dc:publisher>`] : []),
    ...(md.description ? [`<dc:description>${esc(md.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())}</dc:description>`] : []),
    ...[].concat(md.subject || []).slice(0, 8).map((s) => `<dc:subject>${esc(s)}</dc:subject>`),
    ...(coverName ? ['<meta name="cover" content="cover-image"/>'] : []),
    ...(gs ? [`<meta name="calibre:series" content="${esc(gs.series)}"/>`, `<meta name="calibre:series_index" content="${gs.seriesIndex}"/>`] : []),
    `<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>`,
  ];
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${meta.join('')}</metadata><manifest>${manifest.join('')}</manifest><spine>${secs.map((_, i) => `<itemref idref="s${i + 1}"/>`).join('')}</spine></package>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', opf); zip.file('OEBPS/nav.xhtml', nav);
  for (const s of secs) zip.file('OEBPS/' + s.name, s.xml);
  for (const [n, d] of files) if (n === coverName || usedAssets.has(n)) zip.file('OEBPS/' + n, d);
  const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
  return { buffer, title, kind: kf8 ? 'kf8' : 'mobi' };
}

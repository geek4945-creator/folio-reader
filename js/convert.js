// v0.5.26: DRM-free FB2 / FB2.ZIP, CBZ (comics) and plain TXT files are converted to a simple EPUB in the browser, so they get every
// Folio feature (themes, fonts, highlights, sync). Nothing leaves the device.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const baseName = (n) => String(n || 'Untitled').replace(/\.(fb2\.zip|fbz|[^.]+)$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const CONVERT_RE = /\.(fb2|fb2\.zip|fbz|cbz|txt)$/i;
const page = (title, body) => `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(title)}</title><style>img{max-width:100%;height:auto}.pg{text-align:center;margin:0;padding:0}</style></head><body>${body}</body></html>`;

/** chapters: [{ title, body (xhtml) }]; images: [{ name, data (Uint8Array|ArrayBuffer), type }] */
export async function makeEpub({ title, author = '', series = '', seriesIndex = null, lang = 'en', chapters, images = [], coverName = '' }) {
  const id = 'urn:folio:' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const secs = chapters.map((c, i) => ({ name: `c${i + 1}.xhtml`, title: c.title || `Part ${i + 1}`, xml: page(c.title || title, c.body) }));
  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...secs.map((s, i) => `<item id="s${i + 1}" href="${s.name}" media-type="application/xhtml+xml"/>`),
    ...images.map((im, i) => `<item id="${im.name === coverName ? 'cover-image' : 'img' + i}" href="${esc(im.name)}" media-type="${im.type}"${im.name === coverName ? ' properties="cover-image"' : ''}/>`)];
  const meta = [`<dc:identifier id="bookid">${id}</dc:identifier>`, `<dc:title>${esc(title)}</dc:title>`, author ? `<dc:creator>${esc(author)}</dc:creator>` : '', `<dc:language>${esc(lang || 'en')}</dc:language>`,
    coverName ? '<meta name="cover" content="cover-image"/>' : '',
    series ? `<meta name="calibre:series" content="${esc(series)}"/>` + (seriesIndex != null ? `<meta name="calibre:series_index" content="${seriesIndex}"/>` : '') : '',
    `<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>`];
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${meta.join('')}</metadata><manifest>${manifest.join('')}</manifest><spine>${secs.map((_, i) => `<itemref idref="s${i + 1}"/>`).join('')}</spine></package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(title)}</title></head><body><nav epub:type="toc"><ol>${secs.map((s) => `<li><a href="${s.name}">${esc(s.title)}</a></li>`).join('')}</ol></nav></body></html>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', opf); zip.file('OEBPS/nav.xhtml', nav);
  for (const s of secs) zip.file('OEBPS/' + s.name, s.xml);
  for (const im of images) zip.file('OEBPS/' + im.name, im.data);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}

/* ---------- TXT ---------- */
export function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  const t = new TextDecoder('utf-8').decode(u8);
  return (t.match(/\uFFFD/g) || []).length > 3 ? new TextDecoder('windows-1252').decode(u8) : t.replace(/^\uFEFF/, '');
}
const HEAD_RE = /^\s*(chapter|book|part|prologue|epilogue|section)\b.{0,60}$|^\s*[IVXLC]{1,7}\.?\s*$/i;
export async function txtToEpub(buf, filename) {
  const text = decodeText(buf).replace(/\r\n?/g, '\n');
  let paras = /\n\s*\n/.test(text) ? text.split(/\n\s*\n+/) : text.split('\n');
  paras = paras.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const chapters = []; let cur = { title: '', ps: [] };
  const push = () => { if (cur.ps.length || cur.title) chapters.push(cur); };
  for (const p of paras) {
    if (HEAD_RE.test(p) && p.length < 70) { push(); cur = { title: p, ps: [] }; continue; }
    cur.ps.push(p); if (!cur.title && cur.ps.length >= 300) { push(); cur = { title: '', ps: [] }; }
  }
  push();
  const title = baseName(filename);
  return makeEpub({ title, chapters: (chapters.length ? chapters : [{ title, ps: ['(empty)'] }]).map((c, i) => ({ title: c.title || (chapters.length > 1 ? `Part ${i + 1}` : title), body: (c.title ? `<h2>${esc(c.title)}</h2>` : '') + c.ps.map((p) => `<p>${esc(p)}</p>`).join('') })) });
}

/* ---------- CBZ ---------- */
export async function cbzToEpub(buf, filename) {
  const z = await JSZip.loadAsync(buf);
  const names = Object.keys(z.files).filter((n) => !z.files[n].dir && MIME[extOf(n)] && !/(^|\/)(__MACOSX|\.)/.test(n)).sort(natural);
  if (!names.length) throw new Error('No pictures were found in this comic file.');
  const images = []; const chapters = [];
  for (let i = 0; i < names.length; i++) {
    const n = `img/p${String(i + 1).padStart(4, '0')}.${extOf(names[i])}`;
    images.push({ name: n, data: await z.file(names[i]).async('uint8array'), type: MIME[extOf(names[i])] });
    chapters.push({ title: 'Page ' + (i + 1), body: `<div class="pg"><img src="${n}" alt=""/></div>` });
  }
  return makeEpub({ title: baseName(filename), chapters, images, coverName: images[0].name });
}

/* ---------- FB2 ---------- */
function fb2Html(node, imgs) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { out += esc(c.nodeValue); continue; }
    if (c.nodeType !== 1) continue;
    const t = c.localName, inner = () => fb2Html(c, imgs);
    switch (t) {
      case 'p': case 'v': case 'subtitle': case 'text-author': out += `<p>${inner()}</p>`; break;
      case 'title': out += `<h2>${[...c.children].map((p) => fb2Html(p, imgs)).join(' ') || esc(c.textContent)}</h2>`; break;
      case 'emphasis': out += `<em>${inner()}</em>`; break;
      case 'strong': out += `<strong>${inner()}</strong>`; break;
      case 'strikethrough': out += `<s>${inner()}</s>`; break;
      case 'sup': case 'sub': case 'code': out += `<${t}>${inner()}</${t}>`; break;
      case 'empty-line': out += '<br/>'; break;
      case 'epigraph': case 'cite': case 'annotation': out += `<blockquote>${inner()}</blockquote>`; break;
      case 'image': { const href = (c.getAttribute('l:href') || c.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || c.getAttribute('xlink:href') || '').replace(/^#/, ''); if (imgs.has(href)) out += `<div class="pg"><img src="${imgs.get(href)}" alt=""/></div>`; break; }
      case 'a': out += inner(); break;
      default: out += inner();
    }
  }
  return out;
}
export async function fb2ToEpub(buf, filename) {
  let text = new TextDecoder('utf-8').decode(buf);
  const enc = (text.slice(0, 200).match(/encoding=["']([\w-]+)["']/i) || [])[1];
  if (enc && !/utf-?8/i.test(enc)) { try { text = new TextDecoder(enc).decode(buf); } catch { /* keep utf-8 */ } }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || !doc.documentElement || doc.documentElement.localName !== 'FictionBook') throw new Error('This FB2 file couldn’t be read (damaged or not FB2).');
  const q = (root, sel) => [...root.getElementsByTagName('*')].filter((e) => e.localName === sel);
  const ti = q(doc, 'title-info')[0] || doc;
  const title = (q(ti, 'book-title')[0]?.textContent || '').trim() || baseName(filename);
  const au = q(ti, 'author')[0]; const author = au ? ['first-name', 'middle-name', 'last-name'].map((k) => q(au, k)[0]?.textContent?.trim()).filter(Boolean).join(' ') || (q(au, 'nickname')[0]?.textContent || '').trim() : '';
  const seq = q(ti, 'sequence')[0]; const lang = (q(ti, 'lang')[0]?.textContent || 'en').trim();
  const imgs = new Map(), images = [];
  q(doc, 'binary').forEach((b, i) => {
    const type = b.getAttribute('content-type') || 'image/jpeg'; const ext = Object.keys(MIME).find((k) => MIME[k] === type) || 'jpg';
    try { const bin = atob(b.textContent.replace(/\s+/g, '')); const u8 = new Uint8Array(bin.length); for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j); const name = `img/b${i}.${ext}`; images.push({ name, data: u8, type }); imgs.set(b.getAttribute('id'), name); } catch { /* skip a broken picture */ }
  });
  const cp = q(ti, 'coverpage')[0]; const ci = cp && q(cp, 'image')[0];
  const coverHref = ci ? (ci.getAttribute('l:href') || ci.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '').replace(/^#/, '') : '';
  const body = q(doc, 'body').filter((b) => b.getAttribute('name') !== 'notes')[0];
  if (!body) throw new Error('This FB2 file has no text.');
  const secs = [...body.children].filter((e) => e.localName === 'section');
  const chapters = (secs.length ? secs : [body]).map((s, i) => { const t = [...s.children].find((e) => e.localName === 'title'); return { title: (t ? t.textContent.replace(/\s+/g, ' ').trim() : '') || `Part ${i + 1}`, body: fb2Html(s, imgs) }; });
  return makeEpub({ title, author, lang, series: seq ? seq.getAttribute('name') || '' : '', seriesIndex: seq && seq.getAttribute('number') ? parseFloat(seq.getAttribute('number')) : null, chapters, images, coverName: imgs.get(coverHref) || '' });
}

/** Any convertible file → { buffer (EPUB), kind } or null when the file isn't one of these formats. */
export async function convertToEpub(buf, filename) {
  const n = String(filename || '');
  if (/\.cbz$/i.test(n)) return { buffer: await cbzToEpub(buf, n), kind: 'cbz' };
  if (/\.fb2$/i.test(n)) return { buffer: await fb2ToEpub(buf, n), kind: 'fb2' };
  if (/\.(fb2\.zip|fbz)$/i.test(n)) { const z = await JSZip.loadAsync(buf); const f = Object.keys(z.files).find((x) => /\.fb2$/i.test(x)); if (!f) throw new Error('No FB2 book inside this zip.'); return { buffer: await fb2ToEpub(await z.file(f).async('arraybuffer'), f), kind: 'fb2' }; }
  if (/\.txt$/i.test(n)) return { buffer: await txtToEpub(buf, n), kind: 'txt' };
  return null;
}

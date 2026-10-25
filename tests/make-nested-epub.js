// Builds "Nested Book" (v0.5.18 tests): Part One › Chapter 1, Chapter 2 (with nested sections 2.1 / 2.2 as #anchors in the same file), Part Two › Chapters 3–30.
// Searchable markers: "zebracorn" ×2 in chapter 1, ×1 in section 2.2, ×1 in chapter 29; "Ünïcode café" once in chapter 3 (accent-insensitive search).
const JSZip = require('../vendor/jszip.min.js'); const fs = require('fs');
const out = process.argv[2] || '/tmp/nested-epub'; fs.mkdirSync(out, { recursive: true });
const CONT = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const xh = (t, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`;
const words = 'the quiet harbour lamp showed pale water under a heavy sky while travellers argued about old roads and distant towns'.split(' ');
const para = (ch, n) => { let s = ''; for (let i = 0; i < 40; i++) s += words[(i * 7 + n * 3 + ch) % words.length] + ' '; return `<p>Paragraph ${ch}.${n}: ${s.trim()}.</p>`; };
const paras = (ch, k, extra = {}) => Array.from({ length: k }, (_, i) => extra[i] || para(ch, i + 1)).join('');
(async () => {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); z.file('META-INF/container.xml', CONT);
  const files = [];
  const add = (id, title, body) => { z.file(`OEBPS/${id}.xhtml`, xh(title, body)); files.push(id); };
  add('p1', 'Part One', '<p>Opening words of part one.</p>');
  add('c1', 'Chapter 1', paras(1, 14, { 3: '<p>A <b>zebra</b>corn appeared near the harbour.</p>', 10: '<p>Later the zebracorn left quietly.</p>' }));
  add('c2', 'Chapter 2', paras(2, 4) + '<h2 id="s1">Section 2.1</h2>' + paras(21, 14) + '<h2 id="s2">Section 2.2</h2>' + paras(22, 6, { 2: '<p>Only one zebracorn in this section.</p>' }));
  add('p2', 'Part Two', '<p>Opening words of part two.</p>');
  for (let ch = 3; ch <= 30; ch++) add('c' + ch, 'Chapter ' + ch, paras(ch, 4, ch === 3 ? { 1: '<p>The sign said Ünïcode café in bright letters.</p>' } : ch === 29 ? { 2: '<p>The last zebracorn of the book.</p>' } : {}));
  const li = (id, t, kids = '') => `<li><a href="${id}">${t}</a>${kids ? '<ol>' + kids + '</ol>' : ''}</li>`;
  const part2 = Array.from({ length: 28 }, (_, i) => li('c' + (i + 3) + '.xhtml', 'Chapter ' + (i + 3))).join('');
  const toc = li('p1.xhtml', 'Part One', li('c1.xhtml', 'Chapter 1') + li('c2.xhtml', 'Chapter 2', li('c2.xhtml#s1', 'Section 2.1') + li('c2.xhtml#s2', 'Section 2.2'))) + li('p2.xhtml', 'Part Two', part2);
  z.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${toc}</ol></nav></body></html>`);
  const man = files.map((f) => `<item id="${f}" href="${f}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = files.map((f) => `<itemref idref="${f}"/>`).join('');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Nested Book</dc:title><dc:creator>Una Author</dc:creator><dc:identifier id="id">nested-book-518</dc:identifier><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${man}</manifest><spine>${spine}</spine></package>`);
  fs.writeFileSync(out + '/nested-book.epub', await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); console.log('built', out);
})();

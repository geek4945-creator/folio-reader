// Builds "Notes Book": two chapters of numbered paragraphs (enough text for many pages), one with nested <em>/<b> markup, for the highlights & notes test.
const JSZip = require('../vendor/jszip.min.js'); const fs = require('fs');
const out = process.argv[2] || '/tmp/notes-epub'; fs.mkdirSync(out, { recursive: true });
const CONT = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-pac' + 'kage+xml"/></rootfiles></container>';
const xh = (t, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`;
const words = 'the quiet harbour lamp showed pale water under a heavy sky while travellers argued about old roads and distant towns'.split(' ');
const para = (ch, n) => { let s = ''; for (let i = 0; i < 46; i++) s += words[(i * 7 + n * 3 + ch) % words.length] + ' '; return `Paragraph ${ch}.${n} begins here: ${s.trim()}, and Paragraph ${ch}.${n} ends here.`; };
(async () => {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); z.file('META-INF/container.xml', CONT);
  const mk = (ch, count) => Array.from({ length: count }, (_, i) => { const n = i + 1; let t = para(ch, n); if (n === 2) t = t.replace('quiet harbour', '<em>quiet <b>harbour</b></em>'); return `<p>${t}</p>`; }).join('');
  z.file('OEBPS/c1.xhtml', xh('Chapter One', mk(1, 24))); z.file('OEBPS/c2.xhtml', xh('Chapter Two', mk(2, 14)));
  z.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li><li><a href="c2.xhtml">Chapter Two</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Notes Book</dc:title><dc:creator>Una Author</dc:creator><dc:identifier id="id">notes-book-1</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  fs.writeFileSync(out + '/notes-book.epub', await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })); console.log('built', out);
})();

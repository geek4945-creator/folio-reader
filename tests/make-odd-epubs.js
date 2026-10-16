// Generates unusual EPUBs into a directory (default /tmp/odd): no TOC, missing nav file, missing spine file, no cover, huge, bad XHTML, odd zip layouts.
const JSZip = require('../vendor/jszip.min.js'); const fs = require('fs');
const out = process.argv[2] || '/tmp/odd'; fs.mkdirSync(out, { recursive: true });
const CONT = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const para = (n, s = 1) => { const w = ['amber', 'river', 'stone', 'quiet', 'harbour', 'ember', 'linen']; let t = ''; for (let i = 0; t.length < n; i++) t += w[(i * 7 + s) % 7] + (i % 11 === 0 ? '. ' : ' '); return t; };
const xh = (t, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`;
async function build(name, { chapters = 3, size = 3000, nav = 'nav', title = 'Odd Book', missingSpine = false, extra = null, rawBody = null, noMimetype = false, imgBytes = 0, noTitle = false, rootOpf = false, dangling = false } = {}) {
  const z = new JSZip(); if (!noMimetype) z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  const opfPath = rootOpf ? 'content.opf' : 'OEBPS/content.opf'; const base = rootOpf ? '' : 'OEBPS/';
  z.file('META-INF/container.xml', rootOpf ? CONT.replace('OEBPS/content.opf', 'content.opf') : CONT);
  const items = []; const spine = [];
  for (let i = 1; i <= chapters; i++) { items.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${i}"/>`); if (!(missingSpine && i === 2)) z.file(`${base}c${i}.xhtml`, rawBody ? rawBody(i) : xh('Chapter ' + i, `<p>${para(size, i)}</p>` + (imgBytes && i === 1 ? '<img src="big.png" alt=""/>' : ''))); }
  if (imgBytes) { items.push('<item id="big" href="big.png" media-type="image/png"/>'); z.file(base + 'big.png', require('crypto').randomBytes(imgBytes)); }
  if (dangling) spine.unshift('<itemref idref="cover"/>', '<itemref idref="ghost"/>');   // itemrefs with no manifest item (Internet Archive scanned-page EPUBs)
  let navItem = ''; if (nav === 'nav') { navItem = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'; z.file(base + 'nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body><nav epub:type="toc"><ol>${Array.from({ length: chapters }, (_, i) => `<li><a href="c${i + 1}.xhtml">Chapter ${i + 1}</a></li>`).join('')}</ol></nav></body></html>`); }
  else if (nav === 'missing-nav') navItem = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>';   // declared, file absent
  else if (nav === 'ncx-missing') navItem = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>';
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${noTitle ? '' : `<dc:title>${title}</dc:title>`}<dc:identifier id="id">urn:uuid:${name}</dc:identifier><dc:language>en</dc:language></metadata><manifest>${navItem}${items.join('')}</manifest><spine${nav === 'ncx-missing' ? ' toc="ncx"' : ''}>${spine.join('')}</spine></package>`;
  z.file(opfPath, opf); if (extra) extra(z, base);
  fs.writeFileSync(`${out}/${name}.epub`, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
(async () => {
  await build('odd-no-toc', { nav: 'none', title: 'Odd No TOC' });
  await build('odd-missing-nav', { nav: 'missing-nav', title: 'Odd Missing Nav' });
  await build('odd-ncx-missing', { nav: 'ncx-missing', title: 'Odd NCX Missing' });
  await build('odd-missing-spine', { missingSpine: true, title: 'Odd Missing Spine' });
  await build('odd-dangling-spine', { dangling: true, nav: 'none', title: 'Odd Dangling Spine' });
  await build('odd-no-title', { noTitle: true });
  await build('odd-root-opf', { rootOpf: true, title: 'Odd Root OPF' });
  await build('odd-no-mimetype', { noMimetype: true, title: 'Odd No Mimetype' });
  await build('odd-bad-xhtml', { title: 'Odd Bad XHTML', rawBody: (i) => `<html><head><title>x</title></head><body><p>Unclosed <b>bold<p>${para(2000, i)} &nbsp; &copy; <br></body>` });
  await build('odd-huge-chapter', { chapters: 2, size: 2500000, title: 'Odd Huge Chapter' });
  await build('odd-big-image', { chapters: 3, imgBytes: 25 * 1024 * 1024, title: 'Odd Big Image' });
  await build('odd-many-chapters', { chapters: 600, size: 1500, title: 'Odd Many Chapters' });
  console.log('ok');
})();

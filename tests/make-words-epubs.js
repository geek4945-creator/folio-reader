// Builds two small EPUBs for the word-lookup / glossary tests: "Saga of Ash One / Two", each with a chapter, a Glossary page (dl + "Term – def" paragraphs) and a Dramatis Personae page.
const JSZip = require('../vendor/jszip.min.js'); const fs = require('fs');
const out = process.argv[2] || '/tmp/words-epubs'; fs.mkdirSync(out, { recursive: true });
const CONT = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-pac' + 'kage+xml"/></rootfiles></container>';
const xh = (t, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${t}</title></head><body><h1>${t}</h1>${body}</body></html>`;
async function build(name, title, body, { glossary = true } = {}) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); z.file('META-INF/container.xml', CONT);
  const items = ['<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>', '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']; const spine = ['<itemref idref="c1"/>']; const toc = ['<li><a href="c1.xhtml">Chapter One</a></li>'];
  z.file('OEBPS/c1.xhtml', xh('Chapter One', body));
  if (glossary) {
    items.push('<item id="g" href="glossary.xhtml" media-type="application/xhtml+xml"/>', '<item id="p" href="people.xhtml" media-type="application/xhtml+xml"/>'); spine.push('<itemref idref="g"/>', '<itemref idref="p"/>'); toc.push('<li><a href="glossary.xhtml">Glossary</a></li>', '<li><a href="people.xhtml">Dramatis Personae</a></li>');
    z.file('OEBPS/glossary.xhtml', xh('Glossary', '<p>This glossary lists the terms used in the book.</p><dl><dt>Saidar</dt><dd>The female half of the True Source.</dd><dt>Saidin</dt><dd>The male half of the True Source.</dd></dl><p><b>Aiel</b> – A people of the Waste.</p><p><strong>Warder:</strong> A bonded protector of an Aes Sedai.</p><p>Ta’veren – one around whom the Pattern bends.</p>'));
    z.file('OEBPS/people.xhtml', xh('Dramatis Personae', '<p><b>Egwene</b> – a Two Rivers girl<br/><b>Nynaeve</b> – a Wisdom<br/><i>Moiraine</i>: an Aes Sedai</p>'));
  }
  z.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol>${toc.join('')}</ol></nav></body></html>`);
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Una Author</dc:creator><dc:identifier id="id">urn:test:${name}</dc:identifier><dc:language>en</dc:language></metadata><manifest>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(`${out}/${name}.epub`, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
(async () => {
  await build('ash-one', 'Saga of Ash One', '<p>The ephemeral light of the lamp showed that the Aes Sedai were running toward the harbour.</p><p>It was pure serendipity, and nobody spoke of zzzqx again.</p>');
  await build('ash-two', 'Saga of Ash Two', '<p>Another Aes Sedai arrived, and the ephemeral light returned.</p>', { glossary: false });
  console.log('built in', out);
})();

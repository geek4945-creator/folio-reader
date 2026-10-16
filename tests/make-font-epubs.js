// Generates the font-size audit fixtures: font-nasty.epub (hard-coded px/pt/rem sizes, !important, ids, inline styles, <font>, tables…) and font-fixed.epub (fixed layout).
const JSZip = require('../vendor/jszip.min.js'); const fs = require('fs'); const path = require('path');
const out = process.argv[2] || path.join(__dirname, 'fixtures');
const CONT = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const lorem = 'Amber river stone quiet harbour ember linen. '.repeat(60);
const NASTY_CSS = `
html { font-size: 62.5% !important; }
body { font-size: 11px; font-family: serif; line-height: 1.1; margin: 0 }
p { font-size: 10px !important; line-height: 12px !important; }
#t-id { font-size: 9px !important; }
.big { font-size: 30px !important; }
.rem { font-size: 1.2rem; }
h1 { font-size: 40px; } h2 { font-size: 18pt !important; } h3 { font-size: 7px !important; }
td { font-size: 9px; } li { font-size: 8pt !important; } blockquote { font-size: 14px; } a.link { font-size: 22px !important; }
div.wrap p.deep > span.x { font-size: 6px !important; }
`;
const nasty = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nasty</title><style>${NASTY_CSS}</style></head><body>
<h1 id="t-h1">Heading one</h1><h2 id="t-h2">Heading two</h2><h3 id="t-h3">Heading three</h3>
<p id="t-p">Plain paragraph with <em id="t-em">emphasis</em> and <span id="t-span" style="font-size:7pt">inline span</span>. ${lorem}</p>
<p id="t-id">Paragraph with id rule !important</p>
<p id="t-big" class="big">Class rule 30px !important</p>
<p id="t-inline" style="font-size:8px">Inline px</p>
<p id="t-inline-imp" style="font-size:8px !important">Inline px !important</p>
<div id="t-rem" class="rem">rem sized div</div>
<div class="wrap"><p class="deep"><span id="t-deep" class="x">deep specificity 6px !important</span></p></div>
<p><font id="t-font" size="2">font size=2</font> <font id="t-font7" size="7">font size=7</font></p>
<center id="t-center"><font size="1">center</font></center>
<table><tr><td id="t-td">cell text</td></tr></table>
<ul><li id="t-li">list item 8pt !important</li></ul>
<blockquote id="t-bq">quote</blockquote>
<p><a id="t-a" class="link" href="#t-p" style="font-size:30px">link 22px !important</a> <small id="t-small">small text</small> x<sup id="t-sup">sup</sup> y<sub id="t-sub">sub</sub></p>
<pre id="t-pre">preformatted code</pre><dl><dt id="t-dt">term</dt><dd id="t-dd" style="font-size:9px">definition</dd></dl>
<aside style="font-size:12px"><p id="t-aside">inside aside</p></aside><figure><figcaption id="t-cap" style="font-size:9px">caption</figcaption></figure>
</body></html>`;
const chap = (i) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>C${i}</title><style>p{font-size:12px !important}</style></head><body><h1>Chapter ${i}</h1><p>${lorem.repeat(3)}</p></body></html>`;
async function build(name, { fixed }) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip', { compression: 'STORE' }); z.file('META-INF/container.xml', CONT);
  const items = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']; const spine = [];
  const pages = fixed ? 3 : 3;
  for (let i = 1; i <= pages; i++) {
    items.push(`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${i}"/>`);
    if (fixed) z.file(`OEBPS/c${i}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>P${i}</title><meta name="viewport" content="width=600, height=800"/><style>body{margin:0;width:600px;height:800px;position:relative;background:#fff} .t{position:absolute;left:40px;top:60px;width:520px;font-size:26px;line-height:34px;color:#000} .h{position:absolute;left:40px;top:10px;font-size:44px;font-weight:bold}</style></head><body><div class="h" id="t-fx-h">Page ${i}</div><div class="t" id="t-fx-p">${lorem.slice(0, 500)}</div></body></html>`);
    else z.file(`OEBPS/c${i}.xhtml`, i === 1 ? nasty : chap(i));
  }
  z.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>`);
  const title = fixed ? 'Font Fixed Layout' : 'Font Nasty';
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Tester</dc:creator><dc:identifier id="id">urn:uuid:font-${name}</dc:identifier><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>${fixed ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta>' : ''}</metadata><manifest>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  fs.writeFileSync(path.join(out, name + '.epub'), await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
(async () => { await build('font-nasty', { fixed: false }); await build('font-fixed', { fixed: true }); console.log('wrote fixtures to', out); })();

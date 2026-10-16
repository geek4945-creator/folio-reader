// Shared mocks for the v0.4.0 tests: Open Library, Google Books, cover hosts (some without CORS → must go through the proxy), Google Drive
// (appDataFolder sync file + cover files, Drive image listing) and Google Identity Services. All traffic is intercepted; nothing real is contacted.
const fs = require('fs'); const path = require('path');
const IMG = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'img', n));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const GIS = `window.google={accounts:{id:{disableAutoSelect(){}},oauth2:{initTokenClient(cfg){return{requestAccessToken(){setTimeout(()=>cfg.callback({access_token:'tok-'+Math.random().toString(36).slice(2),expires_in:3600,scope:cfg.scope}),20);}}},revoke(t,cb){cb&&cb();},hasGrantedAllScopes(){return true}}}};`;

/* title (lower-case) → Open Library docs / Google Books volumes */
const OL = {
  'the test odyssey': [{ key: '/works/OL1W', title: 'The Test Odyssey', author_name: ['Ada Writer'], first_publish_year: 1999, language: ['eng'], cover_i: 111, isbn: ['9781234567897'] },
    { key: '/works/OL1X', title: 'The Test Odyssey (Illustrated)', author_name: ['Ada Writer'], first_publish_year: 2005, language: ['eng'], cover_i: 112, isbn: [] }],
  'mystery tome': [{ key: '/works/OL2W', title: 'Mystery Tome', author_name: ['Zed Unknown'], first_publish_year: 1980, language: ['fre'], cover_i: 111, isbn: [] }],
  'wrong match': [{ key: '/works/OL3W', title: 'Wrong Match', author_name: ['Other Person'], first_publish_year: 1970, language: ['eng'], cover_i: 112, isbn: [] }],
  'edited book': [{ key: '/works/OL4W', title: 'Edited Book', author_name: ['Eddie Tor'], first_publish_year: 2001, language: ['eng'], isbn: [] }],
  'saga part two': [{ key: '/works/OL5W', title: 'Saga Part Two', author_name: ['Sage Teller'], first_publish_year: 2010, language: ['eng'], cover_i: 111, isbn: [] }],
  'auto high book': [{ key: '/works/OL6W', title: 'Auto High Book', author_name: ['Hannah High'], first_publish_year: 2015, language: ['eng'], cover_i: 112, isbn: [] }],
  'auto medium book': [{ key: '/works/OL7W', title: 'Auto Medium Book', author_name: ['Mo Medium'], first_publish_year: 2016, language: ['eng'], cover_i: 111, isbn: [] }],
  'ogg tone': [{ key: '/works/OL8W', title: 'Ogg Tone', author_name: ['Ogg Artist'], first_publish_year: 2012, language: ['eng'], cover_i: 112, isbn: [] }],
  'isbn book': [{ key: '/works/OL9W', title: 'Completely Different Title', author_name: ['Isbn Person'], first_publish_year: 1990, language: ['ger'], cover_i: 111, isbn: ['9780306406157'] }],
};
const GBV = (id, title, authors, extra = {}) => ({ id, volumeInfo: { title, authors, publishedDate: extra.date || '', language: extra.lang || 'en', description: extra.desc || '', industryIdentifiers: extra.isbn ? [{ type: 'ISBN_13', identifier: extra.isbn }] : [], imageLinks: extra.noimg ? undefined : { thumbnail: `http://books.google.com/books/content?id=${id}&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api` } } });
const GB = {
  'the test odyssey': [GBV('GB1', 'The Test Odyssey', ['Ada Writer'], { date: '1999-05-01', desc: '<p>An epic <b>test</b> voyage.</p>', isbn: '9781234567897' })],
  'mystery tome': [GBV('GB2', 'Mystery Tome', ['Zed Unknown'], { date: '1980', desc: 'A tome of mystery.' })],
  'edited book': [GBV('GB4', 'Edited Book', ['Eddie Tor'], { date: '2001', desc: 'Description from Google Books (must not replace the user’s).' })],
  'auto high book': [GBV('GB6', 'Auto High Book', ['Hannah High'], { date: '2015', desc: 'Auto-filled description.' })],
  'ogg tone': [GBV('GB8', 'Ogg Tone', ['Ogg Artist'], { date: '2012-03-04', desc: 'A tone, recorded in ogg.' })],
};

const DF = require('./drive-fake');
function makeState() {
  return { log: { ol: [], gb: [], proxy: [], img: [], cse: [], olTimes: [], drive: [] }, gb429: 0, gbAlways429: false, olFail: false, cloud: DF.attach({ covers: new Map(), writes: 0, seq: 0, uploads: 0, deletes: [], lastBody: null, auth: [] }, 'folio'), pageUrl: null };
}
const png1 = (b) => b;
/** Install interception on a page. `S` is the shared state (so two devices can share one cloud). */
async function install(page, S) {
  await page.exposeFunction('__capture', (b64) => { S.cloud.lastBody = Buffer.from(b64, 'base64'); });
  await page.evaluateOnNewDocument(() => {
    const of = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      if (/googleapis\.com\/upload\/drive/.test(String(url)) && init.body != null) { const buf = await new Response(init.body).arrayBuffer(); let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); await window.__capture(btoa(s)); }
      return of(url, init);
    };
  });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url(); let target = u; let viaProxy = false;
    const px = /^https:\/\/folio-proxy\.geek4945\.workers\.dev\/\?url=(.+)$/.exec(u); if (px) { target = decodeURIComponent(px[1]); viaProxy = true; S.log.proxy.push(target); }
    const json = (o, status = 200, extra = {}) => req.respond({ status, headers: { ...CORS, ...extra }, contentType: 'application/json', body: JSON.stringify(o) });
    const img = (name, type = 'image/jpeg', noCors = false) => req.respond({ status: 200, headers: noCors ? {} : CORS, contentType: type, body: IMG(name) });
    if (u.startsWith('https://accounts.google.com/gsi/client')) return req.respond({ status: 200, contentType: 'text/javascript', body: GIS });
    let m;
    if (/^https:\/\/openlibrary\.org\/search\.json/.test(target)) {
      const q = new URL(target).searchParams; S.log.ol.push(target); S.log.olTimes.push(Date.now()); if (S.olFail) return req.abort();
      const t = (q.get('title') || '').toLowerCase(); const isbn = q.get('isbn');
      if (isbn) return json({ docs: Object.values(OL).flat().filter((d) => d.isbn.includes(isbn)) });
      return json({ docs: OL[t] || [] });
    }
    if ((m = /^https:\/\/openlibrary\.org\/works\/(OL\d+[WX])(\.json|\/editions\.json.*)$/.exec(target))) {
      S.log.ol.push(target);
      if (m[2] === '.json') return json({ description: m[1] === 'OL5W' ? { type: '/type/text', value: 'Saga from the Open Library work record.' } : m[1] === 'OL2W' ? 'Mystery described by the work record.' : '' });
      return m[1] === 'OL5W' ? json({ entries: [{ title: 'x' }, { title: 'Saga Part Two', series: ['The Test Saga ; 2'] }] }) : req.respond({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' });
    }
    if ((m = /^https:\/\/covers\.openlibrary\.org\/b\/id\/(\d+)-([LM])\.jpg/.exec(target))) { S.log.img.push(target); return m[1] === '113' ? img('placeholder.gif', 'image/gif') : img(m[1] === '111' ? 'cover-a.jpg' : 'cover-b.jpg'); }
    if (/^https:\/\/www\.googleapis\.com\/books\/v1\/volumes/.test(target)) {
      S.log.gb.push(target); S.log.olTimes.length;
      if (S.gbAlways429) return req.respond({ status: 429, headers: CORS, contentType: 'application/json', body: '{"error":{"code":429}}' });
      if (S.gb429 > 0) { S.gb429--; return req.respond({ status: 429, headers: CORS, contentType: 'application/json', body: '{"error":{"code":429}}' }); }
      const qq = decodeURIComponent(new URL(target).searchParams.get('q') || '').replace(/\+/g, ' '); const t = ((/intitle:(.*?)(\s*inauthor:|$)/.exec(qq) || [])[1] || '').trim().toLowerCase();
      return json({ items: GB[t] || [] });
    }
    if (/^https?:\/\/books\.google\.com\/books\/content/.test(target)) { S.log.img.push(target); return viaProxy ? img('cover-b.jpg') : img('cover-b.jpg', 'image/jpeg', true); }   // direct: no CORS header → the browser blocks it → proxy
    if (/^https:\/\/img\.example\.test\//.test(target)) { S.log.img.push(target); return viaProxy ? img('big.jpg') : img('big.jpg', 'image/jpeg', true); }
    if (/^https:\/\/cors\.example\.test\/wide\.png/.test(target)) { S.log.img.push(target); return img('wide.png', 'image/png'); }
    if (/^https:\/\/cors\.example\.test\/page\.html/.test(target)) return req.respond({ status: 200, headers: CORS, contentType: 'text/html', body: '<html><body>not an image</body></html>' });
    if (/^https:\/\/customsearch\.googleapis\.com|googleapis\.com\/customsearch\/v1/.test(target)) { S.log.cse.push(target); return json({ items: [{ link: 'https://cors.example.test/wide.png', image: { thumbnailLink: 'https://cors.example.test/wide.png' } }] }); }
    if (/^https:\/\/(api\.dictionaryapi\.dev|en\.wiktionary\.org\/api\/rest_v1|api\.datamuse\.com)\//.test(u)) {   // v0.5.6 dictionary sources: S.dict.reply(url) → { status, body }
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
      const d = S.dict || { calls: [], reply: () => ({ status: 404, body: {} }) }; (d.calls = d.calls || []).push(u); const r = (d.reply ? d.reply(u) : null) || { status: 404, body: {} };
      return req.respond({ status: r.status, headers: CORS, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    if (!/googleapis\.com/.test(u)) return req.continue();
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
    S.cloud.auth.push(req.headers().authorization);
    const C = S.cloud;
    if (u.includes('/oauth2/v3/userinfo')) return json({ name: 'Ada Reader', email: 'ada@example.com', picture: '' });
    if (u.includes('spaces=drive')) { S.log.drive.push(decodeURIComponent(u)); const q = decodeURIComponent(u.replace(/\+/g, ' ')); if (q.includes("image/")) return json({ files: [{ id: 'IMG1', name: 'my-cover.jpg', mimeType: 'image/jpeg', size: '31000' }] }); return json({ files: [] }); }
    if (/\/drive\/v3\/files\/IMG1\?alt=media/.test(u)) return img('cover-a.jpg');
    const cm = /\/drive\/v3\/files\/(C\d+)\?alt=media/.exec(u); if (cm) { const f = [...C.covers.values()].find((x) => x.id === cm[1]); return f ? req.respond({ status: 200, headers: CORS, contentType: 'image/jpeg', body: f.buf }) : req.respond({ status: 404, headers: CORS, body: 'nf' }); }
    if (/\/drive\/v3\/files\/C\d+$/.test(u.split('?')[0]) && req.method() === 'DELETE') { const id = u.split('?')[0].split('/').pop(); for (const [k, f] of C.covers) if (f.id === id) { C.covers.delete(k); C.deletes.push(k); } return req.respond({ status: 204, headers: CORS }); }
    if (await DF.handle(req, u, C, json, CORS)) return;
    if (u.includes('/drive/v3/files?') && !u.includes('/upload/')) {
      const q = decodeURIComponent(u).replace(/\+/g, ' ');
      if (/name contains 'cover-'/.test(q)) return json({ files: [...C.covers.entries()].map(([name, f]) => ({ id: f.id, name, createdTime: f.createdTime })) });
      return json({ files: [] });
    }
    if (u.includes('/upload/drive/v3/files') && req.method() === 'POST') {
      const buf = C.lastBody || Buffer.from(req.postData() || ''); C.writes++; const s = buf.toString('latin1'); const nameM = /"name":"([^"]+)"/.exec(s);
      if (nameM && /^cover-/.test(nameM[1])) { const mark = Buffer.from('Content-Type: image/jpeg\r\n\r\n'); const i = buf.indexOf(mark) + mark.length; const e = buf.lastIndexOf(Buffer.from('\r\n--folio')); const id = 'C' + (++C.seq); C.uploads++; const f = { id, buf: buf.subarray(i, e), createdTime: new Date(C.coverAge ? Date.now() - C.coverAge : Date.now()).toISOString() }; C.covers.set(nameM[1], f); return json({ id, name: nameM[1], createdTime: f.createdTime }); }
    }
    return req.respond({ status: 404, headers: CORS, body: 'nf' });
  });
}
const fakeLogin = (exp = Date.now() + 3600000) => `localStorage.setItem('folio.google', JSON.stringify({ token: 'seed-token', exp: ${exp}, profile: { name: 'Ada Reader', email: 'ada@example.com', picture: '' } }));`;

/** In-page: build a minimal (metadata-poor) EPUB and import it. opts: {title, author, description, language, date, cover(bool), identifier} */
const MAKE_EPUB = async (o) => {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(o.title)}</dc:title>${o.author ? `<dc:creator>${esc(o.author)}</dc:creator>` : ''}<dc:identifier id="id">${esc(o.identifier || 'urn:test:' + o.title)}</dc:identifier>${o.language ? `<dc:language>${o.language}</dc:language>` : ''}${o.description ? `<dc:description>${esc(o.description)}</dc:description>` : ''}${o.date ? `<dc:date>${o.date}</dc:date>` : ''}${o.cover ? '<meta name="cover" content="cov"/>' : ''}</metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>${o.cover ? '<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>' : ''}</manifest><spine><itemref idref="c1"/></spine></package>`);
  z.file('OEBPS/c1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>Hello ' + esc(o.title) + '</p></body></html>');
  if (o.cover) { const r = await fetch('./tests/fixtures/img/cover-b.jpg'); z.file('OEBPS/cover.jpg', await r.arrayBuffer()); }
  const buf = await z.generateAsync({ type: 'arraybuffer' }); const S = await import('./js/store.js'); return S.addBookFromBuffer(buf, { filename: o.title + '.epub' });
};
module.exports = { makeState, install, fakeLogin, MAKE_EPUB, IMG, CORS };

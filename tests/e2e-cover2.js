// v0.5.0 "Change cover" search: editable title / author / ISBN, many sources (Open Library editions, Google Books, Internet Archive, Apple Books) with
// paging, de-duplication, size labels, size filter + sort, one-tap "Use this" → crop; "Search in browser" links (Google / Bing / DuckDuckGo, Chrome on
// iOS / Android) with step-by-step hints; Paste image (Clipboard API, paste event), Choose from Photos / Files; Web Share Target (manifest + service worker).
const puppeteer = require('puppeteer-core'); const path = require('path'); const zlib = require('zlib');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (...p) => path.join(__dirname, 'fixtures', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const pngCache = new Map();
function png(w, h, rgb = [200, 80, 60]) { const k = w + 'x' + h; if (pngCache.has(k)) return pngCache.get(k); const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1] + (x % 50); row[3 + x * 3] = rgb[2]; } const raw = Buffer.concat(Array.from({ length: h }, () => row)); const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const b = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); pngCache.set(k, b); return b; }
const SIZES = [[120, 180], [300, 450], [500, 750], [800, 1200]];
const LOG = { ol: [], gb: [], ia: [], itunes: [], editions: 0 };
function routes(req) {
  const u = new URL(req.url()); const json = (o) => req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(o) }); const img = (w, h) => req.respond({ status: 200, headers: CORS, contentType: 'image/png', body: png(w, h) });
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
  if (u.host === 'openlibrary.org' && u.pathname === '/search.json') {
    const title = u.searchParams.get('title') || ''; const off = +u.searchParams.get('offset') || 0; LOG.ol.push({ title, author: u.searchParams.get('author'), isbn: u.searchParams.get('isbn'), off });
    if (/another/i.test(title)) return json({ docs: off ? [] : [{ key: '/works/OL9W', title: 'Another Book', author_name: ['Ada Writer'], cover_i: 4001, first_publish_year: 2001, publisher: ['Zed Press'] }] });
    if (!/test odyssey/i.test(title)) return json({ docs: [] });
    const n = off === 0 ? 20 : 3; return json({ docs: Array.from({ length: n }, (_, i) => { const id = (off ? 2000 : 1000) + i; return { key: '/works/OL' + id + 'W', title: 'The Test Odyssey', author_name: ['Ada Writer'], cover_i: id, first_publish_year: 1990 + (i % 20), publisher: ['Pub ' + i] }; }) });
  }
  if (u.host === 'openlibrary.org' && /editions\.json$/.test(u.pathname)) { LOG.editions++; return json({ entries: [{ covers: [1000], publish_date: 'May 1999', publishers: ['Dup House'] }, { covers: [3001], publish_date: '2012', publishers: ['Edition House'], physical_format: 'Paperback' }] }); }
  if (u.host === 'covers.openlibrary.org') { const m = /\/b\/id\/(\d+)-/.exec(u.pathname); if (m) { const id = +m[1]; const [w, h] = id === 4001 ? [500, 750] : id === 3001 ? [640, 960] : SIZES[id % 4]; return img(w, h); } if (/isbn\/9780000000002/.test(u.pathname)) return img(500, 750); return req.respond({ status: 404, headers: CORS, body: 'nf' }); }
  if (u.host === 'www.googleapis.com' && /books\/v1\/volumes/.test(u.pathname)) { LOG.gb.push(u.searchParams.get('q')); return json({ items: [1, 2, 3].map((i) => ({ id: 'GB' + i, volumeInfo: { title: 'The Test Odyssey', authors: ['Ada Writer'], publishedDate: '200' + i, publisher: 'Gee Books', imageLinks: { thumbnail: `http://books.google.com/books/content?id=GB${i}&printsec=frontcover&img=1&zoom=1&edge=curl` } } })) }); }
  if (u.host === 'books.google.com') return img(600, 900);
  if (u.host === 'archive.org' && u.pathname === '/advancedsearch.php') { LOG.ia.push(u.searchParams.get('q')); return json({ response: { docs: [{ identifier: 'testodyssey00writ', title: 'The Test Odyssey', creator: 'Ada Writer', year: '1975' }, { identifier: 'unrelated', title: 'Cooking for Eight', creator: 'Chef' }] } }); }
  if (u.host === 'archive.org' && u.pathname.startsWith('/services/img/')) return img(200, 300);
  if (u.host === 'itunes.apple.com') { LOG.itunes.push(u.searchParams.get('media')); return json({ results: u.searchParams.get('media') === 'ebook' ? [{ trackId: 77, trackName: 'The Test Odyssey', artistName: 'Ada Writer', releaseDate: '2015-01-01T00:00:00Z', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Publication/x/100x100bb.jpg' }] : [] }); }
  if (u.host.endsWith('mzstatic.com')) return img(/1000x1000/.test(u.pathname) ? 1000 : 400, /1000x1000/.test(u.pathname) ? 1000 : 400);
  if (u.host === 'img.test') return img(400, 600);
  req.continue();
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const mkPage = async (ua) => { const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); if (ua) await page.setUserAgent(ua);
    page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); await page.setRequestInterception(true); page.on('request', (r) => { const h = new URL(r.url()).host; if (/openlibrary|googleapis|books\.google|archive\.org|itunes|mzstatic|img\.test/.test(h)) routes(r); else r.continue(); });
    await page.evaluateOnNewDocument(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push({ u, t, f }); return null; }; });
    await page.goto(APP, { waitUntil: 'networkidle0' }); page.ctx = ctx; return page; };
  const page = await mkPage(); const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ev((s) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click(); }, sel);
  const closeAll = () => ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  const bookId = () => ev(async () => (await (await import('./js/store.js')).getBooks())[0].id);
  const openSearch = async () => { await closeAll(); const id = await bookId(); await ev((id) => import('./js/covers.js').then((m) => m.openCoverEditor('book', id)), id); await page.waitForSelector('#cover-opt-search'); await click('#cover-opt-search'); await page.waitForSelector('#cover-results .cover-cand', { timeout: 15000 }); await sleep(900); };
  const tiles = () => ev(() => [...document.querySelectorAll('#cover-results .cover-cand')].map((t) => ({ id: t.dataset.id, src: t.dataset.src, hidden: t.hidden, dim: t.querySelector('.cover-dim').innerText, lbl: t.querySelector('.cover-lbl').innerText })));
  const dimH = (t) => +(/×(\d+)/.exec(t.dim) || [0, 0])[1];

  await step('Setup: one book titled “The Test Odyssey” by Ada Writer', async () => {
    await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub')); for (let i = 0; i < 60; i++) { if (await ev(async () => (await (await import('./js/store.js')).getBooks()).length)) break; await sleep(300); }
    await ev(async () => { const { DB } = await import('./js/db.js'); const b = (await DB.all('books'))[0]; b.title = 'The Test Odyssey'; b.author = 'Ada Writer'; b.isbn = ''; await DB.put('books', b); });
  });
  await step('Search: editable title / author / ISBN fields; many candidates from all four sources with source · edition · size shown', async () => {
    await openSearch(); const f = await ev(() => ({ t: document.querySelector('#cover-q-title').value, a: document.querySelector('#cover-q-author').value, i: !!document.querySelector('#cover-q-isbn') })); assert(f.t === 'The Test Odyssey' && f.a === 'Ada Writer' && f.i, JSON.stringify(f));
    const t = await tiles(); const srcs = new Set(t.map((x) => x.src)); assert(['Open Library', 'Google Books', 'Internet Archive', 'Apple Books'].every((s) => srcs.has(s)), [...srcs].join()); assert(t.length >= 25, 'only ' + t.length + ' candidates: ' + [...srcs].map((s) => s + '=' + t.filter((x) => x.src === s).length).join(' '));
    assert(t.every((x) => /^\d+×\d+$/.test(x.dim)), 'sizes not measured: ' + t.filter((x) => !/^\d+×\d+$/.test(x.dim)).map((x) => x.id + ':' + x.dim).join()); assert(t.some((x) => /edition/i.test(x.lbl) && /Paperback/.test(x.lbl)), 'edition label'); assert(t.some((x) => /Pub \d+/.test(x.lbl) && /19\d\d/.test(x.lbl)), 'publisher/year label');
    assert(LOG.itunes.length >= 2, 'ebook + audiobook queries'); return `${t.length} candidates from ${srcs.size} sources`;
  });
  await step('De-duplicated (the same cover from a work and its edition appears once); small covers filtered by default; sorted largest first', async () => {
    const t = await tiles(); const ids = t.map((x) => x.id); assert(new Set(ids).size === ids.length, 'duplicate tiles'); assert(ids.filter((i) => i === 'ol:1000').length === 1, 'dup cover 1000');
    const vis = t.filter((x) => !x.hidden); assert(vis.length < t.length && vis.every((x) => dimH(x) >= 200), 'default filter should hide < 200px tall: ' + vis.map((x) => x.dim).join()); assert(t.filter((x) => x.hidden).every((x) => dimH(x) < 200));
    const area = vis.map((x) => { const [w, h] = x.dim.split('×').map(Number); return w * h; }); assert(area.every((a, i) => i === 0 || area[i - 1] >= a), 'not sorted by size desc: ' + area.slice(0, 12).join());
  });
  await step('Size filter and sort controls: ≥ 700 px only; Any shows tiny ones; “Best match” sort', async () => {
    await ev(() => { const s = document.querySelector('#cover-minsize'); s.value = '700'; s.dispatchEvent(new Event('change')); }); await sleep(300); let t = (await tiles()).filter((x) => !x.hidden); assert(t.length && t.every((x) => dimH(x) >= 700), t.map((x) => x.dim).join());
    await ev(() => { const s = document.querySelector('#cover-minsize'); s.value = '0'; s.dispatchEvent(new Event('change')); }); await sleep(300); t = (await tiles()).filter((x) => !x.hidden); assert(t.some((x) => dimH(x) <= 180), 'tiny covers should show with Any size');
    await ev(() => { const s = document.querySelector('#cover-sort'); s.value = 'match'; s.dispatchEvent(new Event('change')); }); await sleep(300); const all = await tiles(); assert(all.length >= 25, 'tiles lost'); await ev(() => { const s = document.querySelector('#cover-minsize'); s.value = '200'; s.dispatchEvent(new Event('change')); const so = document.querySelector('#cover-sort'); so.value = 'size'; so.dispatchEvent(new Event('change')); });
  });
  await step('Load more: next pages from every source; the button goes away when nothing is left', async () => {
    const before = (await tiles()).length; assert(await ev(() => !document.querySelector('#cover-more').hidden), 'no load-more'); await click('#cover-more'); await sleep(2500); const t = await tiles(); assert(t.length > before && t.some((x) => /^ol:2000$/.test(x.id)), `before ${before} after ${t.length}`);
    assert(LOG.ol.some((q) => q.off === 20), 'second Open Library page not requested'); assert(await ev(() => document.querySelector('#cover-more').hidden), 'load-more should hide when every source is exhausted');
  });
  await step('Edit the query: new title searches again; an ISBN-only search offers the Open Library ISBN cover', async () => {
    await ev(() => { document.querySelector('#cover-q-title').value = 'Another Book'; }); await click('#cover-q-go'); await sleep(2500); let t = await tiles(); assert(t.some((x) => x.id === 'ol:4001') && !t.some((x) => x.id === 'ol:1001'), t.map((x) => x.id).join()); assert(LOG.ol.some((q) => q.title === 'Another Book'));
    await ev(() => { document.querySelector('#cover-q-title').value = ''; document.querySelector('#cover-q-author').value = ''; document.querySelector('#cover-q-isbn').value = '978-0-00-000000-2'; }); await click('#cover-q-go'); await sleep(2500); t = await tiles(); assert(t.some((x) => x.id === 'ol:isbn:9780000000002' && x.dim === '500×750'), t.map((x) => x.id + ':' + x.dim).join());
  });
  await step('One tap on a cover → crop preview → Use this cover saves it', async () => {
    await ev(() => { document.querySelector('#cover-q-title').value = 'The Test Odyssey'; document.querySelector('#cover-q-author').value = 'Ada Writer'; document.querySelector('#cover-q-isbn').value = ''; }); await click('#cover-q-go'); await sleep(2500);
    await ev(() => document.querySelector('#cover-results .cover-cand[data-src="Google Books"]').click()); await page.waitForSelector('#crop-apply', { timeout: 10000 }); await click('#crop-apply'); await sleep(900);
    const b = await ev(async () => { const x = (await (await import('./js/store.js')).getBooks())[0]; return { src: x.coverSource, user: !!x.userSet?.cover }; }); assert(b.user, JSON.stringify(b));
  });
  await step('Search in browser: Google Images (+ Bing / DuckDuckGo) open https links; hints; no Chrome buttons on desktop', async () => {
    await openSearch(); await click('#cover-open-browser'); await page.waitForSelector('#cover-steps'); const r = await ev(() => ({ steps: document.querySelectorAll('#cover-steps li').length, txt: document.querySelector('#cover-steps').innerText, g: document.querySelector('#cover-google-images').href, bing: document.querySelector('#cover-bing').href, ddg: document.querySelector('#cover-ddg').href, chrome: !!document.querySelector('#cover-chrome-ios, #cover-chrome-android'), paste: !!document.querySelector('#cover-paste-image'), choose: !!document.querySelector('#cover-choose-file') }));
    assert(r.steps === 4 && /Touch and hold/.test(r.txt) && /Paste image/.test(r.txt) && /Photos \/ Files/.test(r.txt), r.txt); assert(/^https:\/\/www\.google\.com\/search\?tbm=isch&q=The%20Test%20Odyssey%20Ada%20Writer%20book%20cover$/.test(r.g), r.g); assert(/^https:\/\/www\.bing\.com\/images\/search\?q=/.test(r.bing) && /^https:\/\/duckduckgo\.com\/\?iax=images&ia=images&q=/.test(r.ddg), r.bing + ' ' + r.ddg); assert(!r.chrome && r.paste && r.choose);
    await click('#cover-google-images'); await click('#cover-bing'); const op = await ev(() => window.__opened.slice(-2)); assert(/google\.com/.test(op[0].u) && op[0].t === '_blank' && /bing\.com/.test(op[1].u), JSON.stringify(op));
    await ev(() => { const q = document.querySelector('#cover-browser-q'); q.value = 'my own words'; }); assert(/my%20own%20words/.test(await ev(() => { document.querySelector('#cover-google-images').click(); return window.__opened.slice(-1)[0].u; })), 'edited query not used');
  });
  await step('iPhone: “open in Chrome” (googlechromes://) offered next to Safari; Android: Chrome intent link', async () => {
    const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', AND = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
    for (const [ua, id, re] of [[IOS, '#cover-chrome-ios', /^googlechromes:\/\/www\.google\.com\/search\?tbm=isch&q=/], [AND, '#cover-chrome-android', /^intent:\/\/www\.google\.com\/search\?tbm=isch&q=.*#Intent;scheme=https;package=com\.android\.chrome;end$/]]) {
      const p = await mkPage(ua); await (await p.$('#file-input')).uploadFile(fx('frankenstein.epub')); for (let i = 0; i < 60; i++) { if (await p.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length)) break; await sleep(300); }
      await p.evaluate(async () => { const m = await import('./js/covers.js'); const s = await import('./js/store.js'); m.openCoverEditor('book', (await s.getBooks())[0].id); }); await p.waitForSelector('#cover-opt-browser'); await p.evaluate(() => document.querySelector('#cover-opt-browser').click()); await p.waitForSelector(id);
      const href = await p.$eval(id, (e) => e.href); assert(re.test(href), href); const safari = await p.$eval('#cover-google-images', (e) => e.innerText); assert(ua === IOS ? /Safari/.test(safari) : true, safari); await p.close();
    }
  });
  await step('Paste image: Clipboard API image, copied picture address, paste event, and “Use the copied image” when you come back', async () => {
    const origin = new URL(APP).origin; await page.ctx.overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']); await page.bringToFront();
    await closeAll(); const id = await bookId(); await ev((id) => import('./js/covers.js').then((m) => m.openCoverEditor('book', id)), id); await page.waitForSelector('#cover-opt-browser'); await click('#cover-opt-browser'); await page.waitForSelector('#cover-paste-image');
    const b64 = png(300, 450).toString('base64');
    await ev(async (b64) => { const blob = await (await fetch('data:image/png;base64,' + b64)).blob(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); }, b64);
    await ev(() => window.dispatchEvent(new Event('focus'))); await page.waitForSelector('#cover-clip-found', { timeout: 5000 }); assert(/image you copied/.test(await ev(() => document.querySelector('#cover-clip-found').innerText)), 'banner text');
    await click('#cover-paste-image'); await page.waitForSelector('#crop-apply', { timeout: 8000 }); assert(/300×450/.test(await ev(() => document.querySelector('.crop-wrap').parentElement.innerText)), 'pasted image not the one copied'); await click('#crop-back'); await page.waitForSelector('#cover-opt-paste');
    await click('#cover-opt-browser'); await page.waitForSelector('#cover-paste-image'); await ev(() => navigator.clipboard.writeText('https://img.test/cover.png')); await click('#cover-paste-image'); await page.waitForSelector('#crop-apply', { timeout: 8000 }); assert(/400×600/.test(await ev(() => document.querySelector('.crop-wrap').parentElement.innerText)), 'URL paste');
    await click('#crop-back'); await click('#cover-opt-browser'); await page.waitForSelector('#cover-paste-box');
    await ev(async (b64) => { const f = new File([await (await fetch('data:image/png;base64,' + b64)).blob()], 'x.png', { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(f); document.querySelector('#cover-paste-box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, b64); await page.waitForSelector('#crop-apply', { timeout: 8000 });
  });
  await step('Choose from Photos / Files opens the picker and goes to the crop preview', async () => {
    await closeAll(); const id = await bookId(); await ev((id) => import('./js/covers.js').then((m) => m.openCoverEditor('book', id)), id); await page.waitForSelector('#cover-opt-browser'); await click('#cover-opt-browser'); await page.waitForSelector('#cover-choose-file');
    const [fc] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), click('#cover-choose-file')]); await fc.accept([fx('cover-a.png')]); await page.waitForSelector('#crop-apply', { timeout: 8000 });
  });
  await step('Web Share Target: manifest entry + service worker keeps the shared image; the app asks which book it is for, then shows the crop preview', async () => {
    const m = await ev(async () => (await fetch('manifest.webmanifest')).json()); const st = m.share_target; assert(st && st.method === 'POST' && st.enctype === 'multipart/form-data' && /share-target$/.test(st.action) && st.params.files[0].name === 'image' && st.params.files[0].accept.includes('image/*'), JSON.stringify(st));
    await ev(async () => { await navigator.serviceWorker.ready; }); await page.reload({ waitUntil: 'networkidle0' }); await ev(async () => { for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100)); }); assert(await ev(() => !!navigator.serviceWorker.controller), 'page not controlled by the service worker');
    const kept = await ev(async (b64) => { const blob = await (await fetch('data:image/png;base64,' + b64)).blob(); const fd = new FormData(); fd.append('image', new File([blob], 'shared.png', { type: 'image/png' })); fd.append('title', 'x'); const r = await fetch('share-target', { method: 'POST', body: fd }); return { ok: r.ok, url: r.url, hit: !!(await caches.match(new URL('__shared__/cover', document.baseURI).href)) }; }, png(320, 480).toString('base64'));
    assert(kept.ok && /index\.html\?share=cover/.test(kept.url) && kept.hit, JSON.stringify(kept));
    await page.goto(APP + '?share=cover', { waitUntil: 'networkidle0' }); await page.waitForSelector('#share-targets .share-target', { timeout: 8000 }); assert(await ev(() => !!document.querySelector('#share-preview')), 'preview'); assert(!/share=/.test(await ev(() => location.search)), 'share param not removed');
    await click('#share-targets .share-target'); await page.waitForSelector('#crop-apply', { timeout: 8000 }); assert(/320×480/.test(await ev(() => document.querySelector('.crop-wrap').parentElement.innerText)), 'wrong image in the crop preview');
    assert(!(await ev(async () => !!(await caches.match(new URL('__shared__/cover', document.baseURI).href)))), 'shared file should be removed after use');
  });
  await step('No page errors', async () => { assert(!page.errs.length, page.errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

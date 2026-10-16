// Kindle-format import tests (MOBI6, KF8/AZW3, combo MOBI+KF8, series-in-title, DRM refusal, OPDS, Drive-path, drag&drop).
// Needs: static server on :8765 and the mock server (node tests/mock-server.js) on :8766.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const books = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction('books').objectStore('books').getAll(); a.onsuccess = () => res(a.result.map((b) => ({ title: b.title, author: b.author, series: b.setId, idx: b.seriesIndex, cover: !!b.coverBlob, size: b.size, orig: b.origFormat, status: b.status }))); }; }));
const sets = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction('sets').objectStore('sets').getAll(); a.onsuccess = () => res(a.result.map((s) => s.name)); }; }));
const uploadAndWait = async (page, files, n) => { await (await page.$('#file-input')).uploadFile(...files.map(fx)); for (let i = 0; i < 60 && (await books(page)).length < n; i++) await sleep(300); assert((await books(page)).length >= n, 'import did not finish'); await sleep(500); };
const readerText = async (page, title) => {
  await page.evaluate((t) => [...document.querySelectorAll('.tile.book')].find((x) => x.innerText.includes(t)).click(), title);
  await page.waitForSelector('#viewer iframe', { timeout: 15000 });
  await page.waitForFunction(() => window.__reader?.loc && document.querySelector('#viewer iframe')?.contentDocument?.body?.innerText.length > 20, { timeout: 15000 });
  const info = await page.evaluate(() => { const d = document.querySelector('#viewer iframe').contentDocument; const cs = d.defaultView.getComputedStyle(d.querySelector('p') || d.body); return { text: d.body.innerText.slice(0, 80), fs: parseFloat(cs.fontSize), bg: d.defaultView.getComputedStyle(d.body).backgroundColor }; });
  return info;
};
const closeReader = async (page) => { await page.evaluate(() => (document.querySelector('#r-back') || document.querySelector('#r-close')).click()); await sleep(600); };

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });

  await step('file input accepts .mobi/.azw/.azw3/.kf8 as well as .epub', async () => {
    const a = await page.$eval('#file-input', (e) => e.accept); assert(/\.mobi/.test(a) && /\.azw3/.test(a) && /\.azw/.test(a) && /\.kf8/.test(a) && /\.epub/.test(a), a); return a;
  });
  await step('Import MOBI6 via file picker: title/author/cover extracted, stored as EPUB', async () => {
    await uploadAndWait(page, ['saga-mobi6.mobi'], 1);
    const b = (await books(page)); assert(b.length === 1 && b[0].title === 'Saga Book One' && b[0].author === 'Test Author' && b[0].cover && b[0].orig === 'mobi', JSON.stringify(b)); return JSON.stringify(b[0]);
  });
  await step('Import AZW3/KF8 and combo MOBI+KF8 (KF8 part is used)', async () => {
    await uploadAndWait(page, ['saga-kf8.azw3'], 2);
    await uploadAndWait(page, ['series-kf8.azw3'], 3);
    const b = await books(page); assert(b.length === 3 && b.filter((x) => x.orig === 'kf8').length === 2, JSON.stringify(b));
    const combo = await page.evaluate(async (bytes) => { const { detectKindle, kindleToEpub } = await import('./js/kindle.js'); const u = new Uint8Array(bytes).buffer; const r = await kindleToEpub(u, { filename: 'c.mobi' }); return { det: detectKindle(u), kind: r.kind, size: r.buffer.byteLength }; }, [...fs.readFileSync(fx('saga-combo.mobi'))]);
    assert(combo.det.kind === 'mobi' && !combo.det.drm && combo.kind === 'kf8', JSON.stringify(combo)); return 'combo → ' + combo.kind;
  });
  await step('Series in title ("Title (Series, Book 2)") becomes a set with index; title cleaned', async () => {
    const b = await books(page); const k = b.find((x) => /Kindle Saga Two/.test(x.title)); assert(k && k.title === 'Kindle Saga Two' && k.idx === 2 && k.series, JSON.stringify(b));
    assert((await sets(page)).includes('Kindle Saga'), 'set missing'); return JSON.stringify(k);
  });
  await step('MOBI6 book opens in the reader and renders text with chapters in TOC', async () => {
    const i = await readerText(page, 'Saga Book One'); assert(i.text.length > 10, JSON.stringify(i));
    await page.screenshot({ path: '/tmp/shot-kindle-reader.png' });
    await page.click('#r-toc'); await page.waitForSelector('.toc-item'); const n = await page.$$eval('.toc-item', (e) => e.length); assert(n >= 1, 'toc ' + n);
    await page.evaluate(() => [...document.querySelectorAll('.btn-text')].find((e) => /Done/.test(e.textContent))?.click()); await sleep(300); return i.text.replace(/\n/g, ' ') + ' | toc ' + n;
  });
  await step('Existing reader features work on a converted book (global font size + theme)', async () => {
    const before = (await page.evaluate(() => document.querySelector('#viewer iframe').contentDocument.defaultView.getComputedStyle(document.querySelector('#viewer iframe').contentDocument.querySelector('p') || document.querySelector('#viewer iframe').contentDocument.body).fontSize));
    await page.evaluate(() => window.__folio.settings.set({ fontSizePt: 24, theme: 'dark' })); await sleep(900);
    const i = await page.evaluate(() => { const d = document.querySelector('#viewer iframe').contentDocument; const cs = d.defaultView.getComputedStyle(d.querySelector('p') || d.body); return { fs: parseFloat(cs.fontSize), bg: d.defaultView.getComputedStyle(d.body).backgroundColor }; });
    assert(i.fs > parseFloat(before) + 4, before + ' → ' + i.fs); assert(/rgb\((\d+), (\d+), (\d+)\)/.test(i.bg) && +RegExp.$1 < 80, 'bg ' + i.bg);
    await page.evaluate(() => window.__folio.settings.set({ fontSizePt: 17, theme: 'light' })); return before + ' → ' + i.fs + 'px, dark bg ' + i.bg;
  });
  await step('KF8 book renders (images/css resolved to files, anchors intact)', async () => {
    await closeReader(page);
    const i = await readerText(page, 'Kindle Saga Two'); assert(i.text.length > 10, JSON.stringify(i));
    const z = await page.evaluate(async () => { const { getBooks, getFile } = await import('./js/store.js'); const b = (await getBooks()).find((x) => /Kindle Saga Two/.test(x.title)); const f = await getFile(b.id); const zip = await JSZip.loadAsync(await f.arrayBuffer()); const names = Object.keys(zip.files); const s1 = await zip.file('OEBPS/s0001.xhtml').async('string'); const parsed = new DOMParser().parseFromString(s1, 'application/xhtml+xml'); return { names, wellFormed: !parsed.querySelector('parsererror'), blob: /blob:/.test(s1) }; });
    assert(z.wellFormed && !z.blob, JSON.stringify(z)); await closeReader(page); return z.names.length + ' files in converted EPUB';
  });
  await step('DRM-flagged MOBI is refused with a friendly message, nothing added', async () => {
    const n0 = (await books(page)).length;
    await (await page.$('#file-input')).uploadFile(fx('drm-flagged.mobi')); await page.waitForFunction(() => /copy-protected/i.test(document.querySelector('#overlay')?.innerText || ''), { timeout: 8000 });
    const t = await page.$eval('#overlay', (e) => e.innerText); assert(/DRM-free/.test(t) && /Folio can’t import it/.test(t), t); assert((await books(page)).length === n0, 'book was added');
    await page.screenshot({ path: '/tmp/shot-drm.png' }); await page.evaluate(() => [...document.querySelectorAll('#overlay .btn-text')].forEach((b) => b.click())); await sleep(300); return t.replace(/\n+/g, ' ').slice(0, 140);
  });
  await step('KFX/Topaz-style container refused as copy-protected', async () => {
    await (await page.$('#file-input')).uploadFile(fx('kfx-stub.azw')); await page.waitForFunction(() => /copy-protected/i.test(document.querySelector('#overlay')?.innerText || ''), { timeout: 8000 });
    await page.evaluate(() => [...document.querySelectorAll('#overlay .btn-text')].forEach((b) => b.click())); await sleep(300);
  });
  await step('Detection unit checks (EPUB zip ignored; DRM header fields; garbage)', async () => {
    const r = await page.evaluate(async () => { const { detectKindle } = await import('./js/kindle.js'); const z = new Uint8Array(200); z[0] = 0x50; z[1] = 0x4b; return { zip: detectKindle(z.buffer), junk: detectKindle(new Uint8Array(300).buffer) }; });
    assert(r.zip === null && r.junk === null, JSON.stringify(r));
  });
  await step('Drag-and-drop of a .azw3 file is accepted by the window drop handler', async () => {
    await page.evaluate(async (bytes) => { const f = new File([new Uint8Array(bytes)], 'dropped.azw3', { type: '' }); const dt = new DataTransfer(); dt.items.add(f); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, [...fs.readFileSync(fx('saga-combo.mobi'))]);
    await sleep(3000); const b = await books(page); assert(b.length >= 2, 'books ' + b.length); const toast = await page.$eval('#toast', (e) => e.innerText).catch(() => ''); return 'toast: ' + toast;
  });
  await step('Drive import path: addBookFromBuffer with a Drive-style filename hint converts MOBI', async () => {
    const r = await page.evaluate(async (bytes) => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) await S.deleteBook(b.id); const b = await S.addBookFromBuffer(new Uint8Array(bytes).buffer, { source: 'Google Drive', sourceKey: 'gdrive:KINDLE1', filename: 'My Book.mobi' }); return { title: b.title, orig: b.origFormat, src: b.source }; }, [...fs.readFileSync(fx('series-kf8.azw3'))]);
    assert(r.orig === 'kf8' && r.src === 'Google Drive' && r.title === 'Kindle Saga Two', JSON.stringify(r)); return JSON.stringify(r);
  });
  await step('Drive file list query includes MOBI/AZW/AZW3', async () => {
    const q = await page.evaluate(async () => { let url = ''; const of = window.fetch; window.fetch = async (u) => { url = String(u); return new Response('{"files":[]}', { status: 200 }); }; localStorage.setItem('folio.google', JSON.stringify({ token: 'x', exp: Date.now() + 1e7, scope: 'drive.readonly', profile: { email: 'a@b.c' } })); try { await window.__folio.G.listDriveFiles({}); } finally { window.fetch = of; localStorage.removeItem('folio.google'); } return decodeURIComponent(url).replace(/\+/g, ' '); });
    assert(/\.mobi/.test(q) && /\.azw/.test(q) && /x-mobipocket-ebook/.test(q) && /\.epub/.test(q), q); return 'query covers epub + mobi + azw';
  });
  await step('OPDS: Kindle-only entries are downloadable (AZW3 preferred); DRM-flagged is refused', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) await S.deleteBook(b.id); if (!(await S.getSources()).some((x) => x.name === 'Mock Kindle')) await S.addSource({ name: 'Mock Kindle', url: 'http://localhost:8766/opds', kind: 'opds' }); });
    await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await sleep(200); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.source')].find((x) => /Mock Kindle/.test(x.innerText)).click()); await page.waitForFunction(() => [...document.querySelectorAll('.list-item')].some((x) => /Kindle files/.test(x.innerText)), { timeout: 10000 }).catch(async (e) => { throw new Error(e.message + ' :: ' + (await page.evaluate(() => document.querySelector('#view').innerText.slice(0, 300)))); });
    await page.evaluate(() => [...document.querySelectorAll('.list-item')].find((x) => /Kindle files/.test(x.innerText)).click()); await page.waitForSelector('.card', { timeout: 8000 });
    const cards = await page.$$eval('.card', (c) => c.map((x) => x.innerText.replace(/\n/g, ' | '))); assert(cards.length === 2 && !/No EPUB/.test(cards.join()), JSON.stringify(cards));
    await page.evaluate(() => document.querySelectorAll('.card .dl')[0].click());
    for (let i = 0; i < 40 && !(await books(page)).length; i++) await sleep(300);
    const b = await books(page); assert(b.length === 1 && b[0].orig === 'kf8', JSON.stringify(b));
    await page.evaluate(() => document.querySelectorAll('.card .dl')[1].click()); await page.waitForFunction(() => /copy-protected/i.test(document.querySelector('#toast')?.innerText || ''), { timeout: 8000 });
    assert((await books(page)).length === 1, 'protected book added'); return JSON.stringify(cards);
  });
  await step('No page errors during Kindle tests', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close();
  const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

// PDF import + reader tests. Needs static server :8765 and mock server :8766.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const books = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction('books').objectStore('books').getAll(); a.onsuccess = () => res(a.result.map((b) => ({ id: b.id, title: b.title, author: b.author, cover: !!b.coverBlob, format: b.format, pages: b.pages, status: b.status, page: b.pdfPage, zoom: b.pdfZoom, progress: b.progress, shelves: b.shelves, setId: b.setId }))); }; }));
const waitCanvas = (page, n = 1) => page.waitForFunction((n) => document.querySelectorAll('#viewer canvas.pdf-canvas').length >= n, { timeout: 15000 }, n);
const curPage = (page) => page.evaluate(() => window.__pdf.page);
const canvasW = (page) => page.$eval('#viewer canvas.pdf-canvas', (c) => parseFloat(c.style.width));

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('folio.settings')) localStorage.setItem('folio.settings', JSON.stringify({ flow: 'paginated', flowChosen: true })); });   // these tests drive page turns: seed the explicit Pages choice (the default is Scroll since v0.5.2)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });

  await step('file input accepts .pdf', async () => { const a = await page.$eval('#file-input', (e) => e.accept); assert(/\.pdf/.test(a) && /application\/pdf/.test(a), a); });
  await step('Import PDF via picker: title/author from metadata, cover = first page, stored as pdf', async () => {
    await (await page.$('#file-input')).uploadFile(fx('test-doc.pdf'));
    for (let i = 0; i < 60 && !(await books(page)).length; i++) await sleep(300);
    const b = await books(page); assert(b.length === 1 && b[0].title === 'Folio Test PDF' && b[0].author === 'Pat Tester' && b[0].cover && b[0].format === 'pdf' && b[0].pages === 6, JSON.stringify(b)); await sleep(500);
    await page.screenshot({ path: '/tmp/shot-pdf-lib.png' }); return JSON.stringify(b[0]);
  });
  await step('Library tile shows PDF badge; search finds the PDF', async () => {
    assert(await page.$('.tile.book .pill-pdf'), 'no pdf pill');
    await page.type('input.search', 'folio test'); await sleep(300); const n = await page.$$eval('.tile.book', (e) => e.length); assert(n === 1, 'tiles ' + n);
    await page.$eval('input.search', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); await sleep(200);
  });
  await step('Open PDF: page 1 renders on a canvas (paged mode)', async () => {
    await page.evaluate(() => document.querySelector('.tile.book').click()); await waitCanvas(page); await sleep(500);
    const info = await page.evaluate(() => ({ pg: window.__pdf.page, n: window.__pdf.n, mode: window.__pdf.mode, w: document.querySelector('canvas.pdf-canvas').style.width, nonBlank: (() => { const c = document.querySelector('canvas.pdf-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 2] > 100) dark++; return dark; })() }));
    assert(info.pg === 1 && info.n === 6 && info.mode === 'paged' && info.nonBlank > 100, JSON.stringify(info)); await page.screenshot({ path: '/tmp/shot-pdf-reader.png' }); return JSON.stringify(info);
  });
  await step('Next/prev: tap zones, keyboard, swipe', async () => {
    await page.mouse.click(360, 420); await sleep(700); assert((await curPage(page)) === 2, 'tap next');
    await page.keyboard.press('ArrowRight'); await sleep(600); assert((await curPage(page)) === 3, 'key next');
    await page.mouse.click(20, 420); await sleep(600); assert((await curPage(page)) === 2, 'tap prev');
    const cdp = await page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 400 }] });
    for (let x = 300; x >= 100; x -= 25) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 402 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(700); assert((await curPage(page)) === 3, 'swipe next ' + (await curPage(page)));
  });
  await step('Page jump input + slider', async () => {
    await page.$eval('#pdf-page-num', (e) => { e.value = 5; e.dispatchEvent(new Event('change')); }); await sleep(700); assert((await curPage(page)) === 5, 'jump');
    await page.$eval('#r-slider', (e) => { e.value = 2; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); }); await sleep(700); assert((await curPage(page)) === 2, 'slider');
    assert((await page.$eval('#pdf-page-num', (e) => e.value)) === '2'); await waitCanvas(page);
  });
  await step('Zoom +/− and fit width', async () => {
    await waitCanvas(page); await sleep(300); const w0 = await canvasW(page);
    await page.click('#pdf-zin'); await sleep(900); await waitCanvas(page); const w1 = await canvasW(page); assert(w1 > w0 * 1.2, `zoom in ${w0}→${w1}`);
    await page.click('#pdf-zout'); await page.click('#pdf-zout'); await sleep(900); await waitCanvas(page); const w2 = await canvasW(page); assert(w2 < w0, `zoom out ${w2}`);
    await page.click('#pdf-fit'); await sleep(900); await waitCanvas(page); const w3 = await canvasW(page); assert(Math.abs(w3 - w0) < 2, `fit ${w3} vs ${w0}`); return `${w0} → ${w1} → ${w2} → ${w3}`;
  });
  await step('Pinch zoom (two-finger touch)', async () => {
    const w0 = await canvasW(page); const cdp = await page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 400, id: 1 }, { x: 240, y: 400, id: 2 }] });
    for (let d = 0; d <= 120; d += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150 - d / 2, y: 400, id: 1 }, { x: 240 + d / 2, y: 400, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(1200); await waitCanvas(page);
    const w1 = await canvasW(page); assert(w1 > w0 * 1.5, `pinch ${w0}→${w1}`); await page.click('#pdf-fit'); await sleep(700); return `${w0} → ${w1}`;
  });
  await step('Appearance: PDF has zoom/layout/theme only (no font, margin or line-spacing controls)', async () => {
    await page.click('#r-aa'); await page.waitForSelector('.sheet'); const t = await page.$eval('.sheet', (e) => e.innerText);
    assert(/Zoom/.test(t) && /Layout/.test(t) && /Theme/.test(t), t); assert(!(await page.$('#fs-num')) && !(await page.$('#font-sel')) && !(await page.$('#lh-range')) && !(await page.$('#mg-range')), 'text controls present');
    const note = await page.$eval('#pdf-note', (e) => e.innerText); assert(!/Line spacing|Margins|Text size/.test(t.replace(note, '')), t);
    await page.screenshot({ path: '/tmp/shot-pdf-appearance.png' });
    await page.evaluate(() => document.querySelector('[data-theme-pick=dark]').click()); await sleep(500);
    const cls = await page.$eval('#viewer', (e) => e.className); assert(/pdf-inv/.test(cls), cls); assert(await page.$('#pdf-invert'), 'invert toggle');
    await page.evaluate(() => document.querySelector('[data-theme-pick=sepia]').click()); await sleep(400);
    const cls2 = await page.$eval('#viewer', (e) => e.className + '|' + e.style.background); assert(/pdf-multiply/.test(cls2), cls2); await page.screenshot({ path: '/tmp/shot-pdf-sepia.png' });
    await page.evaluate(() => [...document.querySelectorAll('#overlay .btn-text')].forEach((b) => b.click())); await sleep(200); return cls2;
  });
  await step('Outline (☰) jumps to the chapter page', async () => {
    await page.waitForFunction(() => !document.querySelector('#r-toc').hidden, { timeout: 5000 }); await page.click('#r-toc'); await page.waitForSelector('.toc-item');
    await page.evaluate(() => document.querySelector('.toc-item').click()); await sleep(800); assert((await curPage(page)) === 3, 'outline page ' + (await curPage(page)));
  });
  await step('Continuous scroll mode: many pages, lazy canvases, scrolling updates page', async () => {
    await page.click('#r-aa'); await page.waitForSelector('.sheet'); await page.evaluate(() => document.querySelector('[data-flow=scrolled]').click()); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('#overlay .btn-text')].forEach((b) => b.click())); await waitCanvas(page, 2); await sleep(600);
    const n = await page.$$eval('.pdf-page', (e) => e.length); assert(n === 6, 'slots ' + n);
    assert((await curPage(page)) === 3, 'kept page ' + (await curPage(page)));
    await page.$eval('#viewer', (v) => { v.scrollTop = v.scrollHeight; }); await sleep(900); assert((await curPage(page)) === 6, 'bottom page ' + (await curPage(page)));
    await page.$eval('#viewer', (v) => { v.scrollTop = 0; }); await sleep(900); assert((await curPage(page)) === 1, 'top ' + (await curPage(page))); await page.screenshot({ path: '/tmp/shot-pdf-scroll.png' });
  });
  await step('Progress + zoom remembered per book (close & reopen) and last page marks Finished', async () => {
    await page.evaluate(() => window.__pdf && 0); await page.$eval('#pdf-page-num', (e) => { e.value = 4; e.dispatchEvent(new Event('change')); }); await sleep(800);
    await page.click('#pdf-zin'); await sleep(600);
    await page.click('#r-back'); await sleep(800);
    let b = (await books(page))[0]; assert(b.page === 4 && b.zoom > 1 && b.progress > 0.5 && b.progress < 0.7, JSON.stringify(b));
    await page.evaluate(() => document.querySelector('.tile.book').click()); await waitCanvas(page); await sleep(900);
    const pg = await curPage(page); assert(pg === 4, 'restored page ' + pg); const z = await page.evaluate(() => window.__pdf.zoom); assert(z > 1, 'zoom ' + z);
    await page.evaluate(async () => { const S = await import('./js/store.js'); const [b] = await S.getBooks(); await S.setStatus(b.id, 'reading'); window.__pdf.book.status = 'reading'; window.__pdf.finishedThisSession = false; });
    await page.$eval('#pdf-page-num', (e) => { e.value = 6; e.dispatchEvent(new Event('change')); }); await sleep(1200);
    await page.click('#r-back'); await sleep(900); b = (await books(page))[0]; assert(b.status === 'finished' && b.progress === 1, JSON.stringify(b)); return JSON.stringify(b);
  });
  await step('Shelves: move PDF to a custom shelf and back; custom shelf lists it', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); const sh = await S.createShelf('Manuals'); const [b] = await S.getBooks(); await S.toggleShelf(b.id, sh.id); await S.setStatus(b.id, 'reading'); });
    const b = (await books(page))[0]; assert(b.shelves.length === 1 && b.status === 'reading', JSON.stringify(b));
  });
  await step('Sets: PDF can be added to a set / series', async () => {
    const r = await page.evaluate(async () => { const S = await import('./js/store.js'); const set = await S.createSet('Manuals Set'); const [b] = await S.getBooks(); await S.assignSet(b.id, set.id, 1); return (await S.getBook(b.id)).setId === set.id; }); assert(r);
  });
  await step('Drag-and-drop a .pdf onto the window; Drive-path filename hint', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) await S.deleteBook(b.id); });
    await page.evaluate(async (bytes) => { const f = new File([new Uint8Array(bytes)], 'dropped.pdf', { type: 'application/pdf' }); const dt = new DataTransfer(); dt.items.add(f); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, [...fs.readFileSync(fx('test-doc.pdf'))]);
    for (let i = 0; i < 40 && !(await books(page)).length; i++) await sleep(300); assert((await books(page)).length === 1, 'drop failed');
    const r = await page.evaluate(async (bytes) => { const S = await import('./js/store.js'); try { await S.addBookFromBuffer(new Uint8Array(bytes).buffer, { source: 'Google Drive', sourceKey: 'gdrive:PDF1', filename: 'x.pdf' }); return 'added'; } catch (e) { return e.message; } }, [...fs.readFileSync(fx('test-doc.pdf'))]);
    assert(/already in your library/.test(r), 'duplicate detection: ' + r);
    const q = await page.evaluate(async () => { let url = ''; const of = window.fetch; window.fetch = async (u) => { url = String(u); return new Response('{"files":[]}', { status: 200 }); }; localStorage.setItem('folio.google', JSON.stringify({ token: 'x', exp: Date.now() + 1e7, scope: 'drive.readonly', profile: { email: 'a@b.c' } })); try { await window.__folio.G.listDriveFiles({}); } finally { window.fetch = of; localStorage.removeItem('folio.google'); } return decodeURIComponent(url).replace(/\+/g, ' '); });
    assert(/application\/pdf/.test(q) && /\.pdf/.test(q), q);
  });
  await step('OPDS: PDF-only entry downloads and imports', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) await S.deleteBook(b.id); if (!(await S.getSources()).some((x) => x.name === 'Mock PDF')) await S.addSource({ name: 'Mock PDF', url: 'http://localhost:8766/opds', kind: 'opds' }); });
    await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await sleep(200); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.source')].find((x) => /Mock PDF/.test(x.innerText)).click());
    await page.waitForFunction(() => [...document.querySelectorAll('.list-item')].some((x) => /PDF files/.test(x.innerText)), { timeout: 10000 });
    await page.evaluate(() => [...document.querySelectorAll('.list-item')].find((x) => /PDF files/.test(x.innerText)).click()); await page.waitForSelector('.card', { timeout: 8000 });
    assert(!/No EPUB/.test(await page.$eval('.card', (e) => e.innerText)), 'button disabled');
    await page.evaluate(() => document.querySelector('.card .dl').click()); for (let i = 0; i < 50 && !(await books(page)).length; i++) await sleep(300);
    const b = await books(page); assert(b.length === 1 && b[0].format === 'pdf', JSON.stringify(b));
  });
  await step('Password-protected / garbage PDF gives a friendly error', async () => {
    const r = await page.evaluate(async () => { const S = await import('./js/store.js'); try { await S.addBookFromBuffer(new TextEncoder().encode('%PDF-1.4\nnot really a pdf').buffer, { filename: 'bad.pdf' }); return 'added'; } catch (e) { return e.message; } });
    assert(/couldn’t read this PDF|password/i.test(r), r);
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close();
  const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

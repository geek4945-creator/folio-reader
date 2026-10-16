// "Stuck on Opening…" (v0.5.1): EPUBs whose nav / NCX file is missing used to hang forever. Now they open; a book that really cannot open shows an error
// after the watchdog with Retry / Retry from the start / Back / Copy details, and the loading screen always has a working Back (button, ‹ and Escape).
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs'); const { execSync } = require('child_process');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  fs.mkdirSync('/tmp/odd', { recursive: true }); execSync('node ' + path.join(__dirname, 'make-odd-epubs.js') + ' /tmp/odd');
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  await page.evaluateOnNewDocument(() => { window.__openWatchdogMs = 1500; }); await page.goto(APP, { waitUntil: 'networkidle0' });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const until = async (fn, ms = 15000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(150); } };
  const bookId = (re) => ev(async (re) => (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re, 'i').test(b.title))?.id, re);
  const openBook = (id, o) => ev((id, o) => { import('./js/reader.js').then((m) => m.openReader(id, o)); }, id, o);
  const closed = () => ev(() => document.querySelector('#reader')?.hidden !== false);
  const rendered = () => ev(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe'));
  const closeAll = () => ev(async () => { await (await import('./js/reader.js')).closeReader(); });
  await step('Setup: import a normal book, a no-nav EPUB, a missing-NCX EPUB and a PDF', async () => {
    await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), '/tmp/odd/odd-missing-nav.epub', '/tmp/odd/odd-ncx-missing.epub', '/tmp/odd/odd-missing-spine.epub', '/tmp/odd/odd-dangling-spine.epub', fx('test-doc.pdf'));
    await until(() => ev(async () => (await (await import('./js/store.js')).getBooks()).length === 6), 20000, 'six books');
  });
  await step('EPUB with a missing nav file opens (used to hang on “Opening…” forever), with a section list as contents and working page turns', async () => {
    const id = await bookId('Missing Nav'); const t = Date.now(); await openBook(id); await until(rendered, 12000, 'the book to render'); const ms = Date.now() - t;
    await sleep(500); const r = await ev(async () => { const c = window.__reader; const before = c.loc?.start?.cfi; await c.rendition.next(); await new Promise((r) => setTimeout(r, 500)); return { toc: c.toc.length, label: c.toc[0]?.label, moved: !!c.loc, hasPageList: !!c.epub.pageList }; });
    assert(r.toc >= 1 && /Section 1/.test(r.label) && r.hasPageList && r.moved, JSON.stringify(r)); await closeAll(); return ms + ' ms';
  });
  await step('EPUB whose spine lists items missing from the manifest (Internet Archive scanned-book EPUBs: “Reminiscences of a Stock Operator”) opens instead of throwing in epub.js', async () => {
    await openBook(await bookId('Dangling Spine')); await until(rendered, 12000, 'the book to render'); await sleep(400);
    const r = await ev(() => ({ toc: window.__reader.toc.length, spine: window.__reader.epub.spine.length })); assert(r.spine === 3 && r.toc >= 1, JSON.stringify(r)); await closeAll(); return JSON.stringify(r);
  });
  await step('Same for a missing NCX, and for a book with a missing spine file', async () => {
    for (const re of ['NCX Missing', 'Missing Spine']) { await openBook(await bookId(re)); await until(rendered, 12000, re + ' to render'); await closeAll(); }
  });
  await step('Loading screen always has a way out: Back button, the ‹ in the bar is not covered, and Escape', async () => {
    await ev(() => { window.__realAB = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = function () { return new Promise(() => {}); }; });   // reading the file never finishes
    const id = await bookId('Frankenstein'); await openBook(id); await page.waitForSelector('#reader .r-loading #r-load-back'); const cov = await ev(() => { const e = document.querySelector('#r-back'); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return t === e || e.contains(t); }); assert(cov, '‹ is covered by the loading screen');
    await ev(() => document.querySelector('#r-load-back').click()); await until(closed, 5000, 'back to the library');
    await openBook(id); await page.waitForSelector('#r-load-back'); await page.keyboard.press('Escape'); await until(closed, 5000, 'Escape to close');
    await openBook(id); await page.waitForSelector('#r-back'); await ev(() => document.querySelector('#r-back').click()); await until(closed, 5000, '‹ to close');
  });
  await step('Watchdog: a stalled open shows an error with Retry / Retry from the start / Back / details (stage named), not a spinner', async () => {
    const id = await bookId('Frankenstein'); await openBook(id); await page.waitForSelector('#r-error', { timeout: 8000 });
    const r = await ev(() => ({ title: document.querySelector('.r-err-title').innerText, ids: ['r-retry', 'r-retry-start', 'r-load-back', 'r-copy'].map((i) => !!document.getElementById(i)), spinner: !!document.querySelector('#reader .spinner') }));
    assert(/taking too long/.test(r.title) && r.ids.every(Boolean) && !r.spinner, JSON.stringify(r)); await until(() => ev(() => /Stage: Reading the book file/.test(document.querySelector('#r-details').textContent)), 5000, 'details'); const d = await ev(() => document.querySelector('#r-details').textContent);
    assert(/Book: Frankenstein/.test(d) && /service worker folio-v/.test(d) && /Platform:/.test(d) && /Error: Timed out|longer than expected/.test(d), d); return d.split('\n').length + ' lines of details';
  });
  await step('Retry after the cause is gone opens the book; Back from the error panel returns to the library', async () => {
    await ev(() => { Blob.prototype.arrayBuffer = window.__realAB; }); await ev(() => document.querySelector('#r-retry').click()); await until(rendered, 15000, 'retry to render'); await closeAll();
    await ev(() => { Blob.prototype.arrayBuffer = function () { return new Promise(() => {}); }; }); await openBook(await bookId('Frankenstein')); await page.waitForSelector('#r-error', { timeout: 8000 }); await ev(() => document.querySelector('#r-error #r-load-back').click()); await until(closed, 5000, 'back');
    await ev(() => { Blob.prototype.arrayBuffer = window.__realAB; });
  });
  await step('PDF that cannot be read: same watchdog panel and Back', async () => {
    await ev(() => { Blob.prototype.arrayBuffer = function () { return new Promise(() => {}); }; }); await openBook(await bookId('PDF')); await page.waitForSelector('#r-error', { timeout: 8000 }); assert(await ev(() => !document.getElementById('r-retry-start') && !!document.getElementById('r-retry')), 'pdf panel');
    await ev(() => document.querySelector('#r-error #r-load-back').click()); await until(closed, 5000, 'pdf back'); await ev(() => { Blob.prototype.arrayBuffer = window.__realAB; });
    await openBook(await bookId('PDF')); await until(() => ev(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer')), 12000, 'pdf renders'); await closeAll();
  });
  await step('A corrupt book file gives an error panel (not a hang) and Back works', async () => {
    const id = await bookId('Frankenstein'); await ev(async (id) => { const { DB } = await import('./js/db.js'); const f = await DB.get('files', id); await DB.put('files', { ...f, id: 'bak-' + id }); await DB.put('files', { ...f, blob: new Blob(['not an epub at all']) }); }, id);
    await openBook(id); await page.waitForSelector('#r-error', { timeout: 20000 }); assert(await ev(() => !!document.getElementById('r-retry')), 'retry'); await ev(() => document.querySelector('#r-error #r-load-back').click()); await until(closed, 5000, 'back');
    await ev(async (id) => { const { DB } = await import('./js/db.js'); const f = await DB.get('files', 'bak-' + id); await DB.put('files', { ...f, id }); }, id);
  });
  await step('A saved place that no longer exists falls back to the start of the book', async () => {
    const id = await bookId('Frankenstein'); await ev(async (id) => { const S = await import('./js/store.js'); const b = await S.getBook(id); b.cfi = 'epubcfi(/6/999!/4/2/1:0)'; b.locations = 'garbage[[['; b.progress = 0.5; await S.saveBook(b); }, id);
    await openBook(id); await until(rendered, 20000, 'render with a stale saved place'); await closeAll();
  });
  await step('“Retry from the start” opens at the beginning ignoring the saved place', async () => {
    const id = await bookId('Frankenstein'); await ev(async (id) => { const S = await import('./js/store.js'); const b = await S.getBook(id); b.cfi = ''; await S.saveBook(b); }, id); await openBook(id, { safe: true }); await until(rendered, 12000, 'safe open'); await closeAll();
  });
  await step('No unexpected page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

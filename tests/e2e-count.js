// v0.5.0 Library count footer: "N books" at the bottom of the All view and of each shelf / status chip, "N of M books" while a search (or the hidden-Finished
// option) narrows the list, singular "1 book", and it updates live after adding / deleting / moving books.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const FILES = ['frankenstein.epub', 'saga-1.epub', 'saga-2.epub', 'saga-3.epub', 'standalone.epub', 'test-doc.pdf'];
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); await page.goto(URL, { waitUntil: 'networkidle0' });
  const foot = () => page.evaluate(() => { const e = document.querySelector('#lib-body > #lib-count, #lib-count'); return e ? e.innerText : null; });
  const waitFoot = async (want, t = 6000) => { const end = Date.now() + t; let v; while (Date.now() < end) { v = await foot(); if (v === want) return v; await sleep(100); } throw new Error(`footer is "${v}", wanted "${want}"`); };
  const chip = async (id) => { await page.evaluate((id) => document.querySelector(`.chip[data-chip="${id}"]`).click(), id); await sleep(400); };
  const search = async (q) => { await page.$eval('input.search', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); if (q) await page.type('input.search', q); await sleep(300); };
  const nBooks = () => page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length);
  const show = async () => { await page.evaluate(() => window.__folio.show('library')); await sleep(500); };

  await step('No footer on the empty library', async () => { await show(); assert((await foot()) === null, 'footer on empty library'); });
  await step('All view: "6 books" after importing 6', async () => {
    await (await page.$('#file-input')).uploadFile(...FILES.map(fx)); for (let i = 0; i < 80 && (await nBooks()) < 6; i++) await sleep(300); await show(); await waitFoot('6 books');
    assert(await page.evaluate(() => { const f = document.querySelector('#lib-count'); const b = document.querySelector('#lib-body'); return b.lastElementChild === f; }), 'footer must be the last thing in the library body');
  });
  await step('Search: "N of M books"; no match: "0 of 6 books"; cleared: "6 books"', async () => {
    await search('saga'); await waitFoot('3 of 6 books'); await search('zzzz-none'); await waitFoot('0 of 6 books'); assert(/No matches/.test(await page.$eval('#lib-body', (e) => e.innerText)), 'no-matches text'); await search(''); await waitFoot('6 books');
  });
  await step('Hidden Finished books count as a filter ("5 of 6 books"), shown again → "6 books"', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Frankenstein/i.test(x.title)); await S.setStatus(b.id, 'finished'); });
    await waitFoot('6 books'); await page.evaluate(async () => (await import('./js/settings.js')).settings.set({ showFinished: false })); await page.evaluate(() => window.__folio.show('library')); await sleep(500); await waitFoot('5 of 6 books');
    await page.evaluate(async () => (await import('./js/settings.js')).settings.set({ showFinished: true })); await show(); await waitFoot('6 books');
  });
  let shelf;
  await step('Status chips and a custom shelf have their own footer; singular "1 book"', async () => {
    shelf = await page.evaluate(async () => { const S = await import('./js/store.js'); const sh = await S.createShelf('Favourites'); const bs = await S.getBooks(); await S.addToShelfMany(bs.filter((b) => /Saga Book (One|Two)/i.test(b.title)).map((b) => b.id), sh.id); return sh.id; });
    await show(); await chip('finished'); await waitFoot('1 book'); await chip(shelf); await waitFoot('2 books'); await search('two'); await waitFoot('1 of 2 books'); await search(''); await waitFoot('2 books'); await chip('want'); await waitFoot('5 books');
  });
  await step('Live update: deleting a book on a shelf lowers the count; adding a book raises it (no manual refresh)', async () => {
    await chip(shelf); await waitFoot('2 books');
    await page.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Saga Book One/i.test(x.title)); await S.deleteBooks([b.id]); }); await waitFoot('1 book');
    await chip('all'); await waitFoot('5 books'); await (await page.$('#file-input')).uploadFile(fx('saga-1.epub')); await waitFoot('6 books', 15000);
    await page.evaluate(async () => { const S = await import('./js/store.js'); await S.deleteBooks((await S.getBooks()).slice(0, 2).map((b) => b.id)); }); await waitFoot('4 books');
  });
  await step('Delete all returns to the empty state (no footer)', async () => { await page.evaluate(async () => (await import('./js/store.js')).deleteAllBooks()); await sleep(600); assert((await foot()) === null, 'footer should be gone'); });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

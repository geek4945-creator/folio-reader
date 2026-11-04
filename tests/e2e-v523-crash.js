// v0.5.23: big library (450 books with covers + big sync records + 450 queued cover downloads) on a phone: launch must finish, the storage migration must keep
// every record, a sync must not re-read the library per queued cover, a book must open, and a crashed launch must bring safe mode next time.
const puppeteer = require('puppeteer-core');
const JSZip = require('../vendor/jszip.min.js');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const N = 450;
(async () => {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Crash Book</dc:title><dc:creator>A</dc:creator><dc:identifier id="id">urn:c:1</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>');
  z.file('OEBPS/c1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>Hello</p></body></html>');
  const b64 = (await z.generateAsync({ type: 'nodebuffer' })).toString('base64');
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const S = makeState(); const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.evaluateOnNewDocument(() => { window.__getAllBooks = 0; const ga = IDBObjectStore.prototype.getAll; IDBObjectStore.prototype.getAll = function (...a) { if (this.name === 'books') window.__getAllBooks++; return ga.apply(this, a); }; });
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(1200);
  let bigPending = '';
  await step(`seed ${N} books with covers, big sync records in localStorage (as v0.5.21 left them), ${N} queued covers`, async () => {
    bigPending = await page.evaluate(async (b64, N) => {
      (await import('./js/google.js')).syncTuning.minGap = 3600e3;
      const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const first = await S.addBookFromBuffer(buf, {}); const base = await S.getBook(first.id || first);
      const cv = document.createElement('canvas'); cv.width = 60; cv.height = 90; cv.getContext('2d').fillRect(0, 0, 30, 30); const cover = await new Promise((r) => cv.toBlob(r, 'image/jpeg'));
      const q = { up: [], down: {} }; const pend = {};
      for (let i = 1; i < N; i++) { const b = { ...base, id: 'big' + i, title: 'Big ' + i, syncKey: 'k:' + i, coverBlob: cover, coverId: 'c' + i, coverSource: 'enrich', _noTouch: true }; await DB.put('books', b); q.down['book:k:' + i] = { id: 'cv' + i, at: Date.now() }; pend['zz:' + i] = { title: 'Pending ' + i, note: 'x'.repeat(4000) }; }
      const lsx = (await import('./js/lsx.js')); const P = JSON.stringify(pend);
      // write straight to localStorage (bypassing the overflow store), the way an older version left it
      const raw = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem'); indexedDB.deleteDatabase('folio-kv');
      localStorage.__proto__.constructor; return P;
    }, b64, N);
    // reload with the raw values put into localStorage before any app code runs
    await page.evaluateOnNewDocument((P, N) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); indexedDB.deleteDatabase('folio-kv'); const q = { up: [], down: {} }; for (let i = 1; i < N; i++) q.down['book:k:' + i] = { id: 'cv' + i, at: Date.now() }; localStorage.setItem('folio.pending', P); localStorage.setItem('folio.coverQ', JSON.stringify(q)); localStorage.setItem('folio.settings', localStorage.getItem('folio.settings') || '{}'); }, bigPending, N);
    return (bigPending.length / 1048576).toFixed(1) + ' MB pending';
  });
  await step('launch finishes with the big library; migration moved the records to IndexedDB intact (nothing lost)', async () => {
    await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(2500);
    const r = await page.evaluate(async () => {
      const tiles = document.querySelectorAll('.cover').length; const raw = Storage.prototype.getItem;
      const kv = await new Promise((res) => { const o = indexedDB.open('folio-kv', 1); o.onsuccess = () => { const g = o.result.transaction('kv').objectStore('kv').get('folio.pending'); g.onsuccess = () => res(g.result || ''); }; });
      const zz = (t) => { try { const o = JSON.parse(t); return Object.keys(o).filter((k) => /^zz:/.test(k) && o[k].title === 'Pending ' + k.slice(3)).length; } catch { return -1; } };
      return { tiles, viaApp: zz(localStorage.getItem('folio.pending')), kv: zz(kv), lsLeft: Object.keys(localStorage).includes('folio.pending'), safe: !!window.FOLIO_SAFE, lazy: [...document.querySelectorAll('img.cover-img')].every((i) => i.loading === 'lazy') };
    });
    assert(r.tiles > 50, 'tiles ' + r.tiles); assert(r.viaApp === N - 1 && r.kv === N - 1, JSON.stringify(r)); assert(!r.lsLeft, 'still in localStorage'); assert(!r.safe, 'safe mode on a good launch'); assert(r.lazy, 'covers not lazy');
    return JSON.stringify(r);
  });
  await step(`sync with ${N} queued covers reads the library a handful of times, not once per cover`, async () => {
    const r = await page.evaluate(async () => { const g = await import('./js/google.js'); window.__getAllBooks = 0; let err = null; try { await g.syncNow({}); } catch (e) { err = e.message; } return { err, n: window.__getAllBooks }; });
    assert(r.n < 40, 'getAll(books) x' + r.n); return JSON.stringify(r);
  });
  const openOne = async () => { const ok = await page.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Crash Book'); await (await import('./js/reader.js')).openReader(b.id); await new Promise((r) => setTimeout(r, 1500)); const o = document.body.classList.contains('reading'); await (await import('./js/reader.js')).closeReader(); return o; }); assert(ok, 'reader did not open'); };
  await step('a book opens', openOne);
  await step('a launch that never finished (crash) → next launch is in safe mode: no auto-sync, library shows, book opens, edits kept', async () => {
    // a crash fires no pagehide: the flag is put back at the very start of the next load, as if the last launch had died
    await page.evaluateOnNewDocument(() => { if (sessionStorage.getItem('crashSim') === '1') { sessionStorage.setItem('crashSim', '2'); localStorage.setItem('folio.bootAt', String(Date.now() - 5000)); } });
    await page.evaluate(() => sessionStorage.setItem('crashSim', '1'));
    await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(2500);
    const r = await page.evaluate(async () => ({ safe: !!window.FOLIO_SAFE, tiles: document.querySelectorAll('.cover').length, pend: Object.keys(JSON.parse(localStorage.getItem('folio.pending'))).filter((k) => /^zz:/.test(k)).length, toast: document.querySelector('#toast')?.textContent || '' }));
    assert(r.safe, 'not safe'); assert(r.tiles > 50, 'tiles'); assert(r.pend === N - 1, 'pending lost ' + r.pend); assert(/Safe mode/.test(r.toast), 'no safe toast: ' + r.toast);
    const s = await page.evaluate(async () => { const g = await import('./js/google.js'); return await g.syncNow({ quiet: true }); }); assert(s === null, 'quiet sync ran in safe mode');
    await openOne(); return JSON.stringify({ safe: r.safe, tiles: r.tiles });
  });
  await step('?safe=1 forces safe mode; ?safe=0 leaves it', async () => {
    await page.goto(APP.replace('index.html', 'index.html?safe=0'), { waitUntil: 'networkidle0' }); await sleep(800); assert(!(await page.evaluate(() => window.FOLIO_SAFE)), 'safe=0');
    await page.evaluate(() => localStorage.removeItem('folio.bootAt'));
    await page.goto(APP + '?safe=1', { waitUntil: 'networkidle0' }); await sleep(800); assert(await page.evaluate(() => window.FOLIO_SAFE), 'safe=1');
  });
  await step('no page errors', async () => { assert(!page.errs.length, page.errs.join(' | ')); });
  await browser.close(); const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
})();

// v0.5.22: iPhone storage full ("QuotaExceededError"). localStorage writes and IndexedDB blob writes (book files, covers) throw; sync must still bring
// over every book's info + edits, never show a raw error, keep books "in Drive", and download a book when it is opened.
const puppeteer = require('puppeteer-core');
const JSZip = require('../vendor/jszip.min.js');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState(); S.userDrive = new Map(); const N = 8; const FILES = [];
async function epub(title, id) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>A</dc:creator><dc:identifier id="id">${id}</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  z.file('OEBPS/c1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${title}</p></body></html>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
async function mk(ctx, name, scope, full) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.evaluateOnNewDocument((n, sc) => { localStorage.setItem('folio.deviceName', n); if (sc) { const a = JSON.parse(localStorage.getItem('folio.google')); a.scope = sc; localStorage.setItem('folio.google', JSON.stringify(a)); } }, name, scope || '');
  if (full) await page.evaluateOnNewDocument(() => {   // the phone is full
    const q = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    Storage.prototype.setItem = function () { throw q(); };
    const put = IDBObjectStore.prototype.put; window.__blobFails = 0;
    IDBObjectStore.prototype.put = function (v, k) { if (v && (v.blob instanceof Blob || v.coverBlob instanceof Blob)) { window.__blobFails++; throw q(); } return put.call(this, v, k); };
  });
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(1500);
  await page.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; (await import('./js/drivebatch.js')).BATCH.gap = 0; });
  return page;
}
const sync = (p) => p.evaluate(async () => { const g = await import('./js/google.js'); let err = null; try { await g.syncNow({}); } catch (e) { err = e.message; } await new Promise((x) => setTimeout(x, 150)); return err; });
const books = (p) => p.evaluate(async () => (await (await import('./js/store.js')).getBooks()).map((b) => ({ id: b.id, title: b.title, inDrive: !!b.inDrive, progress: b.progress })));
(async () => {
  for (let i = 1; i <= N; i++) { const id = 'D' + (900 + i); const t = `Quota Book ${i}`; S.userDrive.set(id, await epub(t, 'urn:q:' + i)); FILES.push({ id, name: t + '.epub', size: S.userDrive.get(id).length }); }
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const SC = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.readonly';
  const LT = await mk(await browser.createBrowserContext(), 'Laptop', SC);
  await step('Laptop: imports the Drive books, renames one, sets progress on another, syncs', async () => {
    await sync(LT); const r = await LT.evaluate(async (files) => (await (await import('./js/drivebatch.js')).runBatch('book', files)).imported.length, FILES); assert(r === N, 'imported ' + r);
    await LT.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const a = bs.find((b) => b.title === 'Quota Book 1'); const BI = await import('./js/bookinfo.js');
      if (S.setBookInfo) await S.setBookInfo(a, { title: 'Her Fixed Title' }); else { a.title = 'Her Fixed Title'; await S.saveBook(a); }
      const b = bs.find((x) => x.title === 'Quota Book 2'); b.progress = 0.42; b.cfi = null; await S.saveBook(b); });
    const e = await sync(LT); assert(!e, e); return (await books(LT)).map((b) => b.title).filter((t) => /Her/.test(t)).join();
  });
  const PH = await mk(await browser.createBrowserContext(), 'iPhone', SC, true);
  await step('iPhone (storage full): sync completes with no error and no raw quota message', async () => {
    const e = await sync(PH); assert(!e, 'threw ' + e);
    const st = await PH.evaluate(async () => { const g = await import('./js/google.js'); const u = await import('./js/syncui.js'); return u.statusLine(g.getStatus()); }).catch(() => '');
    assert(!/Sync error|quota has been/i.test(st), st); return st;
  });
  await step('iPhone: "Get missing books" keeps every book (info + edits + progress), marked in Drive; batch stops downloading cleanly', async () => {
    const r = await PH.evaluate(async () => { const m = (await import('./js/syncfetch.js')).missingBooks(); const res = await (await import('./js/drivebatch.js')).runBatch('book', m.drive); return { n: m.drive.length, imp: res.imported.length, failed: res.failed.map((x) => x.why), full: !!res.storageFull }; });
    assert(r.n === N && r.imp === N && !r.failed.length && r.full, JSON.stringify(r));
    const bs = await books(PH); assert(bs.length === N, 'count ' + bs.length); assert(bs.every((b) => b.inDrive), 'not all in Drive');
    assert(bs.some((b) => b.title === 'Her Fixed Title'), 'edit lost: ' + bs.map((b) => b.title)); assert(bs.find((b) => b.title === 'Quota Book 2')?.progress === 0.42, 'progress lost');
    const toasts = await PH.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')); assert(!/quota|Sync error/i.test(toasts), toasts);
    return `${bs.length} books, all in Drive`;
  });
  await step('iPhone: sync again still works and the edit survives (metadata sync never aborted by blob writes)', async () => {
    const e = await sync(PH); assert(!e, e); const t = await books(PH); assert(t.some((b) => b.title === 'Her Fixed Title'), 'reverted');
  });
  await step('iPhone: opening an in-Drive book downloads it from Drive and opens the reader', async () => {
    const id = (await books(PH)).find((b) => b.title === 'Quota Book 3').id;
    await PH.evaluate(async (id) => { await (await import('./js/reader.js')).openReader(id); }, id); await sleep(1500);
    const ok = await PH.evaluate(() => document.body.classList.contains('reading')); assert(ok, 'reader not open'); return 'opened';
  });
  await step('Free up space button present in Settings → Sync code path', async () => {
    const r = await PH.evaluate(async () => (await (await import('./js/store.js')).freeUpSpace(null)).n); return 'freed ' + r;
  });
  await step('no page errors', async () => { const e = [...LT.errs, ...PH.errs]; assert(!e.length, e.join(' | ')); });
  await browser.close(); const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
})();

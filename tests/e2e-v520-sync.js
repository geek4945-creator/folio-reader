// v0.5.20 sync at scale: hundreds of books added from a Google Drive folder on a laptop must all show up on the iPhone.
// Laptop imports 240 books from (fake) Drive files; iPhone already had 120 of them. The iPhone sees the counts, a "N books aren't on this device yet"
// banner, and downloads the rest from the same Drive files (read-only access asked on tap), each linking to the laptop's shelves. Also: books that
// shared one sync key (same ID, different titles) stay separate; big library files use resumable uploads; a major conflict asks Keep / Use / Merge on the
// library screen (never inside a book) and can remember the choice; Settings → Sync shows Sync now + counts.
const puppeteer = require('puppeteer-core');
const JSZip = require('../vendor/jszip.min.js');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState(); const C = S.cloud; S.userDrive = new Map();
const N = 240, HALF = 120;
async function epub(title, author, id) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>${id ? `<dc:identifier id="id">${id}</dc:identifier>` : ''}<dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  z.file('OEBPS/c1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${title}</p></body></html>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
const FILES = [];
async function mk(ctx, name, scope) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.evaluateOnNewDocument((n, sc) => { localStorage.setItem('folio.deviceName', n); if (sc) { const a = JSON.parse(localStorage.getItem('folio.google')); a.scope = sc; localStorage.setItem('folio.google', JSON.stringify(a)); } }, name, scope || '');
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(2000);
  await page.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; (await import('./js/drivebatch.js')).BATCH.gap = 0; });
  return page;
}
const sync = (p, o = {}) => p.evaluate(async (o) => { const g = await import('./js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 150)); return r; }, o);
const count = (p) => p.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length);
const runBatch = (p, files) => p.evaluate(async (files) => { const r = await (await import('./js/drivebatch.js')).runBatch('book', files); return { imported: r.imported.length, skipped: r.skipped.length, failed: r.failed.map((x) => x.why) }; }, files);
const realBooks = () => Object.values(C.json('folio-sync.json').books).filter((b) => b.title !== undefined);
const setStatusOf = (p, titles, status) => p.evaluate(async (titles, status) => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) if (titles.includes(b.title)) { b.status = status; if (status === 'finished') b.finishedAt = Date.now(); await DB_put(b); } async function DB_put(b) { await S.saveBook(b); } }, titles, status);
const statusOf = (p, t) => p.evaluate(async (t) => (await (await import('./js/store.js')).getBooks()).find((b) => b.title === t)?.status, t);

(async () => {
  for (let i = 1; i <= N; i++) { const id = 'D' + i; const t = `Haley Book ${String(i).padStart(3, '0')}`; S.userDrive.set(id, await epub(t, 'Author ' + (i % 17), i <= 2 ? 'urn:same-id' : i <= 4 ? '' : 'urn:hb:' + i)); FILES.push({ id, name: t + '.epub', size: S.userDrive.get(id).length }); }
  // books 1+2 share one identifier (different titles); books 3+4 have no identifier (unique title|author)
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const PH = await mk(await browser.createBrowserContext(), 'iPhone');
  await step(`iPhone: imports the first ${HALF} books from the Drive folder itself and syncs (the "about half" she sees)`, async () => {
    const r = await runBatch(PH, FILES.slice(0, HALF)); assert(r.imported === HALF, JSON.stringify(r));
    await sync(PH); assert(realBooks().length === HALF, 'cloud ' + realBooks().length); return `${r.imported} imported, cloud ${realBooks().length}`;
  });
  const LT = await mk(await browser.createBrowserContext(), 'Chrome on Laptop', 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.readonly');
  await step(`Laptop: imports all ${N} from the same folder, puts them on a shelf; the library file is big → resumable upload; every book carries its Drive file id`, async () => {
    await sync(LT);
    const r = await runBatch(LT, FILES); assert(r.imported === N && !r.failed.length, JSON.stringify(r));
    const ids = await LT.evaluate(async () => { const S = await import('./js/store.js'); const sh = await S.createShelf ? await S.createShelf('Haley’s') : null; return sh && sh.id; });
    if (ids) await LT.evaluate(async (sid) => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) { b.shelves = [...new Set([...(b.shelves || []), sid])]; await S.saveBook(b); } }, ids);
    await LT.evaluate(async () => { (await import('./js/google.js')).uploadTuning.resumableOver = 20000; });
    const before = C.resumable || 0; await sync(LT);
    const rb = realBooks(); assert(rb.length === N, 'cloud has ' + rb.length + ' of ' + N);
    assert(rb.every((b) => b.src && b.src.kind === 'gdrive' && /^D\d+$/.test(b.src.id)), 'src: ' + JSON.stringify(rb.find((b) => !b.src?.id)));
    const keys = Object.keys(C.json('folio-sync.json').books).filter((k) => /same-id/.test(k)); assert(keys.length === 2, 'same-ID books separate: ' + keys.join(' , '));
    assert((C.resumable || 0) > before, 'resumable used'); return `cloud ${rb.length} books, shelf ${!!ids}, resumable uploads ${C.resumable}`;
  });
  await step('iPhone: Sync → counts "This device 120 · Synced library 240 · 120 not on this device"; library banner offers to get them; no conflict prompt (different books)', async () => {
    const r = await sync(PH); assert(!r.conflict, 'no conflict'); const c = await PH.evaluate(async () => (await import('./js/google.js')).syncCounts());
    assert(c.local === HALF && c.cloud === N && c.missing === N - HALF, JSON.stringify(c));
    await PH.evaluate(() => { location.hash = '#/library'; }); await sleep(600);
    const txt = await PH.$eval('#sync-missing', (e) => e.textContent); assert(txt.includes(String(N - HALF)), txt);
    return txt;
  });
  await step('iPhone: "Get them" → "Allow Drive access & download 120" → read-only Drive access is asked once, all 120 download, each links to the laptop shelf', async () => {
    await PH.click('#sync-missing-open'); await PH.waitForSelector('#sm-download'); const label = await PH.$eval('#sm-download', (e) => e.textContent); assert(/Allow Drive access/.test(label) && label.includes(String(N - HALF)), label);
    await PH.click('#sm-download'); await PH.waitForSelector('#dv-summary', { timeout: 240000 }); const sum = await PH.$eval('#dv-summary', (e) => e.textContent);
    await PH.click('#dv-done'); assert(await count(PH) === N, 'iPhone has ' + await count(PH));
    const onShelf = await PH.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); return bs.filter((b) => b.shelves && b.shelves.length).length; });
    assert(onShelf === N, 'on shelf: ' + onShelf);
    const scope = await PH.evaluate(async () => (await import('./js/google.js')).canBrowseDrive()); assert(scope, 'scope granted');
    await sync(PH); const c = await PH.evaluate(async () => (await import('./js/google.js')).syncCounts()); assert(c.missing === 0 && c.local === N, JSON.stringify(c));
    assert(!(await PH.$('#sync-missing')), 'banner gone'); return sum.trim() + ` · ${onShelf} on the shelf`;
  });
  await step('Settings → Account & sync: Sync now, last synced time and the book counts', async () => {
    await PH.evaluate(() => window.__folio.show('settings')); await PH.waitForSelector('#sync-details'); await sleep(500);
    const t = await PH.$eval('#sync-counts', (e) => e.textContent); assert(t.includes('This device: ' + N) && t.includes('Synced library: ' + N), t);
    await PH.click('#sync-now'); await sleep(1500); const st = await PH.$eval('#sync-status', (e) => e.textContent); assert(/Last synced/.test(st), st); return t + ' · ' + st;
  });
  const T12 = FILES.slice(10, 22).map((f) => f.name.replace(/\.epub$/, ''));
  await step('Major conflict: both devices change the same 12 books differently → iPhone asks (names both devices), changes nothing until a choice; not inside a book', async () => {
    await sync(LT);
    await setStatusOf(LT, T12, 'finished'); await sync(LT);
    await setStatusOf(PH, T12, 'reading');
    await PH.evaluate(() => document.body.classList.add('reading'));
    const r = await sync(PH); assert(r && r.conflict && r.conflict.books === 12, JSON.stringify(r && r.conflict));
    await sleep(500); assert(!(await PH.$('#sync-conflict')), 'not shown while reading');
    assert(await statusOf(PH, T12[0]) === 'reading', 'nothing applied yet');
    await PH.evaluate(() => { document.body.classList.remove('reading'); window.dispatchEvent(new Event('reader-closed')); }); await PH.waitForSelector('#sync-conflict', { timeout: 4000 });
    const t = await PH.$eval('#sync-conflict', (e) => e.textContent); assert(t.includes('Chrome on Laptop') && t.includes('iPhone') && t.includes('Merge both (recommended)') && t.includes('Keep this device') && t.includes('Use the other device (cloud)'), t);
    return t.slice(0, 160);
  });
  await step('"Keep this device" → iPhone’s values win everywhere (laptop follows on its next sync)', async () => {
    await PH.click('#sc-local'); await sleep(1500);
    assert(await statusOf(PH, T12[0]) === 'reading', 'iPhone kept'); const cb = realBooks().find((b) => b.title === T12[0]); assert(cb.status === 'reading', 'cloud: ' + cb.status);
    await sync(LT); assert(await statusOf(LT, T12[3]) === 'reading', 'laptop: ' + await statusOf(LT, T12[3]));
    assert(!(await PH.evaluate(async () => (await import('./js/google.js')).pendingConflict())), 'cleared'); return 'reading on both';
  });
  await step('"Use the other device (cloud)" + Remember → the cloud wins; the next big conflict is resolved the same way without asking', async () => {
    await setStatusOf(LT, T12, 'finished'); await sync(LT); await setStatusOf(PH, T12, 'want');
    let r = await sync(PH); assert(r.conflict, 'asks');
    await PH.evaluate(async () => (await import('./js/syncfetch.js')).maybeShowConflict(true)); await PH.waitForSelector('#sc-remember');
    await PH.click('#sc-remember'); await PH.click('#sc-cloud'); await sleep(1500);
    assert(await statusOf(PH, T12[0]) === 'finished', 'cloud won: ' + await statusOf(PH, T12[0]));
    await setStatusOf(LT, T12, 'reading'); const rl = await sync(LT); assert(!rl.conflict, 'the laptop sees no fake conflict from the iPhone’s choice'); await setStatusOf(PH, T12, 'want');
    r = await sync(PH); assert(!r.conflict, 'remembered: no prompt'); assert(await statusOf(PH, T12[5]) === 'reading', 'cloud again: ' + await statusOf(PH, T12[5]));
    await PH.evaluate(() => window.__folio.show('settings')); await PH.waitForSelector('#sync-details'); await sleep(500); const pref = await PH.$eval('#sync-conflict-pref', (e) => e.textContent); assert(/Use the other device/.test(pref), pref);
    await PH.click('#sync-conflict-ask'); assert(!(await PH.evaluate(async () => (await import('./js/google.js')).conflictPref())), 'ask again'); return pref;
  });
  await step('Merge both: a few books changed on both sides → no prompt (below the threshold), newest change wins per book', async () => {
    await setStatusOf(PH, [T12[0]], 'want'); await sleep(20); await setStatusOf(LT, [T12[0]], 'finished'); await sync(LT);
    const r = await sync(PH); assert(!r.conflict, 'small: merged quietly'); assert(await statusOf(PH, T12[0]) === 'finished', 'newest (laptop) wins'); return 'ok';
  });
  await step('Edits made while a long sync runs are not overwritten by it (records re-read before writing)', async () => {
    await setStatusOf(LT, [T12[1]], 'finished'); await sync(LT);
    const st = await PH.evaluate(async (t) => { const S = await import('./js/store.js'); const G = await import('./js/google.js'); const p = G.syncNow({ force: true });
      const b = (await S.getBooks()).find((x) => x.title === t); b.overrides = { fontSizePt: 22 }; await S.saveBook(b); await p; await new Promise((r) => setTimeout(r, 200)); return (await S.getBooks()).find((x) => x.title === t).overrides; }, T12[2]);
    assert(st && st.fontSizePt === 22, JSON.stringify(st)); return JSON.stringify(st);
  });
  const errs = [PH.errs, LT.errs]; console.log('  page errors:', JSON.stringify(errs));
  await browser.close();
  const ok = results.filter((r) => r[0]).length; console.log(`\n${ok}/${results.length} passed`); process.exit(ok === results.length && !errs.flat().length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

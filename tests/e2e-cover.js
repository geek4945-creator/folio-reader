// v0.4.0 "Change cover": device picker, Google Drive image picker, pasted URL (via the proxy when CORS blocks), search covers (Open Library + Google Books,
// optional Google Custom Search), Google Images in a new tab, crop / centre preview, ~400 px JPEG, user-set protection, sync through Drive appData, revert.
const puppeteer = require('puppeteer-core'); const path = require('path');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const img = (n) => path.join(__dirname, 'fixtures', 'img', n); const S = makeState();

async function mk(ctx, { login = false } = {}) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); await install(page, S); if (login) await page.evaluateOnNewDocument(fakeLogin());
  await page.goto(APP, { waitUntil: 'networkidle0' }); await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`);
  await page.evaluate(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push({ u, t, f }); return null; }; });
  return page;
}
const getItem = (page, title, store = 'books') => page.evaluate(async (title, store) => { const { DB } = await import('/js/db.js'); const b = (await DB.all(store)).find((x) => x.title === title); if (!b) return null; const o = { ...b }; if (o.coverBlob) { const bmp = await createImageBitmap(o.coverBlob); o.cover = { w: bmp.width, h: bmp.height, type: o.coverBlob.type, size: o.coverBlob.size }; const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const px = (x, y) => [...g.getImageData(Math.min(x, c.width - 1), Math.min(y, c.height - 1), 1, 1).data].slice(0, 3); o.cover.left = px(20, Math.floor(c.height / 2)); o.cover.right = px(c.width - 20, Math.floor(c.height / 2)); } delete o.coverBlob; return o; }, title, store);
const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
const setVal = (page, sel, v) => page.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const tileMenu = async (page, title) => { await page.evaluate((t) => { const tile = [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.t')?.innerText === t); if (!tile) throw new Error('no tile ' + t); tile.querySelector('.tile-more').click(); }, title); await sleep(200); };
const openEditor = async (page, title, audio = false) => { await tileMenu(page, title); await click(page, audio ? '#audio-menu-cover' : '#menu-change-cover'); await page.waitForSelector('#cover-opt-device'); };
const waitSheetsGone = (page) => page.waitForFunction(() => !document.querySelector('.sheet'), { timeout: 8000 });
const closeSheets = (page) => page.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; });
const syncNow = (page) => page.evaluate(async () => { const g = await import('/js/google.js'); const r = await g.syncNow(); await new Promise((x) => setTimeout(x, 250)); return r; });
const waitFor = async (page, fn, arg, t = 10000) => { const end = Date.now() + t; while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(120); } throw new Error('timeout: ' + fn.toString().slice(0, 140)); };
const red = (p) => p[0] > 150 && p[2] < 110, blue = (p) => p[2] > 150 && p[0] < 110;
async function applyCrop(page, { x, zoom, keep } = {}) {
  await page.waitForSelector('#crop-apply'); if (x != null) await setVal(page, '#crop-x', x); if (zoom != null) await setVal(page, '#crop-zoom', zoom); if (keep) await click(page, '#crop-keep'); await sleep(100); await click(page, '#crop-apply'); await waitSheetsGone(page); await sleep(300);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const A = await mk(await browser.createBrowserContext(), { login: true });
  const seed = async (p) => { for (const o of [{ title: 'Cover Book', author: 'Cora Author', cover: true }, { title: 'Plain Book', author: 'Pat Plain' }, { title: 'The Test Odyssey', author: 'Ada Writer' }]) await p.evaluate((o) => window.__mk(o), o); await p.evaluate(() => window.__folio.show('library')); await sleep(500); };
  await seed(A);
  await A.evaluate(async () => { const f = new File([await (await fetch('./tests/fixtures/audio/tone.ogg')).arrayBuffer()], 'tone.ogg', { type: 'audio/ogg' }); await (await import('/js/audiostore.js')).importAudioFiles([f], 'each'); });
  let fileCover;

  await step('Crop geometry (pure): frame is 2:3, zoom halves the window, centre / edges map to the right pixels', async () => {
    const r = await A.evaluate(async () => { const C = await import('/js/covers.js'); return { a: C.cropRect(800, 400, { cx: 0 }), b: C.cropRect(800, 400, { cx: 1 }), c: C.cropRect(800, 400, { zoom: 2 }), d: C.cropRect(300, 900, {}) }; });
    const near = (a, b) => Math.abs(a - b) < 0.01; assert(near(r.a.sx, 0) && near(r.a.sw, 266.67) && near(r.a.sh, 400) && near(r.b.sx, 533.33) && near(r.c.sw, 133.33) && near(r.c.sx, 333.33) && near(r.d.sw, 300) && near(r.d.sh, 450) && near(r.d.sy, 225), JSON.stringify(r)); return 'ok';
  });

  await step('Menu: "Change cover…" offers device / Drive / URL / search; "Revert" only when there is a cover', async () => {
    await openEditor(A, 'Plain Book'); const ids = await A.$$eval('.sheet .list-item', (e) => e.map((x) => x.id)); assert(['cover-opt-device', 'cover-opt-drive', 'cover-opt-url', 'cover-opt-search'].every((i) => ids.includes(i)) && !ids.includes('cover-opt-revert'), ids.join()); await closeSheets(A);
    await openEditor(A, 'Cover Book'); assert(await A.$('#cover-opt-revert'), 'revert missing for a book with a cover'); await closeSheets(A);
    const cb = await getItem(A, 'Cover Book'); fileCover = cb.cover; assert(cb.coverSource === 'file' && cb.cover.w === 300 && cb.cover.h === 450, JSON.stringify(cb.cover)); return 'embedded cover is ' + cb.cover.w + 'x' + cb.cover.h;
  });

  await step('Pick from device: crop preview, left/right position changes the result, ~400 px JPEG, saved as user-set', async () => {
    await openEditor(A, 'Plain Book'); await (await A.$('#cover-file')).uploadFile(img('wide.png')); await A.waitForSelector('#crop-frame'); assert(await A.$('#crop-zoom') && await A.$('#crop-x') && await A.$('#crop-y') && await A.$('#crop-keep'), 'crop controls missing');
    const w = await A.$eval('#crop-img', (e) => parseFloat(e.style.width)); const left0 = await A.$eval('#crop-img', (e) => parseFloat(e.style.left)); assert(w > 200 && Math.abs(left0 + (w - 200) / 2) < 1.5, `preview not centred: w=${w} left=${left0}`);
    await applyCrop(A, { x: 0 }); let it = await getItem(A, 'Plain Book'); assert(it.cover.type === 'image/jpeg' && it.cover.w === 400 && it.cover.h === 600 && red(it.cover.left) && red(it.cover.right) , JSON.stringify(it.cover));
    assert(it.coverSource === 'user' && it.userSet.cover === true && it.metaAt.cover > 0 && it.cover.size < 120000, JSON.stringify({ s: it.coverSource, u: it.userSet }));
    await openEditor(A, 'Plain Book'); await (await A.$('#cover-file')).uploadFile(img('wide.png')); await applyCrop(A, { x: 100 }); it = await getItem(A, 'Plain Book'); assert(blue(it.cover.left) && blue(it.cover.right), 'cx=1 should show the blue half: ' + JSON.stringify(it.cover));
    assert(await A.$('.tile .cover-img') !== null, 'library tile shows the cover'); return 'left → red, right → blue, 400x600';
  });

  await step('"Keep the whole image" skips cropping (400x200 for a 2:1 picture); an unreadable file gives a friendly error', async () => {
    await openEditor(A, 'Plain Book'); await (await A.$('#cover-file')).uploadFile(img('wide.png')); await applyCrop(A, { keep: true }); const it = await getItem(A, 'Plain Book'); assert(it.cover.w === 400 && it.cover.h === 200, JSON.stringify(it.cover));
    await openEditor(A, 'Plain Book'); await (await A.$('#cover-file')).uploadFile(path.join(__dirname, 'fixtures', 'audio', 'story-01.mp3')); await waitFor(A, () => /read that image/i.test(document.querySelector('#toast')?.innerText || '')); await closeSheets(A); return 'ok';
  });

  await step('Paste an image URL: CORS-less host goes through the proxy; CORS-enabled host direct; an HTML page is refused', async () => {
    await openEditor(A, 'Plain Book'); await click(A, '#cover-opt-url'); await A.type('#cover-url', 'https://img.example.test/cover.jpg'); await click(A, '#cover-url-go'); await A.waitForSelector('#crop-apply', { timeout: 10000 });
    assert(S.log.proxy.some((u) => /img\.example\.test/.test(u)), 'expected the proxy to be used: ' + S.log.proxy.join('|')); await applyCrop(A); let it = await getItem(A, 'Plain Book'); assert(it.cover.w === 400 && it.cover.h === 600 && it.coverSource === 'user', JSON.stringify(it.cover));
    const px = S.log.proxy.length; await openEditor(A, 'Plain Book'); await click(A, '#cover-opt-url'); await A.type('#cover-url', 'cors.example.test/wide.png'); await click(A, '#cover-url-go'); await A.waitForSelector('#crop-apply', { timeout: 10000 }); assert(S.log.proxy.length === px, 'CORS-enabled host should not need the proxy'); await click(A, '#crop-back');
    await click(A, '#cover-opt-url'); await A.$eval('#cover-url', (e) => { e.value = ''; }); await A.type('#cover-url', 'https://cors.example.test/page.html'); await click(A, '#cover-url-go'); await waitFor(A, () => /isn’t an image/.test(document.querySelector('#cover-url-err')?.innerText || '')); await closeSheets(A); return 'proxy fallback ok';
  });

  await step('Search covers: Open Library + Google Books candidates; pick one → crop → saved; Google Images button opens a new tab with the right query; no CSE without keys', async () => {
    await openEditor(A, 'The Test Odyssey'); await click(A, '#cover-opt-search'); await A.waitForSelector('#cover-results .cover-cand', { timeout: 15000 }); await sleep(300);
    const c = await A.$$eval('#cover-results .cover-cand', (e) => e.map((x) => x.dataset.src)); assert(c.includes('Open Library') && c.includes('Google Books') && c.length >= 3, c.join()); assert(S.log.cse.length === 0, 'CSE called without keys');
    await click(A, '#cover-google-images'); const op = await A.evaluate(() => window.__opened.slice(-1)[0]); const u = new URL(op.u); assert(u.hostname === 'www.google.com' && u.searchParams.get('tbm') === 'isch' && u.searchParams.get('q') === 'The Test Odyssey Ada Writer book cover' && op.t === '_blank' && /noopener/.test(op.f), JSON.stringify(op));
    assert(await A.$('#cover-search-paste'), 'paste hint missing'); await A.evaluate(() => document.querySelector('#cover-results .cover-cand[data-src="Google Books"]').click()); await A.waitForSelector('#crop-apply', { timeout: 10000 }); await applyCrop(A);
    const it = await getItem(A, 'The Test Odyssey'); assert(it.cover.w === 400 && it.coverSource === 'user' && it.userSet.cover, JSON.stringify(it.cover)); return c.join(',');
  });

  await step('Optional Google Custom Search: only when googleCseKey + googleCseCx are configured', async () => {
    await A.evaluate(() => { window.FOLIO_CONFIG.googleCseKey = 'KEY1'; window.FOLIO_CONFIG.googleCseCx = 'CX1'; });
    await openEditor(A, 'The Test Odyssey'); await click(A, '#cover-opt-search'); await A.waitForSelector('#cover-results .cover-cand'); await sleep(500);
    assert(S.log.cse.length === 1 && /key=KEY1/.test(S.log.cse[0]) && /cx=CX1/.test(S.log.cse[0]) && /searchType=image/.test(S.log.cse[0]), S.log.cse.join()); assert((await A.$$eval('#cover-results .cover-cand', (e) => e.map((x) => x.dataset.src))).includes('Google Images'), 'CSE result missing');
    await closeSheets(A); await A.evaluate(() => { window.FOLIO_CONFIG.googleCseKey = ''; window.FOLIO_CONFIG.googleCseCx = ''; }); return 'ok';
  });

  await step('Pick from Google Drive (images only, reuses the Drive browser)', async () => {
    await A.evaluate(() => window.__folio.show('settings')); await A.waitForSelector('#enable-drive'); await click(A, '#enable-drive'); await waitFor(A, () => /✓/.test(document.querySelector('#enable-drive')?.innerText || '')); await A.evaluate(() => window.__folio.show('library')); await sleep(500);
    await openEditor(A, 'Cover Book'); await click(A, '#cover-opt-drive'); await A.waitForSelector('#drive-list .file', { timeout: 10000 });
    const title = await A.$$eval('.sheet-head strong', (e) => e.map((x) => x.innerText)); assert(title.includes('Google Drive: pictures'), title.join()); assert(S.log.drive.some((q) => /image\//.test(q) && !/epub/i.test(q)), 'image query not used: ' + S.log.drive.join('|'));
    assert(/my-cover\.jpg/.test(await A.$eval('#drive-list', (e) => e.innerText)), 'image not listed'); await click(A, '#drive-list .file .dl'); await A.waitForSelector('#crop-apply', { timeout: 10000 }); await applyCrop(A);
    const it = await getItem(A, 'Cover Book'); assert(it.cover.w === 400 && it.cover.h === 600 && it.coverSource === 'user', JSON.stringify(it.cover)); return 'my-cover.jpg → 400x600';
  });

  await step('Revert to automatic cover: restores the one inside the file; clears the user-set flag', async () => {
    await openEditor(A, 'Cover Book'); await click(A, '#cover-opt-revert'); await waitSheetsGone(A); await sleep(300); const it = await getItem(A, 'Cover Book');
    assert(it.coverSource === 'file' && !it.userSet?.cover && it.cover.w === fileCover.w && it.cover.h === fileCover.h && it.cover.left.every((v, i) => Math.abs(v - fileCover.left[i]) < 25) && it.revertedAt > 0, JSON.stringify({ s: it.coverSource, u: it.userSet, c: it.cover, r: it.revertedAt }));
    await openEditor(A, 'The Test Odyssey'); await click(A, '#cover-opt-revert'); await waitSheetsGone(A); await sleep(300); const od = await getItem(A, 'The Test Odyssey'); assert(!od.cover && od.coverSource === 'file', 'a book without an embedded cover should end up with none'); return 'cover back to ' + it.cover.w + 'x' + it.cover.h;
  });

  await step('Auto-fix never overwrites a user cover (scan, lookup and apply all skip it)', async () => {
    const r = await A.evaluate(async () => { const E = await import('/js/enrich.js'); const { DB } = await import('/js/db.js'); const b = (await DB.all('books')).find((x) => x.title === 'Plain Book');
      const scan = await E.scanLibrary({ audio: false }); const miss = scan.find((x) => x.id === b.id); const before = b.coverBlob.size;
      const w = await E.applyProposal({ kind: 'book', id: b.id, fields: { cover: { value: 'https://covers.openlibrary.org/b/id/111-L.jpg', source: 'x', conf: 1 } } }, { cover: true }); const after = (await DB.get('books', b.id)).coverBlob.size; return { miss: miss?.missing, w, before, after }; });
    assert(!(r.miss || []).includes('cover') && r.w.length === 0 && r.before === r.after, JSON.stringify(r)); return 'protected';
  });

  await step('Audiobooks: Change cover works the same (device pick → user-set → revert)', async () => {
    await A.evaluate(() => window.__folio.show('audiobooks')); await sleep(500); await openEditor(A, 'Ogg Tone', true); await (await A.$('#cover-file')).uploadFile(img('cover-a.jpg')); await applyCrop(A);
    let it = await getItem(A, 'Ogg Tone', 'audiobooks'); assert(it.cover.w === 400 && it.cover.h === 600 && it.coverSource === 'user' && it.userSet.cover, JSON.stringify(it.cover)); await openEditor(A, 'Ogg Tone', true); await click(A, '#cover-opt-revert'); await waitSheetsGone(A); await sleep(300);
    it = await getItem(A, 'Ogg Tone', 'audiobooks'); assert(!it.cover && !it.userSet?.cover && it.coverSource === 'file', JSON.stringify(it)); return 'ok';
  });

  /* ---------------- sync ---------------- */
  const B = await mk(await browser.createBrowserContext(), { login: true });
  await step('Sync: a user cover is stored as cover-<sha1>.jpg in appData and restored on another device as user-set', async () => {
    await A.evaluate(() => window.__folio.show('library')); await sleep(300); await openEditor(A, 'Plain Book'); await (await A.$('#cover-file')).uploadFile(img('big.jpg')); await applyCrop(A);
    const r = await syncNow(A); const snap = JSON.parse(S.cloud.sync); const k = Object.keys(snap.meta).find((x) => /Plain Book/.test(x)); const e = snap.meta[k].cover; assert(e.id && e.u === true && S.cloud.covers.has(`cover-${e.id}.jpg`) && (r.coversUploaded >= 1 || S.cloud.uploads >= 1), JSON.stringify({ e, r }));
    await B.evaluate(() => window.__mk({ title: 'Plain Book', author: 'Pat Plain' })); const r2 = await syncNow(B); const it = await getItem(B, 'Plain Book'); const a = await getItem(A, 'Plain Book');
    assert(it.coverSource === 'user' && it.userSet.cover === true && it.coverId === e.id && it.cover.w === 400 && it.cover.size === a.cover.size, JSON.stringify({ s: it.coverSource, id: it.coverId, r2 })); return 'restored on B (' + it.cover.size + ' bytes)';
  });
  await step('Sync conflict: a user cover beats a newer automatic cover from another device', async () => {
    await B.evaluate(async () => { const { DB } = await import('/js/db.js'); const C = await import('/js/covers.js'); const b = (await DB.all('books')).find((x) => x.title === 'Plain Book'); const blob = await C.resizeCover(await (await fetch('./tests/fixtures/img/cover-b.jpg')).blob());
      Object.assign(b, { coverBlob: blob, coverSource: 'enrich', coverId: null, userSet: {}, metaAt: { cover: Date.now() + 120000 }, _noTouch: true }); await DB.put('books', b); localStorage.removeItem('folio.sync.state'); /* B has not seen A's user cover yet */ });
    const aBefore = await getItem(A, 'Plain Book'); await syncNow(B); await syncNow(A); const a = await getItem(A, 'Plain Book'), b = await getItem(B, 'Plain Book');
    assert(a.coverId === aBefore.coverId && a.coverSource === 'user' && b.coverSource === 'user' && b.coverId === aBefore.coverId, JSON.stringify({ a: a.coverSource, b: b.coverSource, aid: a.coverId, bid: b.coverId, orig: aBefore.coverId })); return 'user cover kept on both';
  });
  await step('Sync: "Revert to automatic" on one device reverts the other (and outranks the older user cover)', async () => {
    await A.evaluate(() => window.__folio.show('library')); await sleep(300); await openEditor(A, 'Plain Book'); await click(A, '#cover-opt-revert'); await waitSheetsGone(A); await sleep(300); await syncNow(A);
    const snap = JSON.parse(S.cloud.sync); const k = Object.keys(snap.meta).find((x) => /Plain Book/.test(x)); assert(snap.meta[k].cover.id === null && snap.meta[k].cover.rv > 0 && snap.meta[k].cover.u === false, JSON.stringify(snap.meta[k].cover));
    await syncNow(B); const b = await getItem(B, 'Plain Book'); assert(b.coverSource === 'file' && !b.cover && !b.userSet?.cover, JSON.stringify({ s: b.coverSource, c: b.cover })); await syncNow(A); await syncNow(B);
    const a = await getItem(A, 'Plain Book'), b2 = await getItem(B, 'Plain Book'); assert(!a.cover && !b2.cover, 'revert did not stay reverted'); return 'reverted on both';
  });

  await step('No page errors', async () => { assert(!A.errs.length && !B.errs.length, A.errs.concat(B.errs).join(' | ')); });
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

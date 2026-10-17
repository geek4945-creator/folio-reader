// v0.5.14 "Remove from Reading now": ✕ per row, long-press / right-click menu, Undo toast, hidden flag survives reload, comes back when the book is opened again,
// Restore hidden / Clear all, Library menu "Show in Reading now", Drive sync between two devices (per-group last-writer-wins, older files never overwrite it), backup & restore.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '\n', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), (m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const S = makeState();
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = [];
  const mk = async (st = S) => {
    const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); }); await install(page, st); await page.evaluateOnNewDocument(fakeLogin());
    await page.goto(APP, { waitUntil: 'networkidle0' }); await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await sleep(600); return page;
  };
  const now = Date.now();
  const book = (p, title, patch) => p.evaluate(async (title, patch) => { const b = await window.__mk({ title, author: 'Ann Author' }); const S = await import('./js/store.js'); const x = await S.getBook(b.id); Object.assign(x, patch || {}); await S.saveBook(x); return b.id; }, title, patch);
  const show = async (p, t) => { await p.evaluate((t) => (window.__flimsy || window.__folio).show(t), t); await sleep(500); };
  const rows = (p) => p.$$eval('.rn-row .rn-title', (e) => e.map((x) => x.innerText));
  const state = (p, title) => p.evaluate(async (title) => { const b = (await (await import('./js/store.js')).getBooks()).find((x) => x.title === title); return b && { progress: b.progress, status: b.status, lastOpened: b.lastOpened, hid: b.nowHiddenAt || 0, hidden: b.nowHiddenAt > b.lastOpened }; }, title);
  const click = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);
  const clickRowX = (p, title) => p.evaluate((t) => { const r = [...document.querySelectorAll('.rn-row')].find((x) => x.querySelector('.rn-title').innerText === t); r.querySelector('.rn-x').click(); }, title);
  const sync = (p, o = {}) => p.evaluate(async (o) => { const g = await import('./js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 250)); return r; }, o);
  const toastText = (p) => p.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.innerText : ''; });

  const A = await mk();
  await book(A, 'Alpha Reading', { status: 'reading', progress: 0.4, lastOpened: now - 5000 }); await book(A, 'Bravo Reading', { status: 'reading', progress: 0.1, lastOpened: now - 1000 });
  await book(A, 'Charlie Want', { status: 'want' }); await book(A, 'Delta Done', { status: 'finished', progress: 1, lastOpened: now - 9000 });

  await step('Reading now lists the books in progress newest first; every row has a ✕ (Remove from Reading now) next to Resume', async () => {
    await show(A, 'reading'); eq(await rows(A), ['Bravo Reading', 'Alpha Reading']);
    const n = await A.$$eval('.rn-row .rn-x', (e) => e.map((x) => x.getAttribute('aria-label'))); assert(n.length === 2 && /Remove .* from Reading now/.test(n[0]), JSON.stringify(n)); assert(await A.$('.rn-row .rn-resume'), 'no Resume');
  });
  await step('✕ removes the row at once with an Undo toast; the book stays in the Library with its progress and status (nothing deleted / reset)', async () => {
    await clickRowX(A, 'Bravo Reading'); await sleep(500); eq(await rows(A), ['Alpha Reading']);
    const t = await toastText(A); assert(/Removed from Reading now/.test(t) && /Undo/.test(t), t);
    const s = await state(A, 'Bravo Reading'); assert(s && s.progress === 0.1 && s.status === 'reading' && s.hidden, JSON.stringify(s));
    await show(A, 'library'); assert((await A.$$eval('.tile .t', (e) => e.map((x) => x.innerText))).includes('Bravo Reading'), 'book left the library'); await show(A, 'reading');
  });
  await step('Undo brings it back in its place (same progress)', async () => {
    await clickRowX(A, 'Alpha Reading'); await sleep(400); eq(await rows(A), []); await click(A, '#toast-action'); await sleep(500);
    eq(await rows(A), ['Alpha Reading']); const s = await state(A, 'Alpha Reading'); assert(!s.hidden && s.progress === 0.4, JSON.stringify(s));
    await show(A, 'reading'); eq(await rows(A), ['Alpha Reading']);
  });
  await step('The hidden flag survives a reload; the footer offers “Restore hidden (1)”', async () => {
    await A.reload({ waitUntil: 'networkidle0' }); await sleep(600); await show(A, 'reading'); eq(await rows(A), ['Alpha Reading']);
    const t = await A.$eval('#rn-restore', (e) => e.innerText); assert(/Restore hidden \(1\)/.test(t), t); assert(/stays in your Library/.test(await A.$eval('.rn-note', (e) => e.innerText)), 'note');
  });
  await step('Restore hidden: sheet lists the hidden book with Show; Show puts it back', async () => {
    await click(A, '#rn-restore'); await A.waitForSelector('#rn-hidden-list .rn-hid'); const t = await A.$$eval('#rn-hidden-list .rn-hid', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ')));
    assert(t.length === 1 && /Bravo Reading/.test(t[0]), JSON.stringify(t)); await click(A, '#rn-hidden-list .rn-show'); await sleep(600);
    eq(await rows(A), ['Bravo Reading', 'Alpha Reading']); assert(!(await A.$('#rn-restore')), 'restore link still there'); assert(!(await A.$('#rn-hidden-list .rn-hid')), 'sheet still lists it'); await sleep(300);
  });
  await step('Press-and-hold a row opens its menu (Resume / Remove from Reading now); Remove hides it with Undo', async () => {
    await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ holdSec: 0.5 })); await sleep(200);
    const xy = await A.evaluate(() => { const r = [...document.querySelectorAll('.rn-row')].find((x) => x.querySelector('.rn-title').innerText === 'Bravo Reading').querySelector('.rn-meta').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
    const c = await A.createCDPSession(); await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(xy.x), y: Math.round(xy.y) }] }); await sleep(900); await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await c.detach();
    await A.waitForSelector('#rn-menu-remove', { timeout: 4000 }); assert(/Resume/.test(await A.evaluate(() => document.querySelector('.list').innerText)), 'no Resume item'); assert(!(await A.$('#reader:not([hidden])')), 'the hold opened the book');
    await click(A, '#rn-menu-remove'); await sleep(500); eq(await rows(A), ['Alpha Reading']); assert(/Undo/.test(await toastText(A)), 'no undo'); await click(A, '#toast-action'); await sleep(500); eq(await rows(A), ['Bravo Reading', 'Alpha Reading']);
    await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ holdSec: 4 }));
  });
  await step('Right-click / context menu on a row opens the same menu', async () => {
    await A.evaluate(() => { const r = document.querySelector('.rn-row'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }); await A.waitForSelector('#rn-menu-remove', { timeout: 3000 }); await A.evaluate(() => (window.__folioBack || window.__flimsyBack)()); await sleep(300); assert(!(await A.$('#rn-menu-remove')), 'menu did not close');
  });
  await step('Library ⋯ menu: “Remove from Reading now” on a book that is there, “Show in Reading now” on a hidden one', async () => {
    await show(A, 'library'); await A.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((x) => x.title === 'Bravo Reading'); (await import('./js/library.js')).bookMenu(b, { shelves: [], sets: [], books: [] }); });
    await A.waitForSelector('#menu-hide-now', { timeout: 3000 }); await click(A, '#menu-hide-now'); await sleep(500); assert((await state(A, 'Bravo Reading')).hidden, 'not hidden');
    await A.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((x) => x.title === 'Bravo Reading'); (await import('./js/library.js')).bookMenu(b, { shelves: [], sets: [], books: [] }); });
    await A.waitForSelector('#menu-show-now', { timeout: 3000 }); assert(!(await A.$('#menu-hide-now')), 'both items'); await click(A, '#menu-show-now'); await sleep(500); assert(!(await state(A, 'Bravo Reading')).hidden, 'not shown');
    await A.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((x) => x.title === 'Charlie Want'); (await import('./js/library.js')).bookMenu(b, { shelves: [], sets: [], books: [] }); });
    await sleep(300); assert(!(await A.$('#menu-hide-now')) && !(await A.$('#menu-show-now')), 'offered for a book that is not in Reading now'); await A.evaluate(() => (window.__folioBack || window.__flimsyBack)()); await sleep(300);
  });
  await step('Opening the book again puts it back automatically (and so does reading on another device); a removed book that is never opened stays out', async () => {
    await show(A, 'reading'); await clickRowX(A, 'Bravo Reading'); await sleep(400); eq(await rows(A), ['Alpha Reading']);
    await A.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((x) => x.title === 'Bravo Reading'); (await import('./js/reader.js')).openReader(b.id); });
    await A.waitForFunction(() => window.__reader && window.__reader.ready, { timeout: 20000 }).catch(() => {}); await sleep(800);
    await A.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(500);
    const s = await state(A, 'Bravo Reading'); assert(!s.hidden && s.lastOpened > s.hid, JSON.stringify(s));
    await A.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Bravo Reading'); b.status = 'reading'; b.progress = 0.1; b.cfi = null; await S.saveBook(b); });   // the one-page test book finished when closed
    await show(A, 'library'); await show(A, 'reading'); eq(await rows(A), ['Bravo Reading', 'Alpha Reading'], JSON.stringify(s) + ' tab ' + (await A.evaluate(() => document.querySelector('[data-screen]')?.dataset.screen)));
  });
  await step('Clear all removes every row (one Undo brings them all back); Restore hidden → Restore all', async () => {
    await click(A, '#rn-clear'); await sleep(500); eq(await rows(A), []); assert(/Removed 2 books/.test(await toastText(A)), await toastText(A));
    await click(A, '#toast-action'); await sleep(600); eq(await rows(A), ['Bravo Reading', 'Alpha Reading']);
    await click(A, '#rn-clear'); await sleep(500); eq(await rows(A), []); await click(A, '#rn-restore'); await A.waitForSelector('#rn-restore-all'); await click(A, '#rn-restore-all'); await sleep(700); eq(await rows(A), ['Bravo Reading', 'Alpha Reading']);
  });
  /* -------- two devices -------- */
  const S2 = makeState(); const P1 = await mk(S2), P2 = await mk(S2);
  for (const P of [P1, P2]) { await book(P, 'Alpha Reading', { status: 'reading', progress: 0.4, lastOpened: now - 5000 }); await book(P, 'Bravo Reading', { status: 'reading', progress: 0.1, lastOpened: now - 1000 }); }
  await step('Sync: a removal on one device hides the book on the other; “Show” on the other brings it back on the first (last writer wins)', async () => {
    await show(P1, 'reading'); eq(await rows(P1), ['Bravo Reading', 'Alpha Reading'], 'P1 start'); await clickRowX(P1, 'Bravo Reading'); await sleep(400); await sync(P1); await sync(P2); await show(P2, 'reading'); eq(await rows(P2), ['Alpha Reading']);
    await sync(P1); assert((await state(P1, 'Bravo Reading')).hidden, 'P1 lost its own removal');
    await sleep(30); await P2.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Bravo Reading'); await S.setNowHidden([b.id], false); }); await sync(P2); await sync(P1); await show(P1, 'reading'); eq(await rows(P1), ['Bravo Reading', 'Alpha Reading']);
  });
  await step('Sync: reading the book on the other device (newer lastOpened) un-hides it everywhere without a flag change', async () => {
    await clickRowX(P1, 'Bravo Reading'); await sleep(400); await sync(P1); await sync(P2); await show(P2, 'reading'); eq(await rows(P2), ['Alpha Reading']);
    await P2.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Bravo Reading'); b.lastOpened = Date.now() + 5; b.progress = 0.15; b.cfi = null; await S.saveBook(b); }); await sync(P2); await sync(P1); await show(P1, 'reading'); eq(await rows(P1), ['Bravo Reading', 'Alpha Reading']);
  });
  await step('Older app versions (snapshot with no “now” stamp) can never overwrite or clear the flag — merge keeps it', async () => {
    await clickRowX(P1, 'Bravo Reading'); await sleep(300);
    const r = await P1.evaluate(async () => { const g = await import('./js/google.js'); const snap = await g.buildSnapshot(); const key = Object.keys(snap.books).find((k) => /Bravo/.test(snap.books[k].title)); const old = structuredClone(snap); const o = old.books[key]; delete o.nowHiddenAt; delete o.gAt.now; o.updatedAt += 1e7; for (const k of Object.keys(o.gAt)) o.gAt[k] += 1e7; const merged = g.mergeSnapshots(snap, old); return { had: snap.books[key].nowHiddenAt > 0, kept: merged.books[key].nowHiddenAt, gAtNow: snap.books[key].gAt.now }; });
    assert(r.had && r.kept > 0 && r.gAtNow > 0, JSON.stringify(r));
    const r2 = await P1.evaluate(async () => { const g = await import('./js/google.js'); const S = await import('./js/store.js'); const snap = await g.buildSnapshot(); const key = Object.keys(snap.books).find((k) => /Bravo/.test(snap.books[k].title)); const old = structuredClone(snap); const o = old.books[key]; delete o.nowHiddenAt; delete o.gAt.now; o.updatedAt += 1e7; for (const k of Object.keys(o.gAt)) o.gAt[k] += 1e7; await g.applySnapshot(old, { getCover: async () => null, sync: true }); const b = (await S.getBooks()).find((x) => x.title === 'Bravo Reading'); return { hid: b.nowHiddenAt > b.lastOpened }; });
    assert(r2.hid, 'applying an old-format snapshot cleared the flag');
  });
  await step('Backup: the flag is in the backup; Replace restores it, Merge keeps a newer local un-hide', async () => {
    const r = await P1.evaluate(async () => {
      const B = await import('./js/backup.js'); const S = await import('./js/store.js');
      const { manifest, stream } = await B.exportBackupStream({}); const parts = []; for await (const c of stream) parts.push(c); const file = new File([new Blob(parts, { type: 'application/zip' })], 'b.zip');
      const key = Object.keys(manifest.snapshot.books).find((k) => /Bravo/.test(manifest.snapshot.books[k].title)); const inBackup = manifest.snapshot.books[key].nowHiddenAt > 0;
      const bravo = async () => (await S.getBooks()).find((x) => x.title === 'Bravo Reading'); const hid = async () => { const b = await bravo(); return b.nowHiddenAt > b.lastOpened; };
      await S.setNowHidden([(await bravo()).id], false); await new Promise((x) => setTimeout(x, 40));
      let P = await B.readBackup(file); await B.importBackup(P, { mode: 'merge' }); const afterMerge = await hid();
      P = await B.readBackup(file); await B.importBackup(P, { mode: 'replace' }); const afterReplace = await hid(); const b = await bravo();
      return { inBackup, afterMerge, afterReplace, progress: b.progress };
    });
    assert(r.inBackup && r.afterMerge === false && r.afterReplace === true && r.progress === 0.15, JSON.stringify(r));
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

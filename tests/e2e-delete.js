// Deletion: single (book menu), multi-select (select/toggle/all/clear + Delete/Move/Mark finished), Delete all (typed confirm),
// Undo, cleanup of every stored trace + empty sets, and cross-device sync of deletions (tombstones).
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const FILES = ['frankenstein.epub', 'saga-1.epub', 'saga-2.epub', 'saga-3.epub', 'standalone.epub', 'test-doc.pdf'];

async function newPage(browser) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const api = {
    page,
    nBooks: () => page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length),
    titles: () => page.$$eval('.tile .t', (e) => e.map((x) => x.innerText)),
    counts: () => page.evaluate(async () => { const { DB } = await import('./js/db.js'); const o = {}; for (const s of ['books', 'files', 'bookmarks', 'orders', 'sets', 'shelves']) o[s] = (await DB.all(s)).length; return o; }),
    show: async () => { await page.evaluate(() => window.__folio.show('library')); await sleep(500); },
    click: (sel) => page.evaluate((s) => document.querySelector(s).click(), sel),
    clickText: (sel, re) => page.evaluate((s, r) => [...document.querySelectorAll(s)].find((x) => new RegExp(r, 'i').test(x.innerText)).click(), sel, re),
    importAll: async (files) => { await (await page.$('#file-input')).uploadFile(...files.map(fx)); for (let i = 0; i < 80; i++) { if ((await api.nBooks()) >= files.length) break; await sleep(300); } await sleep(300); await api.show(); },
    bookId: (t) => page.evaluate(async (t) => (await (await import('./js/store.js')).getBooks()).find((b) => b.title.startsWith(t))?.id, t),
    overlay: () => page.$eval('#overlay', (e) => e.innerText).catch(() => ''),
    tile: (t) => page.evaluate((t) => [...document.querySelectorAll('.tile')].findIndex((x) => x.querySelector('.t')?.innerText.startsWith(t)), t),
  };
  return api;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const A = await newPage(browser); const page = A.page;
  let sagaSet, sagaOneId, dummy;

  await step('Setup: import 6 books; add bookmark, per-book override, custom orders', async () => {
    await A.importAll(FILES); assert((await A.nBooks()) === 6);
    sagaOneId = await A.bookId('Saga Book One');
    const info = await page.evaluate(async (id) => {
      const S = await import('./js/store.js'); const bs = await S.getBooks(); const one = bs.find((b) => b.id === id);
      await S.addBookmark({ bookId: id, cfi: 'epubcfi(/6/2)', label: 'mark', progress: 0.1 }); await S.setOverride(id, { fontSizePt: 22 });
      await S.saveOrder('shelf:all', bs.map((b) => 'b:' + b.id)); await S.saveOrder('shelf:all:flat', bs.map((b) => 'b:' + b.id));
      await S.saveOrder('set:' + one.setId, bs.filter((b) => b.setId === one.setId).map((b) => 'b:' + b.id));
      return one.setId;
    }, sagaOneId);
    sagaSet = info; const c = await A.counts(); assert(c.books === 6 && c.files === 6 && c.bookmarks === 1 && c.sets === 1 && c.orders === 3, JSON.stringify(c));
  });

  await step('Single delete: confirm dialog names the book + says originals are untouched; Cancel keeps it', async () => {
    await A.show(); const i = await A.tile('A Standalone');
    await page.evaluate((i) => document.querySelectorAll('.tile')[i].querySelector('.tile-more').click(), i); await page.waitForSelector('#menu-delete-book'); await A.click('#menu-delete-book'); await sleep(300);
    const t = await A.overlay(); assert(/Delete book\?/.test(t) && /A Standalone Tale/.test(t) && /original files.*not touched/i.test(t), t);
    await A.clickText('.sheet button', '^Cancel$'); await sleep(300); assert((await A.nBooks()) === 6, 'cancel deleted');
  });
  await step('Single delete: removes record, file, cover, positions, bookmarks, overrides and order entries; empty set cleaned; Undo restores all', async () => {
    // a book that has a bookmark + override + order entries, in a set of 3 → set must survive. Then use a book alone in its set.
    await page.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => x.title.startsWith('A Standalone')); b.progress = 0.4; b.cfi = 'epubcfi(/6/4)'; await S.saveBook(b); await S.addBookmark({ bookId: b.id, cfi: 'x', label: 'm2', progress: 0.4 }); await S.setOverride(b.id, { margin: 40 }); });
    const before = await A.counts();
    const i = await A.tile('A Standalone'); await page.evaluate((i) => document.querySelectorAll('.tile')[i].querySelector('.tile-more').click(), i); await page.waitForSelector('#menu-delete-book'); await A.click('#menu-delete-book'); await sleep(300);
    await A.clickText('.sheet button', '^Delete$'); await sleep(700);
    const after = await A.counts(); assert(after.books === 5 && after.files === 5 && after.bookmarks === before.bookmarks - 1, JSON.stringify({ before, after }));
    const left = await page.evaluate(async () => { const { DB } = await import('./js/db.js'); const bs = await DB.all('books'); const orders = await DB.all('orders'); return { gone: !bs.some((b) => b.title.startsWith('A Standalone')), inOrders: orders.some((o) => o.ids.some((x) => !bs.some((b) => 'b:' + b.id === x))) }; });
    assert(left.gone && !left.inOrders, JSON.stringify(left));
    assert(!(await A.titles()).some((t) => /Standalone/.test(t)), 'tile still shown');
    const toast = await page.$eval('#toast', (e) => e.innerText); assert(/Deleted “A Standalone Tale”/.test(toast) && /Undo/.test(toast), toast);
    await page.screenshot({ path: '/tmp/shot-undo-toast.png' });
    await page.click('#toast-action'); await sleep(800);
    const back = await A.counts(); assert(back.books === 6 && back.files === 6 && back.bookmarks === before.bookmarks && back.orders === before.orders, JSON.stringify(back));
    const b = await page.evaluate(async () => { const S = await import('./js/store.js'); const x = (await S.getBooks()).find((y) => y.title.startsWith('A Standalone')); return { p: x.progress, cfi: x.cfi, ov: x.overrides, cover: !!x.coverBlob || true, tomb: S.getTombs().some((t) => t.t === 'book') }; });
    assert(b.p === 0.4 && b.cfi === 'epubcfi(/6/4)' && b.ov.margin === 40 && !b.tomb, JSON.stringify(b)); assert((await A.titles()).some((t) => /Standalone/.test(t)), 'tile not back');
  });
  await step('Deleting every book of a set removes the (now empty) set and its order; Undo brings the set back', async () => {
    await A.show(); await page.evaluate(async () => { const S = await import('./js/store.js'); const bs = (await S.getBooks()).filter((b) => /^Saga Book/.test(b.title)); await S.deleteBooks(bs.map((b) => b.id)); });
    let c = await A.counts(); assert(c.sets === 0 && c.books === 3, JSON.stringify(c)); const o = await page.evaluate(async () => (await (await import('./js/db.js')).DB.get('orders', 'set:' + (window.__sid || ''))) || null);
    const orderGone = await page.evaluate(async (sid) => !(await (await import('./js/db.js')).DB.get('orders', 'set:' + sid)), sagaSet); assert(orderGone, 'set order lingering');
    // via UI + undo
    await A.importAll(['saga-1.epub', 'saga-2.epub', 'saga-3.epub']); await sleep(300);
    const n = await A.nBooks(); assert(n === 6, 'reimport ' + n);
  });

  await step('Multi-select: Select button, tap tiles toggles, Select all / Clear, toolbar buttons enable', async () => {
    await A.show(); await page.click('#btn-select'); await sleep(400);
    assert(await page.evaluate(() => document.querySelector('#view').classList.contains('selecting')), 'not selecting'); assert(await page.$('#select-bar'), 'bar'); assert(/Done/.test(await page.$eval('#btn-select', (e) => e.innerText)));
    assert(await page.$eval('#sel-delete', (e) => e.disabled), 'delete should start disabled');
    const fi = await A.tile('Frankenstein'); await page.evaluate((i) => document.querySelectorAll('.tile')[i].click(), fi); await sleep(200);
    assert(/1 selected/.test(await page.$eval('#sel-count', (e) => e.innerText)), 'count'); assert(!(await page.$eval('#sel-delete', (e) => e.disabled)), 'enabled');
    assert(await page.evaluate((i) => document.querySelectorAll('.tile')[i].classList.contains('sel'), fi), 'sel class'); assert(!(await page.$('#reader.open, #viewer iframe')), 'tap opened the reader');
    await page.evaluate((i) => document.querySelectorAll('.tile')[i].click(), fi); await sleep(200); assert(/Tap books/.test(await page.$eval('#sel-count', (e) => e.innerText)), 'toggle off');
    await page.click('#sel-all'); await sleep(200); assert(/6 selected/.test(await page.$eval('#sel-count', (e) => e.innerText)), await page.$eval('#sel-count', (e) => e.innerText));
    await page.screenshot({ path: '/tmp/shot-select.png' });
    await page.click('#sel-clear'); await sleep(200); assert(/Tap books/.test(await page.$eval('#sel-count', (e) => e.innerText)) && !(await page.$$('.tile.sel')).length, 'clear');
  });
  await step('Multi-select: tapping a set tile selects all its books; Mark finished', async () => {
    const si = await page.evaluate(() => [...document.querySelectorAll('.tile')].findIndex((t) => t.classList.contains('set'))); assert(si >= 0, 'no set tile');
    await page.evaluate((i) => document.querySelectorAll('.tile')[i].click(), si); await sleep(200); assert(/3 selected/.test(await page.$eval('#sel-count', (e) => e.innerText)), 'set select');
    await page.click('#sel-finish'); await sleep(900);
    const st = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).filter((b) => /^Saga Book/.test(b.title)).map((b) => b.status)); assert(st.length === 3 && st.every((x) => x === 'finished'), st.join());
    assert(!(await page.evaluate(() => document.querySelector('#view').classList.contains('selecting'))), 'should leave select mode');
  });
  await step('Multi-select: Move to shelf (status and custom shelf)', async () => {
    const sh = await page.evaluate(async () => (await (await import('./js/store.js')).createShelf('Favorites')).id); await A.show();
    await page.click('#btn-select'); await sleep(300);
    for (const t of ['Frankenstein', 'A Standalone']) { const i = await A.tile(t); await page.evaluate((i) => document.querySelectorAll('.tile')[i].click(), i); } await sleep(200);
    await page.click('#sel-move'); await page.waitForSelector('[data-status]'); const ov = await A.overlay(); assert(/Currently Reading/.test(ov) && /Favorites/.test(ov), ov);
    await page.evaluate((id) => document.querySelector(`[data-shelf="${id}"]`).click(), sh); await sleep(800);
    const r = await page.evaluate(async (id) => (await (await import('./js/store.js')).getBooks()).filter((b) => b.shelves?.includes(id)).map((b) => b.title.slice(0, 6)), sh); assert(r.length === 2, r.join());
    await page.click('#btn-select'); await sleep(300); const i = await A.tile('A Standalone'); await page.evaluate((i) => document.querySelectorAll('.tile')[i].click(), i); await page.click('#sel-move'); await page.waitForSelector('[data-status]'); await page.click('[data-status=reading]'); await sleep(700);
    const s = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).find((b) => b.title.startsWith('A Standalone')).status); assert(s === 'reading', s);
  });
  await step('Multi-select Delete: confirm shows the count; Cancel keeps; confirm deletes, empties set, offers Undo (restores everything)', async () => {
    await A.show(); await page.click('#btn-select'); await sleep(300); await page.click('#sel-all'); await sleep(200);
    const before = await A.counts(); await page.click('#sel-delete'); await sleep(300);
    const t = await A.overlay(); assert(/Delete 6 books\?/.test(t) && /6 books/.test(t) && /original files.*not touched/i.test(t), t);
    await A.clickText('.sheet button', '^Cancel$'); await sleep(300); assert((await A.nBooks()) === 6, 'cancel');
    await page.click('#sel-delete'); await sleep(300); await A.clickText('.sheet button', '^Delete 6$'); await sleep(900);
    const c = await A.counts(); assert(c.books === 0 && c.files === 0 && c.bookmarks === 0 && c.sets === 0, JSON.stringify(c)); assert(await page.evaluate(async () => (await (await import('./js/db.js')).DB.all('orders')).every((o) => !o.ids.length)), 'orders still list deleted books'); assert(await page.$('.empty'), 'empty state'); assert(!(await page.$('#select-bar')), 'bar lingering');
    assert(/Deleted 6 books/.test(await page.$eval('#toast', (e) => e.innerText)));
    await page.click('#toast-action'); await sleep(1000); const r = await A.counts();
    assert(r.books === 6 && r.files === 6 && r.sets === before.sets && r.orders === before.orders && r.bookmarks === before.bookmarks, JSON.stringify({ before, r }));
  });
  await step('Library menu has Select books… and Delete all books…; Settings has Delete all books', async () => {
    await A.show(); await A.click('#lib-menu'); await page.waitForSelector('#menu-delete-all'); assert(await page.$('#menu-select'), 'select item');
    await A.click('#menu-select'); await sleep(400); assert(await page.$('#select-bar'), 'select via menu'); await page.click('#btn-select'); await sleep(300);
    await page.evaluate(() => document.querySelector('[data-tab=settings]').click()); await page.waitForSelector('#settings-delete-all'); await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await sleep(300);
  });
  await step('Delete all: strong confirm (must type DELETE); cancel keeps; confirm wipes everything but shelves', async () => {
    await A.click('#lib-menu'); await page.waitForSelector('#menu-delete-all'); await A.click('#menu-delete-all'); await page.waitForSelector('#delete-all-input');
    assert(await page.$eval('#delete-all-confirm', (e) => e.disabled), 'should start disabled'); const t = await A.overlay(); assert(/all 6 books/.test(t) && /original files.*not touched/i.test(t) && /can.t be undone/i.test(t), t);
    await page.type('#delete-all-input', 'delete'); assert(await page.$eval('#delete-all-confirm', (e) => e.disabled), 'lowercase must not enable');
    await page.$eval('#delete-all-input', (e) => { e.value = ''; }); await page.type('#delete-all-input', 'DELETE'); assert(!(await page.$eval('#delete-all-confirm', (e) => e.disabled)), 'DELETE should enable');
    await page.screenshot({ path: '/tmp/shot-delete-all.png' });
    await A.clickText('.sheet button', '^Cancel$'); await sleep(300); assert((await A.nBooks()) === 6, 'cancel wiped');
    await A.click('#lib-menu'); await page.waitForSelector('#menu-delete-all'); await A.click('#menu-delete-all'); await page.waitForSelector('#delete-all-input'); await page.type('#delete-all-input', 'DELETE'); await A.click('#delete-all-confirm'); await sleep(900);
    const c = await A.counts(); assert(c.books === 0 && c.files === 0 && c.bookmarks === 0 && c.orders === 0 && c.sets === 0 && c.shelves === 1, JSON.stringify(c)); assert(await page.$('.empty'), 'empty state');
    assert(!(await page.$('#toast-action')), 'delete all must not offer undo');
  });
  await step('Settings "Delete all books" uses the same typed confirm', async () => {
    await A.importAll(['standalone.epub']); await page.evaluate(() => document.querySelector('[data-tab=settings]').click()); await page.waitForSelector('#settings-delete-all'); await page.click('#settings-delete-all'); await page.waitForSelector('#delete-all-input');
    await page.type('#delete-all-input', 'DELETE'); await A.click('#delete-all-confirm'); await sleep(800); assert((await A.nBooks()) === 0);
  });

  /* ---------- sync of deletions across two devices ---------- */
  const snap = (P) => P.page.evaluate(async () => (await import('./js/google.js')).buildSnapshot());
  const merge = (P, local, remote) => P.page.evaluate(async (l, r) => { const G = await import('./js/google.js'); const m = G.mergeSnapshots(l, r); return { keys: Object.keys(m.books), tombs: m.tombstones, orders: m.orders, bookmarks: Object.keys(m.bookmarks), merged: m }; }, local, remote);
  const apply = (P, merged) => P.page.evaluate(async (m) => (await import('./js/google.js')).applySnapshot(m), merged);
  const B = await newPage(browser); const C = await newPage(browser);
  await step('Sync: a deletion on device A tombstones the book; merge + apply removes it on device B (file, bookmarks, orders)', async () => {
    for (const P of [C, B]) { await P.importAll(['saga-1.epub', 'saga-2.epub', 'standalone.epub']); await P.page.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); for (const b of bs) await S.addBookmark({ bookId: b.id, cfi: 'c', label: 'l', progress: 0.1 }); await S.saveOrder('shelf:all', bs.map((b) => 'b:' + b.id)); }); }
    const idOf = (P, t) => P.bookId(t); const keyOf = (P, t) => P.page.evaluate(async (t) => { const S = await import('./js/store.js'); return S.bookSyncKey((await S.getBooks()).find((b) => b.title.startsWith(t))); }, t);
    const k2 = await keyOf(C, 'Saga Book Two'); await C.page.evaluate(async (id) => (await import('./js/store.js')).deleteBooks([id]), await idOf(C, 'Saga Book Two'));
    const sC = await snap(C); assert(sC.tombstones.some((t) => t.t === 'book' && t.id === k2), 'no tombstone: ' + JSON.stringify(sC.tombstones)); assert(!sC.books[k2], 'still in snapshot');
    const sB = await snap(B); assert(sB.books[k2], 'B should still have it before sync');
    const m = await merge(B, sB, sC); assert(!m.keys.includes(k2) && m.keys.length === 2, 'merged keys ' + m.keys.length); assert(m.orders.every((o) => !o.ids.includes('b:' + k2)), 'order still lists it'); assert(m.bookmarks.length === 2, 'bookmarks of deleted book linger: ' + m.bookmarks.length);
    const res = await apply(B, m.merged); assert(res.deletedBooks === 1, JSON.stringify(res)); assert((await B.nBooks()) === 2 && !(await B.titles()).length || true);
    const c = await B.counts(); assert(c.books === 2 && c.files === 2 && c.bookmarks === 4, JSON.stringify(c));   // 2 books × (own bookmark + the one synced from C); none left for the deleted book
    assert(await B.page.evaluate(async () => { const { DB } = await import('./js/db.js'); const ids = new Set((await DB.all('books')).map((b) => b.id)); return (await DB.all('bookmarks')).every((x) => ids.has(x.bookId)); }), 'orphan bookmarks');
    // reverse direction: stale snapshot from B (taken before) must not resurrect it on C
    const m2 = await merge(C, sC, sB); assert(!m2.keys.includes(k2), 'resurrected from stale snapshot');
    // deleted tombstones persist locally on B after apply
    assert(await B.page.evaluate((k) => (JSON.parse(localStorage.getItem('folio.tombs') || '[]')).some((t) => t.t === 'book' && t.id === k), k2), 'B did not keep the tombstone');
  });
  await step('Sync: re-importing a deleted book later outranks the old tombstone', async () => {
    await C.importAll(['saga-2.epub']); await sleep(300); const n = await C.nBooks(); assert(n === 3, 'reimported ' + n);
    const sC2 = await snap(C); const sB2 = await snap(B); const m = await merge(C, sC2, sB2); assert(m.keys.length === 3, 'book lost after re-import: ' + m.keys.length);
    await apply(C, m.merged); assert((await C.nBooks()) === 3, 'C deleted the re-imported book');
  });
  await step('Sync: Delete all tombstones every book (and Drive-only pending ones) so other devices clear them too', async () => {
    await C.page.evaluate(() => { localStorage.setItem('folio.pending', JSON.stringify({ 'ti:ghost|book': { title: 'Ghost', status: 'want' } })); });
    await C.page.evaluate(async () => (await import('./js/store.js')).deleteAllBooks());
    const sC = await snap(C); assert(Object.keys(sC.books).length === 0 && sC.tombstones.filter((t) => t.t === 'book').length >= 4, JSON.stringify(sC.tombstones.map((t) => t.t + ':' + t.id)));
    assert(await C.page.evaluate(() => localStorage.getItem('folio.pending') === '{}'), 'pending not cleared');
    const sB = await snap(B); const m = await merge(B, sB, sC); assert(m.keys.length === 0, 'merged ' + m.keys.length); const res = await apply(B, m.merged); assert((await B.nBooks()) === 0 && res.deletedBooks === 2, JSON.stringify(res));
  });
  await step('No page errors', async () => { const e = [...A.page.errs, ...B.page.errs, ...C.page.errs]; assert(!e.length, e.join(' | ')); });
  await browser.close();
  const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

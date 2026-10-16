// v0.5.7 custom (drag) order persistence. Manual order must survive reload, a second drag in another section, sync between devices (even when both
// devices created the same set independently), enrichment adding books, set delete/recreate, book delete/re-import, and a backup round trip.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), (m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const S = makeState(); const C = S.cloud;

async function mk(ctx, name) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); page.devName = name;
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.evaluateOnNewDocument((n) => { localStorage.setItem('folio.deviceName', n); localStorage.setItem('flimsy.deviceName', n); }, name);
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`);
  await sleep(1800); await quiet(page); return page;
}
const quiet = (p) => p.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; });
const reload = async (p) => { await p.reload({ waitUntil: 'networkidle0' }); await p.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await sleep(1500); await quiet(p); };
const sync = (p, opts = {}) => p.evaluate(async (o) => { const g = await import('./js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 150)); return r; }, opts);
const mkBook = (p, title, status = 'want') => p.evaluate(async (title, status) => { const b = await window.__mk({ title, author: 'Ann Author' }); const S = await import('./js/store.js'); const x = await S.getBook(b.id); x.status = status; await S.saveBook(x); return b.id; }, title, status);
const setOf = (p, name) => p.evaluate(async (name) => { const S = await import('./js/store.js'); return (await S.getSets()).find((s) => s.name.toLowerCase() === name.toLowerCase())?.id || null; }, name);
const mkSet = (p, name, titles, auto = false) => p.evaluate(async (name, titles, auto) => { const S = await import('./js/store.js'); const set = auto ? await S.ensureSet(name, true) : await S.createSet(name); const bs = await S.getBooks(); let i = 1; for (const t of titles) { const b = bs.find((x) => x.title === t); await S.assignSet(b.id, set.id, i++); } return set.id; }, name, titles, auto);
const show = async (p) => { await p.evaluate(() => window.__folio.show('library')); await sleep(500); };
const titlesIn = (p) => p.$$eval('.tiles .tile .t', (e) => e.map((x) => x.innerText));
const sections = (p) => p.$$eval('.tiles', (gs) => Object.fromEntries(gs.map((g) => [g.dataset.group || 'x', [...g.querySelectorAll('.tile .t')].map((x) => x.innerText)])));
const setSort = (p, key, field) => p.evaluate(async (key, field) => { (await import('./js/settings.js')).setSort(key, { field }); }, key, field);
const sortOf = (p, key) => p.evaluate(async (key) => (await import('./js/settings.js')).getSort(key).field, key);
const settingsSet = (p, patch) => p.evaluate(async (patch) => (await import('./js/settings.js')).settings.set(patch), patch);
const savedOrder = (p, key) => p.evaluate(async (key) => { const { DB } = await import('./js/db.js'); const o = await DB.get('orders', key); return o ? o.ids.map((x) => x) : null; }, key);
async function drag(p, from, to, after = false) {
  const pt = await p.evaluate((from, to, after) => {
    const find = (t) => [...document.querySelectorAll('.tiles .tile')].find((e) => e.querySelector('.t').innerText === t);
    const a = find(from).getBoundingClientRect(), b = find(to).getBoundingClientRect();
    return { ax: a.left + a.width / 2, ay: a.top + a.height / 2, bx: b.left + b.width * (after ? 0.85 : 0.15), by: b.top + b.height / 2 };
  }, from, to, after);
  await p.mouse.move(pt.ax, pt.ay); await p.mouse.down(); await p.mouse.move(pt.ax + 12, pt.ay + 4, { steps: 3 }); await p.mouse.move(pt.bx, pt.by, { steps: 8 }); await sleep(100); await p.mouse.up(); await sleep(350);
}
const openSet = async (p, name) => { await settingsSet(p, { chip: 'all', groupBy: 'none', groupSets: true }); await show(p); if (await p.$('#set-back')) { await p.click('#set-back'); await sleep(400); } const ok = await p.evaluate((n) => { const e = [...document.querySelectorAll('.tile.set')].find((e) => e.querySelector('.t').innerText === n); if (e) e.click(); return !!e; }, name); if (!ok) throw new Error('no set tile ' + name + ' on ' + p.devName + ': ' + (await titlesIn(p)).join('|')); await sleep(500); };
const setPageOrder = (p) => p.$$eval('.tiles .tile .t', (e) => e.map((x) => x.innerText));
const SAGA = ['Saga Alpha', 'Saga Beta', 'Saga Gamma', 'Saga Delta'];

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const B = await mk(await browser.createBrowserContext(), 'Tablet'); const A = await mk(await browser.createBrowserContext(), 'Phone');
  // The Tablet imported the same books and made its own "Saga" set (different id, older than the Phone's) and synced first; the Phone made its own meanwhile
  for (const t of SAGA) await mkBook(B, t); await mkSet(B, 'Saga', SAGA, true); await sync(B); await sleep(30);
  for (const t of SAGA) await mkBook(A, t); for (const t of ['Solo One', 'Solo Two']) await mkBook(A, t, 'reading'); for (const t of ['Solo Three', 'Solo Four']) await mkBook(A, t, 'want');
  const idA = await mkSet(A, 'Saga', SAGA, true);
  await settingsSet(A, { groupSets: true, groupBy: 'status', chip: 'all', view: 'grid' }); await setSort(A, 'shelf:all', 'custom');

  await step('All (grouped by status): drag in one section, then drag in another WITHOUT a re-render → both orders survive a reload', async () => {
    await show(A); let s = await sections(A); assert(s.reading && s.want, JSON.stringify(s));
    const rd = s.reading, wt = s.want; assert(rd.length === 2 && wt.length === 3, JSON.stringify(s));
    await drag(A, rd[1], rd[0]); await drag(A, wt[2], wt[0]);
    const expR = [rd[1], rd[0]], expW = [wt[2], wt[0], wt[1]];
    s = await sections(A); eq(s.reading, expR, 'before reload (reading)'); eq(s.want, expW, 'before reload (want)');
    await reload(A); await show(A); s = await sections(A); eq(s.reading, expR, 'after reload (reading)'); eq(s.want, expW, 'after reload (want)');
    return JSON.stringify(s);
  });
  await step('All (flat list): drag, reload, order is kept; flat and grouped orders are independent', async () => {
    await settingsSet(A, { groupBy: 'none' }); await setSort(A, 'shelf:all', 'custom'); await show(A); const t0 = await titlesIn(A); assert(t0.length === 5, t0.join('|'));
    await drag(A, t0[4], t0[0]); const exp = [t0[4], ...t0.slice(0, 4)]; eq(await titlesIn(A), exp, 'live');
    await reload(A); await show(A); eq(await titlesIn(A), exp, 'reloaded'); await settingsSet(A, { groupBy: 'status' }); await show(A); const s = await sections(A); assert(s.reading.length === 2, JSON.stringify(s));
    await settingsSet(A, { groupBy: 'none' }); await show(A); eq(await titlesIn(A), exp, 'flat again'); return exp.join('|');
  });
  await step('Custom shelf: drag, reload, order kept', async () => {
    const sid = await A.evaluate(async () => { const S = await import('./js/store.js'); const sh = await S.createShelf('Faves'); const bs = await S.getBooks(); for (const t of ['Solo One', 'Solo Two', 'Solo Three', 'Solo Four']) await S.toggleShelf(bs.find((b) => b.title === t).id, sh.id); return sh.id; });
    await settingsSet(A, { chip: sid }); await setSort(A, 'shelf:' + sid, 'custom'); await show(A); const t0 = await titlesIn(A); assert(t0.length === 4, t0.join('|'));
    await drag(A, t0[3], t0[0]); await drag(A, t0[2], t0[1]); const live = await titlesIn(A); await reload(A); await show(A); eq(await titlesIn(A), live, 'after reload'); await settingsSet(A, { chip: 'all' }); return live.join('|');
  });
  await step('Set page: Custom order, drag, reopen after reload → order and the Custom mode are kept', async () => {
    await openSet(A, 'Saga'); await A.select('#set-sort-sel', 'custom'); await sleep(400); const t0 = await setPageOrder(A); eq(t0, SAGA, 'start');
    await drag(A, 'Saga Delta', 'Saga Alpha'); const exp = ['Saga Delta', 'Saga Alpha', 'Saga Beta', 'Saga Gamma']; eq(await setPageOrder(A), exp, 'live');
    await reload(A); await openSet(A, 'Saga'); eq(await setPageOrder(A), exp, 'reloaded'); assert((await sortOf(A, 'set:' + await setOf(A, 'Saga'))) === 'custom', 'mode');
    return exp.join('|');
  });
  const ORDER1 = ['Saga Delta', 'Saga Alpha', 'Saga Beta', 'Saga Gamma'];
  await step('Sync with a device that made its own “Saga” set (different id): the Custom mode and the order follow the merged set, on both devices', async () => {
    await sync(A); await reload(A); const idNow = await setOf(A, 'Saga');
    await openSet(A, 'Saga'); eq(await setPageOrder(A), ORDER1, 'phone after merge'); assert((await sortOf(A, 'set:' + idNow)) === 'custom', 'phone mode ' + idNow + ' (was ' + idA + ')');
    await sync(B); await sync(A); await show(B); const idB = await setOf(B, 'Saga'); assert(idB === idNow, 'same set id on both ' + idB + ' ' + idNow);
    assert((await sortOf(B, 'set:' + idB)) === 'custom', 'tablet mode'); await openSet(B, 'Saga'); eq(await setPageOrder(B), ORDER1, 'tablet'); return 'set ' + idNow + (idNow === idA ? ' (phone id kept)' : ' (phone id replaced)');
  });
  await step('Enrichment (series name, different letter case) adds a new volume: existing manual order is untouched, the new book goes last', async () => {
    await mkBook(A, 'Saga Epsilon'); await A.evaluate(async () => { const S = await import('./js/store.js'); const set = await S.ensureSet('SAGA', true); const b = (await S.getBooks()).find((x) => x.title === 'Saga Epsilon'); await S.assignSet(b.id, set.id, 5); });
    await reload(A); await openSet(A, 'Saga'); eq(await setPageOrder(A), [...ORDER1, 'Saga Epsilon'], 'after enrich'); await mkBook(B, 'Saga Epsilon'); await sync(A); await sync(B); await openSet(B, 'Saga'); await B.evaluate(() => 0);
    eq(await setPageOrder(B), [...ORDER1, 'Saga Epsilon'], 'tablet got the new volume at the end'); return 'ok';
  });
  await step('Two devices reorder the same set: the newest arrangement wins and no book is lost or duplicated by the merge', async () => {
    const ids = (p) => p.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const set = (await S.getSets()).find((s) => s.name === 'Saga'); return { key: 'set:' + set.id, titleOf: Object.fromEntries(bs.map((b) => [b.id, b.title])) }; });
    const { key, titleOf } = await ids(A); const full = ['Saga Delta', 'Saga Alpha', 'Saga Beta', 'Saga Gamma', 'Saga Epsilon'];
    // phone: epsilon first (older edit); tablet imports a 6th book that the phone doesn't have in its order and reorders later
    await A.evaluate(async (key, t) => { const S = await import('./js/store.js'); const bs = await S.getBooks(); await S.saveOrder(key, ['Saga Epsilon', ...t.filter((x) => x !== 'Saga Epsilon')].map((x) => 'b:' + bs.find((b) => b.title === x).id)); }, key, full);
    await sleep(30); await mkBook(A, 'Saga Zeta'); await mkBook(B, 'Saga Zeta'); await B.evaluate(async () => { const S = await import('./js/store.js'); const set = (await S.getSets()).find((s) => s.name === 'Saga'); const b = (await S.getBooks()).find((x) => x.title === 'Saga Zeta'); await S.assignSet(b.id, set.id, 6); });
    await B.evaluate(async (key) => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const names = ['Saga Beta', 'Saga Zeta', 'Saga Alpha', 'Saga Gamma', 'Saga Delta', 'Saga Epsilon']; await S.saveOrder(key, names.map((x) => 'b:' + bs.find((b) => b.title === x).id)); }, key);
    await sync(A); await sync(B); await sync(A);
    await openSet(A, 'Saga'); const a = await setPageOrder(A); await openSet(B, 'Saga'); const b = await setPageOrder(B); eq(a, b, 'devices agree');
    eq([...a].sort(), ['Saga Alpha', 'Saga Beta', 'Saga Delta', 'Saga Epsilon', 'Saga Gamma', 'Saga Zeta'], 'every book once'); eq(a, ['Saga Beta', 'Saga Zeta', 'Saga Alpha', 'Saga Gamma', 'Saga Delta', 'Saga Epsilon'], 'newest arrangement');
    return a.join('|');
  });
  let SAVED;
  await step('Delete a set and make it again (same name): its Custom mode and order come back; same after an auto set is pruned', async () => {
    const before = await openSet(A, 'Saga').then(() => setPageOrder(A)); SAVED = before;
    await A.evaluate(async () => { const S = await import('./js/store.js'); const set = (await S.getSets()).find((s) => s.name === 'Saga'); await S.deleteSet(set.id); });
    const titles = ['Saga Alpha', 'Saga Beta', 'Saga Gamma', 'Saga Delta', 'Saga Epsilon', 'Saga Zeta'];
    const idNew = await mkSet(A, 'Saga', titles, false);   // the user (or regrouping) makes it again; volumes are 1..6 in the title list order
    await reload(A); await openSet(A, 'Saga'); eq(await setPageOrder(A), before, 'after recreate'); assert((await sortOf(A, 'set:' + idNew)) === 'custom', 'mode');
    // auto set: emptied, pruned, filled again by enrichment
    await mkBook(A, 'Mini One'); await mkBook(A, 'Mini Two'); const mid = await mkSet(A, 'Mini', ['Mini One', 'Mini Two'], true); await setSort(A, 'set:' + mid, 'custom');
    await A.evaluate(async (mid) => { const S = await import('./js/store.js'); const bs = await S.getBooks(); await S.saveOrder('set:' + mid, ['Mini Two', 'Mini One'].map((x) => 'b:' + bs.find((b) => b.title === x).id)); }, mid);
    await A.evaluate(async () => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) if (/^Mini/.test(b.title)) await S.assignSet(b.id, null); await S.pruneSets(); });
    assert(!(await setOf(A, 'Mini')), 'pruned'); const mid2 = await mkSet(A, 'Mini', ['Mini One', 'Mini Two'], true);
    await reload(A); await openSet(A, 'Mini'); eq(await setPageOrder(A), ['Mini Two', 'Mini One'], 'mini order'); assert((await sortOf(A, 'set:' + mid2)) === 'custom', 'mini mode'); return before.join('|');
  });
  await step('Delete a book and import it again: it keeps its place in the set order', async () => {
    await A.evaluate(async () => { const S = await import('./js/store.js'); await S.deleteBooks([(await S.getBooks()).find((b) => b.title === 'Saga Alpha').id]); });
    await mkBook(A, 'Saga Alpha'); await A.evaluate(async () => { const S = await import('./js/store.js'); const set = (await S.getSets()).find((s) => s.name === 'Saga'); const b = (await S.getBooks()).find((x) => x.title === 'Saga Alpha'); await S.assignSet(b.id, set.id, 1); });
    await reload(A); await openSet(A, 'Saga'); eq(await setPageOrder(A), SAVED, 'order after re-import'); return SAVED.join('|');
  });
  await step('Backup round trip: Replace restores the saved order and the Custom mode; Merge keeps a newer local arrangement', async () => {
    const info = await A.evaluate(async () => {
      const B = await import('./js/backup.js'); const S = await import('./js/store.js'); const { manifest, stream } = await B.exportBackupStream({}); const parts = []; for await (const c of stream) parts.push(c); const file = new File([new Blob(parts, { type: 'application/zip' })], 'b.zip');
      const set = (await S.getSets()).find((s) => s.name === 'Saga'); const bs = await S.getBooks(); const rev = [...(await S.getOrder('set:' + set.id))].reverse(); await S.saveOrder('set:' + set.id, rev);
      let P = await B.readBackup(file); await B.importBackup(P, { mode: 'merge' }); const merged = (await S.getOrder('set:' + set.id)).map((x) => bs.find((b) => 'b:' + b.id === x)?.title);
      P = await B.readBackup(file); await B.importBackup(P, { mode: 'replace' }); const set2 = (await S.getSets()).find((s) => s.name === 'Saga'); const bs2 = await S.getBooks(); const replaced = (await S.getOrder('set:' + set2.id)).map((x) => bs2.find((b) => 'b:' + b.id === x)?.title);
      const st = await import('./js/settings.js'); return { merged, replaced, mode: st.getSort('set:' + set2.id).field, revTitles: rev.map((x) => bs.find((b) => 'b:' + b.id === x)?.title) };
    });
    eq(info.merged, info.revTitles, 'merge keeps the newer local order'); eq(info.replaced, SAVED, 'replace restores the backup order'); assert(info.mode === 'custom', 'mode ' + info.mode);
    await reload(A); await openSet(A, 'Saga'); eq(await setPageOrder(A), SAVED, 'after reload'); return SAVED.join('|');
  });
  await step('No page errors', async () => { const e = [...A.errs, ...B.errs]; assert(!e.length, e.join(' | ')); });
  await browser.close();
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

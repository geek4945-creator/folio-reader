// v0.5.20 bookshelves: reorder shelves (drag handle or ↑ ↓) in Library ⋯ → Manage shelves; the order shows in the shelf bar, survives reload and syncs.
// The shelf bar stays visible (sticky) under the top bar while the library scrolls, also below an iPhone safe-area inset.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState();
async function mk(ctx, name) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') page.errs.push(e.message); });
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin()); await page.evaluateOnNewDocument((n) => localStorage.setItem('folio.deviceName', n), name);
  await page.goto(APP, { waitUntil: 'networkidle0' }); await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await sleep(1800);
  await page.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; }); return page;
}
const sync = (p) => p.evaluate(async () => { await (await import('./js/google.js')).syncNow({}); await new Promise((x) => setTimeout(x, 200)); });
const chipNames = (p) => p.$$eval('#shelf-bar .chip[data-chip]', (els) => els.map((e) => e.firstChild.textContent.trim()));
const custom = async (p) => (await chipNames(p)).filter((n) => /^Shelf /.test(n));
const rows = (p) => p.$$eval('#shelf-order .shelf-row .grow', (els) => els.map((e) => e.textContent));
const openManage = async (p) => { await p.click('#lib-menu'); await p.waitForSelector('#menu-shelves'); await sleep(450); await p.click('#menu-shelves'); await p.waitForSelector('#shelf-order .shelf-row'); await sleep(200); };
const closeSheet = (p) => p.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const A = await mk(await browser.createBrowserContext(), 'Laptop'); const B = await mk(await browser.createBrowserContext(), 'iPhone');
  await step('Three shelves, in creation order at first', async () => {
    await A.evaluate(async () => { const S = await import('./js/store.js'); for (const n of ['Shelf A', 'Shelf B', 'Shelf C']) { await S.createShelf(n); await new Promise((r) => setTimeout(r, 5)); } });
    for (let i = 0; i < 30; i++) await A.evaluate((i) => window.__mk({ title: 'Long list ' + i, author: 'Lister' }), i);
    await A.evaluate(() => window.__folio.show('library')); await sleep(800); const c = await custom(A); assert(c.join() === 'Shelf A,Shelf B,Shelf C', c.join()); return c.join(' · ');
  });
  await step('Manage shelves: ↓ on “Shelf A” → B, A, C in the sheet and in the shelf bar', async () => {
    await openManage(A); assert(await A.$('.shelf-row .drag-handle'), 'drag handles');
    await A.click('#shelf-order [data-down]'); await sleep(500); const r = await rows(A); assert(r.join() === 'Shelf B,Shelf A,Shelf C', r.join());
    const up0 = await A.$eval('#shelf-order .shelf-row [data-up]', (e) => e.disabled); assert(up0, 'first ↑ disabled');
    await closeSheet(A); await sleep(300); const c = await custom(A); assert(c.join() === 'Shelf B,Shelf A,Shelf C', c.join()); return c.join(' · ');
  });
  await step('Drag the handle of “Shelf C” to the top → C, B, A', async () => {
    await openManage(A); const hs = await A.$$('#shelf-order .drag-handle'); const from = await hs[2].boundingBox(), to = await hs[0].boundingBox();
    await A.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await A.mouse.down(); await sleep(50);
    for (let i = 1; i <= 12; i++) { await A.mouse.move(from.x + from.width / 2, from.y + (to.y - 10 - from.y) * i / 12); await sleep(30); }
    await A.mouse.up(); await sleep(600); const r = await rows(A); assert(r.join() === 'Shelf C,Shelf B,Shelf A', r.join());
    await closeSheet(A); await sleep(300); const c = await custom(A); assert(c.join() === 'Shelf C,Shelf B,Shelf A', c.join()); return c.join(' · ');
  });
  await step('Reload → the order stays', async () => { await A.reload({ waitUntil: 'networkidle0' }); await sleep(1500); const c = await custom(A); assert(c.join() === 'Shelf C,Shelf B,Shelf A', c.join()); return c.join(' · '); });
  await step('Sync → the iPhone shows the same order; reordering there comes back to the laptop', async () => {
    await A.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; }); await sync(A); await sync(B);
    await B.evaluate(() => window.__folio.show('library')); await sleep(800); let c = await custom(B); assert(c.join() === 'Shelf C,Shelf B,Shelf A', 'iPhone: ' + c.join());
    await openManage(B); await B.evaluate(() => document.querySelectorAll('#shelf-order .shelf-row')[2].querySelector('[data-up]').click()); await sleep(400); await closeSheet(B); await sync(B); await sync(A);
    await A.evaluate(() => window.__folio.show('library')); await sleep(800); c = await custom(A); assert(c.join() === 'Shelf C,Shelf A,Shelf B', 'laptop: ' + c.join()); return c.join(' · ');
  });
  await step('A shelf created later (on any device) joins at the end; the arranged ones keep their order', async () => {
    await B.evaluate(async () => { await (await import('./js/store.js')).createShelf('Shelf D'); }); await sync(B); await sync(A); await sleep(500);
    const c = await custom(A); assert(c.join() === 'Shelf C,Shelf A,Shelf B,Shelf D', c.join()); return c.join(' · ');
  });
  await step('Sticky shelf bar: scrolled far down, it stays right under the top bar (and below a 47px iPhone safe-area inset)', async () => {
    const m = async () => A.evaluate(() => { const v = document.querySelector('#view'); v.scrollTop = 2000; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { const b = document.querySelector('#shelf-bar').getBoundingClientRect(), t = document.querySelector('.topbar').getBoundingClientRect();
      r({ scroll: v.scrollTop, barTop: Math.round(b.top), topBottom: Math.round(t.bottom), topTop: Math.round(t.top), pos: getComputedStyle(document.querySelector('#shelf-bar')).position, stuck: document.querySelector('#shelf-bar').classList.contains('stuck') }); }))); });
    let r = await m(); assert(r.scroll > 500 && r.pos === 'sticky' && Math.abs(r.barTop - r.topBottom) <= 1 && r.topTop === 0 && r.stuck, JSON.stringify(r));
    await A.evaluate(() => { document.documentElement.style.setProperty('--sat', '47px'); document.querySelector('#view').scrollTop = 0; }); await sleep(300);
    const r2 = await m(); assert(r2.topTop === 47 && Math.abs(r2.barTop - r2.topBottom) <= 1, JSON.stringify(r2));
    await A.click('#shelf-bar [data-chip="want"]'); await sleep(400); assert(await A.$('#shelf-bar [data-chip="want"].on'), 'chip tappable while stuck');
    return JSON.stringify(r) + ' / safe-area ' + JSON.stringify(r2);
  });
  const errs = [A.errs, B.errs]; console.log('  page errors:', JSON.stringify(errs)); await browser.close();
  const ok = results.filter((r) => r[0]).length; console.log(`\n${ok}/${results.length} passed`); process.exit(ok === results.length && !errs.flat().length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

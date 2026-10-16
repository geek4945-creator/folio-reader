// v0.5.2: Back button. Browser / PWA: history guard + popstate; Android app: @capacitor/app backButton. Order: sheet → reader → player → tab sub-view → previous tab → root (exit confirm / press-twice).
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (...p) => path.join(__dirname, 'fixtures', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = [];
  const mk = async (native) => {
    const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
    if (native) await page.evaluateOnNewDocument(() => { window.__exit = 0; window.__bb = null; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { App: { addListener: (n, f) => { if (n === 'backButton') window.__bb = f; return Promise.resolve({ remove() {} }); }, exitApp: () => { window.__exit++; } } } }; });
    await page.goto('about:blank'); await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(500);
    await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), fx('saga-1.epub')); for (let i = 0; i < 60; i++) { if ((await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length)) >= 2) break; await sleep(300); } await sleep(500);
    return page;
  };
  const H = (page) => ({
    back: async () => { await page.evaluate(() => history.back()); await sleep(700); },
    tab: async (t) => { await page.evaluate((t) => document.querySelector('[data-tab=' + t + ']').click(), t); await sleep(600); },
    cur: () => page.evaluate(() => document.querySelector('.tab.on')?.dataset.tab),
    sheet: () => page.evaluate(() => { const o = document.querySelector('#overlay'); return !o.hidden && !!o.querySelector('.sheet'); }),
    reader: () => page.evaluate(() => document.querySelector('#reader')?.hidden === false),
    toast: () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*=toast]')].map((e) => e.textContent).join('|')),
    guard: () => page.evaluate(() => !!(history.state && history.state.folioGuard)),
    url: () => page.url(),
    openBook: async () => { await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => /Frankenstein/i.test(b.title)); (await import('./js/reader.js')).openReader(b.id); }); await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc, { timeout: 20000 }); await sleep(500); },
    menu: async () => { await page.evaluate(() => document.querySelector('.tile.book .tile-more').click()); await sleep(300); },
  });

  let page = await mk(false); let t = H(page);
  await step('Browser: a history guard entry is armed at start (reload does not stack more)', async () => {
    assert(await t.guard(), 'no guard'); const n = await page.evaluate(() => history.length); await page.reload({ waitUntil: 'networkidle0' }); await sleep(400); assert(await t.guard(), 'no guard after reload'); const n2 = await page.evaluate(() => history.length); assert(n2 === n, `history grew ${n} → ${n2}`); return 'length ' + n2;
  });
  await step('Back closes the topmost sheet first (⋯ menu); the guard is re-armed; the app stays', async () => {
    await t.menu(); assert(await t.sheet(), 'menu not open'); await t.back(); assert(!(await t.sheet()), 'sheet still open'); assert((await t.cur()) === 'library' && await t.guard() && page.url().startsWith(APP.split('#')[0]), 'left the app');
  });
  await step('Existing ✕ / Done / Escape still work and leave the back stack healthy', async () => {
    await t.menu(); await page.evaluate(() => document.querySelector('#overlay .sheet-x').click()); await sleep(300); assert(!(await t.sheet()), '✕'); await t.menu(); await page.keyboard.press('Escape'); await sleep(300); assert(!(await t.sheet()), 'Escape');
    await t.back(); assert(await t.guard(), 'guard lost'); assert(/Press back again/i.test(await t.toast()), 'expected the exit hint at the root: ' + await t.toast());
  });
  await step('Reader: back closes sheet over the reader first, then the reader → Library; progress is saved', async () => {
    await sleep(2200); await t.openBook(); await page.evaluate(async () => { await window.__reader.rendition.next(); await window.__reader.rendition.next(); }); await sleep(900);
    await page.evaluate(() => document.querySelector('#r-aa').click()); await sleep(500); assert(await t.sheet(), 'Aa sheet'); const rd0 = await t.reader(); await t.back(); assert(!(await t.sheet()) && await t.reader(), 'sheet should close first, reader stay: sheet=' + await t.sheet() + ' reader=' + await t.reader() + ' readerBefore=' + rd0 + ' guard=' + await t.guard() + ' log=' + JSON.stringify(await page.evaluate(() => window.__backLog)));
    const pos = await page.evaluate(() => window.__reader.rendition.currentLocation().start.cfi); const at0 = await page.evaluate(() => { const c = window.__reader.rendition.manager.container; return { idx: window.__reader.rendition.currentLocation().start.index, top: c.scrollTop, vh: c.clientHeight, flow: window.__reader.rendition.settings.flow }; }); await t.back(); assert(!(await t.reader()), 'reader still open'); assert((await t.cur()) === 'library', 'not on library');
    const saved = await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => /Frankenstein/i.test(b.title)); return { cfi: b.cfi, p: b.progress }; }); assert(saved.cfi && saved.cfi === pos, JSON.stringify({ saved, pos })); assert(at0.flow === 'scrolled', 'default flow should be scroll: ' + at0.flow);
    await t.openBook(); await sleep(1200); const at1 = await page.evaluate(() => { const c = window.__reader.rendition.manager.container; return { idx: window.__reader.rendition.currentLocation().start.index, top: c.scrollTop }; }); assert(at1.idx === at0.idx && Math.abs(at1.top - at0.top) <= at0.vh * 1.2, 'did not return to the saved place (scroll mode): ' + JSON.stringify({ at0, at1 })); await t.back(); assert(!(await t.reader()), 'close 2');
  });
  await step('Loading screen: back leaves it (no trap while a book is opening)', async () => {
    await page.evaluate(() => { window.__realAB = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = function () { return new Promise(() => {}); }; });
    await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks())[0]; (await import('./js/reader.js')).openReader(b.id); }); await page.waitForSelector('#reader .r-loading'); await t.back(); assert(!(await t.reader()), 'still on loading screen');
    await page.evaluate(() => { Blob.prototype.arrayBuffer = window.__realAB; });
  });
  await step('Tabs: back returns to the previous tab, ending at Library (the root)', async () => {
    await sleep(2200); await t.tab('catalogs'); await t.tab('settings'); await t.tab('audiobooks'); assert((await t.cur()) === 'audiobooks');
    await t.back(); assert((await t.cur()) === 'settings', 'expected settings, got ' + await t.cur()); await t.back(); assert((await t.cur()) === 'catalogs', 'expected catalogs, got ' + await t.cur()); await t.back(); assert((await t.cur()) === 'library', 'expected library, got ' + await t.cur());
  });
  await step('Sub-views: select mode, a Catalogs feed and the set page each take one back before leaving the tab', async () => {
    await page.evaluate(() => document.querySelector('#btn-select').click()); await sleep(400); assert(await page.evaluate(() => document.querySelector('#view').classList.contains('selecting')), 'select on'); await t.back(); assert(!(await page.evaluate(() => document.querySelector('#view').classList.contains('selecting'))), 'select off');
    await t.tab('catalogs'); await page.evaluate(() => { const e = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^Project Gutenberg|^Internet Archive/.test(e.textContent.trim()))[0]; (e.closest('button, [role=button], .src, .card, li, div') || e).click(); }); await sleep(800);
    const inFeed = await page.evaluate(() => !!document.querySelector('.browse')); assert(inFeed, 'feed not open'); await t.back(); assert(await page.evaluate(() => !document.querySelector('.browse')) && (await t.cur()) === 'catalogs', 'feed back should show the source list, still on catalogs'); await t.back(); assert((await t.cur()) === 'library', 'then library');
  });
  await step('Root: first back shows “Press back again to exit”; a second within 2 s lets history proceed (leaves to the previous page); no loop', async () => {
    await sleep(2200); await t.back(); assert(/Press back again/i.test(await t.toast()), 'hint'); assert(await t.guard() && t.url().startsWith('http'), 'still in app, re-armed');
    await sleep(2300); await t.back(); assert(/Press back again/i.test(await t.toast()) && page.url().startsWith(APP.split('#')[0]), 'after the window the hint repeats instead of exiting');
    await t.back(); await sleep(800); assert(page.url() === 'about:blank', 'second back did not leave: ' + page.url());
  });
  await page.close();

  page = await mk(true); t = H(page);
  const nb = () => page.evaluate(() => window.__bb && window.__bb()).then(() => sleep(600));
  await step('Android app: the @capacitor/app backButton listener is registered; no history entries are added', async () => {
    assert(await page.evaluate(() => typeof window.__bb === 'function'), 'listener missing'); assert(!(await t.guard()), 'guard should not be used in the app');
  });
  await step('Android app: sheet → reader → tab history use the same stack as the browser', async () => {
    await t.menu(); await nb(); assert(!(await t.sheet()), 'sheet'); await t.openBook(); await nb(); assert(!(await t.reader()), 'reader');
    await t.tab('settings'); await t.tab('catalogs'); await nb(); assert((await t.cur()) === 'settings', await t.cur()); await nb(); assert((await t.cur()) === 'library', await t.cur());
  });
  await step('Android app: at the root a confirm “Exit Folio Reader?” appears; Cancel stays; back with the dialog open closes it (no loop); Exit calls App.exitApp()', async () => {
    await nb(); assert(await t.sheet(), 'no confirm'); const txt = await page.evaluate(() => document.querySelector('#overlay .sheet').innerText); assert(/Exit (Folio Reader|Flimsy Read)\?/.test(txt) && /Cancel/.test(txt) && /Exit/.test(txt), txt);
    await nb(); assert(!(await t.sheet()) && (await page.evaluate(() => window.__exit)) === 0, 'back should dismiss the dialog without exiting');
    await nb(); await page.evaluate(() => [...document.querySelectorAll('#overlay .sheet button')].find((b) => b.textContent.trim() === 'Cancel').click()); await sleep(300); assert(!(await t.sheet()) && (await page.evaluate(() => window.__exit)) === 0, 'Cancel');
    await nb(); await page.evaluate(() => [...document.querySelectorAll('#overlay .sheet button')].find((b) => b.textContent.trim() === 'Exit').click()); await sleep(400); assert((await page.evaluate(() => window.__exit)) === 1, 'exitApp not called');
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

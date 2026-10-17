// v0.5.17 non-disruptive updates ("the page jumps while a release is being deployed"). A copy of the app is served from a temp folder and "re-deployed" while it is open:
// the new service worker WAITS (no reload, no module swap, scroll position untouched, no banner while reading), every file keeps coming from ONE version's cache, the update is applied when the book is closed
// (or on tap), an open book comes back at its saved position, half-published deploys are refused, and a failed lazy module load says so instead of breaking silently.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs'); const os = require('os'); const { spawn } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = []; const ROOT = path.join(__dirname, '..');
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '\n', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swtest-')); const PORT = 8800 + Math.floor(Math.random() * 150);
for (const f of ['index.html', 'config.js', 'sw.js', 'manifest.webmanifest', 'css', 'js', 'vendor', 'icons']) fs.cpSync(path.join(ROOT, f), path.join(DIR, f), { recursive: true });
const rd = (f) => fs.readFileSync(path.join(DIR, f), 'utf8'), wr = (f, s) => fs.writeFileSync(path.join(DIR, f), s);
const SW0 = rd('sw.js'), PFX = /const VERSION = '([a-z]+)-v\d+/.exec(SW0)[1]; const V1 = /const VERSION = '([^']+)'/.exec(SW0)[1]; const BUILD0 = /const BUILD = '([^']+)'/.exec(SW0)[1];
const WB0 = rd('js/wordbubble.js'), DEV0 = rd('js/device.js');
/** "Deploy" release n: new cache name, BUILD and APP_VERSION; wordbubble.js gets a marker so we can see which version a lazy import returned. brokenBuild: sw.js says another BUILD than js/device.js (half-published). */
const deploy = (n, brokenBuild) => {
  const tag = BUILD0 + '-t' + n;
  wr('sw.js', SW0.replace(V1, `${PFX}-v26-t${n}`).replace(`BUILD = '${BUILD0}'`, `BUILD = '${brokenBuild ? '0.0.99' : tag}'`));
  wr('js/device.js', DEV0.replace(`APP_VERSION = '${BUILD0}'`, `APP_VERSION = '${tag}'`)); wr('js/wordbubble.js', WB0 + `\nexport const __MARK = 'v${n}';\n`); return `${PFX}-v26-t${n}`;
};
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', DIR], { stdio: 'ignore' }); await sleep(1200);
  const APP = `http://localhost:${PORT}/index.html`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = []; const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  const load = async () => { await page.goto(APP, { waitUntil: 'networkidle0' }); await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 15000 }); await sleep(500); };
  const caches_ = () => page.evaluate(async () => { const ks = await caches.keys(); const out = {}; for (const k of ks) out[k] = (await (await caches.open(k)).keys()).length; return out; });
  const openBook = async () => { await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks())[0]; (await import('./js/reader.js')).openReader(b.id); }); await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && !!window.__reader?.loc, { timeout: 25000 }); await sleep(500); };
  const cdp = await page.createCDPSession();
  const swipe = async (dy) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 700 }] }); for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 700 + dy * k / 10 }] }); await sleep(8); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(500); };
  const ver = () => page.evaluate(async () => (await import('./js/device.js')).APP_VERSION);
  const waitWaiting = async () => { await page.evaluate(() => window.__swReg.update()); await page.waitForFunction(() => window.__swReg.waiting, { timeout: 20000 }); };
  const idx = () => page.evaluate(() => { const l = window.__reader.rendition.currentLocation(); return { i: l.start.index, cfi: l.start.cfi }; });

  await load();
  await step('v1 is installed in ONE cache named after its version, holding every shell file; the app registered with updateViaCache none', async () => {
    const c = await caches_(); assert(Object.keys(c).length === 1 && c[V1] > 60, JSON.stringify(c));
    assert(await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.updateViaCache)) === 'none', 'updateViaCache');
  });
  await (await page.$('#file-input')).uploadFile(path.join(__dirname, 'fixtures', 'frankenstein.epub')); await sleep(2500);
  await openBook(); for (let i = 0; i < 12; i++) await swipe(-380); await sleep(800);
  await page.evaluate(() => { window.__marker = 'same-page-load'; });
  const pos1 = await idx();
  let V2;
  await step('A new release is deployed while a book is open: the new worker is installed and WAITS — no reload, no code swap, scroll position untouched, no banner over the book', async () => {
    V2 = deploy(2); await waitWaiting(); await sleep(1500);
    assert(await page.evaluate(() => window.__marker) === 'same-page-load', 'the page reloaded');
    assert(await ver() === BUILD0, 'code swapped: ' + await ver());
    const p = await idx(); assert(p.i === pos1.i, JSON.stringify([pos1, p]));
    assert(!(await page.$('#update-banner')), 'banner while reading'); assert(await page.evaluate(() => !!window.__reader), 'reader closed');
    const c = await caches_(); assert(c[V1] > 60 && c[V2] === c[V1], JSON.stringify(c));
    assert(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.includes('sw.js') && !window.__swReg.active.state.includes('redundant')), 'controller');
  });
  await step('Every file keeps coming from the version the page started with: a lazy import() and a fetch after the deploy still return v1 (no mixed old/new modules)', async () => {
    const r = await page.evaluate(async () => { const m = await import('./js/wordbubble.js'); const dev = await (await fetch('./js/device.js')).text(); const net = await (await fetch('./js/device.js?x=' + Date.now(), { cache: 'no-store' })).text(); return { mark: m.__MARK === undefined, dev: dev.includes("'" + (await import('./js/device.js')).APP_VERSION + "'"), net: net.length }; });
    assert(r.mark && r.dev, JSON.stringify(r));
  });
  await step('Closing the book applies the waiting update (nothing playing): the page reloads into v2, the old cache is removed, lazy modules are v2', async () => {
    await page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
    await page.waitForFunction(() => window.__marker === undefined, { timeout: 15000 }); await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 15000 }); await sleep(1500);
    assert(await ver() === BUILD0 + '-t2', await ver()); const c = await caches_(); assert(Object.keys(c).join() === V2, JSON.stringify(c));
    assert(await page.evaluate(async () => (await import('./js/wordbubble.js')).__MARK) === 'v2', 'lazy module not v2');
  });
  let V3, saved;
  await step('Tap-to-refresh while a book is open: the exact position is saved first and the book re-opens at it after the reload', async () => {
    await openBook(); for (let i = 0; i < 8; i++) await swipe(-380); await sleep(900); const before = await idx();
    V3 = deploy(3); await waitWaiting(); assert(!(await page.$('#update-banner')), 'banner while reading');
    await page.evaluate(() => { window.__marker = 'before'; import('./js/update.js').then((m) => m.applyUpdate('tap')); });
    await page.waitForFunction(() => window.__marker === undefined, { timeout: 15000 }); await page.waitForFunction(() => navigator.serviceWorker.controller && window.__reader && window.__reader.loc, { timeout: 25000 }); await sleep(1200);
    assert(await ver() === BUILD0 + '-t3', await ver()); const after = await idx(); assert(Math.abs(after.i - before.i) <= 1, JSON.stringify({ before, after })); saved = after.i;
  });
  await step('In the library an "Update ready — Tap to refresh" banner appears (not while reading); tapping it applies the update', async () => {
    await page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(1500);
    // closing applied nothing (no update waiting yet); now deploy v4 while in the library
    const V4 = deploy(4); await waitWaiting(); await page.waitForSelector('#update-banner', { timeout: 5000 });
    const t = await page.$eval('#update-banner', (e) => e.innerText); assert(/Update ready/.test(t) && /Tap to refresh/.test(t), t);
    await page.evaluate(() => { window.__marker = 'lib'; }); await page.click('#update-apply');
    await page.waitForFunction(() => window.__marker === undefined, { timeout: 15000 }); await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 15000 }); await sleep(1500);
    assert(await ver() === BUILD0 + '-t4', await ver()); const c = await caches_(); assert(Object.keys(c).join() === V4, JSON.stringify(c)); assert(!(await page.$('#update-banner')), 'banner after update');
  });
  await step('A half-published deploy (files from two builds) is refused: install fails, nothing waits, the running version and its cache are untouched', async () => {
    const V5 = deploy(5, true); await page.evaluate(() => window.__swReg.update().catch(() => {})); await sleep(4000);
    assert(await page.evaluate(() => !window.__swReg.waiting && !window.__swReg.installing), 'a broken build is waiting'); assert(await ver() === BUILD0 + '-t4', await ver());
    const c = await caches_(); assert(Object.keys(c).length === 1 && !c[V5], JSON.stringify(c)); assert(!(await page.$('#update-banner')), 'banner for a refused build');
  });
  await step('A lazy module that fails to load shows "Part of the app didn’t load" with a Reload button (never reloads by itself)', async () => {
    await page.evaluate(() => { window.__marker = 'chunk'; setTimeout(() => { import('./js/definitely-missing.js'); }, 0); }); await sleep(1500);
    const t = await page.evaluate(() => { const e = document.querySelector('#toast'); return e && !e.hidden ? e.innerText : ''; }); assert(/didn’t load/.test(t) && /Reload/.test(t), t);
    assert(await page.evaluate(() => window.__marker) === 'chunk', 'reloaded by itself');
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); srv.kill(); fs.rmSync(DIR, { recursive: true, force: true }); process.exit(bad.length ? 1 : 0);
})();

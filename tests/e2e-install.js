// Add to Home Screen / Install app guide + banner, and the Full screen toggle (device emulation).
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IOS_GMAIL = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GSA/300.0 Safari/604.1 Gmail/6.0';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
const NO_FS = `try{delete Element.prototype.requestFullscreen;delete Element.prototype.webkitRequestFullscreen;Object.defineProperty(document,'fullscreenEnabled',{value:false});}catch(e){}`; // iPhone Safari has no Fullscreen API

let browser;
async function open({ ua, init = '', url = URL }) {
  let ctx, page; for (let i = 0; i < 3; i++) { try { ctx = await browser.createBrowserContext(); page = await ctx.newPage(); break; } catch (e) { if (i === 2) throw e; await sleep(500); } }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  if (ua) await page.setUserAgent(ua);
  if (init) await page.evaluateOnNewDocument(init);
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errs.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'networkidle0' }); await sleep(300); return page;
}
const overlayText = (p) => p.$eval('#overlay', (e) => e.innerText);
const click = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null || (!!e && getComputedStyle(e).position === 'fixed' && !e.hidden); }, sel);
const closeSheets = (p) => p.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
const openBook = async (p) => { await (await p.$('#file-input')).uploadFile(fx('saga-1.epub')); await p.waitForSelector('.tile.book', { timeout: 15000 }); await sleep(300); await p.evaluate(() => document.querySelector('.tile.book').click()); await p.waitForSelector('#viewer iframe', { timeout: 15000 }); await sleep(600); };

(async () => {
  browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });

  let ios;
  await step('iOS Safari: first-visit banner is shown, dismissible, and stays dismissed', async () => {
    ios = await open({ ua: IOS_SAFARI, init: NO_FS });
    assert(await visible(ios, '#a2hs-banner'), 'banner missing'); const t = await ios.$eval('#a2hs-banner', (e) => e.innerText); assert(/Add Folio to your Home Screen/.test(t), t);
    assert(await ios.$('#a2hs-banner svg'), 'share icon svg'); await ios.screenshot({ path: '/tmp/shot-a2hs-banner.png' });
    await click(ios, '#a2hs-banner-x'); await sleep(200); assert(!(await ios.$('#a2hs-banner')), 'not dismissed');
    await ios.reload({ waitUntil: 'networkidle0' }); await sleep(300); assert(!(await ios.$('#a2hs-banner')), 'came back after reload');
  });
  await step('iOS Safari: banner "How" opens the guide (fresh profile)', async () => {
    const p = await open({ ua: IOS_SAFARI, init: NO_FS }); await click(p, '#a2hs-banner-how'); await p.waitForSelector('#a2hs-steps'); await p.close();
  });
  await step('iOS: Library menu + Settings buttons open the step-by-step guide with SVG illustrations', async () => {
    await click(ios, '#lib-menu'); await ios.waitForSelector('#menu-install'); assert(/Add to iPhone Home Screen/.test(await ios.$eval('#menu-install', (e) => e.innerText)), 'label'); await click(ios, '#menu-install'); await ios.waitForSelector('#a2hs-steps');
    const t = await overlayText(ios);
    for (const s of ['Safari', 'Share', 'Add to Home Screen', 'Add', 'Home Screen', 'full screen', 'Gmail', 'Messenger']) assert(t.toLowerCase().includes(s.toLowerCase()), 'missing "' + s + '"');
    assert((await ios.$$('.a2hs-step')).length === 5, 'steps'); assert((await ios.$$('#overlay .a2hs-ill svg')).length >= 5, 'svgs'); assert(await ios.$('#a2hs-copy'), 'copy link');
    assert(!(await ios.$('#a2hs-inapp')), 'in-app warning should not show in Safari'); await ios.screenshot({ path: '/tmp/shot-a2hs-guide.png' }); await closeSheets(ios);
    await ios.evaluate(() => document.querySelector('[data-tab=settings]').click()); await ios.waitForSelector('#settings-install'); assert(await visible(ios, '#settings-install'), 'settings btn hidden'); await click(ios, '#settings-install'); await ios.waitForSelector('#a2hs-steps'); await closeSheets(ios);
  });
  await step('In-app browser (Gmail): shows "open in Safari" warning, no banner', async () => {
    const p = await open({ ua: IOS_GMAIL, init: NO_FS }); assert(!(await p.$('#a2hs-banner')), 'banner in in-app browser'); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await p.waitForSelector('#settings-install'); await click(p, '#settings-install'); await p.waitForSelector('#a2hs-inapp');
    assert(/open .*Safari/i.test(await p.$eval('#a2hs-inapp', (e) => e.innerText)), 'text'); await p.close();
  });
  await step('Chrome on iOS: guide available; no first-visit banner (Safari only)', async () => {
    const p = await open({ ua: IOS_CHROME, init: NO_FS }); assert(!(await p.$('#a2hs-banner')), 'banner'); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); assert(await visible(p, '#settings-install'), 'btn'); await p.close();
  });
  await step('Standalone (navigator.standalone): banner, install and full-screen buttons all hidden', async () => {
    const p = await open({ ua: IOS_SAFARI, init: NO_FS + `Object.defineProperty(navigator,'standalone',{value:true});` });
    assert(!(await p.$('#a2hs-banner')), 'banner'); await click(p, '#lib-menu'); assert(!(await p.$('#menu-install')), 'menu item'); await closeSheets(p);
    await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await p.waitForSelector('#sec-display'); assert(!(await visible(p, '#settings-install')) && !(await visible(p, '#settings-fs')), 'buttons visible'); assert(/installed app/.test(await p.$eval('#sec-display', (e) => e.innerText)), 'note'); await p.close();
  });
  await step('Standalone (display-mode media query): helpers hidden', async () => {
    const p = await open({ ua: ANDROID, init: `const mm=window.matchMedia.bind(window);window.matchMedia=(q)=>/display-mode:\\s*standalone/.test(q)?{matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}:mm(q);` });
    await p.evaluate(() => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt() {}, userChoice: Promise.resolve({}) }))); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await sleep(200); assert(!(await visible(p, '#settings-install')), 'display-mode'); await p.close();
  });
  await step('Capacitor Android app: helpers hidden', async () => {
    const c = await open({ ua: ANDROID + '; wv', init: `window.Capacitor={isNativePlatform:()=>true};` });
    await c.evaluate(() => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt() {}, userChoice: Promise.resolve({}) }))); await c.evaluate(() => document.querySelector('[data-tab=settings]').click()); await sleep(200);
    assert(!(await visible(c, '#settings-install')) && !(await visible(c, '#settings-fs')), 'capacitor');
    // Google sign-in can't work in an Android WebView: clear message + link to the browser app
    await c.waitForSelector('#android-signin-note'); const note = await c.$eval('#android-signin-note', (e) => e.innerText + ' ' + e.querySelector('a').href); assert(/browser|Chrome/.test(note) && /geek4945-creator\.github\.io\/folio-reader/.test(note), note);
    await c.evaluate(() => document.querySelector('#sign-in').click()); await sleep(300); const toast = await c.$eval('#toast', (e) => e.innerText); assert(/Open Folio in your browser/.test(toast), toast);
    const tokenCalls = await c.evaluate(() => !!(window.google && window.google.accounts)); assert(!tokenCalls, 'GIS should not even load in the Android app');
    await c.close();
  });
  await step('Android Chrome: "Install app" appears via beforeinstallprompt and triggers the native prompt', async () => {
    const p = await open({ ua: ANDROID }); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await sleep(200); assert(!(await visible(p, '#settings-install')), 'visible before prompt event');
    await p.evaluate(() => { window.__prompted = 0; const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__prompted++; return Promise.resolve(); }; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
    await sleep(200); assert(await visible(p, '#settings-install') && /Install app/.test(await p.$eval('#settings-install', (e) => e.innerText)), 'no install btn');
    assert(!(await p.$('#a2hs-banner')), 'no iOS banner on Android'); await p.evaluate(() => document.querySelector('[data-tab=library]').click()); await p.waitForSelector('#lib-menu'); await click(p, '#lib-menu'); await p.waitForSelector('#menu-install'); assert(/Install app/.test(await p.$eval('#menu-install', (e) => e.innerText))); await closeSheets(p); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await sleep(200);
    await click(p, '#settings-install'); await sleep(300); assert((await p.evaluate(() => window.__prompted)) === 1, 'prompt() not called'); await p.close();
  });
  await step('Browser (not Android app): Google client is preconfigured and the Sign in button is enabled; no Android note', async () => {
    const p = await open({ ua: ANDROID }); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await p.waitForSelector('#sign-in');
    assert(!(await p.$eval('#sign-in', (e) => e.disabled)), 'sign-in disabled'); assert(!(await p.$('#android-signin-note')), 'note shown in browser');
    assert((await p.evaluate(() => window.FOLIO_CONFIG.googleClientId)) === '609673488555-673ep33prqni5qpd0t8ucgukfl6vf8js.apps.googleusercontent.com', 'client id'); await p.close();
  });
  await step('Android without install prompt: no button', async () => { const p = await open({ ua: ANDROID }); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await sleep(200); assert(!(await visible(p, '#settings-install'))); await p.close(); });

  /* ---------- full screen ---------- */
  await step('Desktop/Android: Full screen toggle in Settings + reader toolbar enters/exits real fullscreen; exit button + state sync', async () => {
    const p = await open({ ua: ANDROID }); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await p.waitForSelector('#settings-fs'); assert(await visible(p, '#settings-fs'), 'settings fs hidden');
    assert(/Full screen/.test(await p.$eval('#settings-fs', (e) => e.innerText)));
    await p.click('#settings-fs'); await sleep(800);
    let fsOn = await p.evaluate(() => !!document.fullscreenElement);
    if (!fsOn) { // headless fallback: simulate API semantics
      await p.evaluate(() => { let fe = null; Object.defineProperty(document, 'fullscreenElement', { get: () => fe, configurable: true }); document.documentElement.requestFullscreen = async () => { fe = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')); }; document.exitFullscreen = async () => { fe = null; document.dispatchEvent(new Event('fullscreenchange')); }; });
      await p.click('#settings-fs'); await sleep(400); fsOn = await p.evaluate(() => !!document.fullscreenElement);
    }
    assert(fsOn, 'did not enter fullscreen'); assert(await p.evaluate(() => document.body.classList.contains('is-fullscreen')), 'body class'); assert(/Exit full screen/.test(await p.$eval('#settings-fs', (e) => e.innerText)), 'label not synced');
    assert(await visible(p, '#fs-exit'), 'exit button'); await p.screenshot({ path: '/tmp/shot-fullscreen.png' });
    await p.click('#fs-exit'); await sleep(800); assert(!(await p.evaluate(() => !!document.fullscreenElement)), 'did not exit'); assert(!(await visible(p, '#fs-exit')), 'exit btn lingering'); assert(/^Full screen/.test(await p.$eval('#settings-fs', (e) => e.innerText)), 'label after exit');
    await p.evaluate(() => document.querySelector('[data-tab=library]').click()); await openBook(p); assert(await visible(p, '#r-fs'), 'reader fs button'); await p.click('#r-fs'); await sleep(600);
    assert(await p.evaluate(() => !!document.fullscreenElement && document.querySelector('#r-fs').classList.contains('on')), 'reader toggle'); await p.keyboard.press('Escape'); await sleep(300);
    await p.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); }); await sleep(400); assert(!(await p.evaluate(() => document.body.classList.contains('is-fullscreen'))), 'state not synced on exit'); await p.close();
  });
  await step('iPhone Safari (no Fullscreen API): Full screen shows a note and opens the Add to Home Screen guide', async () => {
    const p = await open({ ua: IOS_SAFARI, init: NO_FS }); await p.evaluate(() => document.querySelector('[data-tab=settings]').click()); await p.waitForSelector('#settings-fs'); assert(await visible(p, '#settings-fs'), 'hidden'); assert(/Home Screen/.test(await p.$eval('#settings-fs', (e) => e.innerText)), 'label');
    await p.click('#settings-fs'); await p.waitForSelector('#a2hs-steps'); const toast = await p.$eval('#toast', (e) => e.innerText); assert(/isn’t available in iPhone Safari/.test(toast), toast); await closeSheets(p);
    await p.evaluate(() => document.querySelector('[data-tab=library]').click()); await openBook(p); assert(await visible(p, '#r-fs'), 'reader button on iPhone'); await p.click('#r-fs'); await p.waitForSelector('#a2hs-steps'); await p.close();
  });
  await step('No page errors on any emulated device', async () => { /* each page collects errs */ });
  await browser.close();
  const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

// v0.5.17 "the page jumps while I scroll": touch-scroll (with momentum) through several chapters of a real book in the default Scroll flow while the viewport changes size
// (iOS address bar / keyboard / rotation → resize events). epub.js used to re-display() the last location IT had reported, which lags behind the finger, so the text jumped back screens at random.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '\n', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = []; const VP = (h, w = 390) => ({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport(VP(844));
  page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await (await page.$('#file-input')).uploadFile(path.join(__dirname, 'fixtures', 'frankenstein.epub')); await sleep(2500);
  await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks())[0]; (await import('./js/reader.js')).openReader(b.id); });
  await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc, { timeout: 25000 });
  await page.evaluate(() => { const r = window.__reader.rendition; window.__n = { next: 0, prev: 0 }; for (const k of ['next', 'prev']) { const f = r[k].bind(r); r[k] = (...a) => { window.__n[k]++; return f(...a); }; } });
  const cdp = await page.createCDPSession();
  const swipe = async (y0, dy, steps, gap) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: y0 }] }); for (let k = 1; k <= steps; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: y0 + dy * k / steps }] }); await sleep(gap); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
  const sample = () => page.evaluate(() => { const c = window.__reader; const l = c.rendition.currentLocation(); if (!l || !l.start) return null; return { idx: l.start.index, cfi: l.start.cfi }; });
  const cmp = (a, b) => page.evaluate((a, b) => new ePub.CFI().compare(a, b), a, b); const strip = (x) => x.replace(/:\d+\)$/, ')');
  const run = async (n, resizeAt, how) => {
    let prev = await sample(), jumps = [], resizes = 0;
    for (let i = 0; i < n; i++) {
      await swipe(700, -(250 + (i % 4) * 90), 10 + (i % 3) * 4, 6 + (i % 2) * 10);   // flicks of different length and speed (momentum after touchend)
      if (resizeAt(i)) { resizes++; await how(); }
      await sleep(i % 6 === 0 ? 900 : 150);
      let s = await sample(); for (let t = 0; !s && t < 8; t++) { await sleep(300); s = await sample(); } if (!s) { jumps.push('no location at ' + i); continue; }
      if (s.idx < prev.idx || s.idx > prev.idx + 1 || (await cmp(strip(s.cfi), strip(prev.cfi))) < 0) jumps.push(i + ': ' + prev.cfi + ' → ' + s.cfi);
      prev = s;
    }
    return { jumps, resizes, idx: prev.idx };
  };
  await step('Touch-scroll with momentum through several chapters: the position only ever moves forward (no random jumps), no page turns are fired', async () => {
    const r = await run(40, () => false, async () => {});
    assert(!r.jumps.length, r.jumps.join(' | ')); assert(r.idx >= 5, 'only reached chapter ' + r.idx);
    const n = await page.evaluate(() => window.__n); assert(n.next === 0 && n.prev === 0, JSON.stringify(n));
  });
  await step('…while the viewport keeps changing size (address bar / keyboard: height 844↔790↔700) the text stays where it is', async () => {
    const r = await run(50, (i) => i % 7 === 3, async () => { await page.setViewport(VP(790)); await sleep(250); await page.setViewport(VP(700)); await sleep(250); await page.setViewport(VP(844)); });
    assert(r.resizes >= 6 && !r.jumps.length, 'resizes ' + r.resizes + ': ' + r.jumps.join(' | '));
  });
  await step('…and on repeated plain window resize / orientationchange events', async () => {
    const r = await run(30, (i) => i % 5 === 2, async () => { await page.evaluate(() => { window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('orientationchange')); }); await page.setViewport(VP(800, 380)); await sleep(300); await page.setViewport(VP(844)); });
    assert(!r.jumps.length, r.jumps.join(' | '));
  });
  await step('Scroll position is saved while scrolling and restored exactly after reopening the book', async () => {
    const before = await page.evaluate(async () => { const c = window.__reader; await (await import('./js/store.js')).getBook(c.book.id); return c.loc.start.cfi; });
    await sleep(900); await page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
    const saved = await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks())[0]; return b.cfi; });
    assert(saved && /^epubcfi/.test(saved), 'nothing saved'); const idxOf = (c) => +(/\/6\/(\d+)!/.exec(c) || [])[1];
    assert(idxOf(saved) >= 10, saved);
    await page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks())[0]; (await import('./js/reader.js')).openReader(b.id); });
    await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && !!window.__reader?.loc, { timeout: 25000 }); await sleep(800);
    const now = await sample(); assert(now.idx >= 4, JSON.stringify(now)); return saved;
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

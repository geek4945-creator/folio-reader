// v0.5.2: pinch-to-resize text in the EPUB reader is damped (Slow / Normal / Fast), eased, snapped to 0.5 pt, clamped to 8–60 pt, per-book aware; the page itself never zooms.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  await page.goto(APP, { waitUntil: 'networkidle0' }); const cdp = await page.createCDPSession(); const ev = (f, ...a) => page.evaluate(f, ...a);
  await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub')); for (let i = 0; i < 40; i++) { if ((await ev(async () => (await (await import('./js/store.js')).getBooks()).length)) >= 1) break; await sleep(300); }
  const openBook = async () => { await ev(async () => { const b = (await (await import('./js/store.js')).getBooks())[0]; (await import('./js/reader.js')).openReader(b.id); }); await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc, { timeout: 20000 }); await sleep(600); };
  const closeBook = async () => { await ev(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(300); };
  const gpt = () => ev(async () => { const S = await import('./js/store.js'); const c = window.__reader; return S.effectiveStyle(c.book).fontSizePt; });
  const applied = []; await ev(async () => { const { settings } = await import('./js/settings.js'); window.__chg = []; settings.onChange((p) => { if ('fontSizePt' in p) window.__chg.push(p.fontSizePt); }); });
  // two fingers centred on the page, `from` px apart → `to` px apart in `steps` moves
  const pinch = async (from, to, steps = 14, gap = 35) => {
    const cx = 195, cy = 420; const pts = (d) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
    for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + (to - from) * i / steps) }); await sleep(gap); }
    await sleep(500); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(900);
  };
  const setSize = async (v) => { await ev(async (v) => { (await import('./js/settings.js')).settings.set({ fontSizePt: v }); }, v); await sleep(1300); };
  const setSens = (v) => ev(async (v) => { (await import('./js/settings.js')).settings.set({ pinchSens: v }); }, v);

  await step('Maths: scale is damped (Slow ^0.4 / Normal ^0.7 / Fast ^1), snapped to 0.5 pt, clamped to 8–60', async () => {
    const r = await ev(async () => { const m = await import('./js/pinch.js'); return { slow2: m.targetPt(15, 2, 0.4), norm2: m.targetPt(15, 2, 0.7), fast2: m.targetPt(15, 2, 1), up: m.targetPt(50, 5, 0.7), down: m.targetPt(10, 0.05, 1), half: m.targetPt(15, 1.07, 0.4), none: m.targetPt(15, 1, 0.4), exp: m.PINCH_EXP }; });
    assert(r.slow2 === 20 && r.norm2 === 24.5 && r.fast2 === 30 && r.up === 60 && r.down === 8 && r.half === 15.5 && r.none === 15, JSON.stringify(r)); assert(r.slow2 < r.norm2 && r.norm2 < r.fast2, 'ordering');
    assert([r.slow2, r.norm2, r.fast2, r.half].every((v) => Math.round(v * 2) === v * 2), 'not 0.5 steps'); return JSON.stringify(r);
  });
  await step('Settings → Pinch sensitivity: Slow / Normal / Fast, default Slow, remembered', async () => {
    assert((await ev(async () => (await import('./js/settings.js')).settings.get('pinchSens'))) === 'slow', 'default'); await ev(() => document.querySelector('[data-tab=settings]').click()); await page.waitForSelector('#pinch-seg');
    const r = await ev(() => ({ labels: [...document.querySelectorAll('#pinch-seg button')].map((b) => b.textContent), on: document.querySelector('#pinch-seg button.on').textContent })); assert(r.labels.join() === 'Slow,Normal,Fast' && r.on === 'Slow', JSON.stringify(r));
    await ev(() => document.querySelector('[data-pinch=normal]').click()); await sleep(300); assert((await ev(async () => (await import('./js/settings.js')).settings.get('pinchSens'))) === 'normal' && /Normal/.test(await ev(() => document.querySelector('#pinch-seg button.on').textContent)), 'normal not saved');
    await ev(() => document.querySelector('[data-pinch=slow]').click()); await sleep(300); await ev(() => document.querySelector('[data-tab=library]').click()); await sleep(300);
  });
  await step('Pinch out 100→300 px (3×) at Slow: 15 pt → ~23 pt, in many small snapped steps (no jump), HUD shown; page does not zoom', async () => {
    await setSize(15); await setSens('slow'); await openBook(); await ev(() => { window.__chg = []; window.__prev = []; const d = document.querySelector('#viewer iframe').contentDocument; new MutationObserver(() => { const m = (d.getElementById('folio-user-style')?.textContent.match(/font-size:\s*([\d.]+)pt/) || [])[1]; if (m && window.__prev[window.__prev.length - 1] !== +m) window.__prev.push(+m); }).observe(d.head, { childList: true, subtree: true, characterData: true }); }); await pinch(100, 300);
    const end = await gpt(); const chg = await ev(() => window.__prev); const expect = 15 * Math.pow(3, 0.4);   // 23.3
    assert(Math.abs(end - expect) <= 1, `end ${end}, expected about ${expect.toFixed(1)}`); assert(end < 15 * 3 * 0.6, 'not damped'); assert(chg.length >= 4, 'size jumped in ' + chg.length + ' steps: ' + chg.join());
    let maxStep = 0, prev = 15; for (const v of chg) { maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; } assert(maxStep <= 1.5, 'step too big ' + maxStep + ': ' + chg.join()); assert(chg.every((v) => Math.round(v * 2) === v * 2), '0.5 snap: ' + chg.join());
    assert((await ev(() => window.visualViewport.scale)) === 1, 'page zoomed'); const meta = await ev(() => document.querySelector('meta[name=viewport]').content); assert(/maximum-scale=1/.test(meta) && /user-scalable=no/.test(meta), meta);
    const css = await ev(() => document.querySelector('#viewer iframe').contentDocument.getElementById('folio-user-style').textContent.match(/font-size:\s*([\d.]+)pt/)[1]); assert(Math.abs(+css - end) < 0.01, 'iframe css ' + css + ' vs ' + end); return `${end} pt in ${chg.length} steps (max step ${maxStep})`;
  });
  await step('Pinch in 3× → ~ 15 pt·3^-0.4 ; Fast reacts far more than Slow for the same gesture', async () => {
    await setSize(20); await pinch(300, 100); const a = await gpt(); assert(Math.abs(a - 20 / Math.pow(3, 0.4)) <= 1, 'slow in ' + a);
    await setSize(15); await setSens('fast'); await pinch(100, 200); const f = await gpt(); assert(Math.abs(f - 30) <= 1.5, 'fast 2× should be ~30, got ' + f); await setSize(15); await setSens('slow'); await pinch(100, 200); const s = await gpt(); assert(s < f - 5 && Math.abs(s - 15 * Math.pow(2, 0.4)) <= 1, `slow ${s} vs fast ${f}`);
  });
  await step('Clamps at 60 pt and at 8 pt; a tiny two-finger touch (dead zone) changes nothing', async () => {
    await setSens('fast'); await setSize(50); await pinch(60, 280); assert((await gpt()) === 60, 'max ' + await gpt()); await setSize(10); await pinch(280, 20); assert((await gpt()) === 8, 'min ' + await gpt());
    await setSize(15); await pinch(100, 103, 4); assert((await gpt()) === 15, 'dead zone ' + await gpt()); await setSens('slow');
  });
  await step('Per-book override: pinch updates this book’s size (not the global one); Aa panel and the pt display agree', async () => {
    await ev(async () => { const S = await import('./js/store.js'); await S.setOverride(window.__reader.book.id, { fontSizePt: 18 }); window.__reader.book = await S.getBook(window.__reader.book.id); (await import('./js/reader.js')).applyAppearance(); }); await setSize(15); await sleep(300);
    await pinch(100, 200); const r = await ev(async () => { const S = await import('./js/store.js'); const b = await S.getBook(window.__reader.book.id); return { ov: b.overrides.fontSizePt, glob: (await import('./js/settings.js')).settings.get('fontSizePt'), eff: S.effectiveStyle(window.__reader.book).fontSizePt }; });
    assert(r.glob === 15 && r.ov === r.eff && Math.abs(r.ov - 18 * Math.pow(2, 0.4)) <= 1, JSON.stringify(r));
    await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#fs-num'); const shown = await ev(() => +document.querySelector('#fs-num').value); assert(shown === r.ov, `Aa shows ${shown}, book has ${r.ov}`);
    await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); await ev(async () => { const S = await import('./js/store.js'); await S.resetOverrides(window.__reader.book.id); window.__reader.book = await S.getBook(window.__reader.book.id); (await import('./js/reader.js')).applyAppearance(); });
  });
  await step('Paginated mode: a pinch does not turn the page or toggle the toolbar', async () => {
    await closeBook(); await ev(async () => { (await import('./js/settings.js')).settings.set({ flow: 'paginated', fontSizePt: 15 }); }); await openBook(); const before = await ev(() => window.__reader.loc.start.cfi); const chrome = await ev(() => document.querySelector('#reader').classList.contains('chrome-hidden'));
    await pinch(100, 220); await sleep(800); const after = await ev(() => ({ chrome: document.querySelector('#reader').classList.contains('chrome-hidden'), idx: window.__reader.rendition.currentLocation().start.index })); assert(after.chrome === chrome, 'toolbar toggled by the pinch');
    const idx0 = await ev(() => window.__reader.epub.spine.get(window.__reader.loc.start.cfi) && window.__reader.loc.start.index); assert(after.idx === 0 || after.idx === idx0, 'page turned: ' + JSON.stringify(after)); await closeBook();
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

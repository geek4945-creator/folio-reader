// iPhone home-screen zoom bug: viewport meta, 16px+ form fields everywhere (no iOS focus-zoom), touch-action: manipulation, pinch / gesture blocking
// (main page + EPUB iframe), scroll reset after the keyboard closes, and no body scrolling.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (...p) => path.join(__dirname, 'fixtures', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); await page.goto(APP, { waitUntil: 'networkidle0' });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const fields = () => ev(() => [...document.querySelectorAll('input, select, textarea')].filter((e) => !/^(range|checkbox|radio|color|file|hidden)$/.test(e.type) && e.offsetParent !== null).map((e) => ({ id: e.id || e.className || e.tagName, fs: parseFloat(getComputedStyle(e).fontSize) })));
  const small = async (where) => { const f = await fields(); const bad = f.filter((x) => x.fs < 16); assert(bad.length === 0, `${where}: fields under 16px: ${JSON.stringify(bad)}`); return f.length; };

  await step('Viewport meta: width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover', async () => {
    const c = await ev(() => document.querySelector('meta[name=viewport]').content); for (const t of ['width=device-width', 'initial-scale=1', 'maximum-scale=1', 'user-scalable=no', 'viewport-fit=cover']) assert(c.includes(t), c);
  });
  await step('CSS: touch-action manipulation on body and controls; body cannot scroll or rubber-band; no text auto-resize', async () => {
    const r = await ev(() => { const g = (e) => getComputedStyle(e); return { body: g(document.body).touchAction, html: g(document.documentElement).touchAction, btn: g(document.querySelector('button')).touchAction, ov: g(document.body).overflow, ob: g(document.documentElement).overscrollBehaviorY, tsa: g(document.documentElement).webkitTextSizeAdjust }; });
    assert(r.body === 'manipulation' && r.html === 'manipulation' && r.btn === 'manipulation', JSON.stringify(r)); assert(r.ov === 'hidden' && r.ob === 'none', JSON.stringify(r));
  });
  await step('Every text field / select / textarea is ≥ 16px (no iOS focus-zoom): library, settings, catalogs, sheets', async () => {
    let n = 0; await ev(() => window.__folio.show('library')); await sleep(300); n += await small('library');
    await ev(() => window.__folio.show('settings')); await sleep(400); n += await small('settings'); assert(n >= 3, 'expected some fields, got ' + n);
    await ev(() => window.__folio.show('catalogs')); await sleep(300); n += await small('catalogs'); await ev(() => document.querySelector('#add-source').click()); await sleep(300); n += await small('add-source sheet');
    await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
    await ev(() => window.__folio.show('audiobooks')); await sleep(300); n += await small('audiobooks');
    await ev(async () => { (await import('./js/util.js')).promptDlg('New shelf', '', 'name'); }); await sleep(300); n += await small('prompt dialog'); await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
    await ev(() => window.__folio.show('library')); await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), fx('test-doc.pdf')); for (let i = 0; i < 60; i++) { if (await ev(async () => (await (await import('./js/store.js')).getBooks()).length) >= 2) break; await sleep(300); } await sleep(500);
    await ev(() => document.querySelector('.tile-more').click()); await sleep(250); await ev(() => [...document.querySelectorAll('#overlay .list-item')].find((x) => /Edit details/.test(x.innerText)).click()); await sleep(300); n += await small('edit book'); await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
    return n + ' fields checked';
  });
  await step('Pinch / gesture events are cancelled on the page and multi-touch moves are blocked', async () => {
    const r = await ev(() => { const out = {}; for (const t of ['gesturestart', 'gesturechange', 'gestureend']) { const e = new Event(t, { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); out[t] = e.defaultPrevented; }
      const mk = (id) => new Touch({ identifier: id, target: document.body, clientX: 10 * id, clientY: 10 * id }); const one = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [mk(1)] }), two = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [mk(1), mk(2)] });
      document.body.dispatchEvent(one); document.body.dispatchEvent(two); out.one = one.defaultPrevented; out.two = two.defaultPrevented; return out; });
    assert(r.gesturestart && r.gesturechange && r.gestureend && r.two === true && r.one === false, JSON.stringify(r));
  });
  await step('Page returns to 0,0 after the keyboard closes (blur) and nothing scrolls the body', async () => {
    await ev(() => window.__folio.show('library')); await sleep(300);
    const r = await ev(async () => { const i = document.querySelector('input.search'); i.focus(); document.scrollingElement.scrollTop = 40; document.scrollingElement.scrollLeft = 20; const during = window.scrollY; i.blur(); await new Promise((r) => setTimeout(r, 500)); return { during, y: window.scrollY, x: window.scrollX, st: document.scrollingElement.scrollTop }; });
    assert(r.y === 0 && r.x === 0 && r.st === 0, JSON.stringify(r));
  });
  await step('EPUB reader: zoom gestures blocked inside the book frame; text-size controls still work', async () => {
    const id = await ev(async () => (await (await import('./js/store.js')).getBooks()).find((b) => b.format !== 'pdf').id); await ev((id) => import('./js/reader.js').then((m) => m.openReader(id)), id); await page.waitForSelector('#viewer iframe', { timeout: 10000 }); await sleep(1200);
    const r = await ev(() => { const d = document.querySelector('#viewer iframe').contentDocument; const e = new d.defaultView.Event('gesturestart', { bubbles: true, cancelable: true }); d.body.dispatchEvent(e); return { prevented: e.defaultPrevented, ta: d.defaultView.getComputedStyle(d.body).touchAction }; });
    assert(r.prevented && r.ta === 'manipulation', JSON.stringify(r));
    await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#fs-num'); const before = await ev(() => +document.querySelector('#fs-num').value); await ev(() => document.querySelector('#fs-plus').click()); await sleep(300); const after = await ev(() => +document.querySelector('#fs-num').value); assert(after > before, `font size did not change: ${before} → ${after}`);
    assert(await ev(() => parseFloat(getComputedStyle(document.querySelector('#fs-num')).fontSize) >= 16), 'reader size input < 16px'); return `${before} → ${after} pt`;
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

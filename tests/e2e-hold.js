// v0.5.2: press-and-hold on a Library / Audiobooks tile opens the ⋯ menu (default 4 s; Settings 0.5–5 s), with a progress ring, cancel on release / scroll / move > 10 px,
// no native callout / selection / context menu, no conflict with select mode or drag-reorder, haptic where supported.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (...p) => path.join(__dirname, 'fixtures', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  await page.evaluateOnNewDocument(() => { window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; }; });
  await page.goto(APP, { waitUntil: 'networkidle0' });
  const ev = (f, ...a) => page.evaluate(f, ...a);
  const setHold = (s) => ev(async (s) => { (await import('./js/settings.js')).settings.set({ holdSec: s }); }, s);
  const menuOpen = () => ev(() => { const o = document.querySelector('#overlay'); return !o.hidden && !!o.querySelector('.sheet'); });
  const menuLabels = () => ev(() => [...document.querySelectorAll('#overlay .sheet-body button')].map((b) => b.textContent.trim()).filter(Boolean));
  const closeMenu = () => ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  const readerOpen = () => ev(() => document.querySelector('#reader')?.hidden === false);
  const center = (sel, i = 0) => ev((sel, i) => { const e = document.querySelectorAll(sel)[i]; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel, i);
  const tab = async (t) => { await ev((t) => document.querySelector('[data-tab=' + t + ']').click(), t); await sleep(500); };

  await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), fx('long-book.epub'), fx('saga-1.epub'));
  for (let i = 0; i < 60; i++) { if ((await ev(async () => (await (await import('./js/store.js')).getBooks()).length)) >= 3) break; await sleep(300); } await sleep(600);

  await step('Settings: hold time defaults to 4 s, is clamped to 0.5–5 s, and has a slider in Settings → Press and hold', async () => {
    const r = await ev(async () => { const { settings } = await import('./js/settings.js'); const { holdSeconds } = await import('./js/hold.js'); const d = holdSeconds(); settings.set({ holdSec: 9 }); const hi = holdSeconds(); settings.set({ holdSec: 0.1 }); const lo = holdSeconds(); settings.set({ holdSec: 'x' }); const bad = holdSeconds(); settings.set({ holdSec: 4 }); return { d, hi, lo, bad }; });
    assert(r.d === 4 && r.hi === 5 && r.lo === 0.5 && r.bad === 4, JSON.stringify(r));
    await tab('settings'); const s = await ev(() => { const e = document.querySelector('#hold-sec'); return e && { min: e.min, max: e.max, step: e.step, v: e.value }; }); assert(s && s.min === '0.5' && s.max === '5' && +s.v === 4, JSON.stringify(s));
    await ev(() => { const e = document.querySelector('#hold-sec'); e.value = 1.5; e.dispatchEvent(new Event('input', { bubbles: true })); }); assert((await ev(async () => (await import('./js/settings.js')).settings.get('holdSec'))) === 1.5 && /1\.5/.test(await ev(() => document.querySelector('#hold-sec-val').textContent)), 'slider not applied');
    await setHold(4); await tab('library');
  });
  await step('Tiles suppress native menus: touch-callout none, user-select none, contextmenu / selectstart / dragstart prevented', async () => {
    const r = await ev(() => { const t = document.querySelector('.tile.book'); const cs = getComputedStyle(t); const ev1 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); t.querySelector('.cover').dispatchEvent(ev1); const ev2 = new Event('selectstart', { bubbles: true, cancelable: true }); t.dispatchEvent(ev2);
      return { callout: cs.webkitTouchCallout || cs.getPropertyValue('-webkit-touch-callout'), sel: cs.userSelect || cs.webkitUserSelect, ctx: ev1.defaultPrevented, ss: ev2.defaultPrevented }; });
    assert((r.callout === 'none' || r.callout === '') && r.sel === 'none' && r.ctx && r.ss, JSON.stringify(r));
  });
  let moreLabels;
  await step('Default 4 s: ring fills while holding, nothing at 3 s, menu at ~4 s — the same menu as the ⋯ button; releasing does not open the book or close the menu', async () => {
    await ev(() => document.querySelector('.tile.book .tile-more').click()); await sleep(300); moreLabels = await menuLabels(); assert(moreLabels.length >= 3, 'no ⋯ menu'); await closeMenu();
    const p = await center('.tile.book'); await page.touchscreen.touchStart(p.x, p.y); await sleep(600);
    const ring = await ev(() => ({ ring: !!document.querySelector('.tile.holding .hold-ring circle.hr-fg'), dur: getComputedStyle(document.querySelector('.hold-ring .hr-fg')).animationDuration })); assert(ring.ring, 'no progress ring ' + JSON.stringify(ring));
    await sleep(2400); assert(!(await menuOpen()), 'menu opened before 4 s'); await sleep(1500); assert(await menuOpen(), 'no menu after 4 s');
    const labels = await menuLabels(); assert(JSON.stringify(labels) === JSON.stringify(moreLabels), JSON.stringify([labels, moreLabels]));
    assert(!(await ev(() => !!document.querySelector('.hold-ring'))), 'ring still shown'); assert((await ev(() => window.__vib.length)) >= 1, 'no haptic');
    await page.touchscreen.touchEnd(); await sleep(500); assert(await menuOpen(), 'menu closed by the release'); assert(!(await readerOpen()), 'book opened by the release'); await closeMenu(); return labels.length + ' items';
  });
  await setHold(1);
  await step('Releasing early cancels (ring gone, no menu); a normal tap still opens the book', async () => {
    const p = await center('.tile.book'); await page.touchscreen.touchStart(p.x, p.y); await sleep(600); assert(await ev(() => !!document.querySelector('.hold-ring')), 'ring missing'); await page.touchscreen.touchEnd(); await sleep(1300);
    assert(!(await menuOpen()) && !(await ev(() => !!document.querySelector('.hold-ring'))), 'not cancelled');
    await page.touchscreen.tap(p.x, p.y); await sleep(1500); assert(await readerOpen(), 'tap did not open the book'); await ev(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(500);
  });
  await step('Moving more than 10 px cancels; a small wobble (< 10 px) does not', async () => {
    let p = await center('.tile.book'); await page.touchscreen.touchStart(p.x, p.y); await sleep(300); await page.touchscreen.touchMove(p.x + 4, p.y + 3); await sleep(400); assert(await ev(() => !!document.querySelector('.hold-ring')) || (await menuOpen()), 'wobble cancelled the hold'); await page.touchscreen.touchMove(p.x, p.y + 16); await sleep(1400);
    assert(!(await menuOpen()), 'menu opened after moving 16 px'); await page.touchscreen.touchEnd(); await sleep(300); await closeMenu();
    p = await center('.tile.book'); await page.touchscreen.touchStart(p.x, p.y); await sleep(400); await ev(() => { const v = document.querySelector('#view'); v.scrollTop += 30; v.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scroll')); }); await sleep(1300); assert(!(await menuOpen()), 'scroll did not cancel'); await page.touchscreen.touchEnd(); await sleep(700); await ev(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(400);   // (a synthetic scroll leaves the finger still, so the release is a tap)
  });
  await step('Select mode: holding a tile does nothing (taps still toggle selection)', async () => {
    await ev(() => document.querySelector('#btn-select').click()); await sleep(400); const p = await center('.tile.book'); await page.touchscreen.touchStart(p.x, p.y); await sleep(1500); assert(!(await menuOpen()), 'menu in select mode'); await page.touchscreen.touchEnd(); await sleep(300);
    await ev(() => document.querySelector('#btn-select').click()); await sleep(400);
  });
  await step('Drag-reorder (custom order) is untouched: a press-and-drag still reorders; a still hold opens the menu without reordering', async () => {
    await ev(async () => { const st = await import('./js/settings.js'); st.setSort('shelf:' + st.settings.get('chip'), { field: 'custom' }); await window.__folio.show('library'); }); await sleep(700);
    await ev(() => { const c = [...document.querySelectorAll('.tiles')].find((c) => c.querySelectorAll('.tile').length >= 2); c.dataset.t = '1'; });
    const keys = () => page.$$eval('.tiles[data-t] .tile', (t) => t.map((x) => x.dataset.key));
    const pos = (i) => page.$$eval('.tiles[data-t] .tile', (t, i) => { const r = t[i].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
    const before = await keys(); assert(before.length >= 2, 'need 2 tiles in one grid'); const p0 = await pos(0), p1 = await pos(1); const cdp = await page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p0.x, y: p0.y }] }); await sleep(600);
    assert(await ev(() => document.body.classList.contains('dragging-now')), 'long-press did not start drag ' + JSON.stringify(await ev(() => ({ b: document.body.className, sel: document.querySelector('#view').className, grids: [...document.querySelectorAll('.tiles')].map((c) => c.dataset.ctx + c.querySelectorAll('.tile').length), s: document.querySelector('#overlay').hidden })), p0));
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p0.x + (p1.x + 30 - p0.x) * i / 10, y: p0.y + (p1.y - p0.y) * i / 10 }] });
    await sleep(100); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(700);
    const after = await keys(); assert(after[1] === before[0] && after[0] === before[1], before.join() + ' → ' + after.join()); assert(!(await menuOpen()), 'menu opened during a drag');
    await ev(async () => { await window.__folio.show('library'); }); await sleep(600); await ev(() => { const c = [...document.querySelectorAll('.tiles')].find((c) => c.querySelectorAll('.tile').length >= 2); c.dataset.t = '1'; });
    const order = await keys(); const q = await pos(1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: q.x, y: q.y }] }); await sleep(600); assert(await ev(() => document.body.classList.contains('dragging-now')), 'drag pick-up expected first (custom order)');
    await sleep(900); assert(await menuOpen(), 'no menu from a still hold in custom order'); assert(!(await ev(() => document.body.classList.contains('dragging-now'))), 'drag was not dropped when the menu opened');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(500); assert((await keys()).join() === order.join(), 'still hold reordered'); await closeMenu();
    await ev(async () => { const st = await import('./js/settings.js'); st.clearSort('shelf:' + st.settings.get('chip')); });
  });
  await step('Audiobook tiles: hold opens the audiobook ⋯ menu (same items)', async () => {
    await tab('audiobooks'); await (await page.$('#audio-input')).uploadFile(fx('audio', 'plain_clip.mp3')); await ev(() => 0);
    for (let i = 0; i < 40; i++) { if (await ev(() => !!document.querySelector('.tile.audio'))) break; await sleep(300); } await sleep(500);
    await ev(() => document.querySelector('.tile.audio .tile-more').click()); await sleep(300); const more = await menuLabels(); assert(more.length >= 3, 'no audio ⋯ menu'); await closeMenu();
    const p = await center('.tile.audio'); await page.touchscreen.touchStart(p.x, p.y); await sleep(1500); assert(await menuOpen(), 'no menu from hold'); assert(JSON.stringify(await menuLabels()) === JSON.stringify(more), 'different menu'); await page.touchscreen.touchEnd(); await sleep(300); await closeMenu();
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

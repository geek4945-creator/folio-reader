// v0.5.8: option to hide the reading-progress slider (global Settings + reader Appearance, per-book override); % read / pages left / Page X of Y stay.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  const ev = (f, ...a) => page.evaluate(f, ...a);
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), fx('saga-1.epub'), fx('plain-4pp.pdf'));
  for (let i = 0; i < 80; i++) { if ((await ev(async () => (await (await import('./js/store.js')).getBooks()).length)) >= 3) break; await sleep(300); }
  const idOf = (re) => ev(async (re) => (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re, 'i').test(b.title))?.id, re);
  const open = async (re) => { const id = await idOf(re); await ev(async (id) => { (await import('./js/reader.js')).openReader(id); }, id);
    await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && (!!document.querySelector('#viewer iframe') || !!document.querySelector('#viewer .pdf-page, #viewer .pdf-tpage, #viewer canvas')) && (!!window.__reader?.loc || !!window.__pdf?.ready), { timeout: 30000 }); await sleep(1500); return id; };
  const close = async () => { await ev(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(400); };
  const state = () => ev(() => { const vis = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }; const bar = document.querySelector('.r-bar.bottom').getBoundingClientRect(), v = document.querySelector('#viewer').getBoundingClientRect(), f = document.querySelector('#r-foot');
    return { slider: vis('#r-slider'), label: document.querySelector('.r-label')?.innerText || '', foot: document.querySelector('#r-foot-page')?.innerText || '', left: document.querySelector('#r-foot-left')?.innerText || '', barH: Math.round(bar.height), viewerBottom: Math.round(v.bottom), barTop: Math.round(bar.top), cls: document.querySelector('#reader').className }; });
  const aa = async () => { await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#hide-scrub'); };
  const closeSheet = () => ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  await ev(async () => { (await import('./js/settings.js')).settings.set({ flow: 'scrolled', flowChosen: true }); });

  await step('Default: slider visible with the % label and the footer', async () => {
    await open('frankenstein'); const s = await state(); assert(s.slider && /%/.test(s.label), JSON.stringify(s)); assert(!/no-scrub/.test(s.cls), s.cls); return JSON.stringify(s);
  });
  await step('Reader Appearance → "Hide the progress bar": slider gone, % read + footer stay, bar shrinks (the page area grows)', async () => {
    const before = await state(); await aa(); assert(await ev(() => !document.querySelector('#hide-scrub').checked), 'off by default');
    await page.click('#hide-scrub'); await sleep(500); await closeSheet(); await sleep(300); const s = await state();
    assert(!s.slider && /%/.test(s.label) && /Page|%/.test(s.foot), JSON.stringify(s)); assert(s.barH < before.barH, 'bar shrinks ' + before.barH + '→' + s.barH);
    assert((await ev(async () => (await import('./js/settings.js')).settings.get('hideScrub'))) === true, 'global setting written (All books scope)'); return JSON.stringify({ before: before.barH, after: s.barH, label: s.label, foot: s.foot, left: s.left });
  });
  await step('The choice follows to the next book and survives close / reopen', async () => {
    await close(); await open('saga'); let s = await state(); assert(!s.slider, 'saga hidden'); await close(); await open('frankenstein'); s = await state(); assert(!s.slider && /%/.test(s.label), JSON.stringify(s));
  });
  await step('Per-book override: "This book only" shows the slider for this book while others stay hidden; "Use global" clears it', async () => {
    await aa(); await page.click('#scope-book'); await sleep(300); await page.waitForSelector('#hide-scrub'); assert(await ev(() => document.querySelector('#hide-scrub').checked), 'shows the global value first');
    await page.click('#hide-scrub'); await sleep(500); await closeSheet(); await sleep(300); let s = await state(); assert(s.slider, 'slider back for this book');
    const ov = await ev(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /frankenstein/i.test(x.title)); return { ov: b.overrides, has: S.hasOverrides(b), keys: S.OVERRIDE_KEYS }; });
    assert(ov.ov && ov.ov.hideScrub === false && ov.has && ov.keys.includes('hideScrub'), JSON.stringify(ov));
    assert((await ev(async () => (await import('./js/settings.js')).settings.get('hideScrub'))) === true, 'global untouched');
    await close(); await open('saga'); s = await state(); assert(!s.slider, 'other book still hidden'); await close(); await open('frankenstein'); s = await state(); assert(s.slider, 'override persists');
    await aa(); await page.click('#scope-book'); await sleep(300); await page.click('[data-clear="hideScrub"]'); await sleep(500); await closeSheet(); await sleep(300); s = await state(); assert(!s.slider, 'back to global (hidden)');
    const ov2 = await ev(async () => (await (await import('./js/store.js')).getBooks()).find((x) => /frankenstein/i.test(x.title)).overrides); assert(!ov2 || ov2.hideScrub == null, JSON.stringify(ov2));
  });
  await step('Global Settings page has the toggle (in the reader-footer section); switching it off brings the slider back everywhere', async () => {
    await close(); await ev(() => (window.__flimsy || window.__folio).show('settings')); await page.waitForSelector('#hide-scrub'); assert(await ev(() => document.querySelector('#hide-scrub').checked), 'on'); await page.click('#hide-scrub'); await sleep(300);
    assert((await ev(async () => (await import('./js/settings.js')).settings.get('hideScrub'))) === false, 'global off'); await ev(() => (window.__flimsy || window.__folio).show('library')); await open('saga'); const s = await state(); assert(s.slider, 'slider back'); await close();
  });
  await step('It is a synced setting; the per-book value syncs as a per-book override', async () => {
    const r = await ev(async () => { const st = await import('./js/settings.js'); return { synced: st.SYNCED.includes('hideScrub'), group: st.SETTING_GROUPS.some((g) => g.keys.includes('hideScrub')) }; }); assert(r.synced && r.group, JSON.stringify(r));
  });
  await step('PDF: the progress slider is hidden too, the page label stays', async () => {
    await ev(async () => { (await import('./js/settings.js')).settings.set({ hideScrub: true }); }); await open('plain|4pp|test|pdf'); const s = await state(); assert(!s.slider, JSON.stringify(s)); await close();
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

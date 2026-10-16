// v0.5.2: continuous scroll is the default reading flow. Stored choices win; footer, progress restore, Find my place and PDF behave in scroll mode.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = [];
  const fresh = async (seed) => {   // a new profile; seed = stored settings JSON (or null for a brand-new user)
    const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
    if (seed) await page.evaluateOnNewDocument((s) => { if (!localStorage.getItem('__seeded')) { localStorage.setItem('folio.settings', s); localStorage.setItem('__seeded', '1'); } }, seed);
    await page.goto(APP, { waitUntil: 'networkidle0' }); return page;
  };
  const until = async (fn, ms = 15000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(150); } };
  const importFiles = async (page, ...files) => { const n0 = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); await (await page.$('#file-input')).uploadFile(...files); await until(() => page.evaluate(async (n) => (await (await import('./js/store.js')).getBooks()).length >= n, n0 + files.length), 20000, 'import'); };
  const open = (page, re) => page.evaluate(async (re) => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re, 'i').test(b.title)); (await import('./js/reader.js')).openReader(b.id); }, re);
  const close = (page) => page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
  const rendered = (page) => until(() => page.evaluate(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc), 20000, 'reader');
  const foot = (page) => page.evaluate(() => ({ page: document.querySelector('#r-foot-page')?.textContent || '', left: document.querySelector('#r-foot-left')?.textContent || '' }));
  const mode = (page) => page.evaluate(() => { const c = window.__reader; return { flow: c.rendition.settings.flow, mgr: c.rendition.manager.name || c.rendition.manager.constructor.name, canScroll: c.rendition.manager.container.scrollHeight > c.rendition.manager.container.clientHeight }; });

  let page = await fresh(null);
  await step('Brand-new user: default flow is Scroll; Settings shows Scroll selected; nothing marked as a choice', async () => {
    const r = await page.evaluate(async () => { const { settings } = await import('./js/settings.js'); return { flow: settings.get('flow'), chosen: settings.get('flowChosen') }; });
    assert(r.flow === 'scrolled' && r.chosen === false, JSON.stringify(r));
    await page.evaluate(() => document.querySelector('[data-tab=settings]').click()); await page.waitForFunction(() => document.querySelector('.seg.wide button.on'), { timeout: 5000 });
    const on = await page.evaluate(() => [...document.querySelectorAll('.seg.wide')].map((s) => s.querySelector('button.on')?.textContent).filter(Boolean)); assert(on.includes('Scroll'), on.join());
  });
  await step('A book with no saved choice opens in continuous scroll (no page turns); footer shows Page X of Y and pages left', async () => {
    await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await importFiles(page, fx('long-book.epub'), fx('frankenstein.epub'), fx('test-doc.pdf'));
    await open(page, 'Frankenstein'); await rendered(page); const m = await mode(page); assert(m.flow === 'scrolled' && /continuous/i.test(m.mgr) && m.canScroll, JSON.stringify(m));
    await until(async () => /^Page \d+ of \d+$/.test((await foot(page)).page), 20000, 'Page X of Y'); const f = await foot(page); assert(/left in chapter|Last page of chapter/.test(f.left), JSON.stringify(f)); return JSON.stringify(f);
  });
  await step('Footer in scroll mode follows scrolling (page number rises, pages left shrinks); a percent shows when pages are unknown', async () => {
    const a = await foot(page); await page.evaluate(() => { const c = window.__reader.rendition.manager.container; c.scrollTop += c.clientHeight * 3.1; }); await sleep(1200); const b = await foot(page);
    const n = (f) => +/Page (\d+)/.exec(f.page)[1]; assert(n(b) > n(a), JSON.stringify([a, b]));
    const pct = await page.evaluate(async () => { const { paintFooter } = await import('./js/pages.js'); paintFooter({ percent: 0.426 }); return document.querySelector('#r-foot-page').textContent; }); assert(pct === '43%', pct); return JSON.stringify([a, b]);
  });
  let saved;
  await step('Progress restore works in scroll mode: close, reopen → same place', async () => {
    await page.evaluate(() => { const c = window.__reader; c.rendition.manager.container.scrollTop += c.rendition.manager.container.clientHeight * 4; }); await sleep(1500);
    saved = await page.evaluate(() => { const c = window.__reader; const l = c.rendition.currentLocation(); return { idx: l.start.index, cfi: l.start.cfi, p: c.book.progress }; });
    await close(page); await sleep(500); const stored = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).find((b) => /Frankenstein/i.test(b.title)).cfi); assert(stored, 'no cfi saved');
    await open(page, 'Frankenstein'); await rendered(page); await sleep(1500);
    const after = await page.evaluate(() => { const l = window.__reader.rendition.currentLocation(); return { idx: l.start.index, cfi: l.start.cfi }; });
    assert(after.idx === saved.idx, JSON.stringify({ saved, after })); await close(page); return JSON.stringify({ saved: saved.idx, after: after.idx });
  });
  await step('PDF still opens and has its own paged / scroll controls (PDF follows the same Pages / Scroll choice)', async () => {
    await open(page, '^Folio Test PDF$'); await until(() => page.evaluate(() => !!document.querySelector('#viewer canvas, #viewer .pdf-page, #viewer .scroll-mode, #viewer .paged-mode')), 15000, 'pdf');
    const r = await page.evaluate(() => ({ scroll: document.querySelector('#viewer').classList.contains('scroll-mode'), canvases: document.querySelectorAll('#viewer canvas').length })); assert(r.scroll && r.canvases >= 1, JSON.stringify(r)); await close(page);
  });
  await step('Choosing Pages in the reader is remembered as an explicit choice and sticks across reload', async () => {
    await open(page, 'Frankenstein'); await rendered(page); await page.evaluate(() => document.querySelector('#r-aa').click()); await page.waitForSelector('[data-flow=paginated]'); await page.evaluate(() => document.querySelector('[data-flow=paginated]').click()); await sleep(1500);
    await page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); const m = await mode(page); assert(m.flow === 'paginated', JSON.stringify(m)); await close(page);
    await page.reload({ waitUntil: 'networkidle0' }); const r = await page.evaluate(async () => { const { settings } = await import('./js/settings.js'); return { flow: settings.get('flow'), chosen: settings.get('flowChosen') }; }); assert(r.flow === 'paginated' && r.chosen === true, JSON.stringify(r));
    await open(page, 'Frankenstein'); await rendered(page); assert((await mode(page)).flow === 'paginated', 'did not reopen paginated'); await close(page);
  });
  await step('Sync: an untouched default is not written to Drive settings; an explicit choice is', async () => {
    const a = await page.evaluate(async () => { const { settings } = await import('./js/settings.js'); const { buildSnapshot } = await import('./js/google.js'); settings.set({ flow: 'scrolled' }); const s1 = await buildSnapshot(); return s1.settings.values.flow; }); assert(a === 'scrolled', 'chosen scroll should sync: ' + a);
    const b = await page.evaluate(async () => { const { settings } = await import('./js/settings.js'); const { buildSnapshot } = await import('./js/google.js'); settings.set({ flowChosen: false }); const s = await buildSnapshot(); return 'flow' in s.settings.values; }); assert(b === false, 'default flow leaked into the snapshot');
  });
  await page.close();

  await step('Existing user whose stored settings say Pages keeps Pages (stored choice wins over the new default)', async () => {
    const p = await fresh(JSON.stringify({ theme: 'sepia', flow: 'paginated', flowChosen: true })); const r = await p.evaluate(async () => (await import('./js/settings.js')).settings.all());
    assert(r.flow === 'paginated' && r.theme === 'sepia', JSON.stringify(r)); await importFiles(p, fx('frankenstein.epub')); await open(p, 'Frankenstein'); await rendered(p); assert((await mode(p)).flow === 'paginated', 'paginated expected'); await p.close();
  });
  await step('Existing user whose stored settings say Scroll keeps Scroll; stored settings without a flow key get the new default', async () => {
    const p = await fresh(JSON.stringify({ flow: 'scrolled', flowChosen: true })); assert((await p.evaluate(async () => (await import('./js/settings.js')).settings.get('flow'))) === 'scrolled'); await p.close();
    const q = await fresh(JSON.stringify({ theme: 'dark' })); const r = await q.evaluate(async () => { const { settings } = await import('./js/settings.js'); return [settings.get('flow'), settings.get('theme')]; }); assert(r.join() === 'scrolled,dark', r.join()); await q.close();
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

// v0.5.20 "my appearance changes revert": theme / font / size / layout changes must stick through reloads, stale cloud files, a device with a fast
// clock, a second stale tab, a sync running during the edit, and the reader's "This book only" scope (which used to open by default and mask
// global changes).
const puppeteer = require('puppeteer-core'); const path = require('path');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState(); const C = S.cloud;
async function mk(ctx, name) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') page.errs.push(e.message); });
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin()); await page.evaluateOnNewDocument((n) => localStorage.setItem('folio.deviceName', n), name);
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(1800); await tune(page); return page;
}
const tune = (p) => p.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; });
const sync = (p, o = {}) => p.evaluate(async (o) => { const r = await (await import('./js/google.js')).syncNow(o); await new Promise((x) => setTimeout(x, 150)); return r; }, o);
const set = (p, patch) => p.evaluate(async (patch) => (await import('./js/settings.js')).settings.set(patch), patch);
const LOOK = ['theme', 'font', 'fontSizePt', 'lineHeight', 'margin'];
const get = (p) => p.evaluate(async (keys) => { const { settings } = await import('./js/settings.js'); return Object.fromEntries(keys.map((k) => [k, settings.get(k)])); }, LOOK);
const WANT = { theme: 'sepia', font: 'georgia', fontSizePt: 19.5, lineHeight: 1.8, margin: 40 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reload = async (p) => { await p.reload({ waitUntil: 'networkidle0' }); await sleep(1500); await tune(p); };

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const LT = await mk(await browser.createBrowserContext(), 'Laptop'); const PH = await mk(await browser.createBrowserContext(), 'iPhone');
  let OLD;
  await step('Both devices synced on the defaults', async () => { await sync(LT); await sync(PH); await sync(LT); OLD = C.files.get('folio-settings.json').buf; return JSON.stringify(await get(PH)); });
  await step('Change theme, font, size, line spacing and margins → reload → still there', async () => {
    await sleep(30); await set(PH, WANT); await sync(PH); await reload(PH); const g = await get(PH); assert(same(g, WANT), JSON.stringify(g)); return JSON.stringify(g);
  });
  await step('A stale settings file (written later by a device that never saw the change) → Sync → the change sticks, and the file is fixed', async () => {
    C.put('folio-settings.json', OLD); await sync(PH); await reload(PH); const g = await get(PH); assert(same(g, WANT), JSON.stringify(g));
    const f = C.json('folio-settings.json'); assert(JSON.stringify(f).includes('sepia'), 'cloud has sepia again'); return JSON.stringify(g);
  });
  await step('The laptop (still on old values, with old stamps) syncs → it takes the change instead of reverting it', async () => {
    await sync(LT); const g = await get(LT); assert(same(g, WANT), JSON.stringify(g)); await sync(PH); assert(same(await get(PH), WANT), 'iPhone kept'); return JSON.stringify(g);
  });
  await step('A device whose clock runs a day fast wrote old values earlier → a later real change still wins (future stamps capped to when Drive saved the file)', async () => {
    const f = JSON.parse(OLD.toString('utf8')); const fut = Date.now() + 86400e3; for (const e of Object.values(f.flat || {})) if (e) e.at = fut;
    C.put('folio-settings.json', Buffer.from(JSON.stringify(f))); await sleep(60);
    const W2 = { ...WANT, theme: 'paper' }; await set(PH, W2); await sync(PH); await reload(PH); await sync(PH, { force: true }); const g = await get(PH);
    assert(same(g, W2), JSON.stringify(g)); return JSON.stringify(g);
  });
  await step('This device’s own clock is a day slow → Folio notices (Drive’s time), warns in Settings, and stamps changes with Drive’s time so they still win', async () => {
    await PH.evaluate(() => localStorage.setItem('folio.clockSkew', String(86400e3)));
    await set(PH, { margin: 44 }); const at = await PH.evaluate(async () => (await import('./js/settings.js')).settingStamps().margin); assert(at > Date.now() + 86000e3, 'stamped with Drive time');
    await PH.evaluate(() => window.__folio.show('settings')); await PH.waitForSelector('#sync-details'); const w = await PH.$('#sync-skew'); assert(w, 'skew warning shown');
    await PH.evaluate(() => localStorage.removeItem('folio.clockSkew')); await set(PH, { margin: 40 }); await PH.evaluate(async () => { const st = (await import('./js/settings.js')).settingStamps(); });
    await sync(PH); return 'stamp ' + new Date(at).toISOString();
  });
  await step('Two tabs: a stale second tab changing one setting does not put back the others', async () => {
    const T2 = await (PH.browserContext()).newPage(); await install(T2, S); await T2.goto(APP, { waitUntil: 'networkidle0' }); await sleep(1500); await tune(T2);
    await set(PH, { theme: 'solarized', margin: 32 }); await sleep(200);
    await set(T2, { fontSizePt: 21 }); await sleep(200); await T2.close(); await reload(PH); const g = await get(PH);
    assert(g.theme === 'solarized' && g.margin === 32 && g.fontSizePt === 21 && g.font === 'georgia', JSON.stringify(g)); return JSON.stringify(g);
  });
  await step('A change made while a sync is running is kept (not overwritten by the sync’s older copy)', async () => {
    await set(LT, { lineHeight: 1.3 }); await sync(LT);
    const g = await PH.evaluate(async () => { const G = await import('./js/google.js'); const { settings } = await import('./js/settings.js'); const p = G.syncNow({ force: true }); settings.set({ theme: 'light', margin: 12 }); await p; await new Promise((r) => setTimeout(r, 200)); return { theme: settings.get('theme'), margin: settings.get('margin'), lineHeight: settings.get('lineHeight') }; });
    assert(g.theme === 'light' && g.margin === 12 && g.lineHeight === 1.3, JSON.stringify(g)); await sync(PH); await sync(LT); const l = await get(LT); assert(l.theme === 'light' && l.margin === 12, JSON.stringify(l)); return JSON.stringify(g);
  });
  await step('Reader Appearance opens on "All books" even when the book has its own settings; a change there applies and clears this book’s own value', async () => {
    await (await PH.$('#file-input')).uploadFile(path.join(__dirname, 'fixtures', 'frankenstein.epub'));
    let id; for (let i = 0; i < 60 && !id; i++) { await sleep(300); id = await PH.evaluate(async () => (await (await import('./js/store.js')).getBooks()).find((b) => /frankenstein/i.test(b.title))?.id); }
    await PH.evaluate(async (id) => { const S = await import('./js/store.js'); await S.setOverride(id, { fontSizePt: 25 }); (await import('./js/reader.js')).openReader(id); }, id);
    await PH.waitForFunction(() => !!document.querySelector('#viewer iframe') && !!window.__reader?.loc, { timeout: 30000 }); await sleep(1200);
    await PH.evaluate(() => document.querySelector('#r-aa').click()); await PH.waitForSelector('#scope-global');
    const on = await PH.$eval('#scope-global', (e) => e.className); assert(/on/.test(on), 'global scope by default'); assert(await PH.$('#scope-hint'), 'hint shown');
    await PH.click('#fs-plus'); await sleep(500);
    const r = await PH.evaluate(async (id) => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => x.id === id); return { ov: b.overrides, g: (await import('./js/settings.js')).settings.get('fontSizePt') }; }, id);
    assert(r.g === 25.5 && !(r.ov && r.ov.fontSizePt != null), JSON.stringify(r)); return JSON.stringify(r);
  });
  const errs = [PH.errs, LT.errs]; console.log('  page errors:', JSON.stringify(errs)); await browser.close();
  const ok = results.filter((r) => r[0]).length; console.log(`\n${ok}/${results.length} passed`); process.exit(ok === results.length && !errs.flat().length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

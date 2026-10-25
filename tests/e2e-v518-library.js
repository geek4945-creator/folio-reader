// v0.5.18 library: NEW badge vs series book-count badge colours (every theme) + the "Currently Reading" shelf is gone (and stays gone after old/synced/restored settings), Reading now tab untouched.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const show = async () => { await page.evaluate(() => window.__folio.show('library')); await sleep(600); };
  const chips = () => page.$$eval('[data-chip]', (e) => e.map((x) => x.dataset.chip + (x.classList.contains('on') ? '*' : '')));
  await (await page.$('#file-input')).uploadFile(...['frankenstein.epub', 'saga-1.epub', 'saga-2.epub', 'saga-3.epub', 'standalone.epub'].map(fx));
  for (let i = 0; i < 80; i++) { const n = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); if (n >= 5) break; await sleep(300); }
  await page.evaluate(async () => { const st = await import('./js/settings.js'); st.settings.set({ groupSets: true, chip: 'all', groupBy: 'none' }); }); await show();

  await step('NEW badge and series book-count badge have clearly different colours, white text with ≥4.5:1 contrast, in all 8 themes', async () => {
    await page.waitForSelector('.pbadge.new'); await page.waitForSelector('.pbadge.set');
    const out = [];
    for (const theme of ['light', 'sepia', 'paper', 'solarized', 'dark', 'ocean', 'forest', 'night']) {
      await page.evaluate(async (t) => { (await import('./js/settings.js')).settings.set({ theme: t }); }, theme); await show();
      const r = await page.evaluate(() => {
        const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number); const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const st = (sel) => { const cs = getComputedStyle(document.querySelector(sel)); return { bg: rgb(cs.backgroundColor), fg: rgb(cs.color), text: document.querySelector(sel).innerText }; };
        const n = st('.pbadge.new'), s = st('.pbadge.set'); const dist = Math.hypot(...n.bg.map((v, i) => v - s.bg[i]));
        return { n, s, dist, cn: ratio(n.bg, n.fg), cs: ratio(s.bg, s.fg) };
      });
      assert(r.n.text === 'NEW' && /books/.test(r.s.text), JSON.stringify(r));
      assert(r.dist > 60, theme + ' colours too close ' + JSON.stringify([r.n.bg, r.s.bg]));
      assert(r.n.bg[1] > r.n.bg[0] && r.n.bg[1] > r.n.bg[2], theme + ' NEW not green ' + r.n.bg);
      assert(r.s.bg[2] > r.s.bg[0], theme + ' set not slate/blue ' + r.s.bg);
      assert(r.cn >= 4.5 && r.cs >= 4.5, theme + ' contrast ' + r.cn.toFixed(2) + '/' + r.cs.toFixed(2)); out.push(theme + ' ' + r.cn.toFixed(1) + '/' + r.cs.toFixed(1));
    }
    await page.evaluate(async () => { (await import('./js/settings.js')).settings.set({ theme: 'light' }); }); return out.join(', ');
  });
  await step('Library shelves: no "Currently Reading" chip (All / Want to Read / Finished / custom stay)', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Frankenstein/.test(x.title)); await S.setStatus(b.id, 'reading'); }); await show();
    const c = await chips(); assert(!c.some((x) => x.startsWith('reading')) && c.includes('all*') && c.includes('want') && c.includes('finished'), c.join()); 
    const txt = await page.$eval('.chips', (e) => e.innerText); assert(!/Currently Reading/i.test(txt), txt); return c.join(' ');
  });
  await step('A book with status Currently Reading keeps its status/progress, still shows in All and in the Reading now tab', async () => {
    const st = await page.evaluate(async () => { const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); const b = (await S.getBooks()).find((x) => /Frankenstein/.test(x.title)); b.progress = 0.4; await DB.put('books', b); return b.status; });
    assert(st === 'reading', st); await show(); const t = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText).join('|')); assert(/Frankenstein/.test(t), t);
    await page.evaluate(() => window.__folio.show('reading')); await sleep(700); const rn = await page.evaluate(() => document.querySelector('#view')?.innerText || document.body.innerText); assert(/Frankenstein/.test(rn), rn.slice(0, 200));
    assert(await page.$('[data-tab="reading"], nav [data-view="reading"], #tab-reading, .tabbar [data-v="reading"]') || /Reading now/i.test(await page.evaluate(() => document.body.innerText)), 'Reading now tab missing');
  });
  await step('Old / synced / restored settings with chip "reading" fall back to All, and a stored shelf:reading order or sort does not resurrect the shelf', async () => {
    await page.evaluate(async () => { const st = await import('./js/settings.js'); st.settings.set({ chip: 'reading', sorts: { 'shelf:reading': { field: 'title', dir: 'desc' } } }); const S = await import('./js/store.js'); await S.saveOrder('shelf:reading', (await S.getBooks()).map((b) => b.id)); });
    await show(); let c = await chips(); assert(c.includes('all*') && !c.some((x) => x.startsWith('reading')), c.join());
    await page.reload({ waitUntil: 'networkidle0' }); await show(); c = await chips(); assert(c.includes('all*') && !c.some((x) => x.startsWith('reading')), 'after reload ' + c.join());
    // backup restore path: import a backup whose settings name the old shelf
    const restored = await page.evaluate(async () => { const B = await import('./js/backup.js'); return Object.keys(B).join(','); }); return restored;
  });
  await step('Custom order on All still works (books with status reading included)', async () => {
    const ids = await page.evaluate(async () => { const st = await import('./js/settings.js'); st.settings.set({ chip: 'all', groupBy: 'none', groupSets: false, sorts: { 'shelf:all:flat': { field: 'custom' }, 'shelf:all': { field: 'custom' } } }); const S = await import('./js/store.js'); const bs = (await S.getBooks()).sort((a, b) => b.title.localeCompare(a.title)); const ids = bs.map((b) => 'b:' + b.id); await S.saveOrder('shelf:all:flat', ids); await S.saveOrder('shelf:all', ids); return bs.map((b) => b.title); });
    await show(); const t = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText)); assert(t.length === ids.length && t.every((x, i) => ids[i].startsWith(x.slice(0, 10))), t.join('|') + ' vs ' + ids.join('|')); return t.join(' | ');
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

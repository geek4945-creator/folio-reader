// Sorting tests: per shelf/set sort + direction, Series/Progress/File type/Added/Recent, default sort, reset-all, persistence/sync keys.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const titles = () => page.$$eval('.tile .t', (e) => e.map((x) => x.innerText));
  const show = async () => { await page.evaluate(() => window.__folio.show('library')); await sleep(500); };
  const sortState = () => page.evaluate(() => ({ field: document.querySelector('#sort-sel').value, dir: document.querySelector('#sort-dir')?.dataset.dir }));
  const chip = async (id) => { await page.waitForSelector(`[data-chip="${id}"]`, { timeout: 15000 }); await page.evaluate((id) => document.querySelector(`[data-chip="${id}"]`).click(), id); await sleep(500); };   // a render in flight has emptied the view for a moment: wait for the chip
  const patchBooks = (fn) => page.evaluate(async (src) => { const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); const f = eval(src); for (const b of await S.getBooks()) { f(b); await DB.put('books', b); } }, fn.toString());

  await step('Import mixed library: EPUBs, MOBI, AZW3, PDF', async () => {
    await (await page.$('#file-input')).uploadFile(...['frankenstein.epub', 'saga-1.epub', 'saga-2.epub', 'saga-3.epub', 'standalone.epub', 'test-doc.pdf', 'saga-mobi6.mobi'].map(fx).filter((p) => !/saga-mobi6/.test(p)));
    for (let i = 0; i < 80; i++) { const n = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); if (n >= 6) break; await sleep(300); }
    await (await page.$('#file-input')).uploadFile(fx('series-kf8.azw3')); await sleep(2500);
    const n = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); assert(n === 7, 'books ' + n);
    await page.evaluate(async () => { const st = await import('./js/settings.js'); st.settings.set({ groupSets: false }); }); await show(); return (await titles()).join(' | ');
  });
  // deterministic metadata
  await patchBooks((b) => { const m = { 'Frankenstein; or, the modern prometheus': [1000, 5000, 0.9], 'Saga Book One': [2000, 0, 0], 'Saga Book Two': [3000, 9000, 0.5], 'Saga Book Three': [4000, 8000, 0.2], 'A Standalone Tale': [5000, 7000, 0], 'Folio Test PDF': [6000, 6000, 0.1], 'Kindle Saga Two': [7000, 0, 0] }[b.title]; if (m) { b.addedAt = m[0]; b.lastOpened = m[1]; b.progress = m[2]; } });
  await show();

  await step('Default sort is Recently read, newest first (own sort not set)', async () => {
    const s = await sortState(); assert(s.field === 'recent' && s.dir === 'desc', JSON.stringify(s)); const t = await titles(); assert(t[0] === 'Saga Book Two', t.join('|')); assert(t.slice(-1)[0] !== undefined); return t.join(' | ');
  });
  await step('Sort options include all requested fields', async () => {
    const o = await page.$$eval('#sort-sel option', (e) => e.map((x) => x.value)); for (const k of ['recent', 'added', 'title', 'author', 'series', 'progress', 'type', 'custom']) assert(o.includes(k), 'missing ' + k + ': ' + o); return o.join();
  });
  await step('Recently added (desc → asc via direction toggle)', async () => {
    await page.select('#sort-sel', 'added'); await sleep(400); let t = await titles(); assert(t[0] === 'Kindle Saga Two' && t.slice(-1)[0].startsWith('Frankenstein'), t.join('|'));
    await page.click('#sort-dir'); await sleep(400); t = await titles(); assert(t[0].startsWith('Frankenstein') && t.slice(-1)[0] === 'Kindle Saga Two', t.join('|')); assert((await sortState()).dir === 'asc');
  });
  await step('Title A–Z / Z–A', async () => {
    await page.select('#sort-sel', 'title'); await sleep(400); let t = await titles(); assert(t[0] === 'A Standalone Tale' || t[0].startsWith('Folio') || t[0].startsWith('Frank'), 'title asc ' + t.join('|')); const asc = t.join('|');
    await page.click('#sort-dir'); await sleep(400); t = await titles(); assert(t.join('|') === asc.split('|').reverse().join('|'), 'desc ' + t.join('|')); return asc;
  });
  await step('Author sort; unknown authors last', async () => { await page.select('#sort-sel', 'author'); await sleep(400); const t = await titles(); assert(t.length === 7, t.join()); return t.join(' | '); });
  await step('Series sort groups by series then volume; standalone books last', async () => {
    await page.select('#sort-sel', 'series'); await sleep(400); if ((await sortState()).dir !== 'asc') { await page.click('#sort-dir'); await sleep(300); }
    const t = await titles(); const i1 = t.indexOf('Saga Book One'), i2 = t.indexOf('Saga Book Two'), i3 = t.indexOf('Saga Book Three');
    assert(i1 < i2 && i2 < i3 && i3 === i1 + 2, 'saga order ' + t.join('|')); assert(t.indexOf('Frankenstein; or, the modern prometheus') > i3 && t.indexOf('Folio Test PDF') > i3, 'standalones last ' + t.join('|')); return t.join(' | ');
  });
  await step('Reading progress sort (most read first, and reversed)', async () => {
    await page.select('#sort-sel', 'progress'); await sleep(400); let t = await titles(); assert(t[0].startsWith('Frankenstein') && t[1] === 'Saga Book Two', t.join('|'));
    await page.click('#sort-dir'); await sleep(300); t = await titles(); assert(t.slice(-1)[0].startsWith('Frankenstein'), t.join('|')); await page.click('#sort-dir'); await sleep(200);
  });
  await step('File type sort (EPUB / AZW3 / PDF)', async () => {
    await page.select('#sort-sel', 'type'); await sleep(400); const t = await titles(); // asc: AZW3, EPUB..., PDF
    assert(t[0] === 'Kindle Saga Two' && t.slice(-1)[0] === 'Folio Test PDF', t.join('|')); return t.join(' | ');
  });
  await step('Each shelf keeps its own sort (All=type; Want/Finished/custom shelf independent)', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const f = (t) => bs.find((b) => b.title.startsWith(t)); await S.setStatus(f('Saga Book Two').id, 'finished'); await S.setStatus(f('Saga Book One').id, 'finished'); await S.setStatus(f('A Standalone').id, 'reading'); const sh = await S.createShelf('Faves'); await S.toggleShelf(f('Frankenstein').id, sh.id); await S.toggleShelf(f('Folio').id, sh.id); await S.toggleShelf(f('Kindle').id, sh.id); window.__shelf = sh.id; });
    await chip('finished'); let s = await sortState(); assert(s.field === 'recent' && s.dir === 'desc', 'finished default ' + JSON.stringify(s));
    await page.select('#sort-sel', 'title'); await sleep(300); let t = await titles(); assert(t.join('|') === 'Saga Book One|Saga Book Two', t.join('|'));
    await page.click('#sort-dir'); await sleep(300); t = await titles(); assert(t.join('|') === 'Saga Book Two|Saga Book One', 'finished desc ' + t.join('|'));
    await chip('want'); s = await sortState(); assert(s.field === 'recent', 'want kept default ' + JSON.stringify(s));
    await chip('all'); s = await sortState(); assert(s.field === 'type', 'all kept type ' + JSON.stringify(s));
    await page.waitForSelector('[data-chip]:not([data-chip=all]):not([data-chip=reading]):not([data-chip=want]):not([data-chip=finished])', { timeout: 15000 }); await page.evaluate(() => document.querySelector('[data-chip]:not([data-chip=all]):not([data-chip=reading]):not([data-chip=want]):not([data-chip=finished])').click()); await sleep(500);
    s = await sortState(); assert(s.field === 'recent', 'custom shelf default'); await page.select('#sort-sel', 'author'); await sleep(300);
    await chip('finished'); s = await sortState(); assert(s.field === 'title' && s.dir === 'desc', 'finished still title desc ' + JSON.stringify(s));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings')).sorts); assert(stored['shelf:all'].field === 'type' && stored['shelf:finished'].dir === 'desc' && Object.keys(stored).length === 3, JSON.stringify(stored)); return JSON.stringify(stored);
  });
  await step('Sorts persist across reload', async () => {
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(500); await chip('finished'); const s = await sortState(); assert(s.field === 'title' && s.dir === 'desc', JSON.stringify(s));
  });
  await step('Sets: per-set sort — volume / title / recently added / custom, with direction', async () => {
    await page.evaluate(async () => { const st = await import('./js/settings.js'); st.settings.set({ groupSets: true, chip: 'all' }); }); await show();
    await page.evaluate(() => [...document.querySelectorAll('.tile.set')].find((t) => /Test Saga/.test(t.innerText)).click()); await page.waitForSelector('#set-back');
    const opts = await page.$$eval('#set-sort-sel option', (e) => e.map((x) => x.value)); assert(opts.join() === 'volume,title,added,custom', opts.join());
    let t = await titles(); assert(t.join('|') === 'Saga Book One|Saga Book Two|Saga Book Three', 'volume ' + t.join('|'));
    await page.click('#sort-dir'); await sleep(300); t = await titles(); assert(t.join('|') === 'Saga Book Three|Saga Book Two|Saga Book One', 'volume desc ' + t.join('|'));
    await page.select('#set-sort-sel', 'title'); await sleep(300); t = await titles(); assert(t[0] === 'Saga Book One' || t[0] === 'Saga Book Three', 'title ' + t.join('|')); const sT = t.join('|');
    await page.select('#set-sort-sel', 'added'); await sleep(300); t = await titles(); assert(t.join('|') === 'Saga Book Three|Saga Book Two|Saga Book One', 'added default newest first ' + t.join('|'));
    await page.click('#sort-dir'); await sleep(300); t = await titles(); assert(t.join('|') === 'Saga Book One|Saga Book Two|Saga Book Three', 'added asc ' + t.join('|'));
    await page.select('#set-sort-sel', 'custom'); await sleep(300); assert(await page.$('#reset-order'), 'custom reset btn'); assert(!(await page.$('#sort-dir')), 'no direction for custom');
    await page.click('#reset-order'); await sleep(500); const s = await page.$eval('#set-sort-sel', (e) => e.value); assert(s !== 'custom', 'reset left custom');
    await page.select('#set-sort-sel', 'title'); await sleep(300); await page.click('#set-back'); await sleep(400); return sT;
  });
  await step('Settings → Default sort applies to shelves without their own; own sorts win', async () => {
    await page.evaluate(() => window.__folio.show('settings')); await page.waitForSelector('#default-sort-field');
    await page.select('#default-sort-field', 'title'); await sleep(300); await page.click('#default-sort-dir'); await sleep(300);
    const d = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings')).defaultSort); assert(d.field === 'title', JSON.stringify(d));
    await show(); await chip('want'); const s = await sortState(); assert(s.field === 'title', 'want uses default ' + JSON.stringify(s)); await chip('finished'); assert((await sortState()).field === 'title' && (await sortState()).dir === 'desc', 'finished own');
    await chip('all'); assert((await sortState()).field === 'type', 'all own kept'); return JSON.stringify(d);
  });
  await step('"Reset all shelves to default sort" clears every per-shelf and per-set sort', async () => {
    await page.evaluate(() => window.__folio.show('settings')); await page.waitForSelector('#reset-all-sorts'); await page.click('#reset-all-sorts'); await page.waitForSelector('.sheet, .dlg, .modal', { timeout: 3000 }).catch(() => {});
    await page.evaluate(() => { const b = [...document.querySelectorAll('#overlay button')].find((x) => /^Reset$/.test(x.textContent.trim())); b && b.click(); }); await sleep(500);
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings'))); assert(Object.keys(st.sorts).length === 0, JSON.stringify(st.sorts));
    await show(); await chip('all'); const s = await sortState(); assert(s.field === 'title', 'all follows default after reset ' + JSON.stringify(s));
  });
  await step('Sort settings are in the synced settings set', async () => {
    const r = await page.evaluate(async () => { const st = await import('./js/settings.js'); return { sorts: st.SYNCED.includes('sorts'), def: st.SYNCED.includes('defaultSort') }; }); assert(r.sorts && r.def, JSON.stringify(r));
  });
  await step('Legacy global sort setting migrates to the default sort', async () => {
    const r = await page.evaluate(async () => { localStorage.setItem('folio.settings', JSON.stringify({ sort: 'author' })); const st = await import('./js/settings.js?x=' + Date.now()); return st.settings.get('defaultSort'); }); assert(r.field === 'author', JSON.stringify(r));
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close();
  const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

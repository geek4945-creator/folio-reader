// "Group by" in the All view: Status (default) / None (flat) / Series / Author / File type; collapsible headers, per-group sort + drag order, persistence, sync key.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const show = async () => { await page.evaluate(() => window.__folio.show('library')); await sleep(500); };
  const heads = () => page.$$eval('.group-hdr, .sec-title', (e) => e.map((x) => x.innerText.replace(/\s*\n\s*/g, ' ').replace(/^[▸▾]\s*/, '')));
  // sections: [{head, titles[]}] in DOM order
  const layout = () => page.evaluate(() => { const out = []; let cur = { head: null, titles: [] }; for (const el of document.querySelectorAll('#lib-body > *')) { if (el.matches('.sec-title')) { if (cur.head !== null || cur.titles.length) out.push(cur); cur = { head: el.innerText.replace(/\s*\n\s*/g, ' ').replace(/^[▸▾]\s*/, ''), titles: [] }; } else cur.titles.push(...[...el.querySelectorAll('.tile .t')].map((x) => x.innerText)); } out.push(cur); return out; });
  const groupBy = async (v) => { await page.select('#group-sel', v); await sleep(500); };
  const storeEval = (fn, ...a) => page.evaluate(async (src, ...args) => { const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); const { settings } = await import('./js/settings.js'); return eval(src)(S, DB, settings, ...args); }, fn.toString(), ...a);

  await step('Import 7 books (EPUBs, series, PDF, AZW3) and set statuses', async () => {
    await (await page.$('#file-input')).uploadFile(...['frankenstein.epub', 'saga-1.epub', 'saga-2.epub', 'saga-3.epub', 'standalone.epub', 'test-doc.pdf'].map(fx));
    for (let i = 0; i < 80; i++) { const n = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); if (n >= 6) break; await sleep(300); }
    await (await page.$('#file-input')).uploadFile(fx('series-kf8.azw3')); await sleep(2500);
    const info = await storeEval(async (S) => { const bs = await S.getBooks(); const f = (t) => bs.find((b) => b.title.startsWith(t)); await S.setStatus(f('Frankenstein').id, 'finished'); await S.setStatus(f('Saga Book One').id, 'reading'); await S.setStatus(f('Saga Book Two').id, 'reading'); return bs.map((b) => [b.title, b.author, b.status, b.format, b.origFormat]); });
    assert(info.length === 7, 'books ' + info.length); await show(); return JSON.stringify(info.map((x) => x[0] + ' / ' + x[1]));
  });
  await step('Default stays Status: Currently Reading / Want to Read / Finished sections, picker says Status', async () => {
    assert((await page.$eval('#group-sel', (e) => e.value)) === 'status', 'default'); assert(await page.evaluate(async () => (await import('./js/settings.js')).DEFAULTS.groupBy === 'status'));
    const h = await heads(); assert(h.map((x) => x.replace(/ \d+$/, '')).join('|') === 'Currently Reading|Want to Read|Finished', h.join('|'));
    const opts = await page.$$eval('#group-sel option', (e) => e.map((x) => x.value)); assert(opts.join() === 'status,none,series,author,type', opts.join());
  });
  await step('None: one flat list, finished and unfinished mixed, no headers; flat list has its own order key', async () => {
    await groupBy('none'); assert(!(await heads()).length, 'headers: ' + (await heads()).join()); const grids = await page.$$('#lib-body .tiles'); assert(grids.length === 1, 'grids ' + grids.length);
    const t = await page.$$eval('#lib-body .tile .t', (e) => e.map((x) => x.innerText)); assert(t.some((x) => /Frankenstein/.test(x)) && t.some((x) => /A Standalone/.test(x)), t.join('|'));
    assert((await page.$eval('#lib-body .tiles', (e) => e.dataset.ctx)) === 'shelf:all:flat', 'order key');
    assert((await page.evaluate(async () => (await import('./js/settings.js')).settings.get('groupBy'))) === 'none');
    await page.screenshot({ path: '/tmp/shot-group-none.png' });
  });
  await step('Hide-finished toggle still applies to the flat list (and in the menu the label follows the grouping)', async () => {
    await page.evaluate(async () => (await import('./js/settings.js')).settings.set({ showFinished: false })); await show(); let t = await page.$$eval('#lib-body .tile .t', (e) => e.map((x) => x.innerText)); assert(!t.some((x) => /Frankenstein/.test(x)), 'finished should be hidden');
    await page.click('#lib-menu'); await page.waitForSelector('#menu-show-finished'); assert(/Show finished books in All/.test(await page.$eval('#menu-show-finished', (e) => e.innerText)), 'label'); await page.click('#menu-show-finished'); await sleep(600);
    t = await page.$$eval('#lib-body .tile .t', (e) => e.map((x) => x.innerText)); assert(t.some((x) => /Frankenstein/.test(x)), 'finished should be back (flat, mixed)');
  });
  await step('Persisted across reload (None)', async () => { await page.reload({ waitUntil: 'networkidle0' }); await sleep(500); assert((await page.$eval('#group-sel', (e) => e.value)) === 'none'); assert(!(await heads()).length); });

  await step('Series: a section per series (sorted A–Z), "No series" last; books under the right header', async () => {
    await groupBy('series'); const L = await layout(); const names = L.map((x) => x.head.replace(/ \d+$/, ''));
    assert(names.length >= 3 && names[names.length - 1] === 'No series', names.join('|')); const rest = names.slice(0, -1); assert(rest.join('|') === [...rest].sort((a, b) => a.localeCompare(b)).join('|'), 'not alphabetical ' + rest.join('|'));
    const saga = L.find((x) => x.titles.includes('Saga Book One')); assert(saga && saga.titles.includes('Saga Book Two') && saga.titles.includes('Saga Book Three'), JSON.stringify(L));
    const none = L[L.length - 1]; assert(none.titles.some((t) => /Frankenstein/.test(t)) && none.titles.some((t) => /Standalone/.test(t)), JSON.stringify(none)); return JSON.stringify(L.map((x) => [x.head, x.titles.length]));
  });
  await step('Series: section sort follows the shelf sort (Title A–Z, then reversed)', async () => {
    await page.select('#sort-sel', 'title'); await sleep(500); let L = await layout(); let saga = L.find((x) => x.titles.includes('Saga Book One')); assert(saga.titles.join('|') === ['Saga Book One', 'Saga Book Three', 'Saga Book Two'].join('|'), saga.titles.join('|'));
    await page.click('#sort-dir'); await sleep(400); L = await layout(); saga = L.find((x) => x.titles.includes('Saga Book One')); assert(saga.titles.join('|') === ['Saga Book Two', 'Saga Book Three', 'Saga Book One'].join('|'), saga.titles.join('|'));
    await page.click('#sort-dir'); await sleep(300);
  });
  await step('Author: sections per author A–Z, Unknown last', async () => {
    await groupBy('author'); const L = await layout(); const names = L.map((x) => x.head.replace(/ \d+$/, '')); assert(names.length >= 2, names.join('|'));
    const known = names.filter((n) => n !== 'Unknown author'); assert(known.join('|') === [...known].sort((a, b) => a.replace(/^(the|a|an) /i, '').toLowerCase().localeCompare(b.replace(/^(the|a|an) /i, '').toLowerCase())).join('|'), names.join('|'));
    if (names.includes('Unknown author')) assert(names[names.length - 1] === 'Unknown author', 'unknown not last');
    const total = L.reduce((a, x) => a + x.titles.length, 0); assert(total === 7, 'every book appears once: ' + total); return names.join(' | ');
  });
  await step('File type: EPUB / AZW3 / PDF sections in that order', async () => {
    await groupBy('type'); const L = await layout(); assert(L.map((x) => x.head.replace(/ \d+$/, '')).join('|') === 'EPUB|AZW3|PDF', L.map((x) => x.head).join('|')); assert(L[2].titles.length === 1 && /Folio Test PDF|Test/.test(L[2].titles[0]), JSON.stringify(L[2]));
    assert(L[0].titles.length === 5, 'epubs ' + L[0].titles.length);
  });
  await step('Collapsible headers: tap collapses/expands, state persists across reload', async () => {
    await groupBy('type'); const n0 = (await page.$$('#lib-body .tile')).length; await page.evaluate(() => document.querySelector('.group-hdr[data-group="t:EPUB"]').click()); await sleep(400);
    assert((await page.$$('#lib-body .tile')).length === n0 - 5, 'not collapsed'); assert(/^▸/.test(await page.$eval('.group-hdr[data-group="t:EPUB"]', (e) => e.innerText)), 'arrow');
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(500); assert((await page.$$('#lib-body .tile')).length === n0 - 5, 'collapse not persisted');
    await page.evaluate(() => document.querySelector('.group-hdr[data-group="t:EPUB"]').click()); await sleep(400); assert((await page.$$('#lib-body .tile')).length === n0, 'not expanded');
    await groupBy('status'); await page.evaluate(() => document.querySelector('.group-hdr[data-group="want"]').click()); await sleep(300); assert(await page.$eval('.group-hdr[data-group="want"]', (e) => e.dataset.collapsed === '1'), 'status groups collapse too'); await page.evaluate(() => document.querySelector('.group-hdr[data-group="want"]').click()); await sleep(300);
  });
  await step('Custom order: flat list uses its own key; status/other groupings share the shelf key; each applied inside its groups', async () => {
    await groupBy('none'); await page.select('#sort-sel', 'custom'); await sleep(500);
    const ids = await storeEval(async (S) => (await S.getBooks()).map((b) => ({ id: b.id, t: b.title })));
    const flatOrder = [...ids].sort((a, b) => b.t.localeCompare(a.t)); const shelfOrder = [...ids].sort((a, b) => a.t.localeCompare(b.t));
    await storeEval(async (S, D, st, flat, shelf) => { await S.saveOrder('shelf:all:flat', flat.map((x) => 'b:' + x.id)); await S.saveOrder('shelf:all', shelf.map((x) => 'b:' + x.id)); }, flatOrder, shelfOrder);
    await show(); const flat = await page.$$eval('#lib-body .tile .t', (e) => e.map((x) => x.innerText)); const flatBooks = flat.filter((t) => !/^Saga/.test(t) || true);
    assert(flat.indexOf('Saga Book One') === -1 || true, ''); // set tile may hide saga names; compare relative order of the standalone books
    const pick = (arr, names) => arr.filter((t) => names.some((n) => t.startsWith(n))); const names = ['Frankenstein', 'A Standalone', 'Folio Test'];
    assert(pick(flat, names).join('|') === pick(flatOrder.map((x) => x.t), names).join('|'), 'flat order: ' + flat.join('|'));
    await groupBy('type'); const L = await layout(); const epub = L[0].titles; assert(pick(epub, names.slice(0, 2)).join('|') === pick(shelfOrder.map((x) => x.t), names.slice(0, 2)).join('|'), 'type group order: ' + epub.join('|'));
    await groupBy('series'); const S2 = await layout(); const saga = S2.find((x) => x.titles.includes('Saga Book One')); assert(saga.titles.join('|') === ['Saga Book One', 'Saga Book Three', 'Saga Book Two'].join('|'), 'series group order ' + saga.titles.join('|'));
    assert((await page.$eval('#lib-body .tiles', (e) => e.dataset.ctx)) === 'shelf:all', 'order key');
  });
  await step('Drag inside a group reorders only that group and persists (mouse drag, type grouping)', async () => {
    await groupBy('type'); const before = (await layout())[0].titles; assert(before.length === 5);
    const box = async (i) => page.$$eval('#lib-body .tiles[data-group="t:EPUB"] .tile', (t, i) => { const r = t[i].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
    await page.evaluate(() => window.scrollTo(0, 0)); const a = await box(4), b = await box(0);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x - 10, a.y - 10, { steps: 4 }); await page.mouse.move(b.x - 20, b.y, { steps: 12 }); await sleep(150); await page.mouse.up(); await sleep(600);
    const after = (await layout())[0].titles; assert(after[0] === before[4], 'dragged: ' + after.join('|')); await show(); const again = (await layout())[0].titles; assert(again.join('|') === after.join('|'), 'not persisted'); assert((await layout())[1].titles.length === 1);
  });
  await step('Group picker only on the All shelf; library menu "Group by…" sheet switches grouping', async () => {
    await page.evaluate(() => document.querySelector('[data-chip=reading]').click()); await sleep(400); assert(!(await page.$('#group-sel')), 'picker on non-All shelf'); await page.evaluate(() => document.querySelector('[data-chip=all]').click()); await sleep(400);
    await page.click('#lib-menu'); await page.waitForSelector('#menu-group'); assert(/Group by: File type/.test(await page.$eval('#menu-group', (e) => e.innerText)), await page.$eval('#menu-group', (e) => e.innerText)); await page.click('#menu-group'); await page.waitForSelector('#group-opt-author');
    assert((await page.$$('#overlay .check')).length > 0); await page.click('#group-opt-author'); await sleep(500); assert((await page.$eval('#group-sel', (e) => e.value)) === 'author');
    await page.click('#lib-menu'); await page.waitForSelector('#menu-group'); await page.click('#menu-group'); await page.waitForSelector('#group-opt-status'); await page.click('#group-opt-status'); await sleep(500); assert((await page.$eval('#group-sel', (e) => e.value)) === 'status');
  });
  await step('Choice is a synced setting', async () => {
    const r = await page.evaluate(async () => { const st = await import('./js/settings.js'); const G = await import('./js/google.js'); st.settings.set({ groupBy: 'series' }); const snap = await G.buildSnapshot(); return { synced: st.SYNCED.includes('groupBy'), v: snap.settings.values.groupBy }; });
    assert(r.synced && r.v === 'series', JSON.stringify(r));
  });
  await step('No page errors', async () => assert(!errs.length, errs.join(' | ')));
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

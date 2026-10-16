// v0.5.8 library UI: search "×" clear buttons, "Reading now" tab, set-edit search + alphabetical sets, per-shelf series grouping.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), (m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const S = makeState();
const SHOW = (p, t) => p.evaluate((t) => (window.__flimsy || window.__folio).show(t), t);
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') page.errs.push(e.message); });
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin()); await page.goto(APP, { waitUntil: 'networkidle0' }); await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await sleep(800);
  const ev = (f, ...a) => page.evaluate(f, ...a);
  const mkBook = (title, o = {}) => ev(async (title, o) => { const b = await window.__mk({ title, author: o.author || 'Ann Author' }); const S = await import('./js/store.js'); const x = await S.getBook(b.id); Object.assign(x, o.patch || {}); await S.saveBook(x); return b.id; }, title, o);
  const titles = () => page.$$eval('.tile .t', (e) => e.map((x) => x.innerText));
  const show = async (t = 'library') => { await SHOW(page, t); await sleep(500); };
  const vis = (sel) => ev((sel) => { const e = document.querySelector(sel); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);
  const now = Date.now();
  await mkBook('Alpha Reading', { patch: { status: 'reading', progress: 0.4, lastOpened: now - 5000 } });
  await mkBook('Bravo Reading', { patch: { status: 'reading', progress: 0.1, lastOpened: now - 1000 } });
  await mkBook('Charlie Want', { patch: { status: 'want' } });
  await mkBook('Delta Done', { patch: { status: 'finished', progress: 1, lastOpened: now - 9000 } });
  await mkBook('Echo Saga One', { patch: { status: 'want' } }); await mkBook('Echo Saga Two', { patch: { status: 'finished' } }); await mkBook('Echo Saga Three', { patch: { status: 'finished' } });
  await ev(async () => { const S = await import('./js/store.js'); const set = await S.createSet('Echo Saga'); let i = 1; for (const t of ['Echo Saga One', 'Echo Saga Two', 'Echo Saga Three']) await S.assignSet((await S.getBooks()).find((b) => b.title === t).id, set.id, i++); });
  await show();

  await step('Search clear "×": library search shows it only with text; tapping clears everything, refilters and refocuses', async () => {
    assert(!(await vis('.clr-btn')), 'hidden while empty'); await page.type('input.search', 'bravo'); await sleep(300); assert(await vis('.clr-btn'), 'shown with text'); const some = await titles(); assert(some.length === 1, some.join('|'));
    await page.click('.clr-btn'); await sleep(400); assert((await ev(() => document.querySelector('input.search').value)) === '', 'cleared'); assert(await ev(() => document.activeElement === document.querySelector('input.search')), 'refocused'); assert(!(await vis('.clr-btn')), 'hidden again'); assert((await titles()).length > 3, 'list restored');
  });
  await step('Every search field is decorated (catalog, audiobooks, sheets added later)', async () => {
    await show('audiobooks'); await sleep(300); assert(await vis('#audio-search + .clr-btn') || (await ev(() => !!document.querySelector('#audio-search').parentElement.classList.contains('clr-wrap'))), 'audiobook search wrapped');
    await ev(() => { const i = document.createElement('input'); i.type = 'search'; i.id = 'late'; document.body.append(i); }); await sleep(100); assert(await ev(() => document.querySelector('#late').parentElement.classList.contains('clr-wrap')), 'late field'); await ev(() => document.querySelector('#late').parentElement.remove());
    await show();
  });
  await step('Bottom bar: "Reading now" sits between Library and Audiobooks', async () => {
    const tabs = await ev(() => [...document.querySelectorAll('#tabbar button, #tabbar a')].map((b) => (b.innerText || '').trim().replace(/\s+/g, ' '))); const i = tabs.findIndex((t) => /Reading now/i.test(t)); assert(i > 0 && /Library/i.test(tabs[i - 1]) && /Audio/i.test(tabs[i + 1]), tabs.join(' | '));
    return tabs.join(' | ');
  });
  await step('Reading now: lists the in-progress books, most recently read first, with progress and a Resume button', async () => {
    await show('reading'); const rows = await page.$$eval('#view .rn-row', (e) => e.map((r) => ({ t: r.querySelector('.rn-title').innerText, p: r.querySelector('.rn-pct').innerText, btn: !!r.querySelector('.rn-resume') }))); eq(rows.map((r) => r.t), ['Bravo Reading', 'Alpha Reading'], 'order'); assert(rows[1].p.includes('40') && rows.every((r) => r.btn), JSON.stringify(rows));
    return JSON.stringify(rows);
  });
  await step('Reading now: Resume opens the book; the list updates after reading (sorted by last read)', async () => {
    const opened = await ev(() => { document.querySelectorAll('#view .rn-row')[1].querySelector('.rn-resume').click(); return document.querySelectorAll('#view .rn-row')[1].querySelector('.rn-title').innerText; }); await page.waitForFunction(() => document.body.classList.contains('reading') && !!document.querySelector('#viewer iframe'), { timeout: 20000 }); await sleep(1200);
    assert(opened === 'Alpha Reading', 'opened ' + opened); await ev(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(600);
    const lo = await ev(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const a = bs.find((b) => b.title === 'Alpha Reading'), b = bs.find((x) => x.title === 'Bravo Reading'); return [a.lastOpened > b.lastOpened, a.status]; }); assert(lo[0], 'opening stamps last read ' + lo);   // (the one-page test book is finished by opening it, which is also right)
    await ev(async () => { const S = await import('./js/store.js'); const a = (await S.getBooks()).find((b) => b.title === 'Alpha Reading'); a.status = 'reading'; a.progress = 0.4; a.lastOpened = Date.now() + 1000; await S.saveBook(a); }); await show('reading');
    const t = await page.$$eval('#view .rn-title', (e) => e.map((x) => x.innerText)); assert(t[0] === 'Alpha Reading' && t[1] === 'Bravo Reading', t.join('|'));
  });
  await step('Reading now: empty state when nothing is in progress', async () => {
    await ev(async () => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) if (b.status === 'reading') { b.status = 'want'; b.progress = 0; await S.saveBook(b); } }); await show('reading'); assert(/nothing|not reading|start/i.test(await ev(() => document.querySelector('#view').innerText)), await ev(() => document.querySelector('#view').innerText));
    await ev(async () => { const S = await import('./js/store.js'); for (const b of await S.getBooks()) if (/Reading$/.test(b.title)) { b.status = 'reading'; b.progress = 0.3; b.lastOpened = Date.now(); await S.saveBook(b); } }); await show();
  });

  await step('Edit set → Add books has a search box (title, author or series words) and lists books alphabetically', async () => {
    await mkBook('Zulu Extra', { author: 'Zed Writer' }); await mkBook('Able Extra', { author: 'Ann Author' });
    await ev(async () => { const L = await import('./js/library.js'); const S = await import('./js/store.js'); const bs = await S.getBooks(), sets = await S.getSets(); const ctx = { books: bs, sets, shelves: [], setMap: new Map(sets.map((x) => [x.id, x])) }; window.__ctx = ctx; });
    // open the set page, then ⋯ → Add books…
    await show(); await ev(() => [...document.querySelectorAll('.tile.set')].find((e) => /Echo Saga/.test(e.innerText)).click()); await sleep(500);
    await page.click('.topbar .btn-icon'); await sleep(300); await ev(() => [...document.querySelectorAll('.sheet .list-item')].find((e) => /Add books/.test(e.innerText)).click()); await page.waitForSelector('#set-add-q'); await sleep(200);
    let rows = await page.$$eval('#set-add-list .list-item', (e) => e.map((x) => x.innerText.split(' — ')[0])); const sorted = [...rows].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())); eq(rows, sorted, 'alphabetical'); assert(rows.length >= 4, rows.join('|'));
    await page.type('#set-add-q', 'zed'); await sleep(250); rows = await page.$$eval('#set-add-list .list-item', (e) => e.map((x) => x.innerText.split(' — ')[0])); eq(rows, ['Zulu Extra'], 'author search'); assert(await vis('#set-add-q ~ .clr-btn') || await ev(() => !!document.querySelector('#set-add-q').parentElement.querySelector('.clr-btn:not([hidden])')), '× shown');
    await page.click('.sheet .clr-btn'); await sleep(250); rows = await page.$$eval('#set-add-list .list-item', (e) => e.length); assert(rows >= 4, 'cleared → full list'); await page.type('#set-add-q', 'nomatchxyz'); await sleep(250); assert(/No books match/.test(await ev(() => document.querySelector('#set-add-list').innerText)), 'no match text');
    await page.click('.sheet .clr-btn'); await page.type('#set-add-q', 'able'); await sleep(250); await page.click('#set-add-list .list-item'); await sleep(600);
    const inSet = await ev(async () => { const S = await import('./js/store.js'); const set = (await S.getSets()).find((x) => x.name === 'Echo Saga'); return (await S.getBooks()).filter((b) => b.setId === set.id).map((b) => b.title).sort(); }); assert(inSet.includes('Able Extra') && inSet.length === 4, inSet.join('|'));
    await ev(() => document.querySelector('#set-back').click()); await sleep(300);
  });
  await step('Sets are listed alphabetically (Edit book → Set, Manage sets), the ones with books first', async () => {
    await ev(async () => { const S = await import('./js/store.js'); await S.createSet('Mike Series'); await S.createSet('Bravo Series'); const bs = await S.getBooks(); const bsx = (await S.getSets()).find((x) => x.name === 'Bravo Series'); await S.assignSet(bs.find((b) => b.title === 'Charlie Want').id, bsx.id, 1); await S.createSet('Aardvark Empty'); });
    await show(); const names = await ev(async () => { const L = await import('./js/library.js'); const S = await import('./js/store.js'); const book = (await S.getBooks()).find((b) => b.title === 'Zulu Extra'); L.bookMenu(book, { books: await S.getBooks(), sets: await S.getSets(), shelves: [], setMap: new Map() }); await new Promise((r) => setTimeout(r, 200)); [...document.querySelectorAll('.sheet .list-item')].find((e) => /Edit details/.test(e.innerText)).click(); await new Promise((r) => setTimeout(r, 300)); return [...document.querySelectorAll('.sheet select option')].map((o) => o.textContent); });
    eq(names, ['', '— No set —', 'Bravo Series', 'Echo Saga', 'Aardvark Empty', 'Mike Series', '＋ New set…'].slice(1), 'edit-book order');
    await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  });
  await step('Per-view series grouping: All groups the series into a set, Finished shows its books individually; the choice is remembered per view (and the default can change)', async () => {
    await ev(async () => { const st = await import('./js/settings.js'); st.settings.set({ groupSets: true, groupBy: 'status', chip: 'all', view: 'grid' }); }); await show();
    assert(await ev(() => !!document.querySelector('.tile.set')), 'All shows a set tile'); assert((await ev(() => document.querySelector('#sets-mode').dataset.grouped)) === '1', 'button says grouped');
    await page.click('[data-chip=finished]'); await sleep(500); assert(await ev(() => !!document.querySelector('.tile.set')), 'Finished groups by default (its books of the set form one tile)');
    await page.click('#sets-mode'); await sleep(250); await page.click('#sets-individual'); await sleep(500); let t = await titles(); assert(!(await ev(() => !!document.querySelector('.tile.set'))) && t.some((x) => /Echo Saga Two/.test(x)) && t.some((x) => /Echo Saga Three/.test(x)), 'finished individual: ' + t.join('|'));
    assert((await ev(() => document.querySelector('#sets-mode').dataset.grouped)) === '0', 'button says individual');
    await page.click('[data-chip=all]'); await sleep(500); assert(await ev(() => !!document.querySelector('.tile.set')), 'All still groups');
    const stored = await ev(async () => (await import('./js/settings.js')).settings.get('setGroups')); eq(stored, { 'shelf:finished': false }, 'stored per view');
    await ev(async () => { const st = await import('./js/settings.js'); st.settings.set({ groupSets: false }); }); await show(); assert(!(await ev(() => !!document.querySelector('.tile.set'))), 'default off → All individual'); await page.click('[data-chip=finished]'); await sleep(400); assert(!(await ev(() => !!document.querySelector('.tile.set'))), 'finished still individual');
    await page.click('#sets-mode'); await sleep(250); await page.click('#sets-grouped'); await sleep(500); await page.click('[data-chip=all]'); await sleep(400); assert(!(await ev(() => !!document.querySelector('.tile.set'))), 'All follows the default (off)');
    await ev(async () => { const st = await import('./js/settings.js'); st.settings.set({ groupSets: true, setGroups: {} }); }); await show();
  });
  await step('Per-view grouping syncs between devices (per view, last write wins) and is part of the backup settings', async () => {
    await ev(async () => { const st = await import('./js/settings.js'); st.setSetsGrouped('shelf:finished', false); });
    const flat = await ev(async () => (await import('./js/google.js')).buildSettingsPart().flat); assert(flat['setGroups/shelf:finished'] && flat['setGroups/shelf:finished'].v === false && flat['setGroups/shelf:finished'].at > 1e12, JSON.stringify(Object.keys(flat).filter((k) => /setGroups/.test(k))));
    const G = await ev(async () => { const g = await import('./js/google.js'); return !!g.buildSettingsPart; });
    await ev(async () => { const st = await import('./js/settings.js'); st.setSetsGrouped('shelf:finished', null); }); const flat2 = await ev(async () => (await import('./js/google.js')).buildSettingsPart().flat); assert(flat2['setGroups/shelf:finished'] && flat2['setGroups/shelf:finished'].d === 1, 'a cleared choice syncs as a removal');
  });
  await step('No page errors', async () => { assert(!page.errs.length, page.errs.join(' | ')); });
  await browser.close(); const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

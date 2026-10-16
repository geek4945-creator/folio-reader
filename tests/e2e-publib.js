// Public library guide / Find my library / availability search / catalog help / DRM-free help. Network mocked (plus one live check).
const puppeteer = require('puppeteer-core');
const URL = process.env.URL || 'http://localhost:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const system = { id: 974, websiteId: 83, type: 'Public Library', name: 'Seattle Public Library', fulfillmentId: 'seattle' };
const LOCATE = { branches: [{ id: 1, name: 'Seattle Public Library', city: 'Seattle', regionCode: 'WA', systems: [system] }, { id: 2, name: 'Ballard', city: 'Seattle', regionCode: 'WA', systems: [system] }, { id: 3, name: 'Seattle Branch', city: 'Seattle', regionCode: 'WA', systems: [{ id: 5, websiteId: 9, type: 'Public Library', name: 'Seattle Test Co-op', fulfillmentId: 'coop' }] }] };
const item = (n, o) => ({ reserveId: 'res-' + n, id: n, title: 'Book ' + n, firstCreatorName: 'Author ' + n, type: { id: 'ebook', name: 'eBook' }, covers: { cover150Wide: { href: 'https://img1.od-cdn.com/x' + n + '.jpg' } }, isAvailable: false, isOwned: true, isHoldable: true, availableCopies: 0, ownedCopies: 3, holdsCount: 0, estimatedWaitDays: 0, ...o });
const MEDIA = { 1: { totalItems: 5, links: { last: { page: 2 } }, items: [item(1, { isAvailable: true, availableCopies: 2, ownedCopies: 3, series: 'Dune' }), item(2, { holdsCount: 14, ownedCopies: 5, estimatedWaitDays: 42 }), item(3, { isOwned: false, ownedCopies: 0, isHoldable: false }), item(4, { isPreReleaseTitle: true })] }, 2: { totalItems: 5, links: { last: { page: 2 } }, items: [item(5, { isAvailable: true, availableCopies: 1, ownedCopies: 1 })] } };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  let mock = true; const reqs = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); const cors = { 'Access-Control-Allow-Origin': '*' };
    if (mock && /locate\.libbyapp\.com\/autocomplete\//.test(u)) { reqs.push(u); return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(LOCATE) }); }
    if (mock && /thunder\.api\.overdrive\.com\/v2\/libraries\/[^/?]+$/.test(u)) { reqs.push(u); return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ id: 'spl', preferredKey: 'spl', name: 'Seattle Public Library' }) }); }
    if (mock && /thunder\.api\.overdrive\.com\/v2\/libraries\/spl\/media\?/.test(u)) { reqs.push(u); const pg = new globalThis.URL(u).searchParams.get('page') || '1'; return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(MEDIA[pg]) }); }
    if (/od-cdn\.com/.test(u)) return req.respond({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
    req.continue();
  });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const overlayText = () => page.$eval('#overlay', (e) => e.innerText);
  const closeSheets = () => page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

  await step('Empty-state shows a "Public library" button that opens the step-by-step guide', async () => {
    await page.waitForSelector('#empty-public-library'); await page.screenshot({ path: '/tmp/shot-plib-empty.png' }); await click('#empty-public-library'); await page.waitForSelector('.plib-steps');
    const t = await overlayText(); for (const s of ['Find your library', 'library card number', 'check availability', 'Libby to borrow', 'stay inside Libby', 'OPDS']) assert(t.includes(s) || t.toLowerCase().includes(s.toLowerCase()), 'missing: ' + s);
    assert(/DRM/.test(t) && /can’t be imported/.test(t), 'DRM note'); assert((await page.$$('.plib-step')).length === 6, 'steps'); await page.screenshot({ path: '/tmp/shot-plib-guide.png' });
  });
  await step('Library ⋯ menu has a prominent "Public library" entry (and DRM-free help)', async () => {
    await closeSheets(); await click('#lib-menu'); await page.waitForSelector('#menu-public-library'); assert(await page.$eval('#menu-public-library', (e) => e.classList.contains('primary-item')), 'not prominent');
    assert(/Where to get DRM-free books/.test(await overlayText()), 'no DRM-free item'); await page.screenshot({ path: '/tmp/shot-plib-menu.png' }); await click('#menu-public-library'); await page.waitForSelector('#plib-find-btn');
  });
  await step('Find my library: search by city; systems de-duplicated; pick one → saved', async () => {
    await click('#plib-find-btn'); await page.waitForSelector('#plib-q'); await page.type('#plib-q', 'seattle'); await click('#plib-go'); await page.waitForSelector('.plib-result');
    const rs = await page.$$eval('.plib-result', (e) => e.map((x) => x.innerText.replace(/\n/g, ' | '))); assert(rs.length === 2 && /Seattle Public Library/.test(rs[0]) && /Seattle, WA/.test(rs[0]), JSON.stringify(rs));
    assert(reqs.some((u) => /autocomplete\/seattle$/.test(u)), 'no directory request'); await page.screenshot({ path: '/tmp/shot-plib-find.png' });
    await page.evaluate(() => document.querySelector('.plib-result[data-fid=seattle]').click()); await page.waitForSelector('#plib-search');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings')).publicLibrary); assert(saved.name === 'Seattle Public Library' && saved.key === 'spl' && saved.fid === 'seattle', JSON.stringify(saved)); return JSON.stringify(saved);
  });
  await step('Search a title: availability, holds/wait, covers, DRM note', async () => {
    assert(/DRM-protected and stay inside Libby/.test(await overlayText()), 'drm note'); await page.type('#plib-search', 'dune'); await click('#plib-go'); await page.waitForSelector('.plib-item');
    const items = await page.$$eval('.plib-item', (e) => e.map((x) => ({ s: x.dataset.state, t: x.innerText.replace(/\n/g, ' | '), img: !!x.querySelector('img.plib-cover') }))); assert(items.length === 4, JSON.stringify(items));
    assert(items[0].s === 'available' && /Available now/.test(items[0].t) && /2 of 3 copies available/.test(items[0].t), items[0].t);
    assert(items[1].s === 'wait' && /14 holds on 5 copies/.test(items[1].t) && /6 wk/.test(items[1].t), items[1].t);
    assert(items[2].s === 'unavailable' && /Not in this library/.test(items[2].t), items[2].t); assert(items[3].s === 'soon', items[3].t); assert(items[0].img, 'cover');
    assert(reqs.some((u) => /\/libraries\/spl\/media\?/.test(u) && /query=dune/.test(u) && /mediaTypes=ebook/.test(u)), 'media request'); await page.screenshot({ path: '/tmp/shot-plib-results.png' }); return items.map((i) => i.s).join();
  });
  await step('Open in Libby / library website links (new tab) per title', async () => {
    const l = await page.$$eval('.plib-item', (e) => e.map((x) => [...x.querySelectorAll('a')].map((a) => [a.href, a.target, a.rel, a.textContent])));
    assert(l[0].some((a) => a[0] === 'https://share.libbyapp.com/title/res-1' && a[1] === '_blank' && /noopener/.test(a[2]) && /Open in Libby to borrow/.test(a[3])), JSON.stringify(l[0]));
    assert(l[0].some((a) => a[0] === 'https://spl.overdrive.com/media/res-1'), 'site link'); assert(l[1].some((a) => /place a hold/.test(a[3])), 'hold label'); assert(!l[2].some((a) => /libbyapp/.test(a[0])), 'no libby link when not owned');
  });
  await step('Available-now filter, media-type toggle and Load more', async () => {
    await click('#plib-avail-only'); await sleep(200); let n = await page.$$eval('.plib-item', (e) => e.length); assert(n === 1, 'avail only ' + n); await click('#plib-avail-only'); await sleep(200);
    await click('#plib-more'); await sleep(500); n = await page.$$eval('.plib-item', (e) => e.length); assert(n === 5, 'after more ' + n);
    await page.evaluate(() => document.querySelector('[data-type=audiobook]').click()); await sleep(600); assert(reqs.some((u) => /mediaTypes=audiobook/.test(u)), 'audiobook request');
    await page.evaluate(() => document.querySelector('[data-type=all]').click()); await sleep(600); assert(reqs.slice(-1)[0] && !/mediaTypes/.test(reqs.slice(-1)[0]), 'all types has no mediaTypes: ' + reqs.slice(-1)[0]);
  });
  await step('Chosen library persists across reload; guide offers "Search <library>"', async () => {
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(500); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await page.waitForSelector('#plib-card'); await click('#plib-card'); await page.waitForSelector('#plib-search-btn');
    assert(/Search Seattle Public Library/.test(await overlayText()), 'no search btn');
  });
  await step('Add a library OPDS / Calibre-Web catalog: built-in list + address patterns + Add-a-source', async () => {
    await click('#plib-catalogs-btn'); await page.waitForSelector('#known-catalogs .list-item'); const t = await overlayText();
    for (const s of ['Project Gutenberg', 'Standard Ebooks', 'Internet Archive', 'Calibre-Web', '/opds', 'Koha', 'Evergreen']) assert(t.includes(s), 'missing ' + s);
    await click('#plib-add-source'); await page.waitForSelector('.sheet #source-url'); assert(/Add a source/.test(await overlayText()));
  });
  await step('Where to get DRM-free books lists legitimate sources and what can’t be imported', async () => {
    await closeSheets(); await page.evaluate(() => document.querySelector('[data-tab=settings]').click()); await page.waitForSelector('#help-drmfree'); await click('#help-drmfree'); await page.waitForSelector('.drmfree-item');
    const t = await overlayText(); for (const s of ['Project Gutenberg', 'Standard Ebooks', 'Internet Archive', 'Smashwords', 'Humble Bundle', 'Baen', 'Tor', 'Kobo', 'DRM-free', 'Libby']) assert(t.includes(s), 'missing ' + s);
    assert(/doesn’t remove DRM/.test(t), 'no-removal note'); const links = await page.$$eval('.drmfree-item a', (e) => e.map((a) => a.href)); assert(links.every((h) => h.startsWith('https://')) && links.length >= 7, links.join()); await page.screenshot({ path: '/tmp/shot-drmfree.png' }); await closeSheets();
  });
  await step('Settings has a Public library guide button; library+sorting keys are synced', async () => {
    await click('#help-public-library'); await page.waitForSelector('.plib-steps'); await closeSheets();
    const r = await page.evaluate(async () => (await import('./js/settings.js')).SYNCED.includes('publicLibrary')); assert(r, 'publicLibrary not synced');
  });
  await step('Copy-protected import message links to the DRM-free help', async () => {
    await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await sleep(300);
    await (await page.$('#file-input')).uploadFile(require('path').join(__dirname, 'fixtures', 'drm-flagged.mobi')); await page.waitForFunction(() => /copy-protected/i.test(document.querySelector('#overlay')?.innerText || ''), { timeout: 8000 });
    await page.evaluate(() => [...document.querySelectorAll('#overlay button')].find((b) => /Where to get DRM-free/.test(b.textContent)).click()); await page.waitForSelector('.drmfree-item');
  });
  mock = false; await closeSheets();
  await step('LIVE: OverDrive directory + Thunder search work from the browser (CORS) for a real library', async () => {
    const r = await page.evaluate(async () => { const m = await import('./js/publib.js'); const libs = await m.searchLibraries('seattle public library'); const info = await m.lookupLibrary(libs[0].fid); const res = await m.searchTitles(info.key, 'dune', { type: 'ebook' }); return { lib: libs[0].name, key: info.key, total: res.total, first: res.items[0] }; });
    assert(/Seattle/.test(r.lib) && r.total > 5 && r.first.title && r.first.cover && ['available', 'wait', 'unavailable', 'soon'].includes(r.first.state), JSON.stringify(r)); return `${r.lib} (${r.key}): ${r.total} results; "${r.first.title}" → ${r.first.label} ${r.first.detail}`;
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close();
  const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

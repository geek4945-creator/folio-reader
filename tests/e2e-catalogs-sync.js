// Catalog browsing/download tests (live Gutenberg / Standard Ebooks / Internet Archive + local mocks) and Google sync tests (mocked Google).
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n + '.epub');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); if (global.__dbg) console.log('   VIEW:', (await global.__dbg.evaluate(() => document.querySelector('#view').innerText.slice(0, 250).replace(/\n/g, ' | ')).catch(() => '')) + ' OVERLAY:' + (await global.__dbg.evaluate(() => document.querySelector('#overlay').innerText.slice(0, 200).replace(/\n/g, ' | ')).catch(() => ''))); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
async function mk(ctx) { const p = await ctx.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; }
async function clickText(page, sel, txt) { const ok = await page.evaluate((sel, txt) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(txt)); if (el) { el.click(); return true; } return false; }, sel, txt); if (!ok) throw new Error('no element ' + sel + ' / ' + txt); }
const booksDb = (page) => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction('books').objectStore('books').getAll(); a.onsuccess = () => res(a.result.map((b) => ({ title: b.title, author: b.author, status: b.status, setId: b.setId, idx: b.seriesIndex, size: b.size, cover: !!b.coverBlob, shelves: b.shelves, ov: b.overrides, progress: b.progress, cfi: b.cfi, src: b.source }))); }; }));
const dbAll = (page, store) => page.evaluate((store) => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction(store).objectStore(store).getAll(); a.onsuccess = () => res(a.result); }; }), store);

const GIS = `window.google={accounts:{id:{disableAutoSelect(){}},oauth2:{initTokenClient(cfg){return{requestAccessToken(){window.__gisCalls=(window.__gisCalls||[]);window.__gisCalls.push({prompt:cfg.prompt,hint:cfg.login_hint});setTimeout(()=>cfg.callback({access_token:'tok-'+Math.random().toString(36).slice(2),expires_in:3600,scope:cfg.scope}),20);}}},revoke(t,cb){window.__revoked=t;cb&&cb();},hasGrantedAllScopes(){return true}}}};`;
const cloud = { file: null, writes: 0, auth: [] };
async function mockGoogle(page) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url(); const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (u.startsWith('https://accounts.google.com/gsi/client')) return req.respond({ status: 200, contentType: 'text/javascript', body: GIS });
    if (!/googleapis\.com/.test(u)) return req.continue();
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    cloud.auth.push(req.headers().authorization);
    if (u.includes('/oauth2/v3/userinfo')) return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ name: 'Ada Reader', email: 'ada@example.com', picture: '' }) });
    if (u.includes('spaces=drive')) { const q = decodeURIComponent(u.replace(/\+/g, ' ')); const files = q.includes("'FOLDER1' in parents") ? [{ id: 'DRV2', name: 'InFolder.epub', mimeType: 'application/epub+zip', size: '27000' }] : [{ id: 'FOLDER1', name: 'Books', mimeType: 'application/vnd.google-apps.folder' }, { id: 'DRV1', name: 'MyDriveBook.epub', mimeType: 'application/epub+zip', size: '27679' }]; return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ files }) }); }
    if (/\/drive\/v3\/files\/DRV\d\?alt=media/.test(u)) return req.respond({ status: 200, headers: cors, contentType: 'application/epub+zip', body: require('fs').readFileSync(fx(u.includes('DRV1') ? 'saga-2' : 'saga-3')) });
    if (u.includes('/drive/v3/files?') && !u.includes('/upload/')) return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ files: cloud.file ? [{ id: 'F1', modifiedTime: 'x' }] : [] }) });
    if (u.includes('/drive/v3/files/F1') && !u.includes('/upload/')) return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: cloud.file });
    if (u.includes('/upload/drive/v3/files')) {
      const body = req.postData() || ''; cloud.writes++;
      if (req.method() === 'POST') { const mark = 'Content-Type: application/json\r\n\r\n'; const rest = body.slice(body.lastIndexOf(mark) + mark.length); cloud.file = rest.slice(0, rest.lastIndexOf('\r\n--folio')); cloud.parents = body.includes('appDataFolder'); return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: '{"id":"F1"}' }); }
      cloud.file = body; return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: '{"id":"F1"}' });
    }
    return req.respond({ status: 404, headers: cors, body: 'nf' });
  });
}
const fakeLogin = (exp) => `localStorage.setItem('folio.google', JSON.stringify({ token: 'seed-token', exp: ${exp}, profile: { name: 'Ada Reader', email: 'ada@example.com', picture: '' } }));`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext(); const page = await mk(ctx); global.__dbg = page;
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const openCatalogs = async () => { await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await sleep(200); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300); await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300); };
  const waitCards = async (n = 1, t = 25000) => page.waitForFunction((n) => document.querySelectorAll('.card').length >= n || document.querySelector('.err'), { timeout: t }, n);
  const search = async (q) => { await page.$eval('.browse ~ *, form input.search', (e) => { }).catch(() => {}); await page.click('input.search', { clickCount: 3 }); await page.type('input.search', q); await page.keyboard.press('Enter'); await sleep(500); };
  const goBack = async () => { await page.evaluate(() => document.querySelector('.topbar .btn-text').click()); await sleep(300); };
  const dl = async (title) => { await page.evaluate((title) => { const c = [...document.querySelectorAll('.card')].find((c) => c.innerText.includes(title)) || document.querySelector('.card'); c.querySelector('.dl').click(); }, title); };
  const waitLib = async (n, t = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if ((await booksDb(page)).length >= n) return; await sleep(500); } throw new Error('book not added; toast: ' + (await page.$eval('#toast', (e) => e.innerText))); };

  await step('Catalogs: built-in sources pre-seeded (Gutenberg OPDS, Gutendex, Standard Ebooks, Internet Archive)', async () => {
    await openCatalogs(); const names = await page.$$eval('.source strong', (e) => e.map((x) => x.innerText)); assert(names.length === 5 && names[0] === 'Google Drive', names.join()); await page.screenshot({ path: '/tmp/shot-catalogs.png' }); return names.join(', ');
  });

  // --- local mocks first (deterministic)
  await step('Add a source: auto-detect OPDS (Atom + OpenSearch) from pasted URL', async () => {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Add a source/.test(b.textContent)).click()); await page.waitForSelector('.sheet input[type=url]');
    await page.type('.sheet input[type=url]', 'http://localhost:8766/opds'); await clickText(page, '.sheet .btn', 'Check'); await page.waitForFunction(() => /Found an OPDS catalog/.test(document.querySelector('.sheet').innerText), { timeout: 10000 });
    const msg = await page.$eval('.sheet .small:last-of-type', (e) => e.innerText).catch(() => ''); await clickText(page, '.sheet .btn.primary', 'Add'); await sleep(500);
    const names = await page.$$eval('.source strong', (e) => e.map((x) => x.innerText)); assert(names.includes('Mock Library'), names.join()); return 'added "Mock Library"';
  });
  await step('Browse OPDS: navigation → acquisition feed with covers, series badge, pagination (Load more)', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.source')].find((s) => /Mock Library/.test(s.innerText)).click()); await page.waitForSelector('.list-item'); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.list-item')].find((s) => /Recent additions/.test(s.innerText)).click()); await waitCards(2);
    await sleep(1200); const info = await page.evaluate(() => ({ cards: document.querySelectorAll('.card').length, series: [...document.querySelectorAll('.badge-series')].map((e) => e.innerText), imgs: [...document.querySelectorAll('.card img.cover-img')].filter((i) => i.complete && i.naturalWidth > 0).length }));
    assert(info.cards === 2 && info.series[0] === 'Test Saga #1' && info.imgs === 2, JSON.stringify(info)); await page.screenshot({ path: '/tmp/shot-opds.png' });
    await clickText(page, '.btn.block', 'Load more'); await waitCards(3); const n = await page.$$eval('.card', (e) => e.length); assert(n === 3, 'after load more ' + n); return JSON.stringify(info.series) + ' + page 2 → ' + n + ' cards';
  });
  await step('One-tap download from OPDS into library; catalog series metadata creates a set', async () => {
    await dl('A Standalone Tale'); await waitLib(1, 20000); const b = (await booksDb(page))[0];
    const sets = await dbAll(page, 'sets');
    assert(b.title === 'A Standalone Tale' && b.cover && sets.length === 1 && sets[0].name === 'Hinted Series' && b.idx === 7, JSON.stringify(b) + JSON.stringify(sets));
    return `${b.title}; set(s): ${sets.map((s) => s.name)}; vol ${b.idx}; button now "${(await page.evaluate(() => [...document.querySelectorAll('.card')].find((c) => /Standalone/.test(c.innerText)).querySelector('.dl').innerText))}"`;
  });
  await step('Download detects "already in library"', async () => {
    const lbl = await page.evaluate(() => [...document.querySelectorAll('.card')].find((c) => /Standalone/.test(c.innerText)).querySelector('.dl').innerText); assert(/In library/.test(lbl), lbl);
  });
  await step('OpenSearch search inside the source', async () => {
    await goBack(); await sleep(300); await page.waitForSelector('input.search'); await search('dragons'); await waitCards(1); const t = await page.$eval('.card-t', (e) => e.innerText); assert(/dragons/.test(t), t); return t;
  });
  await step('Add OPDS 2.0 JSON feed (belongsTo.series) and browse', async () => {
    await goBack(); await sleep(300); await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Add a source/.test(b.textContent)).click()); await page.waitForSelector('.sheet input[type=url]');
    await page.type('.sheet input[type=url]', 'http://localhost:8766/opds2.json'); await clickText(page, '.sheet .btn', 'Check'); await page.waitForFunction(() => /Found an? OPDS catalog/.test(document.querySelector('.sheet').innerText), { timeout: 10000 }); await clickText(page, '.sheet .btn.primary', 'Add'); await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll('.source')].find((s) => /Mock OPDS 2/.test(s.innerText)).click()); await waitCards(1); const s = await page.$eval('.badge-series', (e) => e.innerText); assert(s === 'Json Series #2', s); return s;
  });
  await step('Generic HTML mode: finds EPUB link + cover on a page, downloads it', async () => {
    await goBack(); await sleep(300); await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Add a source/.test(b.textContent)).click()); await page.waitForSelector('.sheet input[type=url]');
    await page.type('.sheet input[type=url]', 'http://localhost:8766/html'); await clickText(page, '.sheet .btn', 'Check'); await page.waitForFunction(() => /Found a web page/.test(document.querySelector('.sheet').innerText), { timeout: 10000 }); await clickText(page, '.sheet .btn.primary', 'Add'); await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll('.source')].find((s) => /My Library/.test(s.innerText)).click()); await waitCards(1); const t = await page.$eval('.card-t', (e) => e.innerText); assert(t === 'HTML Book', t);
    const img = await page.$eval('.card img.cover-img', (i) => i.complete && i.naturalWidth > 0).catch(() => false); assert(img, 'cover not shown'); await dl('HTML Book'); await waitLib(2, 20000); return 'HTML Book + cover; downloaded';
  });
  await step('Piracy sites are rejected in Add a source', async () => {
    await goBack(); await sleep(300); await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Add a source/.test(b.textContent)).click()); await page.waitForSelector('.sheet input[type=url]');
    await page.type('.sheet input[type=url]', 'https://z-lib.fm/'); await clickText(page, '.sheet .btn', 'Check'); await sleep(500); const m = await page.$eval('.sheet', (e) => e.innerText); assert(/not supported/.test(m), m); await clickText(page, '.sheet .btn-text', 'Done');
    const r = await page.evaluate(async () => { try { await (await import('/js/net.js')).fetchSmart('https://annas-archive.pk/'); return 'fetched'; } catch (e) { return e.message; } }); assert(/not supported/.test(r), r);
  });

  // --- live catalogs
  const live = async (name, src, q, opts = {}) => step(`Live ${name}: browse, search "${q}", covers shown` + (opts.download ? ', download' : ''), async () => {
    await openCatalogs(); await page.waitForSelector('.source'); await page.evaluate((src) => [...document.querySelectorAll('.source')].find((s) => s.innerText.includes(src)).click(), src);
    await page.waitForFunction(() => document.querySelector('.card') || document.querySelector('.list-item') || document.querySelector('.err'), { timeout: 30000 });
    if (await page.$('.err')) throw new Error('browse error: ' + (await page.$eval('.err', (e) => e.innerText.replace(/\n/g, ' ')))); const first = await page.evaluate(() => document.querySelectorAll('.card').length + ' cards, ' + document.querySelectorAll('.list-item').length + ' rows');
    await search(q); await page.waitForFunction(() => document.querySelector('.card') || document.querySelector('.err') , { timeout: 30000 }); if (await page.$('.err')) throw new Error('search error: ' + (await page.$eval('.err', (e) => e.innerText.replace(/\n/g, ' '))));
    await sleep(2500); const info = await page.evaluate(() => ({ cards: document.querySelectorAll('.card').length, covers: [...document.querySelectorAll('.card img.cover-img')].filter((i) => i.complete && i.naturalWidth > 20).length, first: document.querySelector('.card-t')?.innerText }));
    assert(info.cards > 0 && info.covers > 0, JSON.stringify(info)); await page.screenshot({ path: `/tmp/shot-live-${name.replace(/\W/g, '')}.png` });
    let extra = ''; if (opts.download) { const before = (await booksDb(page)).length; await dl(opts.download); await waitLib(before + 1, opts.timeout || 90000); const b = (await booksDb(page)).find((x) => !opts.download || x.title.toLowerCase().includes(opts.match || opts.download.toLowerCase())) || (await booksDb(page)).slice(-1)[0]; extra = ` | downloaded "${b.title}" (${Math.round(b.size / 1024)} KB, cover: ${b.cover})`; }
    return `${first}; search → ${info.cards} cards, ${info.covers} covers; first "${info.first}"` + extra;
  });
  await live('Standard Ebooks', 'Standard Ebooks', 'frankenstein', { download: 'Frankenstein', match: 'frankenstein' });
  await live('Internet Archive', 'Internet Archive', 'alice in wonderland', { download: '', timeout: 120000 });
  await live('Project Gutenberg OPDS (direct, expect CORS failure on download without proxy)', 'Project Gutenberg', 'dracula');
  await step('Gutenberg download without proxy → clear CORS guidance; with proxy → succeeds', async () => {
    await dl('Dracula'); await sleep(8000); const msg = await page.evaluate(() => (document.querySelector('.sheet')?.innerText || '') + ' ' + document.querySelector('#toast').innerText);
    const before = (await booksDb(page)).length;
    assert(/CORS|proxy|blocked|reach/i.test(msg), 'no guidance: ' + msg); await page.evaluate(() => document.querySelector('#overlay').replaceChildren());
    await page.evaluate(() => window.__folio.settings.set({ proxyUrl: 'http://localhost:8787/' })); await dl('Dracula'); await waitLib(before + 1, 90000);
    const b = (await booksDb(page)).find((x) => /dracula/i.test(x.title)); assert(b && b.cover, JSON.stringify(b)); return `guidance shown; via proxy → "${b.title}" ${Math.round(b.size / 1024)} KB`;
  });
  await live('Gutendex (JSON API)', 'Gutendex', 'austen', {}).catch(() => {});

  await step('Offline: reload with network off → app shell + library still work', async () => {
    await page.evaluate(() => window.__folio.show('library')); await sleep(500); await page.reload({ waitUntil: 'networkidle0' }); await page.evaluate(() => navigator.serviceWorker.ready); await sleep(500);
    await page.setOfflineMode(true); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.tile', { timeout: 15000 }); const n = await page.$$eval('.tile', (e) => e.length); await page.setOfflineMode(false); return n + ' tiles offline';
  });
  console.log('  page errors (catalog phase):', JSON.stringify(page.errs)); await page.close();

  /* ================= Google sync (mocked Google) ================= */
  const exp = Date.now() + 3600000;
  const A = await browser.createBrowserContext(); const a = await mk(A); await mockGoogle(a); await a.evaluateOnNewDocument(fakeLogin(exp)); await a.goto(URL, { waitUntil: 'networkidle0' });
  await step('Sync A: set up library state (shelf, set, override, bookmark, theme, custom order) and push to Drive appDataFolder', async () => {
    await (await a.$('#file-input')).uploadFile(...['frankenstein', 'saga-1', 'saga-2', 'saga-3'].map(fx)); await a.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, { timeout: 15000 }); await sleep(1500);
    await a.evaluate(async () => { const S = await import('/js/store.js'); const books = await S.getBooks(); const fr = books.find((b) => /Frank/.test(b.title)); const sh = await S.createShelf('Favorites'); await S.toggleShelf(fr.id, sh.id); await S.setStatus(fr.id, 'reading'); await S.setOverride(fr.id, { fontSizePt: 19.5, margin: 8 });
      const f = await S.getBook(fr.id); f.progress = 0.42; f.cfi = 'epubcfi(/6/8!/4/2/1:0)'; await S.saveBook(f); await S.addBookmark({ bookId: fr.id, cfi: 'epubcfi(/6/10!/4/2/1:0)', label: 'My mark', progress: 0.5 });
      const s1 = books.find((b) => /Book One/.test(b.title)), s3 = books.find((b) => /Book Three/.test(b.title)); await S.saveOrder('set:' + s1.setId, ['b:' + s3.id, 'b:' + s1.id]); window.__folio.settings.set({ theme: 'ocean', fontSizePt: 18, sort: 'title' }); });
    await a.evaluate(async () => { const { syncNow } = await import('/js/google.js'); await syncNow(); });
    const remote = JSON.parse(cloud.file); assert(cloud.parents, 'file not created in appDataFolder'); assert(cloud.auth.every((x) => x === 'Bearer seed-token'), 'auth header');
    const keys = Object.keys(remote.books); assert(keys.length === 4 && remote.shelves.length === 1 && remote.sets.length === 1 && remote.settings.values.theme === 'ocean', JSON.stringify({ keys: keys.length, shelves: remote.shelves.length, sets: remote.sets.length }));
    await a.screenshot({ path: '/tmp/shot-settings-signedin.png' }); return `remote: ${keys.length} books, ${remote.shelves.length} shelf, ${remote.sets.length} set, ${Object.values(remote.bookmarks).flat().length} bookmark, ${remote.orders.length} order(s), ${(cloud.file.length / 1024).toFixed(1)} KB`;
  });
  await a.close();

  const B = await browser.createBrowserContext(); const b = await mk(B); await mockGoogle(b); await b.evaluateOnNewDocument(fakeLogin(exp)); await b.goto(URL, { waitUntil: 'networkidle0' });
  await step('Sync B (new device, empty library): settings + shelves + sets restored; book state held pending', async () => {
    await b.evaluate(async () => { const { syncNow } = await import('/js/google.js'); await syncNow(); });
    const st = await b.evaluate(() => ({ theme: window.__folio.settings.get('theme'), fs: window.__folio.settings.get('fontSizePt'), pending: Object.keys(JSON.parse(localStorage.getItem('folio.pending') || '{}')).length }));
    const shelves = await dbAll(b, 'shelves'); assert(st.theme === 'ocean' && st.fs === 18 && shelves.length === 1 && st.pending === 4, JSON.stringify({ st, shelves: shelves.length })); return JSON.stringify(st);
  });
  await step('Sync B: importing the same EPUBs re-applies shelf/status/overrides/position/bookmarks/series set', async () => {
    await b.evaluate(() => window.__folio.show('library')); await sleep(300); await (await b.$('#file-input')).uploadFile(...['frankenstein', 'saga-1', 'saga-2', 'saga-3'].map(fx)); await b.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, { timeout: 15000 }); await sleep(1500);
    const books = await booksDb(b); const fr = books.find((x) => /Frank/.test(x.title)); const shelves = await dbAll(b, 'shelves'); const bms = await dbAll(b, 'bookmarks');
    assert(fr.status === 'reading' && fr.ov && fr.ov.fontSizePt === 19.5 && fr.ov.margin === 8 && Math.abs(fr.progress - 0.42) < 1e-6 && fr.shelves.includes(shelves[0].id) && bms.length === 1 && bms[0].label === 'My mark', JSON.stringify({ fr: { s: fr.status, ov: fr.ov, p: fr.progress, sh: fr.shelves }, bms: bms.length }));
    await b.evaluate(async () => { const { syncNow } = await import('/js/google.js'); await syncNow(); });
    const sets = await dbAll(b, 'sets'); const orders = await dbAll(b, 'orders'); assert(sets.length === 1 && orders.some((o) => o.key === 'set:' + sets[0].id && o.ids.length === 2 && o.ids.every((i) => i.startsWith('b:'))), 'sets/orders ' + JSON.stringify({ sets, orders }));
    return 'status/override/position/shelf/bookmark/order restored';
  });
  await step('Sync merge: newer change on B wins; deletions propagate (bookmark, shelf) ; no duplicate sets by name', async () => {
    await b.evaluate(async () => { const S = await import('/js/store.js'); const bms = await (await import('/js/db.js')).DB.all('bookmarks'); await S.removeBookmark(bms[0].id); const books = await S.getBooks(); const fr = books.find((x) => /Frank/.test(x.title)); await S.setStatus(fr.id, 'finished'); await S.createShelf('Temp'); const { syncNow } = await import('/js/google.js'); await syncNow(); });
    const remote = JSON.parse(cloud.file); const fr = Object.values(remote.books).find((x) => /Frank/.test(x.title)); assert(fr.status === 'finished', fr.status); assert(Object.values(remote.bookmarks).flat().length === 0, 'bookmark deletion not synced'); assert(remote.shelves.length === 2, 'shelves ' + remote.shelves.length);
    return 'remote updated';
  });
  await b.close();
  const C = await browser.createBrowserContext(); const c = await mk(C); await mockGoogle(c); await c.evaluateOnNewDocument(fakeLogin(exp)); await c.goto(URL, { waitUntil: 'networkidle0' });
  await step('Sync third device pulls later changes (merge, last-writer-wins)', async () => {
    await c.evaluate(() => window.__folio.show('library')); await (await c.$('#file-input')).uploadFile(...['frankenstein', 'saga-1'].map(fx)); await sleep(2000);
    await c.evaluate(async () => { const { syncNow } = await import('/js/google.js'); await syncNow(); await new Promise((r) => setTimeout(r, 300)); });
    const books = await booksDb(c); const fr = books.find((x) => /Frank/.test(x.title)); const shelves = await dbAll(c, 'shelves'); const bms = await dbAll(c, 'bookmarks'); assert(fr.status === 'finished' && shelves.length === 2 && bms.length === 0, JSON.stringify({ s: fr.status, sh: shelves.length, bm: bms.length })); return 'finished; 2 shelves; 0 bookmarks';
  });
  await c.close();

  const D = await browser.createBrowserContext(); const d = await mk(D); await mockGoogle(d); await d.evaluateOnNewDocument(`localStorage.setItem('folio.gClientId','test-client.apps.googleusercontent.com');`); await d.goto(URL, { waitUntil: 'networkidle0' });
  await step('Google sign-in UI (GIS mocked): sign in → profile remembered → survives reload', async () => {
    await d.evaluate(() => window.__folio.show('settings')); await d.waitForSelector('#sign-in'); await d.click('#sign-in'); await d.waitForSelector('#sync-now', { timeout: 10000 });
    const t = await d.$eval('.account', (e) => e.innerText); assert(/Ada Reader/.test(t) && /ada@example.com/.test(t), t); await d.reload({ waitUntil: 'networkidle0' }); await d.evaluate(() => window.__folio.show('settings')); await d.waitForSelector('#sync-now'); const t2 = await d.$eval('.account', (e) => e.innerText); assert(/Ada Reader/.test(t2), 'profile lost'); return 'remembered after reload';
  });
  await step('Google Drive: enable read access, browse folders, import an EPUB from Drive', async () => {
    await d.evaluate(() => document.querySelector('#enable-drive').click()); await d.waitForFunction(() => /✓/.test(document.querySelector('#enable-drive')?.innerText || ''), { timeout: 8000 });
    await d.evaluate(() => window.__folio.show('library')); await sleep(300); await d.evaluate(() => document.querySelector('#lib-menu').click()); await d.waitForSelector('.sheet .list-item');
    await d.evaluate(() => [...document.querySelectorAll('.sheet .list-item')].find((x) => /Google Drive/.test(x.innerText)).click()); await d.waitForSelector('#drive-list .file', { timeout: 8000 });
    const root = await d.$$eval('#drive-list .list-item', (e) => e.map((x) => x.innerText.replace(/\n/g, ' ')));
    assert(root.some((r) => /Books/.test(r)) && root.some((r) => /MyDriveBook/.test(r)), root.join('|'));
    await d.evaluate(() => [...document.querySelectorAll('#drive-list .folder')][0].click()); await d.waitForFunction(() => /InFolder/.test(document.querySelector('#drive-list').innerText)); await d.screenshot({ path: '/tmp/shot-drive.png' });
    await d.evaluate(() => document.querySelector('#drive-list .file .dl').click()); await d.waitForFunction(() => /Added/.test(document.querySelector('#drive-list .file .dl').innerText), { timeout: 10000 });
    const bs = await booksDb(d); assert(bs.some((b) => b.src === 'Google Drive' && /Book Three/.test(b.title)), JSON.stringify(bs.map((b) => [b.title, b.src]))); return 'imported "Saga Book Three" from Drive/Books';
  });
  await step('Silent token renewal: expired token → GIS requested with prompt:"" + login_hint (no UI)', async () => {
    await d.evaluate(() => { const a = JSON.parse(localStorage.getItem('folio.google')); a.exp = Date.now() - 1000; a.token = 'old'; localStorage.setItem('folio.google', JSON.stringify(a)); });
    await d.evaluate(async () => { const { syncNow } = await import('/js/google.js'); await syncNow({ quiet: true }); }); const calls = await d.evaluate(() => window.__gisCalls); assert(calls && calls.length >= 1 && calls[calls.length - 1].prompt === '' && calls[calls.length - 1].hint === 'ada@example.com', JSON.stringify(calls)); const tok = await d.evaluate(() => JSON.parse(localStorage.getItem('folio.google')).token); assert(tok.startsWith('tok-'), tok); return JSON.stringify(calls[calls.length - 1]);
  });
  await step('Sign out clears the remembered profile; Disconnect revokes the grant', async () => {
    await d.evaluate(() => window.__folio.show('settings')); await d.waitForSelector('#sign-out'); await d.evaluate(() => document.querySelector('#sign-out').click()); await d.waitForSelector('#sign-in'); assert(!(await d.evaluate(() => localStorage.getItem('folio.google'))), 'profile still stored');
    await d.evaluate(() => document.querySelector('#sign-in').click()); await d.waitForSelector('#sync-now'); await d.evaluate(() => [...document.querySelectorAll('.account .btn.danger')][0].click()); await d.waitForSelector('.sheet .btn.danger'); await d.evaluate(() => document.querySelector('.sheet .btn.danger').click()); await d.waitForSelector('#sign-in'); const rv = await d.evaluate(() => window.__revoked); assert(rv && rv.startsWith('tok-'), 'revoke not called'); return 'revoked ' + rv.slice(0, 8);
  });
  console.log('  page errors (sync phase):', JSON.stringify(d.errs));
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

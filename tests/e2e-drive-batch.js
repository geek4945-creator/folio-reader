// v0.5.0 Drive batch import (mocked Drive): per-row selection that survives navigation, "Select all in this folder" (+ subfolders), "Select all book files in
// my whole Drive" (search + pagination + a 429 mid-scan), count + total size + confirm step, progress bar, cancel, duplicate skipping, automatic retry of
// transient errors, "Retry failed", audio mode (files of one folder become one audiobook).
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const JSZip = require('../vendor/jszip.min.js');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const fx = (...p) => path.join(__dirname, 'fixtures', ...p);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const GIS = `window.google={accounts:{id:{disableAutoSelect(){}},oauth2:{initTokenClient(cfg){return{requestAccessToken(){setTimeout(()=>cfg.callback({access_token:'tok-'+Math.random().toString(36).slice(2),expires_in:3600,scope:cfg.scope}),20);}}},revoke(t,cb){cb&&cb();},hasGrantedAllScopes(){return true}}}};`;

async function epub(title, author) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:identifier id="id">urn:drive:${title}</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  z.file('OEBPS/c1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${title}</p></body></html>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
const ROOT = 'root';
const D = { files: new Map(), calls: [], gone: true, flaky: 0, listing429: 1, pages: 0, wholePages: 0, dl: new Map(), maxPage: 50 };
const addFile = (id, name, parent, bytes, mime) => D.files.set(id, { id, name, parents: [parent], mimeType: mime || (/\.pdf$/.test(name) ? 'application/pdf' : /\.epub$/.test(name) ? 'application/epub+zip' : /\.mp3$/.test(name) ? 'audio/mpeg' : 'application/octet-stream'), size: String(bytes.length), bytes });
const addFolder = (id, name, parent) => D.files.set(id, { id, name, parents: [parent], mimeType: 'application/vnd.google-apps.folder', size: undefined });
const isBook = (f) => /\.(epub|pdf|mobi|azw3?)$/i.test(f.name); const isAudio = (f) => /\.(mp3|m4a|m4b|aac|ogg|opus|flac|wav)$/i.test(f.name); const isFolder = (f) => f.mimeType === 'application/vnd.google-apps.folder';

async function buildTree() {
  addFolder('FA', 'Books A', ROOT); addFolder('FAA', 'Sub', 'FA'); addFolder('FS', 'Story folder', ROOT); addFolder('FM', 'Misc', ROOT);
  addFile('R1', 'Root One.epub', ROOT, await epub('Root One', 'Rita Root')); addFile('R2', 'doc.pdf', ROOT, fs.readFileSync(fx('test-doc.pdf')));
  addFile('A1', 'Alpha.epub', 'FA', await epub('Alpha', 'Al Pha')); addFile('A2', 'Beta.epub', 'FA', await epub('Beta', 'Bea Ta')); addFile('A1C', 'Alpha copy.epub', 'FA', await epub('Alpha', 'Al Pha'));
  addFile('BAD', 'Flaky.epub', 'FA', await epub('Flaky', 'Fla Ky')); addFile('GONE', 'Gone.epub', 'FA', await epub('Gone', 'Go Ne'));
  addFile('S1', 'Sub One.epub', 'FAA', await epub('Sub One', 'Sue Bone')); addFile('S2', 'Sub Two.epub', 'FAA', await epub('Sub Two', 'Sue Btwo'));
  for (let i = 1; i <= 100; i++) addFile('M' + i, `Misc ${String(i).padStart(3, '0')}.epub`, 'FM', await epub('Misc ' + i, 'Mia Misc'));
  addFile('T1', 'story-01.mp3', 'FS', fs.readFileSync(fx('audio', 'story-01.mp3'))); addFile('T2', 'story-02.mp3', 'FS', fs.readFileSync(fx('audio', 'story-02.mp3'))); addFile('T3', 'story-03.mp3', 'FS', fs.readFileSync(fx('audio', 'story-03.mp3')));
  addFile('L1', 'long.mp3', ROOT, fs.readFileSync(fx('audio', 'long.mp3')));
}
function listResponse(q, tok) {
  const folderQ = /mimeType='application\/vnd\.google-apps\.folder'/.test(q) && !/mimeType!=/.test(q); const audio = /mimeType contains 'audio\/'/.test(q); const pm = /'([^']+)' in parents/.exec(q);
  let list = [...D.files.values()]; if (pm) list = list.filter((f) => f.parents[0] === pm[1]); else list = list.filter((f) => !isFolder(f));
  list = list.filter((f) => (isFolder(f) ? folderQ : audio ? isAudio(f) : isBook(f)));
  list.sort((a, b) => (isFolder(b) - isFolder(a)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const off = tok ? +tok.slice(1) : 0; const page = list.slice(off, off + D.maxPage);
  return { files: page.map(({ bytes, ...f }) => f), nextPageToken: off + D.maxPage < list.length ? 'p' + (off + D.maxPage) : undefined, whole: !pm };
}
async function mock(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); if (u.startsWith('https://accounts.google.com/gsi/client')) return req.respond({ status: 200, contentType: 'text/javascript', body: GIS });
    if (!/googleapis\.com/.test(u)) return req.continue(); if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
    const json = (o, status = 200, h = {}) => req.respond({ status, headers: { ...CORS, ...h }, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.includes('/oauth2/v3/userinfo')) return json({ name: 'Ada Reader', email: 'ada@example.com', picture: '' });
    let m;
    if ((m = /\/drive\/v3\/files\/([A-Za-z0-9]+)\?alt=media/.exec(u))) { const f = D.files.get(m[1]); D.dl.set(m[1], (D.dl.get(m[1]) || 0) + 1);
      if (m[1] === 'GONE' && D.gone) return req.respond({ status: 404, headers: CORS, body: 'nf' }); if (m[1] === 'BAD' && D.flaky > 0) { D.flaky--; return req.respond({ status: 503, headers: CORS, body: 'busy' }); }
      return req.respond({ status: 200, headers: CORS, contentType: f.mimeType, body: f.bytes }); }
    if ((m = /\/drive\/v3\/files\/([A-Za-z0-9]+)\?fields=name/.exec(u))) return json({ name: D.files.get(m[1])?.name || '' });
    if (u.includes('spaces=drive')) {
      const url = new URL(u); const q = url.searchParams.get('q') || ''; const tok = url.searchParams.get('pageToken') || ''; const r = listResponse(q, tok); D.calls.push({ q, tok, whole: r.whole, pageSize: url.searchParams.get('pageSize') });
      if (r.whole && tok && D.listing429 > 0) { D.listing429--; D.hit429 = true; return req.respond({ status: 429, headers: { ...CORS, 'Retry-After': '0' }, contentType: 'application/json', body: '{"error":{"code":429}}' }); }
      return json({ files: r.files, nextPageToken: r.nextPageToken });
    }
    if (u.includes('spaces=appDataFolder')) return json({ files: [] });
    return req.respond({ status: 404, headers: CORS, body: 'nf' });
  });
}
const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
const clickText = (page, sel, re) => page.evaluate((s, r) => { const el = [...document.querySelectorAll(s)].find((x) => new RegExp(r, 'i').test(x.innerText || x.textContent)); if (!el) throw new Error('no ' + s + ' ~ ' + r + ' in ' + [...document.querySelectorAll(s)].map((x) => x.innerText).join('|').slice(0, 200)); el.click(); }, sel, re);
const waitFor = async (page, fn, arg, t = 20000) => { const end = Date.now() + t; while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(80); } throw new Error('timeout: ' + fn.toString().slice(0, 150)); };
const dbAll = (page, store) => page.evaluate((store) => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction(store).objectStore(store).getAll(); a.onsuccess = () => res(a.result.map((x) => ({ id: x.id, title: x.title, tracks: x.tracks?.length, sourceKey: x.sourceKey }))); }; }), store);
const openBrowser = async (page, audio) => { if (audio) { await page.evaluate(() => window.__folio.show('audiobooks')); await sleep(400); await click(page, '#audio-menu'); await click(page, '#audio-menu-drive'); } else { await page.evaluate(() => window.__folio.show('library')); await sleep(400); await click(page, '#lib-menu'); await clickText(page, '.sheet .list-item, .sheet button', 'Import from Google Drive'); } await page.waitForSelector('#drive-list .file, #drive-list .folder', { timeout: 10000 }); await sleep(200); };
const closeSheets = (page) => page.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; });
const enterFolder = async (page, name) => { await page.evaluate((n) => [...document.querySelectorAll('#drive-list .folder')].find((x) => x.innerText.includes(n)).click(), name); await sleep(400); await page.waitForSelector('#drive-list .file, #drive-list p'); };
const tick = (page, id) => page.evaluate((id) => document.querySelector(`#drive-list .file[data-id="${id}"] .drive-check`).click(), id);
const confirmInfo = (page) => page.evaluate(() => ({ count: document.querySelector('#dv-count')?.innerText, size: document.querySelector('#dv-size')?.innerText, types: document.querySelector('#dv-types')?.innerText, dupes: document.querySelector('#dv-dupes')?.innerText || '', go: !document.querySelector('#dv-go')?.disabled, goText: document.querySelector('#dv-go')?.innerText, group: !!document.querySelector('#dv-group') }));
const sizeStr = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

(async () => {
  await buildTree();
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); await mock(page);
  await page.evaluateOnNewDocument(`localStorage.setItem('folio.google', JSON.stringify({ token: 'seed-token', exp: ${Date.now() + 3600000}, profile: { name: 'Ada Reader', email: 'ada@example.com', picture: '' } }));`);
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => { (await import('/js/drivebatch.js')).BATCH.gap = 2; (await import('/js/google.js')).driveRate.backoff = 20; });
  await page.evaluate(() => window.__folio.show('settings')); await page.waitForSelector('#enable-drive'); await click(page, '#enable-drive'); await waitFor(page, () => /✓/.test(document.querySelector('#enable-drive')?.innerText || ''));

  await step('Drive browser: row checkboxes + "Select all in this folder" (+ Include subfolders) + "Select all book files in my whole Drive"', async () => {
    await openBrowser(page); const ids = await page.$$eval('#drive-tools button, #drive-tools input', (e) => e.map((x) => x.id)); assert(['drive-sel-folder', 'drive-sub', 'drive-sel-all'].every((i) => ids.includes(i)), ids.join());
    assert(await page.$$eval('#drive-list .file .drive-check', (e) => e.length) === 2 && await page.$('#drive-list .file .dl'), 'rows need a checkbox and keep the single Import button'); assert(/whole Drive/.test(await page.$eval('#drive-sel-all', (e) => e.innerText)) && await page.$eval('#drive-batch-bar', (e) => e.hidden), 'bar should be hidden with nothing selected'); return ids.join(',');
  });

  await step('Individual selection survives navigation; the count + total size show in the bar; confirm step lists them; Cancel imports nothing', async () => {
    await tick(page, 'R1'); await tick(page, 'R2'); await enterFolder(page, 'Books A'); await tick(page, 'A2');
    const bar = await page.$eval('#drive-sel-count', (e) => e.innerText); const want = sizeStr(['R1', 'R2', 'A2'].reduce((a, i) => a + +D.files.get(i).size, 0)); assert(/^3 selected/.test(bar) && bar.includes(want), `${bar} (want ${want})`);
    await click(page, '#drive-import-selected'); await page.waitForSelector('#dv-confirm'); const c = await confirmInfo(page); assert(c.count === '3 files' && c.size === want && /1 \.pdf/.test(c.types) && /2 \.epub/.test(c.types) && c.go, JSON.stringify(c));
    await click(page, '#dv-cancel'); await sleep(300); assert((await dbAll(page, 'books')).length === 0, 'cancel must import nothing'); assert(/^3 selected/.test(await page.$eval('#drive-sel-count', (e) => e.innerText)), 'selection should be kept'); await click(page, '#drive-sel-clear'); assert(await page.$eval('#drive-batch-bar', (e) => e.hidden), 'cleared'); return bar;
  });

  await step('Select all in this folder: only that folder (5 files); with "Include subfolders": 7; count + size are exact', async () => {
    await click(page, '#drive-sel-folder'); await page.waitForSelector('#dv-confirm'); let c = await confirmInfo(page); const own = ['A1', 'A2', 'A1C', 'BAD', 'GONE']; assert(c.count === '5 files' && c.size === sizeStr(own.reduce((a, i) => a + +D.files.get(i).size, 0)), JSON.stringify(c)); await click(page, '#dv-cancel'); await sleep(300); await click(page, '#drive-sel-clear');
    await click(page, '#drive-sub'); await click(page, '#drive-sel-folder'); await page.waitForSelector('#dv-confirm'); c = await confirmInfo(page); const all = own.concat(['S1', 'S2']); assert(c.count === '7 files' && c.size === sizeStr(all.reduce((a, i) => a + +D.files.get(i).size, 0)), JSON.stringify(c));
    assert(D.calls.some((x) => /'FAA' in parents/.test(x.q)), 'subfolder was not scanned'); return c.count + ', ' + c.size;
  });

  await step('Batch import: progress bar, transient 503 retried automatically, duplicate skipped, 404 reported as failed', async () => {
    D.flaky = 2; const seen = []; const t0 = Date.now(); await click(page, '#dv-go');
    while (Date.now() - t0 < 30000) { const t = await page.evaluate(() => document.querySelector('#dv-progress-text')?.innerText || (document.querySelector('#dv-summary') ? 'DONE' : '')); if (t === 'DONE') break; if (t && !seen.includes(t)) seen.push(t); await sleep(15); }
    assert(seen.some((t) => /Importing \d+ of 7/.test(t)), 'no progress: ' + seen.join('|')); const sum = await page.$eval('#dv-summary', (e) => e.innerText);
    assert(/Imported 5/.test(sum) && /skipped 1/.test(sum) && /failed 1/.test(sum) && /Gone\.epub: not found/.test(sum), sum); assert((D.dl.get('BAD') || 0) === 3, 'flaky file should need 3 downloads: ' + D.dl.get('BAD'));
    const books = await dbAll(page, 'books'); assert(books.length === 5 && books.every((b) => b.sourceKey?.startsWith('gdrive:')), books.map((b) => b.title).join()); return sum.replace(/\n/g, ' ');
  });

  await step('Retry failed: after the problem is fixed the failed file imports', async () => {
    assert(await page.$('#dv-retry'), 'no retry button'); D.gone = false; await click(page, '#dv-retry'); await waitFor(page, () => /Imported 6/.test(document.querySelector('#dv-summary')?.innerText || '')); assert(!(await page.$('#dv-retry')), 'nothing left to retry');
    assert((await dbAll(page, 'books')).length === 6, 'book count'); await click(page, '#dv-done'); await sleep(200); assert(await page.$eval('#drive-batch-bar', (e) => e.hidden), 'selection cleared after import'); return 'Imported 6 in total';
  });

  await step('Re-running the same selection skips everything already imported ("Nothing to import")', async () => {
    await click(page, '#drive-sel-folder'); await page.waitForSelector('#dv-confirm'); const c = await confirmInfo(page); assert(c.count === '0 files' && !c.go && /7 already imported/.test(c.dupes) && /Nothing to import/.test(c.goText), JSON.stringify(c)); await click(page, '#dv-cancel'); await sleep(200); await click(page, '#drive-sel-clear'); await closeSheets(page);
  });

  await step('Whole Drive: search by type with pagination (3 pages) and a 429 mid-scan retried; count = new files only', async () => {
    await openBrowser(page); D.calls.length = 0; await click(page, '#drive-sel-all'); await page.waitForSelector('#dv-confirm', { timeout: 30000 }); const c = await confirmInfo(page);
    const fresh = ['R1', 'R2'].concat(Array.from({ length: 100 }, (_, i) => 'M' + (i + 1))); assert(c.count === '102 files' && c.size === sizeStr(fresh.reduce((a, i) => a + +D.files.get(i).size, 0)) && /7 already imported/.test(c.dupes), JSON.stringify(c));
    const whole = D.calls.filter((x) => x.whole); assert(whole.length >= 4 && whole.some((x) => x.tok === 'p50') && whole.some((x) => x.tok === 'p100') && D.hit429, `whole-drive pages: ${whole.map((x) => x.tok || '-').join()} 429=${D.hit429}`);
    assert(whole.every((x) => /mimeType!='application\/vnd\.google-apps\.folder'/.test(x.q) && /epub/.test(x.q) && /pdf/.test(x.q) && /mobi/.test(x.q) && /azw/.test(x.q)) && whole.every((x) => !/audio/.test(x.q)), 'query should search epub/pdf/mobi/azw and no audio: ' + whole[0].q);
    return c.count + ', ' + c.size + ', pages ' + whole.map((x) => x.tok || '-').join();
  });

  await step('Cancel mid-import stops cleanly; running again imports the rest without duplicates', async () => {
    await click(page, '#dv-go'); await waitFor(page, () => /Importing (\d+) of 109/.test(document.querySelector('#dv-progress-text')?.innerText || '') && +/Importing (\d+)/.exec(document.querySelector('#dv-progress-text').innerText)[1] > 12, null, 40000); await click(page, '#dv-cancel-run');
    await page.waitForSelector('#dv-summary', { timeout: 20000 }); const sum = await page.$eval('#dv-summary', (e) => e.innerText); const n1 = (await dbAll(page, 'books')).length; assert(/cancelled/.test(sum) && n1 > 5 && n1 < 108, sum + ' / books ' + n1);
    await click(page, '#dv-done'); await sleep(200); await click(page, '#drive-sel-all'); await page.waitForSelector('#dv-confirm', { timeout: 30000 }); const c = await confirmInfo(page); assert(+c.count.split(' ')[0] === 108 - n1 && c.go, JSON.stringify(c) + ' n1=' + n1);
    await click(page, '#dv-go'); await waitFor(page, () => /Imported \d+/.test(document.querySelector('#dv-summary')?.innerText || ''), null, 90000); const books = await dbAll(page, 'books'); assert(books.length === 108 && new Set(books.map((b) => b.title)).size === 108, 'books ' + books.length);
    await click(page, '#dv-done'); await closeSheets(page); return `cancelled after ${n1}, then 108 total, no duplicates`;
  });

  await step('Audio mode: whole-Drive audio search; files of one folder become one audiobook (confirm option), the loose file its own', async () => {
    await openBrowser(page, true); assert(/audio files/.test(await page.$eval('#drive-sel-all', (e) => e.innerText)), 'button label'); D.calls.length = 0; await click(page, '#drive-sel-all'); await page.waitForSelector('#dv-confirm', { timeout: 20000 }); const c = await confirmInfo(page);
    assert(c.count === '4 files' && c.group && /4 \.mp3/.test(c.types), JSON.stringify(c)); assert(D.calls.filter((x) => x.whole).every((x) => /audio\//.test(x.q) && !/epub/.test(x.q)), 'audio query');
    await click(page, '#dv-go'); await waitFor(page, () => /Imported 4/.test(document.querySelector('#dv-summary')?.innerText || ''), null, 30000); const abs = await dbAll(page, 'audiobooks'); assert(abs.length === 2 && abs.some((b) => b.tracks === 3) && abs.some((b) => b.tracks === 1), JSON.stringify(abs));
    await click(page, '#dv-done'); await closeSheets(page); return abs.map((b) => `${b.title} (${b.tracks})`).join(', ');
  });

  await step('No page errors', async () => { assert(!page.errs.length, page.errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

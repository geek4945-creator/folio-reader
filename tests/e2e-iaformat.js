// Internet Archive downloads (v0.5.1): "Reminiscences of a Stock Operator" had a 155 MB derived EPUB (every page image embedded, spine items missing from the manifest)
// next to a 1.8 MB original PDF; the app picked the EPUB and never opened. Now: smaller usable format wins, huge-only files ask first, encrypted files are never offered, 5xx is retried.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n); const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const FILES = {
  ia_scan: [{ name: 'Reminiscences.epub', format: 'EPUB', source: 'derivative', size: '154600891' }, { name: 'Reminiscences.pdf', format: 'Text PDF', source: 'original', size: '1844081' }, { name: 'x_encrypted.pdf', format: 'ACS Encrypted PDF', source: 'original', size: '9' }, { name: 'x.acsm', format: 'ACS Encrypted EPUB', source: 'original', size: '9' }],
  ia_onlybig: [{ name: 'Huge Book.epub', format: 'EPUB', source: 'derivative', size: '154600891' }],
  ia_small: [{ name: 'small.epub', format: 'EPUB', source: 'original', size: '300000' }, { name: 'small.pdf', format: 'PDF', source: 'derivative', size: '200000' }],
};
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); }); const dl = []; let pdfFails = 1;
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); if (/^https?:\/\/localhost/.test(u) || /^(data|blob):/.test(u)) return req.continue();
    if (/archive\.org\/advancedsearch/.test(u)) return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ response: { numFound: 3, docs: Object.keys(FILES).map((id, i) => ({ identifier: id, title: ['Reminiscences of a Stock Operator', 'Only A Huge Book', 'Small Book'][i], creator: 'Edwin Lefèvre' })) } }) });
    const m = /archive\.org\/metadata\/([^/?]+)/.exec(u); if (m) return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ metadata: {}, files: FILES[m[1]] || [] }) });
    if (/archive\.org\/download\//.test(u)) { dl.push(decodeURIComponent(u)); if (/Reminiscences\.pdf$/.test(u) && pdfFails-- > 0) return req.respond({ status: 500, headers: cors, body: 'oops' });
      if (/\.pdf$/.test(u)) return req.respond({ status: 200, headers: cors, contentType: 'application/pdf', body: fs.readFileSync(fx('test-doc.pdf')) });
      if (/small\.epub$/.test(u)) return req.respond({ status: 200, headers: cors, contentType: 'application/epub+zip', body: fs.readFileSync(fx('frankenstein.epub')) });
      return req.respond({ status: 200, headers: cors, contentType: 'application/epub+zip', body: Buffer.from('PK-not-really') }); }
    if (/archive\.org\/services\/img/.test(u)) return req.respond({ status: 200, headers: cors, contentType: 'image/png', body: fs.readFileSync(fx('cover-a.png')) });
    req.abort('failed');
  });
  await page.goto(URL, { waitUntil: 'networkidle0' }); await sleep(300);
  const ev = (f, ...a) => page.evaluate(f, ...a);
  await ev(async () => { (await import('./js/settings.js')).settings.set({ proxyUrl: '' }); });   // direct fetches only (the stub plays archive.org)
  await step('pickEpub: EPUB > MOBI > PDF, but a huge file loses to a normal one; all-huge picks the smallest; encrypted/ACS files are never offered', async () => {
    const r = await ev(async () => { const { pickEpub } = await import('./js/opds.js'); const { iaFiles } = await import('./js/catalogs.js');
      const mk = (u, t, size) => ({ url: u, type: t, label: u, size });
      const files = iaFiles('x', [{ name: 'a.epub', format: 'EPUB', source: 'derivative', size: '154600891' }, { name: 'a.pdf', format: 'Text PDF', source: 'original', size: '1844081' }, { name: 'b.pdf', format: 'ACS Encrypted PDF', size: '5' }, { name: 'c.acsm', format: 'ACS Encrypted EPUB', size: '5' }, { name: 'd.epub', format: 'LCP Encrypted EPUB', size: '5' }]);
      return { names: files.map((f) => f.url.split('/').pop()), big: pickEpub(files).url.split('/').pop(), normal: pickEpub([mk('https://x/a.epub', 'application/epub+zip', 5e6), mk('https://x/a.pdf', 'application/pdf', 1e6)]).url, huge: pickEpub([mk('https://x/a.epub', 'application/epub+zip', 90e6), mk('https://x/a.pdf', 'application/pdf', 70e6)]).url, unknown: pickEpub([mk('https://x/a.epub', 'application/epub+zip', 0), mk('https://x/a.pdf', 'application/pdf', 0)]).url }; });
    assert(r.names.join() === 'a.epub,a.pdf' && r.big === 'a.pdf' && r.normal === 'https://x/a.epub' && r.huge === 'https://x/a.pdf' && r.unknown === 'https://x/a.epub', JSON.stringify(r)); return JSON.stringify(r);
  });
  const openIA = async () => { await ev(() => document.querySelector('[data-tab=catalogs]').click()); await page.waitForFunction(() => [...document.querySelectorAll('#view-catalogs *, #view *')].some((e) => e.children.length === 0 && /Internet Archive/.test(e.textContent)), { timeout: 8000 });
    await ev(() => { const e = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^Internet Archive$/.test(e.textContent.trim()))[0]; (e.closest('button, [role=button], .src, .card, li, div') || e).click(); }); await page.waitForSelector('.card[data-key^="ia:"]', { timeout: 10000 }); };
  const btnText = (key) => ev((k) => document.querySelector(`.card[data-key="${k}"] .dl`).textContent, key);
  await step('Catalog: a scan with a 155 MB EPUB downloads the 1.8 MB PDF instead (retrying the 500) and imports it', async () => {
    await openIA(); await ev(() => document.querySelector('.card[data-key="ia:ia_scan"] .dl').click());
    await page.waitForFunction(() => /In library/.test(document.querySelector('.card[data-key="ia:ia_scan"] .dl')?.textContent), { timeout: 20000 }).catch(async (e) => { throw new Error(e.message + ' btn=' + (await btnText('ia:ia_scan')) + ' toast=' + (await ev(() => document.querySelector('.toast')?.textContent)) + ' dl=' + dl.join('|')); });
    assert(dl.filter((u) => /Reminiscences\.pdf$/.test(u)).length === 2, 'expected 500 then success: ' + dl.join(' | ')); assert(!dl.some((u) => /Reminiscences\.epub|encrypted|acsm/i.test(u)), 'huge/encrypted file requested: ' + dl.join(' | '));
    const b = (await ev(async () => (await (await import('./js/store.js')).getBooks()))).find((x) => x.sourceKey === 'ia:ia_scan' || /Reminiscences|Folio Test PDF/.test(x.title)); assert(b && b.format === 'pdf', JSON.stringify(b) + ' ' + (await ev(async () => (await (await import('./js/store.js')).getBooks()).map((x) => x.title + ':' + x.format))));
  });
  await step('Catalog: a huge-only EPUB asks before downloading; Cancel downloads nothing, Download anyway proceeds', async () => {
    const n0 = dl.length; await ev(() => document.querySelector('.card[data-key="ia:ia_onlybig"] .dl').click()); await page.waitForSelector('.sheet-wrap, #overlay:not([hidden])', { timeout: 6000 }); await sleep(300);
    const txt = await ev(() => document.querySelector('#overlay').innerText); assert(/very large file/i.test(txt) && /154\.6 MB|147\.4 MB|154\.\d MB|147\.\d MB/.test(txt), txt);
    await ev(() => [...document.querySelectorAll('#overlay button')].find((b) => /cancel/i.test(b.textContent)).click()); await sleep(500);
    assert(dl.length === n0, 'downloaded without consent'); assert(/Download/.test(await btnText('ia:ia_onlybig')) && !/In library/.test(await btnText('ia:ia_onlybig')), await btnText('ia:ia_onlybig'));
    await ev(() => document.querySelector('.card[data-key="ia:ia_onlybig"] .dl').click()); await sleep(400); await ev(() => [...document.querySelectorAll('#overlay button')].find((b) => /download anyway/i.test(b.textContent)).click()); await sleep(1500);
    assert(dl.length > n0 && /Huge Book\.epub$/.test(dl[dl.length - 1]), dl.join(' | '));   // the stub body is not a real EPUB, so the import is refused with a message (no hang)
  });
  await step('Catalog: a normal-size item still prefers the EPUB', async () => {
    const n0 = dl.length; await ev(() => document.querySelector('.card[data-key="ia:ia_small"] .dl').click()); await page.waitForFunction(() => /In library/.test(document.querySelector('.card[data-key="ia:ia_small"] .dl')?.textContent), { timeout: 20000 });
    assert(dl.slice(n0).length === 1 && /small\.epub$/.test(dl[n0]), dl.slice(n0).join(' | '));
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

// "Add a source": bare domains / sloppy input are normalized; friendly inline errors; known sites redirect to the built-in source.
const puppeteer = require('puppeteer-core');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const ATOM = (title) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title><id>x</id><entry><id>b1</id><title>Some Book</title><author><name>An Author</name></author><link rel="http://opds-spec.org/acquisition" href="https://catalog.test/f/b.epub" type="application/epub+zip"/></entry></feed>`;
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); const external = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); if (/^(http:\/\/localhost|data:|blob:)/.test(u)) return req.continue();
    external.push(u);
    if (u.startsWith('https://catalog.test/')) return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/atom+xml', body: ATOM('Bare Domain Library') });
    if (/gutenberg\.org\/ebooks\.opds/.test(u)) return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/atom+xml', body: ATOM('Gutenberg OPDS') });
    req.abort('failed');
  });
  await page.goto(URL, { waitUntil: 'networkidle0' }); await sleep(300);
  const openSheet = async () => { await page.evaluate(() => document.querySelector('[data-tab=catalogs]').click()); await page.waitForSelector('#add-source'); await page.click('#add-source'); await page.waitForSelector('#source-url'); };
  const setUrl = async (v, kind = 'auto') => { await page.$eval('#source-url', (e) => { e.value = ''; }); await page.type('#source-url', v); await page.select('#source-kind', kind); };
  const out = () => page.$eval('#source-out', (e) => ({ t: e.innerText, err: e.classList.contains('err') }));
  const clk = (sel) => page.evaluate((x) => document.querySelector(x).click(), sel);
  const closeSheet = () => page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });

  await step('normalizeUrl: bare domains, spaces, scheme-less paths, ports; rejects junk / non-http schemes', async () => {
    const r = await page.evaluate(async () => { const { normalizeUrl } = await import('./js/net.js'); const t = (x) => { try { return normalizeUrl(x); } catch (e) { return 'ERR:' + e.message; } };
      return { a: t('archive.org'), b: t('  Example.com/opds  '), c: t('http://x.org/a b'), d: t('//cdn.x.org/a'), e: t('localhost:8080/opds'), f: t('my library.org/opds'), g: t('ftp://x.org/f'), h: t('not a url'), i: t(''), j: t('https://'), k: t('https://Foo.org/OPDS?q=1'), l: t('www.gutenberg.org/ebooks.opds/') }; });
    assert(r.a === 'https://archive.org/' && r.b === 'https://example.com/opds' && r.c === 'http://x.org/ab' && r.d === 'https://cdn.x.org/a' && r.e === 'https://localhost:8080/opds' && r.f === 'https://mylibrary.org/opds' && r.k === 'https://foo.org/OPDS?q=1' && r.l === 'https://www.gutenberg.org/ebooks.opds/', JSON.stringify(r));
    for (const k of ['g', 'h', 'i', 'j']) assert(/^ERR:/.test(r[k]) && !/Invalid URL string/i.test(r[k]), k + ' ' + r[k]); return 'ok';
  });
  await step('Add a source starts with an empty address field (no stray click-event prefill)', async () => { await openSheet(); assert((await page.$eval('#source-url', (e) => e.value)) === '', 'prefilled'); });
  await step('Bare domain "catalog.test/opds" (with spaces/caps): normalized to https://, Check finds the OPDS catalog, Add works', async () => {
    await setUrl('  Catalog.test/opds '); await clk('#source-check'); await page.waitForFunction(() => /Found an OPDS catalog/.test(document.querySelector('#source-out').innerText), { timeout: 8000 });
    assert((await page.$eval('#source-url', (e) => e.value)) === 'https://catalog.test/opds', 'not normalized: ' + await page.$eval('#source-url', (e) => e.value)); assert(external.includes('https://catalog.test/opds'), 'fetched ' + external.join());
    assert(!/Invalid URL/i.test((await out()).t), 'invalid url text'); await clk('#source-add'); await sleep(600);
    const srcs = await page.evaluate(async () => (await (await import('./js/store.js')).getSources()).map((s) => s.url)); assert(srcs.includes('https://catalog.test/opds'), srcs.join());
    assert(await page.evaluate(() => /Bare Domain Library/.test(document.querySelector('#view').innerText)), 'source not listed');
  });
  await step('Junk input shows a friendly inline error (no "Invalid URL string", no network call)', async () => {
    await openSheet(); const n = external.length; for (const bad of ['not a url', 'ftp://files.example.org/x', '']) { await setUrl(bad); await clk('#source-check'); await sleep(200); const o = await out(); assert(o.err && o.t.length > 10 && !/Invalid URL string/i.test(o.t), bad + ' → ' + JSON.stringify(o)); }
    await clk('#source-add'); await sleep(200); assert((await out()).err, 'add with empty'); assert(external.length === n, 'network call for junk'); await page.screenshot({ path: '/tmp/shot-source-error.png' });
  });
  await step('Typing "archive.org" offers the built-in Internet Archive source (no generic fetch) and opens it', async () => {
    await setUrl('archive.org'); const n = external.length; await clk('#source-check'); await page.waitForSelector('#builtin-offer'); const o = await out(); assert(/built-in source, “Internet Archive”/.test(o.t), o.t); assert(external.length === n, 'fetched archive.org: ' + external.slice(n).join());
    await page.screenshot({ path: '/tmp/shot-source-builtin.png' }); await clk('#builtin-offer'); await sleep(900);
    assert(await page.evaluate(async () => (await import('./js/catalogs.js'))._state().src?.id === 'seed-ia'), 'did not open Internet Archive'); assert(!(await page.$('#source-url')), 'sheet still open');
    await page.evaluate(async () => (await import('./js/catalogs.js')).resetCatalogs());
  });
  await step('Gutenberg and Standard Ebooks hosts redirect to their built-in sources too (also when Add is pressed; also if seeds were removed)', async () => {
    await page.evaluate(async () => { const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); await DB.del('sources', 'seed-gutenberg'); await DB.del('sources', 'seed-se'); });
    await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await openSheet();
    await setUrl('www.gutenberg.org/ebooks/'); await clk('#source-add'); await page.waitForSelector('#builtin-offer'); assert(/Project Gutenberg/.test((await out()).t), (await out()).t);
    await clk('#builtin-offer'); await sleep(900); assert(await page.evaluate(async () => (await import('./js/catalogs.js'))._state().src?.id === 'seed-gutenberg'), 'gutenberg not restored/opened');
    await page.evaluate(async () => (await import('./js/catalogs.js')).resetCatalogs()); await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await openSheet();
    await setUrl('https://standardebooks.org/ebooks/jane-austen'); await clk('#source-check'); await page.waitForSelector('#builtin-offer'); assert(/Standard Ebooks/.test((await out()).t), (await out()).t); await closeSheet();
  });
  await step('Explicit "OPDS feed" on a built-in host is respected (no redirect)', async () => {
    await page.evaluate(async () => (await import('./js/catalogs.js')).resetCatalogs()); await page.evaluate(() => document.querySelector('[data-tab=library]').click()); await openSheet();
    await setUrl('gutenberg.org/ebooks.opds/', 'opds'); await clk('#source-check'); await page.waitForFunction(() => /Found an OPDS catalog/.test(document.querySelector('#source-out').innerText), { timeout: 8000 }); assert(!(await page.$('#builtin-offer')), 'offered anyway'); await closeSheet();
  });
  await step('Settings → proxy URL accepts a bare host and rejects junk', async () => {
    await page.evaluate(() => document.querySelector('[data-tab=settings]').click()); await page.waitForSelector('#proxy-url');
    await page.$eval('#proxy-url', (e) => { e.value = ''; }); await page.type('#proxy-url', ' folio-proxy.example.workers.dev '); await page.$eval('#proxy-url', (e) => e.dispatchEvent(new Event('change'))); await sleep(300);
    assert((await page.evaluate(async () => (await import('./js/settings.js')).settings.get('proxyUrl'))) === 'https://folio-proxy.example.workers.dev/', 'not normalized');
    await page.$eval('#proxy-url', (e) => { e.value = 'nope nope'; e.dispatchEvent(new Event('change')); }); await sleep(300);
    assert((await page.evaluate(async () => (await import('./js/settings.js')).settings.get('proxyUrl'))) === 'https://folio-proxy.example.workers.dev/', 'junk saved'); assert(/web address/.test(await page.$eval('#toast', (e) => e.innerText)), 'toast');
    await page.evaluate(async () => (await import('./js/settings.js')).settings.set({ proxyUrl: '' }));
  });
  await step('No page errors', async () => assert(!errs.length, errs.join(' | ')));
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

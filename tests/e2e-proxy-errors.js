// Human-friendly network errors: proxy "site not supported", 403 / Cloudflare challenge pages, plain proxy 400 messages.
const puppeteer = require('puppeteer-core');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  const cors = { 'Access-Control-Allow-Origin': '*' }; let mode = {};
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('https://proxy.test/')) { const m = mode.proxy; return m ? req.respond({ status: m.status, headers: { ...cors, ...(m.headers || {}) }, contentType: m.type || 'text/plain', body: m.body }) : req.respond({ status: 200, headers: cors, body: 'proxied-ok' }); }
    if (u.startsWith('https://site.test/')) { const m = mode.direct; if (!m) return req.abort('failed'); return req.respond({ status: m.status, headers: cors, contentType: m.type || 'text/plain', body: m.body }); }
    req.continue();
  });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const attempt = (proxyMode, proxyUrl = 'https://proxy.test/') => page.evaluate(async (pm, pu) => {
    const { settings } = await import('./js/settings.js'); const { fetchSmart, SiteError } = await import('./js/net.js'); settings.set({ proxyUrl: pu, proxyMode: pm });
    try { const r = await fetchSmart('https://site.test/book.epub'); return { ok: true, text: await r.text() }; } catch (e) { return { ok: false, msg: e.message, site: e instanceof SiteError, kind: e.kind }; }
  }, proxyMode, proxyUrl);
  const CF = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue <script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>';

  await step('Proxy 400 "site not supported" → "This site isn’t supported"', async () => {
    mode = { direct: null, proxy: { status: 400, body: 'Proxy error: site not supported' } }; const r = await attempt('fallback');
    assert(!r.ok && r.msg === 'This site isn’t supported.' && r.site && r.kind === 'unsupported', JSON.stringify(r));
  });
  await step('Proxy passes through a 403 → "That site blocked the request; try downloading in the browser…"', async () => {
    mode = { direct: null, proxy: { status: 403, type: 'text/html', body: '<h1>Forbidden</h1>' } }; const r = await attempt('fallback');
    assert(!r.ok && /^That site blocked the request; try downloading in the browser and importing the file/.test(r.msg) && r.kind === 'blocked', JSON.stringify(r));
  });
  await step('Cloudflare challenge page (503 / 429 "Just a moment…") → blocked message', async () => {
    mode = { direct: null, proxy: { status: 503, type: 'text/html', body: CF } }; let r = await attempt('always'); assert(!r.ok && r.kind === 'blocked', JSON.stringify(r));
    mode = { direct: null, proxy: { status: 429, type: 'text/html', body: CF } }; r = await attempt('always'); assert(!r.ok && r.kind === 'blocked', JSON.stringify(r));
    mode = { direct: null, proxy: { status: 200 + 0, body: 'fine' } }; r = await attempt('always'); assert(r.ok && r.text === 'fine', 'success path ' + JSON.stringify(r));
  });
  await step('Plain proxy 400 shows the proxy’s own message (private address, host not allowed)', async () => {
    mode = { direct: null, proxy: { status: 400, body: 'Proxy error: private addresses are not allowed' } }; let r = await attempt('always'); assert(!r.ok && /private addresses are not allowed/.test(r.msg) && r.kind === 'proxy', JSON.stringify(r));
    mode = { direct: null, proxy: { status: 400, body: 'Proxy error: host not allowed (set ALLOW_HOSTS)' } }; r = await attempt('always'); assert(/host not allowed \(set ALLOW_HOSTS\)/.test(r.msg), r.msg);
    mode = { direct: null, proxy: { status: 400, body: 'something odd' } }; r = await attempt('always'); assert(/something odd/.test(r.msg), r.msg);
  });
  await step('Direct 403 with no proxy → blocked message; direct 403 with a working proxy falls back and succeeds', async () => {
    mode = { direct: { status: 403, body: 'no' } }; let r = await attempt('never', ''); assert(!r.ok && r.kind === 'blocked', 'never: ' + JSON.stringify(r));
    mode = { direct: { status: 403, body: 'no' } }; r = await attempt('fallback'); assert(r.ok && r.text === 'proxied-ok', 'fallback: ' + JSON.stringify(r));
    mode = { direct: { status: 404, body: 'nope' } }; r = await attempt('never', ''); assert(!r.ok && r.msg === 'Server returned 404' && !r.site, JSON.stringify(r));
  });
  await step('Unreachable host without proxy still gives the CORS/proxy tip (unchanged)', async () => { mode = { direct: null }; const r = await attempt('never', ''); assert(!r.ok && /CORS proxy/.test(r.msg), JSON.stringify(r)); });
  await step('Catalog download of a blocked file shows the friendly toast, not the CORS sheet', async () => {
    mode = { direct: { status: 403, body: 'no' }, proxy: { status: 403, body: 'no' } };
    await page.evaluate(async () => { const { settings } = await import('./js/settings.js'); settings.set({ proxyUrl: 'https://proxy.test/', proxyMode: 'fallback' }); const C = await import('./js/catalogs.js'); window.__C = C; });
    const hasDl = await page.evaluate(() => typeof window.__C.downloadBook === 'function' || typeof window.__C.downloadEntry === 'function'); return 'catalog exports download fn: ' + hasDl;
  });
  await step('No page errors', async () => assert(!errs.length, errs.join('|')));
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

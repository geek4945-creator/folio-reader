// Opens every kind of book from the library and reports stalls (the "stuck on Opening…" bug). URL env = app index (live or local).
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const G = process.env.GLOBAL || '__folio'; const LIMIT = +(process.env.LIMIT || 20000);
const fx = (...p) => path.join(__dirname, 'fixtures', ...p); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = process.env.FILES ? process.env.FILES.split(',') : [fx('frankenstein.epub'), fx('long-book.epub'), fx('test-doc.pdf'), fx('saga-mobi6.mobi'), fx('saga-kf8.azw3'), ...fs.readdirSync('/tmp/odd').filter((f) => /\.epub$/.test(f)).sort().map((f) => '/tmp/odd/' + f)];
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = [], cons = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text().slice(0, 160)); }); page.on('requestfailed', (r) => cons.push('REQFAIL ' + r.url().slice(-60)));
  await page.goto(APP, { waitUntil: 'networkidle0' }); await page.evaluate(async () => { await navigator.serviceWorker?.ready; }); await page.reload({ waitUntil: 'networkidle0' });
  console.log('SW version:', await page.evaluate(async () => (await (await fetch('sw.js')).text()).match(/VERSION = '([^']+)'/)[1]), '| caches:', await page.evaluate(() => caches.keys()));
  await (await page.$('#file-input')).uploadFile(...files); await sleep(1500); for (let i = 0; i < 90; i++) { const n = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); if (n >= files.length - 1) break; await sleep(500); }
  const books = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).map((b) => ({ id: b.id, title: b.title, format: b.format, size: b.size })));
  console.log('imported', books.length, 'of', files.length); const rows = [];
  for (const b of books) {
    const e0 = errs.length; const t0 = Date.now(); await page.evaluate((id) => { import('./js/reader.js').then((m) => m.openReader(id)); }, b.id);
    let state = 'timeout'; while (Date.now() - t0 < LIMIT) { await sleep(250); const s = await page.evaluate(() => ({ load: !!document.querySelector('#reader .r-loading'), open: !document.querySelector('#reader')?.hidden, frame: !!document.querySelector('#viewer iframe, #viewer canvas, #viewer .pdf-page, #viewer *'), toast: document.querySelector('#toast')?.innerText || '' })); if (!s.load && s.open && s.frame) { state = 'ok'; break; } if (!s.open) { state = 'closed: ' + s.toast; break; } }
    const stuck = state === 'timeout' ? await page.evaluate(() => ({ back: (() => { const e = document.querySelector('#r-back'); if (!e) return 'none'; const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === e || e.contains(top) ? 'tappable' : 'COVERED by ' + (top?.className || top?.tagName); })() })) : null;
    rows.push({ title: b.title.slice(0, 22), fmt: b.format, kb: Math.round((b.size || 0) / 1024), ms: Date.now() - t0, state, stuck: stuck && stuck.back, newErrs: errs.slice(e0) });
    await page.evaluate(async () => { try { await (await import('./js/reader.js')).closeReader(); } catch {} const r = document.querySelector('#reader'); if (r) { r.hidden = true; r.replaceChildren(); } document.body.classList.remove('reading'); }); await sleep(400);
  }
  for (const r of rows) console.log((r.state === 'ok' ? 'OK   ' : 'STALL'), String(r.ms).padStart(6), 'ms', r.fmt, String(r.kb).padStart(6) + 'kB', JSON.stringify(r.title), r.state === 'ok' ? '' : r.state + ' back=' + r.stuck, r.newErrs.length ? 'ERR ' + r.newErrs.join(' | ').slice(0, 160) : '');
  console.log('page errors:', errs.length, errs.slice(0, 4)); console.log('console/network errors:', [...new Set(cons)].slice(0, 8));
  await browser.close();
})();

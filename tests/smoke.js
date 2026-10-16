// Quick smoke: load app, import fixtures, screenshot. Usage: NODE_PATH=/tmp/npm/node_modules node tests/smoke.js
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html';
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: '/tmp/s0.png' });
  const fx = path.join(__dirname, 'fixtures');
  const input = await page.$('#file-input');
  await input.uploadFile(...['frankenstein', 'saga-1', 'saga-2', 'saga-3', 'standalone'].map((n) => path.join(fx, n + '.epub')));
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: '/tmp/s1.png' });
  console.log(await page.evaluate(() => document.querySelector('#view').innerText.slice(0, 400)));
  console.log('errors:', errs);
  await browser.close();
})();

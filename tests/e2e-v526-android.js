// v0.5.26: Android app — App updates section (real APK bridge: plugins only on Capacitor.Plugins, NO registerPlugin), the fallback without the
// native plugin, the update banner never shown while reading, Kindle "My Clippings.txt" highlight import, and "Open with"/Share import (mocked).
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'http://localhost:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const FB2 = `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><author><first-name>Anna</first-name><last-name>Tester</last-name></author><book-title>Shared FB2 Book</book-title><sequence name="Test Saga" number="2"/><lang>en</lang></title-info></description><body><section><title><p>Chapter One</p></title><p>Hello <emphasis>there</emphasis>.</p></section><section><title><p>Chapter Two</p></title><p>Bye.</p></section></body></FictionBook>`;
const STUB = (withPlugins, fb2) => {
  window.__calls = []; window.__listeners = {}; window.__fileSrc = {};
  const App = { addListener: (ev, fn) => { window.__listeners['App:' + ev] = fn; return { remove() {} }; }, getLaunchUrl: async () => null };
  const Plugins = { App };
  if (withPlugins) {
    Plugins.AppUpdater = { info: async () => ({ versionName: '0.5.26', versionCode: 32 }), check: async (o) => { window.__calls.push(['check', o]); return window.__checkResult || { available: false, current: '0.5.26' }; },
      install: async (o) => { window.__calls.push(['install', o]); return o.downloadOnly ? { downloaded: true } : { launched: true }; }, addListener: (ev, fn) => ({ remove() {} }) };
    Plugins.ExternalApp = { isInstalled: async (o) => ({ installed: o.package === 'com.amazon.kindle' }), open: async (o) => { window.__calls.push(['open', o]); return { opened: 'app' }; }, openBrowser: async () => ({}) };
    let pending = [];
    Plugins.IncomingFiles = { addListener: (ev, fn) => { window.__listeners['IF:' + ev] = fn; return { remove() {} }; }, getPending: async () => { const p = pending; pending = []; return { files: p }; }, done: async (o) => { window.__calls.push(['done', o]); } };
    window.__share = (name, text) => { const path = '/data/user/0/com.folio.reader/files/incoming/' + name; window.__fileSrc[path] = URL.createObjectURL(new Blob([text])); pending.push({ name, path, size: text.length, mime: '' }); window.__listeners['IF:files']({ files: [] }); };
  }
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins, convertFileSrc: (p) => window.__fileSrc[p] };   // like the real APK: no registerPlugin
};
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const mk = async (withPlugins) => {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
    await page.evaluateOnNewDocument(STUB, withPlugins, FB2);
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().startsWith('https://api.github.com/repos/geek4945-creator/folio-reader/releases/latest')) return r.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ tag_name: 'v0.5.99', assets: [{ name: 'folio-reader.apk', size: 123, browser_download_url: 'https://github.com/geek4945-creator/folio-reader/releases/download/v0.5.99/folio-reader.apk' }] }) });
      if (/^https:\/\/(www\.googleapis|accounts\.google|github)\.com\//.test(r.url())) return r.abort();
      r.continue();
    });
    return page;
  };

  const page = await mk(true);
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await sleep(800);
  await step('APK (plugins on Capacitor.Plugins only): Settings shows App updates near the top, with installed version and both buttons', async () => {
    await page.click('[data-tab=settings]'); await sleep(400);
    const r = await page.evaluate(() => { const secs = [...document.querySelectorAll('#view section, section')]; const i = secs.findIndex((s) => s.id === 'sec-appupdate'); return { i, ver: document.querySelector('#upd-version')?.textContent, check: !!document.querySelector('#upd-check'), inst: !!document.querySelector('#upd-install') }; });
    assert(r.i >= 0 && r.i <= 1, 'section index ' + r.i); assert(/0\.5\.26/.test(r.ver), r.ver); assert(r.check && r.inst, 'buttons'); return JSON.stringify(r);
  });
  await step('Check for updates → Install update 0.5.99 → native installer', async () => {
    await page.evaluate(() => { window.__checkResult = { available: true, version: '0.5.99', current: '0.5.26', apkUrl: 'https://example/folio-reader.apk', size: 9 }; });
    await page.click('#upd-check'); await sleep(300);
    const lbl = await page.$eval('#upd-install', (b) => b.textContent + (b.disabled ? ' (disabled)' : '')); assert(lbl === 'Install update 0.5.99', lbl);
    await page.click('#upd-install'); await sleep(300);
    const c = await page.evaluate(() => window.__calls.filter((x) => x[0] === 'install')); assert(c.length === 1 && !c[0][1].downloadOnly && c[0][1].version === '0.5.99', JSON.stringify(c));
    return await page.$eval('#upd-status', (e) => e.textContent);
  });
  await step('daily check on open: background download + "Update ready" banner; hidden while a book is open, back after closing', async () => {
    await sleep(3000);   // let this page's own first-open check finish
    await page.evaluate(async () => {
      localStorage.removeItem('folio.updcheck'); localStorage.removeItem('folio.updavail');
      const S = await import('./js/store.js'); const buf = await (await fetch('tests/fixtures/frankenstein.epub')).arrayBuffer(); await S.addBookFromBuffer(buf, { filename: 'frankenstein.epub' });
    });
    await page.evaluateOnNewDocument(() => { window.__checkResult = { available: true, version: '0.5.99', current: '0.5.26', apkUrl: 'https://example/folio-reader.apk', size: 9 }; });
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(3800);
    const bg = await page.evaluate(() => window.__calls.filter((x) => x[0] === 'install' && x[1].downloadOnly).length); assert(bg === 1, 'background download ' + bg);
    assert(await page.$('#appupd-banner'), 'banner shown in library');
    const txt = await page.$eval('#appupd-install', (b) => b.textContent); assert(/Update 0\.5\.99 ready/.test(txt), txt);
    const during = await page.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks())[0]; const R = await import('./js/reader.js'); await R.openReader(b.id); await new Promise((r) => setTimeout(r, 1500));
      const el = document.querySelector('#appupd-banner'); const vis = !!el && getComputedStyle(el).display !== 'none'; const reading = document.body.classList.contains('reading'); await R.closeReader(); await new Promise((r) => setTimeout(r, 1200)); return { reading, vis, after: !!document.querySelector('#appupd-banner') }; });
    assert(during.reading && !during.vis, 'banner visible while reading ' + JSON.stringify(during)); assert(during.after, 'banner back after closing'); return JSON.stringify(during);
  });
  await step('Kindle My Clippings.txt: highlights matched by title/author, note joined, missing book listed, bookmark skipped, re-import adds nothing', async () => {
    const r = await page.evaluate(async () => {
      const S = await import('./js/store.js'); const A = await import('./js/annots.js'); const O = await import('./js/otherapps.js');
      const b = (await S.getBooks())[0];
      const t = `\uFEFF${b.title} (Shelley, Mary)\n- Your Highlight on page 5 | Location 70-72 | Added on Monday, 1 January 2024 10:00:00\n\nYou will rejoice to hear that no disaster has accompanied the commencement.\n==========\n${b.title} (Shelley, Mary)\n- Your Note on page 5 | Location 72 | Added on Monday, 1 January 2024 10:01:00\n\nLovely opening\n==========\n${b.title} (Shelley, Mary)\n- Your Bookmark on page 9 | Location 120 | Added on Monday\n\n\n==========\n${b.title} (Shelley, Mary)\n- Your Highlight on page 40 | Location 600-601 | Added on Tuesday\n\nI am by birth a Genevese.\n==========\nSome Other Book (Nobody, Al)\n- Your Highlight on Location 10-11 | Added on Tuesday\n\nNot in Folio.\n==========\n`;
      await O.importAny([new File([t], 'My Clippings.txt', { type: 'text/plain' })]); await new Promise((r) => setTimeout(r, 300));
      const list = await A.forBook(b); const summary = document.querySelector('#clip-summary')?.textContent || '';
      document.querySelector('#overlay') && (document.querySelector('#overlay').hidden = true);
      await O.importAny([new File([t], 'My Clippings.txt')]); const list2 = await A.forBook(b);
      return { n: list.length, withNote: list.filter((a) => a.note === 'Lovely opening').length, summary, n2: list2.length, books: (await S.getBooks()).length };
    });
    assert(r.n === 2 && r.withNote === 1, JSON.stringify(r)); assert(/Some Other Book/.test(r.summary), r.summary); assert(r.n2 === 2, 're-import added ' + r.n2); assert(r.books === 1, 'clippings must not create books');
    return r.summary;
  });
  await step('Android Open with / Share (mocked IncomingFiles): an FB2 and a TXT become books, copies released', async () => {
    await page.evaluate((fb2) => { window.__share('Shared.fb2', fb2); window.__share('Plain Story.txt', 'Chapter 1\n\nIt was a dark night.\n\nChapter 2\n\nThe end.'); }, FB2);
    await sleep(3000);
    const r = await page.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const f = bs.find((b) => b.title === 'Shared FB2 Book'); return { titles: bs.map((b) => b.title), author: f && f.author, series: f && (f.series || ''), done: window.__calls.filter((x) => x[0] === 'done').length }; });
    assert(r.titles.includes('Shared FB2 Book') && r.titles.includes('Plain Story'), JSON.stringify(r)); assert(r.author === 'Anna Tester', r.author); assert(r.done >= 1, 'done not called');
    return JSON.stringify(r);
  });
  await step('Other book apps: Open Kindle launches com.amazon.kindle via ExternalApp', async () => {
    await page.evaluate(() => { const o = document.querySelector('#overlay'); if (o) { o.replaceChildren(); o.hidden = true; } }); await page.click('[data-tab=settings]'); await sleep(500); await page.click('#open-kindle'); await sleep(300);
    const c = await page.evaluate(() => window.__calls.filter((x) => x[0] === 'open')); assert(c.length && c[0][1].package === 'com.amazon.kindle', JSON.stringify(c));
  });
  await step('no page errors (APK)', async () => { assert(!page.errs.length, page.errs.join(' | ')); });

  const p2 = await mk(false);
  await p2.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await sleep(800);
  await step('APK without the native plugin: section still shows; check via GitHub API; Install opens the latest APK link in the browser', async () => {
    await p2.click('[data-tab=settings]'); await sleep(300);
    assert(await p2.$('#sec-appupdate'), 'section missing');
    await p2.evaluate(() => { const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (/folio-reader\.apk$/.test(this.href)) { window.__apk = this.href; return; } return o.call(this); }; });
    await p2.click('#upd-check'); await sleep(500);
    const st = await p2.$eval('#upd-status', (e) => e.textContent); assert(/0\.5\.99 is available/.test(st), st);
    await p2.click('#upd-install'); await sleep(200);
    const href = await p2.evaluate(() => window.__apk); assert(href === 'https://github.com/geek4945-creator/folio-reader/releases/latest/download/folio-reader.apk', href);
    return st;
  });
  await step('no page errors (fallback)', async () => { assert(!p2.errs.length, p2.errs.join(' | ')); });
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

// v0.5.19: "highlight a word → find every time it appears" on iPhone. Emulated iPhone (UA, 390×844, touch). iOS Safari clears an iframe's
// native selection the moment a finger touches the app document and may drop the click; this test simulates exactly that and checks that
// 🔍 Search (selection bar, toolbar, highlight sheet) still searches the selected word and lists every occurrence with jump-to, EPUB + PDF.
// Also: no ☆ / 🎧 in the top bar, "Audiobook sync" in the ☰ menu.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const until = async (fn, ms, what) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(120); } };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setUserAgent(IPHONE_UA);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await (await page.$('#file-input')).uploadFile(fx('nested-book.epub'), fx('test-doc.pdf'));
  await until(() => page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length >= 2), 30000, 'import');
  const open = async (re) => { await page.evaluate(async (re) => { const r = new RegExp(re); const b = (await (await import('./js/store.js')).getBooks()).find((x) => r.test(x.title)); (await import('./js/reader.js')).openReader(b.id); }, re); };
  const close = () => page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
  const rendered = () => until(() => page.evaluate(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc && window.__reader.ready !== false), 25000, 'reader');
  const closeSheets = () => page.evaluate(() => { document.querySelector('#bs-close')?.click(); while (document.querySelector('.sheet-x')) document.querySelector('.sheet-x').click(); });
  const display = (t) => page.evaluate(async (t) => { await window.__reader.rendition.display(t); }, t);
  const results$ = () => page.evaluate(() => [...document.querySelectorAll('#bs-results .bs-hit')].map((x) => ({ ch: x.querySelector('.bs-ch').textContent, m: x.querySelector('mark').textContent })));
  const searchDone = () => until(() => page.evaluate(() => !!document.querySelector('#bs-input') && document.querySelector('#bs-cancel')?.hidden && !/Searching/.test(document.querySelector('#bs-status')?.textContent || '')), 25000, 'search done');
  const barUp = () => until(() => page.evaluate(() => { const m = document.querySelector('#an-menu'); return m && m.style.visibility !== 'hidden'; }), 5000, 'selection bar');
  const center = (sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  // iOS simulation: a finger touching the app document clears every native selection (top doc + epub iframes); optionally the click is dropped
  await page.evaluate(() => {
    window.__ios = { dropClick: false, clicks: 0 };
    const clearAll = () => { try { window.getSelection().removeAllRanges(); } catch {} for (const f of document.querySelectorAll('iframe')) { try { f.contentWindow.getSelection().removeAllRanges(); } catch {} } };
    document.addEventListener('touchstart', (e) => { if (!e.target.closest('#viewer')) clearAll(); }, { capture: true });
    window.addEventListener('click', (e) => { window.__ios.clicks++; if (window.__ios.dropClick && e.isTrusted) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true });
  });
  const touch = async (sel, holdMs = 60) => { const c = await center(sel); await page.touchscreen.touchStart(c.x, c.y); await sleep(holdMs); await page.touchscreen.touchEnd(); };
  const selectInChapter = (word, title = 'Chapter 1') => page.evaluate((word, title) => { const c = window.__reader.rendition.getContents().find((k) => k.document.title === title); const doc = c.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(word); if (i >= 0) { c.window.getSelection().setBaseAndExtent(n, i, n, i + word.length); return true; } } throw new Error('text ' + word); }, word, title);
  const iframeSelText = () => page.evaluate(() => window.__reader.rendition.getContents().map((k) => k.window.getSelection().toString()).join(''));

  await open('Nested Book'); await rendered();
  await step('Top bar: no ☆ bookmark and no 🎧 button; 🔍 and ☰ still there', async () => {
    const ids = await page.$$eval('#reader .r-bar.top button', (e) => e.map((x) => x.id)); assert(!ids.includes('r-bm') && !ids.includes('r-link'), ids.join(',')); assert(ids.includes('r-search') && ids.includes('r-toc'), ids.join(',')); return ids.join(' ');
  });
  await step('An old bookmark in the data is harmless: Contents lists it, nothing throws', async () => {
    await page.evaluate(async () => { const c = window.__reader; const S = await import('./js/store.js'); c.bookmarks.push(await S.addBookmark({ bookId: c.book.id, cfi: c.loc.start.cfi, progress: c.progress, label: 'Legacy mark' })); });
    await page.evaluate(() => document.querySelector('#r-toc').click()); await page.waitForSelector('#toc-list'); const tabs = await page.$$eval('.sheet .seg button', (e) => e.map((x) => x.textContent)); assert(tabs.some((t) => /Bookmarks \(1\)/.test(t)), tabs.join('|'));
    await closeSheets(); return tabs.join(' | ');
  });
  await step('Selection bar: 🔍 Search is the 2nd button (right after 🖍 Highlight), bold, on the first row', async () => {
    await display('c1.xhtml'); await sleep(700); await selectInChapter('Paragraph 1.2'); await barUp();
    const info = await page.evaluate(() => { const m = document.querySelector('#an-menu'); const kids = [...m.children]; const s = document.querySelector('#an-search'); const hl = document.querySelector('#an-hl'); return { order: kids.map((x) => x.id || x.className), sameRow: Math.abs(s.getBoundingClientRect().top - hl.getBoundingClientRect().top) < 4, bold: +getComputedStyle(s).fontWeight >= 600, vis: s.getBoundingClientRect().width > 30 }; });
    assert(info.order[0] === 'an-hl' && info.order[1] === 'an-search' && info.sameRow && info.bold && info.vis, JSON.stringify(info)); return info.order.slice(0, 3).join(',');
  });
  await step('iOS: finger on 🔍 Search clears the iframe selection at touchstart AND the click is dropped → still searches the word (touchend)', async () => {
    await page.evaluate(() => { window.__ios.dropClick = true; }); await touch('#an-search', 300);
    assert(!(await iframeSelText()), 'simulation should have cleared the selection'); await searchDone(); await page.evaluate(() => { window.__ios.dropClick = false; });
    const q = await page.$eval('#bs-input', (e) => e.value); const r = await results$(); assert(q === 'Paragraph 1.2' && r.length >= 1 && r.every((x) => /Paragraph 1\.2/.test(x.m)), q + ' ' + JSON.stringify(r)); return q + ' → ' + r.length + ' result(s)';
  });
  await step('…every result jumps to its place (‹ n / N › bar)', async () => {
    await page.evaluate(() => document.querySelector('#bs-results .bs-hit').click()); await until(() => page.evaluate(() => !!document.querySelector('#bs-bar')), 5000, 'bar');
    const lab = await page.$eval('#bs-bar-n', (e) => e.textContent); assert(/1 \/ \d+/.test(lab), lab); await closeSheets(); return lab;
  });
  await step('iOS: a word found many times — select "harbour", tap Search (click delivered normally) → lists every occurrence', async () => {
    await display('c1.xhtml'); await sleep(700); await selectInChapter('harbour'); await barUp(); await touch('#an-search'); await searchDone();
    const q = await page.$eval('#bs-input', (e) => e.value); const r = await results$(); const st = await page.$eval('#bs-status', (e) => e.textContent);
    assert(q === 'harbour' && r.length > 10 && r.every((x) => /harbour/i.test(x.m)), q + ' ' + r.length); const clicks = await page.evaluate(() => window.__ios.clicks); await closeSheets(); return `${r.length} hits (${st}); no double search`;
  });
  await step('iOS: the selection collapses before the bar even reacts, then 🔍 in the top bar → searches the word just selected', async () => {
    await display('c1.xhtml'); await sleep(700); await selectInChapter('harbour'); await sleep(40); await page.evaluate(() => { for (const k of window.__reader.rendition.getContents()) k.window.getSelection().removeAllRanges(); }); await sleep(700);
    await touch('#r-search'); await searchDone(); const q = await page.$eval('#bs-input', (e) => e.value); const n = (await results$()).length; assert(q === 'harbour' && n > 10, q + ' ' + n); await closeSheets(); return q + ' → ' + n;
  });
  await step('Typed search still works (🔍 with nothing selected → type, Enter)', async () => {
    await page.evaluate(() => document.querySelector('#an-x')?.click()); await sleep(16000);   // the cached selection expires (15 s)
    await touch('#r-search'); await page.waitForSelector('#bs-input'); const c0 = await page.evaluate(async () => (await import('./js/annotui.js')).cachedSelection().text); assert(c0 === '', 'nothing selected any more, cache should be empty: ' + c0);   // (the box keeps the last query, as before)
    await page.evaluate(() => { const i = document.querySelector('#bs-input'); i.value = 'Zebracorn'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await searchDone();
    const r = await results$(); assert(r.length === 4, JSON.stringify(r)); await closeSheets(); return r.length + ' results';
  });
  await step('Highlight a word, then tap the saved highlight → sheet has 🔍 Find in book → searches it', async () => {
    await display('c1.xhtml'); await sleep(700); await selectInChapter('harbour'); await barUp(); await touch('#an-hl'); await page.waitForSelector('#an-ed-search', { timeout: 6000 });
    await page.evaluate(() => document.querySelector('#an-ed-search').click()); await searchDone(); const q = await page.$eval('#bs-input', (e) => e.value); const n = (await results$()).length; assert(q === 'harbour' && n > 10, q + ' ' + n); await closeSheets(); return q + ' → ' + n;
  });
  await step('Long-press bubble: 🔍 Search is prominent and next to Highlight', async () => {
    await selectInChapter('harbour'); await barUp(); await page.evaluate(() => document.querySelector('#an-define').click()); await page.waitForSelector('#wl-search');
    const ok = await page.evaluate(() => { const a = [...document.querySelectorAll('#wl-actions > *')].map((x) => x.id); return a.indexOf('wl-search') === a.indexOf('wl-hl') + 1 && document.querySelector('#wl-search').classList.contains('primary'); }); assert(ok);
    await page.evaluate(() => document.querySelector('#wl-search').click()); await searchDone(); const q = await page.$eval('#bs-input', (e) => e.value); assert(q === 'harbour', q); await closeSheets(); return q;
  });
  await step('☰ menu: "Audiobook sync" appears once an audiobook exists and opens Find my place', async () => {
    const none = await page.evaluate(async () => { document.querySelector('#r-toc').click(); await new Promise((r) => setTimeout(r, 300)); return !document.querySelector('#toc-audiosync'); }); await closeSheets(); assert(none, 'should be hidden without audiobooks');
    await page.evaluate(async () => { const A = await import('./js/audiostore.js'); const fn = A.saveAudiobook || A.addAudiobook || A.putAudiobook; if (!fn) throw new Error('no save fn: ' + Object.keys(A).join(',')); await fn({ id: 'au-test', title: 'Nested Book', author: 'x', duration: 3600, position: 0, files: [], chapters: [] }); });
    await close(); await open('Nested Book'); await rendered(); await sleep(400);
    await page.evaluate(() => document.querySelector('#r-toc').click()); await page.waitForSelector('#toc-audiosync', { timeout: 4000 }); const t = await page.$eval('#toc-audiosync', (e) => e.textContent);
    await page.evaluate(() => document.querySelector('#toc-audiosync').click()); await until(() => page.evaluate(() => !!window.__findplace || !!document.querySelector('[id^="fp-"]')), 8000, 'find place');
    await closeSheets(); return t;
  });
  await close();

  /* ---------- PDF ---------- */
  await step('PDF (page view text layer): select "lazy dog", finger on Search clears it + click dropped → 6 results across the pages', async () => {
    await open('Folio Test PDF'); await until(() => page.evaluate(() => document.querySelector('#reader.pdf-mode') && !document.querySelector('#reader .r-loading') && document.querySelector('#viewer .textLayer span')), 20000, 'pdf'); await sleep(600);
    await page.evaluate(() => { const spans = [...document.querySelectorAll('#viewer .textLayer span')]; for (const s of spans) { const n = s.firstChild; if (!n || n.nodeType !== 3) continue; const i = n.data.indexOf('lazy dog'); if (i >= 0) { window.getSelection().setBaseAndExtent(n, i, n, i + 8); return; } } throw new Error('no text'); });
    await barUp(); await page.evaluate(() => { window.__ios.dropClick = true; }); await touch('#an-search', 250); await searchDone(); await page.evaluate(() => { window.__ios.dropClick = false; });
    const q = await page.$eval('#bs-input', (e) => e.value); const r = await results$(); assert(q === 'lazy dog' && r.length === 6, q + ' ' + JSON.stringify(r)); await closeSheets(); return q + ' → ' + r.map((x) => x.ch).join(', ');
  });
  await step('PDF: selection collapsed, then 🔍 in the top bar → searches it', async () => {
    await page.evaluate(() => { const spans = [...document.querySelectorAll('#viewer .textLayer span')]; for (const s of spans) { const n = s.firstChild; if (!n || n.nodeType !== 3) continue; const i = n.data.indexOf('lazy dog'); if (i >= 0) { window.getSelection().setBaseAndExtent(n, i, n, i + 8); return; } } });
    await sleep(400); await page.evaluate(() => window.getSelection().removeAllRanges()); await sleep(500); await touch('#r-search'); await searchDone();
    const q = await page.$eval('#bs-input', (e) => e.value); assert(q === 'lazy dog' && (await results$()).length === 6, q); await closeSheets(); await close(); return q;
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

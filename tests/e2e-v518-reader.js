// v0.5.18 reader: Contents opens at (and marks) the current chapter — nested EPUB TOC, MOBI/KF8, PDF outline — and "Search inside the book"
// (EPUB incl. matches across markup + accents, MOBI/KF8, PDF page text layer + Text view): async with progress + Cancel, snippet + chapter,
// jump + temporary highlight, ‹ n / N › bar, Search in the selection bar and in the long-press word bubble.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const until = async (fn, ms, what) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(120); } };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await (await page.$('#file-input')).uploadFile(fx('nested-book.epub'), fx('test-doc.pdf'), fx('frankenstein.epub'), fx('outline-24pp.pdf'));
  await until(() => page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length >= 4), 30000, 'import');
  await (await page.$('#file-input')).uploadFile(fx('saga-kf8.azw3'));
  await until(() => page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length >= 5), 30000, 'import kf8');
  const open = async (re) => { await page.evaluate(async (re) => { const r = new RegExp(re); const b = (await (await import('./js/store.js')).getBooks()).find((x) => r.test(x.title) || r.test(x.format || '') || r.test(x.origFormat || '')); (await import('./js/reader.js')).openReader(b.id); }, re); };
  const close = () => page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
  const rendered = () => until(() => page.evaluate(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc && window.__reader.ready !== false), 25000, 'reader');
  const click = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click(); }, sel);
  const tocState = () => page.evaluate(() => { const items = [...document.querySelectorAll('#toc-list .toc-item')]; const cur = document.querySelector('#toc-list .toc-item.current'); const sb = cur?.closest('.sheet-body');
    let vis = false; if (cur && sb) { const r = cur.getBoundingClientRect(), s = sb.getBoundingClientRect(); vis = r.top >= s.top - 1 && r.bottom <= s.bottom + 1; }
    return { n: items.length, cur: cur ? cur.textContent.replace('Current', '').trim() : null, aria: cur?.getAttribute('aria-current'), parents: [...document.querySelectorAll('#toc-list .toc-item.current-parent')].map((x) => x.textContent.trim()), vis, scrolled: sb ? sb.scrollTop : -1 }; });
  const closeSheets = () => page.evaluate(() => { while (document.querySelector('.sheet-x')) document.querySelector('.sheet-x').click(); });
  const display = (target) => page.evaluate(async (t) => { await window.__reader.rendition.display(t); }, target);
  const flashText = () => page.evaluate(() => { const out = []; for (const w of [window, ...(window.__reader?.rendition ? window.__reader.rendition.getContents().map((k) => k.window) : [])]) { const h = w.CSS && w.CSS.highlights && w.CSS.highlights.get('folio-search'); if (h) for (const r of h) out.push(r.toString()); } return out.join('|'); });
  const onScreen = () => page.evaluate(() => { for (const k of window.__reader.rendition.getContents()) { const hl = k.window.CSS.highlights.get('folio-search'); if (!hl) continue; const r = [...hl][0].getBoundingClientRect(); const f = k.window.frameElement.getBoundingClientRect(); const y = r.top + f.top, x = r.left + f.left; return { title: k.document.title, y: Math.round(y), on: y > 0 && y < innerHeight && x >= 0 && x < innerWidth }; } return null; });
  const results$ = () => page.evaluate(() => [...document.querySelectorAll('#bs-results .bs-hit')].map((x) => ({ ch: x.querySelector('.bs-ch').textContent, snip: x.querySelector('.bs-snip').textContent, m: x.querySelector('mark').textContent })));
  const searchFor = async (q) => { await page.evaluate((q) => { const i = document.querySelector('#bs-input'); i.value = q; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, q); await until(() => page.evaluate(() => { const s = document.querySelector('#bs-status')?.textContent || ''; return !/Searching/.test(s) && document.querySelector('#bs-cancel')?.hidden; }), 30000, 'search done'); };

  /* ---------- Contents: current chapter ---------- */
  await open('Nested Book'); await rendered();
  await step('EPUB (nested TOC): Contents marks the current chapter (Chapter 1) and its parent Part One', async () => {
    await display('c1.xhtml'); await sleep(600); await click('#r-toc'); await page.waitForSelector('#toc-list');
    const s = await tocState(); assert(s.cur === 'Chapter 1' && s.aria === 'true', JSON.stringify(s)); assert(s.parents.includes('Part One'), JSON.stringify(s)); await closeSheets(); return JSON.stringify(s);
  });
  await step('EPUB nested anchors: inside Section 2.2 (same file as Chapter 2) the deepest entry Section 2.2 is current, Chapter 2 and Part One are parents', async () => {
    await display('c2.xhtml'); await sleep(700);   // then scroll like a reader would until "Section 2.2" sits just above the top of the screen
    for (let k = 0; k < 4; k++) { await page.evaluate(() => { const c = window.__reader; const m = c.rendition.manager; const kk = c.rendition.getContents().find((x) => x.document.title === 'Chapter 2'); const f = kk.window.frameElement.getBoundingClientRect(); const y = kk.document.getElementById('s2').getBoundingClientRect().top + f.top; m.container.scrollTop += y - m.container.getBoundingClientRect().top - 60; }); await sleep(400); }
    await sleep(900); await click('#r-toc'); await page.waitForSelector('#toc-list'); const s = await tocState();
    assert(s.cur === 'Section 2.2', JSON.stringify(s)); assert(s.parents.includes('Chapter 2') && s.parents.includes('Part One'), JSON.stringify(s)); await closeSheets(); return s.cur;
  });
  await closeSheets();
  await step('EPUB: deep in the book (Chapter 28) the list opens scrolled so the current entry is visible', async () => {
    await click('#r-toc'); await page.waitForSelector('#toc-list'); await page.evaluate(() => [...document.querySelectorAll('#toc-list .toc-item')].find((b) => /^Chapter 28/.test(b.textContent)).click()); await sleep(1500);
    await click('#r-toc'); await page.waitForSelector('#toc-list'); await sleep(300);
    const s = await tocState(); assert(s.cur === 'Chapter 28' && s.parents.includes('Part Two'), JSON.stringify(s)); assert(s.vis && s.scrolled > 100, 'not scrolled into view ' + JSON.stringify(s)); await closeSheets(); return 'scrollTop ' + s.scrolled;
  });

  /* ---------- Search (EPUB) ---------- */
  await step('EPUB search: 🔍 in the toolbar; all 4 "zebracorn" across the book (one split by <b>…</b>), each with chapter + snippet', async () => {
    await display('p1.xhtml'); await sleep(500); await click('#r-search'); await page.waitForSelector('#bs-input'); await searchFor('Zebracorn');
    const r = await results$(); assert(r.length === 4, JSON.stringify(r)); assert(r.every((x) => /zebracorn/i.test(x.m)), JSON.stringify(r));
    assert(r[0].ch === 'Chapter 1' && r[2].ch === 'Section 2.2' && r[3].ch === 'Chapter 29', r.map((x) => x.ch).join('|')); assert(/near the harbour/.test(r[0].snip), r[0].snip);
    const st = await page.$eval('#bs-status', (e) => e.textContent); assert(/4 results/.test(st), st); return r.map((x) => x.ch + ': ' + x.snip.slice(0, 30)).join(' | ');
  });
  await step('Tap a result → jumps there and highlights the match temporarily; ‹ n / N › bar steps through results', async () => {
    await page.evaluate(() => document.querySelectorAll('#bs-results .bs-hit')[3].click()); await until(() => page.evaluate(() => !!document.querySelector('#bs-bar')), 5000, 'bar');
    await until(async () => /zebracorn/i.test(await flashText()), 6000, 'flash'); await sleep(1200); let loc = await onScreen(); assert(loc.on && /Chapter 29/.test(loc.title), JSON.stringify(loc));
    let lab = await page.$eval('#bs-bar-n', (e) => e.textContent); assert(/4 \/ 4/.test(lab), lab);
    await click('#bs-next'); await sleep(900); lab = await page.$eval('#bs-bar-n', (e) => e.textContent); assert(/1 \/ 4/.test(lab), 'wrap ' + lab);
    await until(async () => /zebra/i.test(await flashText()), 6000, 'flash 1'); await sleep(1100); loc = await onScreen(); assert(loc.on && loc.title === 'Chapter 1', JSON.stringify(loc));
    assert((await flashText()).replace(/\s/g, '') === 'zebracorn', 'cross-markup flash ' + await flashText());
    await click('#bs-prev'); await sleep(900); lab = await page.$eval('#bs-bar-n', (e) => e.textContent); assert(/4 \/ 4/.test(lab), lab);
    await sleep(4300); assert(!(await flashText()), 'highlight should be temporary'); return lab;
  });
  await step('Accent / case-insensitive: "unicode cafe" finds "Ünïcode café"; tapping the bar label reopens the list', async () => {
    await click('#bs-bar-n'); await page.waitForSelector('#bs-input'); await searchFor('unicode cafe'); const r = await results$(); assert(r.length === 1 && r[0].m === 'Ünïcode café' && r[0].ch === 'Chapter 3', JSON.stringify(r)); await closeSheets(); return r[0].snip;
  });
  await step('Selection bar has 🔍 Search (right after the highlight colours) → searches the selected words', async () => {
    await page.evaluate(() => document.querySelector('#bs-close') && document.querySelector('#bs-close').click()); await display('c1.xhtml'); await sleep(700);
    await page.evaluate(() => { const c = window.__reader.rendition.getContents().find((k) => k.document.title === 'Chapter 1'); const doc = c.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('Paragraph 1.2'); if (i >= 0) { c.window.getSelection().setBaseAndExtent(n, i, n, i + 13); return; } } throw new Error('text'); });
    await until(() => page.evaluate(() => { const m = document.querySelector('#an-menu'); return m && m.style.visibility !== 'hidden'; }), 5000, 'selection bar');
    const order = await page.$$eval('#an-menu > *', (e) => e.map((x) => x.id || x.className)); const iS = order.indexOf('an-search'); assert(iS > 0 && order[iS - 1].includes('an-dot') && order[iS + 1] === 'an-note', order.join(','));
    await click('#an-search'); await page.waitForSelector('#bs-input'); await until(() => page.evaluate(() => document.querySelector('#bs-cancel')?.hidden && !/Searching/.test(document.querySelector('#bs-status').textContent)), 20000, 'done');
    const q = await page.$eval('#bs-input', (e) => e.value); const r = await results$(); assert(q === 'Paragraph 1.2' && r.length >= 1 && r.every((x) => /Paragraph 1\.2/i.test(x.m)), q + ' ' + JSON.stringify(r)); await closeSheets(); return q + ' → ' + r.length;
  });
  await step('Long-press word bubble has 🔍 Search → searches that word', async () => {
    const viaReader = await page.evaluate(async () => { const c = window.__reader; const k = c.rendition.getContents().find((x) => x.document.title === 'Chapter 1'); const doc = k.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('harbour'); if (i >= 0) { const r = doc.createRange(); r.setStart(n, i); r.setEnd(n, i + 7); k.window.getSelection().setBaseAndExtent(n, i, n, i + 7); return true; } } return false; });
    assert(viaReader); await until(() => page.evaluate(() => !!document.querySelector('#an-define')), 5000, 'menu'); await click('#an-define'); await page.waitForSelector('#wl-bubble'); await page.waitForSelector('#wl-search', { timeout: 5000 });
    const acts = await page.$$eval('#wl-actions > *', (e) => e.map((x) => x.id)); assert(acts.indexOf('wl-search') === acts.indexOf('wl-hl') + 1, acts.join(','));
    await click('#wl-search'); await page.waitForSelector('#bs-input'); await until(() => page.evaluate(() => document.querySelector('#bs-cancel')?.hidden && !/Searching/.test(document.querySelector('#bs-status').textContent)), 20000, 'done');
    const q = await page.$eval('#bs-input', (e) => e.value); const n = (await results$()).length; assert(q === 'harbour' && n > 10, q + ' ' + n); await closeSheets(); return q + ' → ' + n + ' results';
  });
  await step('Paginated flow: Contents marks the chapter on screen (Chapter 5)', async () => {
    await close(); await page.evaluate(async () => (await import('./js/settings.js')).settings.set({ flow: 'paginated' })); await open('Nested Book'); await rendered();
    await display('c5.xhtml'); await sleep(800); await click('#r-toc'); await page.waitForSelector('#toc-list'); const s = await tocState(); await closeSheets();
    await page.evaluate(async () => (await import('./js/settings.js')).settings.set({ flow: 'scrolled' })); assert(s.cur === 'Chapter 5', JSON.stringify(s)); return s.cur;
  });
  await close();

  await step('Big book: the search is incremental (progress shown, results arrive while it runs) and Cancel stops it', async () => {
    await open('Frankenstein'); await rendered(); await click('#r-search'); await page.waitForSelector('#bs-input');
    await page.evaluate(async () => { const M = await import('./js/booksearch.js'); const ad = window.__reader.__search; const orig = ad.scan; ad.scan = async (i, q) => { await new Promise((r) => setTimeout(r, 150)); return orig(i, q); }; });
    await page.evaluate(() => { const i = document.querySelector('#bs-input'); i.value = 'the'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await until(() => page.evaluate(() => /Searching… \d+%/.test(document.querySelector('#bs-status').textContent) && document.querySelectorAll('#bs-results .bs-hit').length > 0), 15000, 'progress');
    const mid = await page.evaluate(() => ({ s: document.querySelector('#bs-status').textContent, n: document.querySelectorAll('#bs-results .bs-hit').length, cancel: !document.querySelector('#bs-cancel').hidden }));
    assert(mid.cancel, JSON.stringify(mid)); await click('#bs-cancel'); await sleep(800);
    const after = await page.evaluate(() => ({ s: document.querySelector('#bs-status').textContent, n: document.querySelectorAll('#bs-results .bs-hit').length })); await sleep(800);
    const later = await page.evaluate(() => document.querySelectorAll('#bs-results .bs-hit').length); assert(/cancelled/i.test(after.s) && later === after.n && after.n < 2000, JSON.stringify([mid, after, later]));
    await closeSheets(); await close(); return mid.s + ' → ' + after.s;
  });

  /* ---------- MOBI / KF8 ---------- */
  await step('MOBI/KF8 (azw3): Contents marks the current chapter; search finds text and jumps with a highlight', async () => {
    await open('azw3|kf8|Kindle'); await rendered();
    const word = await page.evaluate(async () => { const c = window.__reader; const last = c.epub.spine.spineItems.length - 1; await c.rendition.display(c.epub.spine.get(last).href); await new Promise((r) => setTimeout(r, 800)); const t = c.rendition.getContents()[0].document.body.textContent; const m = t.match(/[A-Za-z]{6,}/g) || []; return m[m.length - 1]; });
    await click('#r-toc'); await page.waitForSelector('#toc-list, .toc-item, .list'); const s = await tocState(); assert(s.n > 0 ? !!s.cur : true, JSON.stringify(s)); await closeSheets();
    await click('#r-search'); await page.waitForSelector('#bs-input'); await searchFor(word); const r = await results$(); assert(r.length >= 1, word + ' ' + JSON.stringify(r));
    await page.evaluate(() => document.querySelector('#bs-results .bs-hit').click()); await until(async () => (await flashText()).toLowerCase() === word.toLowerCase(), 8000, 'flash ' + word);
    await page.evaluate(() => document.querySelector('#bs-close')?.click()); await close(); return 'toc current=' + s.cur + ', "' + word + '" ×' + r.length;
  });

  /* ---------- PDF ---------- */
  const pdfOpen = async (re) => { await open(re); await until(() => page.evaluate(() => document.querySelector('#reader.pdf-mode') && !document.querySelector('#reader .r-loading')), 20000, 'pdf'); await sleep(500); };
  const pdfGo = async (n) => { await page.evaluate(async (n) => { const el = document.querySelector('#pdf-page-num'); el.value = n; el.dispatchEvent(new Event('change', { bubbles: true })); }, n); await until(() => page.evaluate(async (n) => (await import('./js/pdfreader.js')).pdfCurrent().page === n, n), 5000, 'page ' + n); await sleep(500); };
  await step('PDF nested outline: page 4 → "Section 2.1" current with Chapter 2 + Part A as parents; page 20 → "Chapter 16" current and scrolled into view', async () => {
    await pdfOpen('Outline Test PDF'); await until(() => page.evaluate(() => !document.querySelector('#r-toc').hidden), 8000, 'outline button');
    await pdfGo(4); await click('#r-toc'); await page.waitForSelector('#toc-list'); await sleep(500); let s = await tocState();
    assert(s.n === 23 && s.cur === 'Section 2.1' && s.parents.join() === 'Part A,Chapter 2', JSON.stringify(s)); await closeSheets();
    await pdfGo(20); await click('#r-toc'); await page.waitForSelector('#toc-list'); await sleep(500); s = await tocState();
    assert(s.cur === 'Chapter 16' && s.parents.join() === 'Part B' && s.vis && s.scrolled > 100, JSON.stringify(s)); await closeSheets(); await close(); return 'scrollTop ' + s.scrolled;
  });
  await step('PDF search setup', async () => { await pdfOpen('Folio Test PDF'); });
  await step('PDF search (page view, text layer): finds "lazy dog" on all 6 pages with page labels; tapping jumps + highlights in the text layer', async () => {
    await click('#r-search'); await page.waitForSelector('#bs-input'); await searchFor('lazy dog'); const r = await results$();
    assert(r.length === 6 && /Page 1$/.test(r[0].ch) && /Page 6$/.test(r[5].ch), JSON.stringify(r)); await page.evaluate(() => document.querySelectorAll('#bs-results .bs-hit')[4].click());
    await until(async () => /lazy\s*dog/i.test(await flashText()), 10000, 'pdf flash'); const pg = await page.evaluate(() => document.querySelector('#pdf-page-num').value); assert(+pg === 5, 'page ' + pg);
    await click('#bs-next'); await until(async () => +(await page.evaluate(() => document.querySelector('#pdf-page-num').value)) === 6, 8000, 'next page'); return r[4].ch;
  });
  await step('PDF Text view: search + jump highlight inside the reflowed text', async () => {
    await page.evaluate(() => document.querySelector('#bs-close')?.click()); await page.evaluate(async () => (await import('./js/pdfreader.js')).setTextMode(true)); await until(() => page.evaluate(() => document.querySelectorAll('.pdf-tpage[data-filled]').length >= 1), 15000, 'text view');
    await click('#r-search'); await page.waitForSelector('#bs-input'); await searchFor('Page 3 of 6'); const r = await results$(); assert(r.length === 1 && /Page 3$/.test(r[0].ch), JSON.stringify(r));
    await page.evaluate(() => document.querySelector('#bs-results .bs-hit').click()); await until(async () => /Page\s*3\s*of\s*6/.test(await flashText()), 10000, 'text-view flash');
    const inText = await page.evaluate(() => { const h = CSS.highlights.get('folio-search'); return h && [...h][0].startContainer.parentElement.closest('.pdf-tpage')?.dataset.page; }); assert(inText === '3', inText);
    await page.evaluate(async () => (await import('./js/pdfreader.js')).setTextMode(false)); await close(); return 'page ' + inText;
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

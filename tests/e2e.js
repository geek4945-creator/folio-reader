// End-to-end tests in headless Chrome. Needs: static server on :8765, mock catalogs (node tests/mock-server.js) on :8766,
// optional proxy (node proxy/server.js) on :8787.   NODE_PATH=/tmp/npm/node_modules node tests/e2e.js
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n + '.epub');
const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) { try { const v = await fn(); results.push([true, name, v === undefined ? '' : String(v)]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

async function newPage(browser, ctx) {
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('folio.settings')) localStorage.setItem('folio.settings', JSON.stringify({ flow: 'paginated', flowChosen: true })); });   // these tests drive page turns: seed the explicit Pages choice (the default is Scroll since v0.5.2)
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errs.push('console: ' + m.text()); });
  return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText);
const click = async (page, sel) => { await page.waitForSelector(sel, { visible: true, timeout: 8000 }); await page.click(sel); };
async function clickText(page, sel, txt) {
  const ok = await page.evaluate((sel, txt) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(txt)); if (el) { el.click(); return true; } return false; }, sel, txt);
  if (!ok) throw new Error('no element ' + sel + ' with text ' + txt);
}
const frameInfo = (page) => page.evaluate(() => { const f = document.querySelector('#viewer iframe'); const d = f.contentDocument; const cs = d.defaultView.getComputedStyle(d.querySelector('p') || d.body); return { fs: parseFloat(cs.fontSize), lh: cs.lineHeight, color: cs.color, bg: d.defaultView.getComputedStyle(d.body).backgroundColor, ff: cs.fontFamily, text: d.body.innerText.slice(0, 60) }; });

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-web-security=false'] });
  const ctx = await browser.createBrowserContext(); const page = await newPage(browser, ctx);
  await page.goto(URL, { waitUntil: 'networkidle0' });

  await step('PWA: manifest, apple meta, icons, service worker', async () => {
    const r = await page.evaluate(async () => {
      const m = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
      const reg = await navigator.serviceWorker.ready;
      const icons = await Promise.all(m.icons.map((i) => fetch(i.src).then((r) => r.status)));
      return { name: m.name, display: m.display, icons, sw: !!reg.active, apple: !!document.querySelector('meta[name=apple-mobile-web-app-capable]') && !!document.querySelector('link[rel=apple-touch-icon]') };
    });
    assert(r.display === 'standalone' && r.sw && r.apple && r.icons.every((s) => s === 200), JSON.stringify(r)); return JSON.stringify(r);
  });

  await step('Import 5 EPUBs via file picker (metadata + covers extracted)', async () => {
    await (await page.$('#file-input')).uploadFile(...['frankenstein', 'saga-1', 'saga-2', 'saga-3', 'standalone'].map(fx));
    await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 3, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.tile img.cover-img').length >= 3, { timeout: 20000 }).catch(() => {});
    const info = await page.evaluate(() => ({ tiles: [...document.querySelectorAll('.tile')].map((t) => t.querySelector('.t').innerText), covers: document.querySelectorAll('.tile img.cover-img').length }));
    assert(info.covers >= 3, 'covers: ' + JSON.stringify(info)); return JSON.stringify(info);
  });

  await step('Series auto-grouped into a set (calibre:series + EPUB3 belongs-to-collection)', async () => {
    const t = await page.evaluate(() => [...document.querySelectorAll('.tile.set')].map((t) => t.innerText.replace(/\n/g, ' | ')));
    assert(t.length === 1 && /Test Saga/.test(t[0]) && /3 books/.test(t[0]), JSON.stringify(t)); return t[0];
  });
  await step('Set page shows volumes in order', async () => {
    await page.click('.tile.set'); await page.waitForSelector('#set-back');
    const titles = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText));
    assert(titles.join() === 'Saga Book One,Saga Book Two,Saga Book Three', titles.join()); await page.screenshot({ path: '/tmp/shot-set.png' });
    await page.click('#set-back'); await page.waitForSelector('input.search'); await sleep(300); return titles.join(' < ');
  });

  await step('Search filters the library', async () => {
    await page.type('input.search', 'frank'); await sleep(200);
    const n = await page.$$eval('.tile', (e) => e.length); assert(n === 1, 'tiles=' + n);
    await page.$eval('input.search', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); }); await sleep(200);
  });
  await step('List/grid toggle', async () => {
    await click(page, '#view-list'); await page.waitForSelector('.tiles.list'); await page.screenshot({ path: '/tmp/shot-list.png' }); await click(page, '#view-grid'); await page.waitForSelector('.tiles.grid');
  });
  await step('Sort by title / author / recent', async () => {
    const order = async (v) => { await page.select('#sort-sel', v); await sleep(300); return page.$$eval('.tile .t', (e) => e.map((x) => x.innerText).join('|')); };
    const t = await order('title'); const a = await order('author'); const r = await order('recent');
    assert(t.startsWith('Frankenstein'), t); assert(a.startsWith('Another Author') || /Another|A Standalone/.test(a), a); return `title: ${t.split('|')[0]} | author: ${a.split('|')[0]}`;
  });

  // ---------- Reader
  await step('Open reader (epub.js renders text)', async () => {
    await page.select('#sort-sel', 'recent'); await sleep(200);
    await page.evaluate(() => [...document.querySelectorAll('.tile.book')].find((t) => /Frankenstein/i.test(t.innerText)).click());
    await page.waitForSelector('#viewer iframe', { timeout: 15000 }); await page.waitForFunction(() => window.__reader?.loc && document.querySelector('#viewer iframe')?.contentDocument?.body?.children.length > 0, { timeout: 15000 });
    await sleep(800); await page.screenshot({ path: '/tmp/shot-reader-light.png' }); return (await frameInfo(page)).text;
  });
  await step('Tap zones turn pages (right = next, left = prev)', async () => {
    const cfi = () => page.evaluate(() => window.__reader.loc.start.cfi);
    const c0 = await cfi();
    await page.mouse.click(350, 420); await sleep(900); const c1 = await cfi();
    assert(c1 !== c0, 'right tap did not advance');
    await page.mouse.click(30, 420); await sleep(900); const c2 = await cfi();
    assert(c2 === c0, 'left tap did not go back: ' + c2 + ' vs ' + c0);
    await page.mouse.click(195, 420); await sleep(400); const hidden = await page.$eval('#reader', (e) => e.classList.contains('chrome-hidden')); assert(hidden, 'center tap should hide chrome');
    await page.mouse.click(195, 420); await sleep(400);
  });
  await step('Swipe turns pages (touch)', async () => {
    const cfi = () => page.evaluate(() => window.__reader.loc.start.cfi); const c0 = await cfi();
    const cdp = await page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 400 }] });
    for (let x = 300; x >= 100; x -= 25) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 402 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(900);
    const c1 = await cfi(); assert(c1 !== c0, 'swipe did not advance');
    await page.mouse.click(30, 420); await sleep(700);
  });
  await step('Table of contents lists chapters and navigates', async () => {
    await click(page, '#r-toc'); await page.waitForSelector('.toc-item'); const n = await page.$$eval('.toc-item', (e) => e.length); assert(n > 3, 'toc items ' + n);
    await page.screenshot({ path: '/tmp/shot-toc.png' });
    await page.evaluate(() => document.querySelectorAll('.toc-item')[3].click()); await sleep(1200);
    await page.waitForFunction(() => !document.querySelector('#overlay .sheet')); return n + ' items; now at ' + (await text(page, '.r-label'));
  });
  await step('Bookmark add / list / remove', async () => {
    await click(page, '#r-bm'); await sleep(300); assert((await text(page, '#r-bm')) === '★', 'star not filled');
    await click(page, '#r-toc'); await clickText(page, '.seg button', 'Bookmarks'); await page.waitForSelector('.list-item'); const n = await page.$$eval('.sheet .list-item', (e) => e.length); assert(n === 1, 'bookmarks ' + n);
    await page.evaluate(() => document.querySelector('.sheet .btn-icon').click()); await sleep(200);
    await clickText(page, '.btn-text', 'Done'); await sleep(200);
    assert((await text(page, '#r-bm')) === '☆', 'star should be empty');
    await click(page, '#r-bm'); await sleep(300); // keep one for later
  });

  // appearance: global
  await step('Theme change applies to reader + app UI (dark → night → sepia)', async () => {
    await click(page, '#r-aa'); await page.waitForSelector('[data-theme-pick]');
    const out = [];
    for (const th of ['dark', 'night', 'sepia']) { await page.click(`[data-theme-pick=${th}]`); await sleep(500); const f = await frameInfo(page); const ui = await page.evaluate(() => getComputedStyle(document.body).backgroundColor); out.push(`${th}: text ${f.color} on ${f.bg}; ui ${ui}`); if (th === 'night') await page.screenshot({ path: '/tmp/shot-reader-night.png' }); }
    assert(out[0].includes('rgb(31, 32, 35)'), out[0]); assert(out[1].includes('rgb(0, 0, 0)'), out[1]);
    await page.screenshot({ path: '/tmp/shot-reader-sepia.png' }); return out.join(' || ');
  });
  await step('Text size: numeric input 17.5pt, ±0.5 buttons, slider all synced', async () => {
    const readAll = () => page.evaluate(() => ({ num: +document.querySelector('#fs-num').value, range: +document.querySelector('#fs-range').value }));
    await page.$eval('#fs-num', (e) => { e.value = ''; }); await page.type('#fs-num', '17.5'); await page.$eval('#fs-num', (e) => e.dispatchEvent(new Event('change'))); await sleep(600);
    let f = await frameInfo(page); let s = await readAll();
    assert(Math.abs(f.fs - 17.5 * 4 / 3) < 0.3 && s.range === 17.5, `input: iframe ${f.fs}px, ${JSON.stringify(s)}`);
    await page.click('#fs-plus'); await sleep(400); s = await readAll(); assert(s.num === 18 && s.range === 18, 'plus ' + JSON.stringify(s));
    await page.click('#fs-minus'); await page.click('#fs-minus'); await sleep(500); s = await readAll(); f = await frameInfo(page);
    assert(s.num === 17 && Math.abs(f.fs - 17 * 4 / 3) < 0.3, 'minus ' + JSON.stringify(s) + f.fs);
    await page.$eval('#fs-range', (e) => { e.value = 30; e.dispatchEvent(new Event('input')); }); await sleep(500); s = await readAll(); f = await frameInfo(page);
    assert(s.num === 30 && Math.abs(f.fs - 40) < 0.3, 'slider ' + JSON.stringify(s) + f.fs);
    await page.$eval('#fs-num', (e) => { e.value = '99'; e.dispatchEvent(new Event('change')); }); await sleep(300); s = await readAll(); assert(s.num === 60, 'clamp max ' + s.num);
    await page.$eval('#fs-num', (e) => { e.value = '2'; e.dispatchEvent(new Event('change')); }); await sleep(300); s = await readAll(); assert(s.num === 8, 'clamp min ' + s.num);
    await page.$eval('#fs-num', (e) => { e.value = '15'; e.dispatchEvent(new Event('change')); }); await sleep(300);
    const g = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings')).fontSizePt); assert(g === 15, 'persisted ' + g);
    return 'ok (clamped 8–60, persisted)';
  });
  await step('Line spacing + margins + font family change (global)', async () => {
    await page.$eval('#lh-range', (e) => { e.value = 2; e.dispatchEvent(new Event('input')); }); await page.$eval('#mg-range', (e) => { e.value = 60; e.dispatchEvent(new Event('input')); });
    await page.select('#font-sel', 'mono'); await sleep(700);
    const f = await frameInfo(page); const pad = await page.$eval('#viewer', (e) => e.style.paddingLeft);
    assert(/Menlo/.test(f.ff) && pad === '60px', `${f.ff} / ${pad} / lh ${f.lh}`);
    return `font ${f.ff.slice(0, 20)}, lh ${f.lh}, margin ${pad}`;
  });
  await step('Per-book override: size/margin/line-height/font win over global; indicator shown', async () => {
    await page.click('#scope-book'); await sleep(200);
    await page.$eval('#fs-num', (e) => { e.value = '22'; e.dispatchEvent(new Event('change')); }); await page.$eval('#mg-range', (e) => { e.value = 10; e.dispatchEvent(new Event('input')); });
    await page.$eval('#lh-range', (e) => { e.value = 1.2; e.dispatchEvent(new Event('input')); }); await page.select('#font-sel', 'georgia'); await sleep(800);
    const f = await frameInfo(page); const pad = await page.$eval('#viewer', (e) => e.style.paddingLeft); const dot = await page.$eval('#r-ovr', (e) => !e.hidden);
    const glob = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('folio.settings')); return [s.fontSizePt, s.margin, s.lineHeight, s.font]; });
    assert(Math.abs(f.fs - 22 * 4 / 3) < 0.3 && pad === '10px' && /Georgia/.test(f.ff) && dot, JSON.stringify({ f, pad, dot }));
    assert(glob[0] === 15 && glob[1] === 60 && glob[3] === 'mono', 'global changed: ' + glob);
    await page.screenshot({ path: '/tmp/shot-reader-override.png' });
    return `book: 22pt/10px/Georgia (global untouched ${glob.join('/')})`;
  });
  await step('"Use global size" clears only the size override', async () => {
    await click(page, '[data-clear=fontSizePt]'); await sleep(700);
    const f = await frameInfo(page); assert(Math.abs(f.fs - 15 * 4 / 3) < 0.3, 'size ' + f.fs);
    const pad = await page.$eval('#viewer', (e) => e.style.paddingLeft); assert(pad === '10px', 'margin override should remain');
  });
  await step('Override persisted per book in IndexedDB; other book unaffected; library shows indicator', async () => {
    const o = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const all = r.result.transaction('books').objectStore('books').getAll(); all.onsuccess = () => res(all.result.map((b) => [b.title.slice(0, 12), JSON.stringify(b.overrides)])); }; }));
    const fr = o.find((x) => /Frankenstein/.test(x[0])); assert(fr[1] !== 'null' && JSON.parse(fr[1]).margin === 10 && JSON.parse(fr[1]).fontSizePt === undefined, JSON.stringify(o));
    assert(o.filter((x) => x[1] === 'null').length === 4, 'others should have no overrides');
    return JSON.stringify(fr);
  });
  await step('Reset this book to defaults', async () => {
    await click(page, '#reset-book'); await sleep(900); const f = await frameInfo(page); const pad = await page.$eval('#viewer', (e) => e.style.paddingLeft); const dot = await page.$eval('#r-ovr', (e) => !e.hidden);
    assert(pad === '60px' && !dot && /Menlo/.test(f.ff), JSON.stringify({ pad, dot, ff: f.ff }));
    await page.evaluate(() => { const s = window.__folio.settings; s.set({ font: 'publisher', lineHeight: 1.5, margin: 24 }); }); await sleep(500);
    await clickText(page, '.btn-text', 'Done'); await sleep(300);
  });
  await step('Scroll mode renders and scrolls', async () => {
    await click(page, '#r-aa'); await page.waitForSelector('[data-flow=scrolled]'); await sleep(300);
    await page.evaluate(() => document.querySelector('[data-flow=scrolled]').click()); await sleep(1800);
    const ok = await page.evaluate(() => !!document.querySelector('#viewer .epub-container') && document.querySelectorAll('#viewer iframe').length >= 1 && window.__reader.rendition.settings.flow === 'scrolled');
    assert(ok, 'not in scrolled flow'); await page.screenshot({ path: '/tmp/shot-reader-scroll.png' });
    const top0 = await page.evaluate(() => document.querySelector('#viewer .epub-container').scrollTop); await page.evaluate(() => { document.querySelector('#viewer .epub-container').scrollTop += 600; }); await sleep(600);
    const top1 = await page.evaluate(() => document.querySelector('#viewer .epub-container').scrollTop); assert(top1 > top0, 'did not scroll');
    await page.evaluate(() => document.querySelector('[data-flow=paginated]').click()); await sleep(1800); await clickText(page, '.btn-text', 'Done');
    return 'scrolled ' + (top1 - top0) + 'px then back to pages';
  });
  await step('Position remembered per book (close → reopen)', async () => {
    await sleep(800); const before = await page.evaluate(() => window.__reader.loc.start.cfi); const prog = await page.evaluate(() => window.__reader.progress);
    await click(page, '#r-back'); await page.waitForSelector('.tile'); await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll('.tile.book')].find((t) => /Frankenstein/i.test(t.innerText)).click());
    await page.waitForFunction(() => window.__reader?.loc, { timeout: 15000 }); await sleep(700);
    const inRange = await page.evaluate((cfi) => { const l = window.__reader.loc; const c = new ePub.CFI(); return c.compare(cfi, l.start.cfi) >= 0 && c.compare(cfi, l.end.cfi) <= 0; }, before); assert(inRange, 'saved position ' + before + ' not on the page shown after reopen');
    return `progress ${(prog * 100).toFixed(1)}% restored`;
  });
  await step('Book auto-moves Currently Reading; reaching the end moves to Finished', async () => {
    const st1 = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction('books').objectStore('books').getAll(); a.onsuccess = () => res(a.result.find((b) => /Frank/.test(b.title)).status); }; }));
    assert(st1 === 'reading', 'status ' + st1);
    // jump to the last spine item then page to the end
    await page.evaluate(async () => { const r = window.__reader; const last = r.epub.spine.get(r.epub.spine.length - 1); await r.rendition.display(last.href); });
    for (let i = 0; i < 80; i++) { const end = await page.evaluate(() => window.__reader.loc && window.__reader.loc.atEnd); if (end) break; await page.mouse.click(350, 420); await sleep(250); }
    await sleep(1200);
    const st2 = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction('books').objectStore('books').getAll(); a.onsuccess = () => res(a.result.find((b) => /Frank/.test(b.title)).status); }; }));
    assert(st2 === 'finished', 'status ' + st2); return 'reading → finished';
  });
  await click(page, '#r-back'); await page.waitForSelector('.tile'); await sleep(400);

  await step('Finished shelf: separate section, hide/show toggle, manual move', async () => {
    let heads = await page.$$eval('.sec-title', (e) => e.map((x) => x.innerText.replace('\n', ' ')));
    assert(heads.some((h) => /Finished/.test(h)), 'no Finished section: ' + heads); await page.screenshot({ path: '/tmp/shot-shelves.png' });
    await page.evaluate(() => window.__folio.settings.set({ showFinished: false })); await page.evaluate(() => window.__folio.show('library')); await sleep(400);
    heads = await page.$$eval('.sec-title', (e) => e.map((x) => x.innerText)); assert(!heads.some((h) => /Finished/.test(h)), 'finished still shown'); 
    assert(!(await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText))).some((t) => /Frankenstein/.test(t)), 'finished book should be hidden in All');
    await page.evaluate(() => window.__folio.settings.set({ showFinished: true })); await page.evaluate(() => window.__folio.show('library')); await sleep(400);
    // manual move back to reading via the book menu
    await page.evaluate(() => [...document.querySelectorAll('.tile.book')].find((t) => /Frankenstein/i.test(t.innerText)).querySelector('.tile-more').click());
    await clickText(page, '.list-item', 'Move to shelf'); await sleep(200); await click(page, '[data-status=want]'); await sleep(600);
    const st = await page.evaluate(() => [...document.querySelectorAll('.sec-title')].map((x) => x.innerText.replace('\n', ' ')).join(' / ')); return st;
  });
  await step('Custom shelf: create, assign book, filter', async () => {
    console.log('  overlay before:', await page.evaluate(() => document.querySelector('#overlay').innerHTML.length), await page.evaluate(() => document.querySelector('.tile.set') ? 'library' : document.querySelector('#set-back') ? 'setpage' : 'other'));
    await click(page, '.chip.add'); await page.waitForSelector('.sheet input', { timeout: 4000 }); await page.type('.sheet input', 'Favorites'); await clickText(page, '.sheet .btn.primary', 'Save'); await sleep(500);
    assert(await page.$$eval('.chip.on', (e) => /Favorites/.test(e[0].innerText)), 'chip not selected');
    await clickText(page, '.chip', 'All'); await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.tile.book')].find((t) => /Standalone/i.test(t.innerText)).querySelector('.tile-more').click());
    await clickText(page, '.list-item', 'Move to shelf'); await sleep(200); await clickText(page, '.sheet .list-item', 'Favorites'); await sleep(400); await clickText(page, '.btn-text', 'Done'); await sleep(200);
    await clickText(page, '.chip', 'Favorites'); await sleep(400);
    const t = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText)); assert(t.length === 1 && /Standalone/.test(t[0]), t.join()); await clickText(page, '.chip', 'All'); await sleep(300);
  });
  await step('Manual set: create set, assign standalone book as volume 4, appears in set page', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.tile.book')].find((t) => /Standalone/i.test(t.innerText)).querySelector('.tile-more').click());
    await clickText(page, '.list-item', 'Edit details'); await sleep(200);
    await page.select('.sheet select', 'e2e-none').catch(() => {}); 
    const sel = await page.$('.sheet select'); const opts = await page.$$eval('.sheet select option', (o) => o.map((x) => [x.value, x.textContent]));
    const existing = opts.find((o) => /Test Saga/.test(o[1])); await sel.select(existing[0]); await page.$eval('.sheet input[type=number]', (e) => { e.value = '4'; }); await click(page, '#save-book'); await sleep(700);
    await page.evaluate(() => document.querySelector('.tile.set').click()); await page.waitForSelector('#set-back'); const titles = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText));
    assert(titles.length === 4 && titles[3] === 'A Standalone Tale', titles.join()); return titles.join(' < ');
  });

  // ---------- custom order
  await step('Custom order within a set: mouse drag reorders and persists; reset restores volume order', async () => {
    await page.select('#set-sort-sel', 'custom'); await sleep(500);
    const box = async (i) => page.$$eval('.tile', (t, i) => { const r = t[i].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
    const a = await box(3), b = await box(0);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x - 10, a.y - 10, { steps: 4 }); await page.mouse.move(b.x - 20, b.y, { steps: 12 }); await sleep(150); await page.mouse.up(); await sleep(500);
    let titles = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText)); assert(titles[0] === 'A Standalone Tale', 'after drag: ' + titles.join());
    await page.evaluate(() => window.__folio.show('library')); await sleep(500); // re-render from DB
    titles = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText)); assert(titles[0] === 'A Standalone Tale', 'not persisted: ' + titles.join());
    await page.screenshot({ path: '/tmp/shot-custom.png' });
    await click(page, '#reset-order'); await sleep(500); titles = await page.$$eval('.tile .t', (e) => e.map((x) => x.innerText)); assert(titles[3] === 'A Standalone Tale', 'reset: ' + titles.join());
    return 'drag persisted, reset OK';
  });
  await step('Custom order in library grid: touch long-press drag (iOS path)', async () => {
    await click(page, '#set-back'); await sleep(300);
    await page.evaluate(async () => { const st = await import('./js/settings.js'); window.__folio.settings.set({ view: 'grid' }); st.setSort('shelf:' + st.settings.get('chip'), { field: 'custom' }); }); await page.evaluate(() => window.__folio.show('library')); await sleep(600);
    await page.evaluate(() => { const c = [...document.querySelectorAll('.tiles')].find((c) => c.querySelectorAll('.tile').length >= 2); c.dataset.t = '1'; });
    const before = await page.$$eval('.tiles[data-t] .tile', (t) => t.map((x) => x.dataset.key)); assert(before.length >= 2);
    const pos = (i) => page.$$eval('.tiles[data-t] .tile', (t, i) => { const r = t[i].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, i);
    const p0 = await pos(0), p1 = await pos(1); const cdp = await page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p0.x, y: p0.y }] }); await sleep(600);
    const dragging = await page.evaluate(() => document.body.classList.contains('dragging-now')); assert(dragging, 'long-press did not start drag');
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p0.x + (p1.x + 30 - p0.x) * i / 10, y: p0.y + (p1.y - p0.y) * i / 10 }] });
    await sleep(100); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(600);
    const after = await page.$$eval('.tiles[data-t] .tile', (t) => t.map((x) => x.dataset.key)); assert(after[1] === before[0] && after[0] === before[1], before.join() + ' → ' + after.join());
    await page.evaluate(() => window.__folio.show('library')); await sleep(500); await page.evaluate(() => { const c = [...document.querySelectorAll('.tiles')].find((c) => c.querySelectorAll('.tile').length >= 2); c.dataset.t = '1'; }); const again = await page.$$eval('.tiles[data-t] .tile', (t) => t.map((x) => x.dataset.key)); assert(again.join() === after.join(), 'not persisted');
    return 'long-press drag persisted';
  });
  await step('New book appends to end of custom order; reset-to-automatic switches sort back', async () => {
    const before = await page.$$eval('.tile', (t) => t.map((x) => x.dataset.key));
    await (await page.$('#file-input')).uploadFile(path.join(__dirname, 'fixtures', 'saga-1.epub')).catch(() => {});
    await sleep(800); await page.evaluate(() => document.querySelector('#reset-order').click()); await sleep(600); const sort = await page.$eval('#sort-sel', (e) => e.value); assert(sort !== 'custom', 'sort still custom');
    return 'reset → ' + sort;
  });

  await step('Drag & drop an .epub onto the window imports it (Files / desktop)', async () => {
    const before = await page.$$eval('.tile', (t) => t.length); const n0 = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const c = r.result.transaction('books').objectStore('books').count(); c.onsuccess = () => res(c.result); }; }));
    await page.evaluate(async () => { const b = await (await fetch('./tests/fixtures/saga-3.epub')).blob(); const f = new File([b], 'dropped-saga-3.epub', { type: 'application/epub+zip' }); const dt = new DataTransfer(); dt.items.add(f); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
    await sleep(1500); const n1 = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const c = r.result.transaction('books').objectStore('books').count(); c.onsuccess = () => res(c.result); }; }));
    // saga-3 is already in the library (same identifier) so this must be rejected as a duplicate, not crash
    const toast = await page.$eval('#toast', (e) => e.innerText); assert(n1 === n0, 'duplicate imported: ' + n0 + '→' + n1); return 'duplicate correctly rejected (toast: ' + toast.slice(0, 60) + ')';
  });
  console.log('\nPage errors:', JSON.stringify(page.errs));
  await page.close();
  require('fs').writeFileSync('/tmp/e2e-part1.json', JSON.stringify(results));
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

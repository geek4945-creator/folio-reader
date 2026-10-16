// Reader footer: "Page X of Y" + "N pages left in chapter" (EPUB paginated + scroll, PDF), recalculation on appearance changes,
// IndexedDB cache, placeholder while counting, settings toggles, themes, chrome hidden, iPhone safe areas.
const puppeteer = require('puppeteer-core'); const path = require('path');
const URL = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Blocked script execution in 'about:srcdoc'/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument(() => { window.__ft = []; const rec = () => { const e = document.querySelector('#r-foot-page'); if (e && window.__ft[window.__ft.length - 1] !== e.textContent) window.__ft.push(e.textContent); }; new MutationObserver(rec).observe(document, { childList: true, subtree: true, characterData: true }); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  const foot = () => page.evaluate(() => { const q = (s) => document.querySelector(s); const pg = q('#r-foot-page'), lf = q('#r-foot-left');
    const m = /Page (\d+) of (\d+)/.exec(pg?.textContent || ''); const l = /^(\d+) pages? left in (chapter|section)$/.exec(lf?.textContent || ''); const last = /^Last page of (chapter|section)/.test(lf?.textContent || '');
    return { pageText: pg?.textContent || '', leftText: lf?.textContent || '', page: m ? +m[1] : null, total: m ? +m[2] : null, left: l ? +l[1] : last ? 0 : null, pageHidden: !!pg?.hidden, leftHidden: !!lf?.hidden, sepHidden: !!q('#r-foot-sep')?.hidden, has: q('#reader').classList.contains('has-foot'), disp: getComputedStyle(q('#r-foot')).display }; });
  const waitFoot = async (fn, ms = 10000, msg = 'footer condition') => { const t = Date.now(); for (;;) { const f = await foot(); if (fn(f)) return f; if (Date.now() - t > ms) throw new Error(msg + ': ' + JSON.stringify(f)); await sleep(150); } };
  const openBook = async (title) => { await page.evaluate(() => window.__folio.show('library')); await sleep(400); await page.evaluate((t) => [...document.querySelectorAll('.tile.book')].find((x) => x.innerText.includes(t)).click(), title); await page.waitForSelector('#viewer iframe, #viewer .pdf-page', { timeout: 15000 }); };
  const closeBook = async () => { await page.evaluate(() => document.querySelector('#r-back').click()); await sleep(700); };
  const setS = (p) => page.evaluate(async (p) => (await import('./js/settings.js')).settings.set(p), p);
  const next = async (n = 1) => { for (let i = 0; i < n; i++) { await page.evaluate(() => window.__reader.rendition.next()); await sleep(420); } };
  const rect = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }; }, sel);
  const cacheKeys = () => page.evaluate(async () => (await (await import('./js/db.js')).DB.all('pagecache')).map((x) => x.key.replace(/^[^|]+\|/, '')));

  /* ---------- EPUB ---------- */
  await step('Import long test book (5 chapters)', async () => {
    await (await page.$('#file-input')).uploadFile(fx('long-book.epub')); await page.waitForSelector('.tile.book'); await sleep(400);
    await page.evaluate(() => { window.__pagesDelay = 350; });   // slow the one-time text counting so the placeholder is observable
  });
  await step('First open: "Calculating pages…" placeholder while counting; pages-left-in-chapter is available immediately', async () => {
    await openBook('Long Test Book'); const first = await waitFoot((f) => f.leftText, 6000, 'left part'); assert(first.left !== null && first.left >= 1, JSON.stringify(first));
    const f1 = await waitFoot((f) => /Calculating pages/.test(f.pageText), 4000, 'placeholder'); assert(f1.left !== null, 'left should show while calculating'); assert(f1.page === null);
    await page.screenshot({ path: '/tmp/shot-footer-calculating.png' });
    const f2 = await waitFoot((f) => f.page !== null, 15000, 'page numbers'); assert(f2.page === 1 && f2.total >= 20, JSON.stringify(f2));
    const seq = await page.evaluate(() => window.__ft); assert(seq.some((t) => /Calculating/.test(t)) && /Page 1 of/.test(seq[seq.length - 1]), JSON.stringify(seq)); return `${f2.pageText} · ${f2.leftText}`;
  });
  await step('Footer shows both parts on one line and is readable (screenshot)', async () => {
    const f = await foot(); assert(!f.pageHidden && !f.leftHidden && !f.sepHidden && f.disp === 'flex', JSON.stringify(f)); await page.screenshot({ path: '/tmp/shot-footer.png' });
    assert(/^Page 1 of \d+$/.test(f.pageText) && /^\d+ pages? left in chapter$/.test(f.leftText), JSON.stringify(f));
  });
  await step('Paging forward: X +1, N left −1, "Last page of chapter", then continues into the next chapter', async () => {
    let f = await foot(); const seq = [f]; const startTotal = f.total; assert(f.left >= 1, 'prologue should span pages');
    for (let i = 0; i < 9; i++) { await next(); await sleep(200); f = await foot(); seq.push(f); }
    for (let i = 1; i < seq.length; i++) assert(seq[i].page === seq[i - 1].page + 1, `page numbers not consecutive at ${i}: ` + seq.map((x) => x.page).join(','));
    const lastIdx = seq.findIndex((x) => x.left === 0); assert(lastIdx > 0, 'never reached "Last page of chapter": ' + seq.map((x) => x.leftText).join(' | '));
    for (let i = 1; i <= lastIdx; i++) assert(seq[i].left === seq[i - 1].left - 1, 'left not decreasing at ' + i); assert(seq[lastIdx + 1].left > 3, 'new chapter should have many pages left: ' + seq[lastIdx + 1].leftText);
    assert(Math.abs(f.total - startTotal) / startTotal < 0.2, `total drifted ${startTotal} → ${f.total}`); return seq.map((x) => `${x.page}/${x.left}`).join(' ');
  });
  await step('Cache in IndexedDB (chars per chapter, calibration factor, per-layout calibration)', async () => {
    const k = await cacheKeys(); assert(k.includes('chars') && k.includes('k') && k.some((x) => x.startsWith('cal|')), k.join(' || ')); assert(!(await cacheKeys()).some((x) => /Calculating/.test(x)));
  });
  await step('Text size change recalculates (bigger text → more pages), restoring it restores the count from cache', async () => {
    const base = await foot(); await setS({ fontSizePt: 24 }); const big = await waitFoot((f) => f.total && f.total > base.total * 1.5, 8000, 'bigger text → more pages'); assert(big.page >= 1);
    for (let i = 0; i < 20 && (await cacheKeys()).filter((x) => x.startsWith('cal|')).length < 2; i++) await sleep(250);   // calibration is saved ~0.6 s after it settles
    assert((await cacheKeys()).filter((x) => x.startsWith('cal|')).length >= 2, 'second layout not cached: ' + (await cacheKeys()).join(' || '));
    await setS({ fontSizePt: 15 }); const back = await waitFoot((f) => f.total && Math.abs(f.total - base.total) / base.total < 0.1, 8000, 'back to original size'); return `${base.total} → ${big.total} → ${back.total}`;
  });
  await step('Margins and line spacing recalculate too', async () => {
    const base = await waitFoot((f) => f.total); await setS({ margin: 70 }); const m = await waitFoot((f) => f.total > base.total * 1.12, 8000, 'wider margins'); await setS({ margin: 24 }); await waitFoot((f) => Math.abs(f.total - base.total) / base.total < 0.1, 8000, 'margin restored');
    await setS({ lineHeight: 2.3 }); const l = await waitFoot((f) => f.total > base.total * 1.25, 8000, 'line spacing'); await setS({ lineHeight: 1.5 }); await waitFoot((f) => Math.abs(f.total - base.total) / base.total < 0.1, 8000, 'spacing restored'); return `${base.total} → margin ${m.total}, spacing ${l.total}`;
  });
  await step('Per-book font override also recalculates', async () => {
    const base = await waitFoot((f) => f.total); await page.evaluate(async () => { const S = await import('./js/store.js'); await S.setOverride(window.__reader.book.id, { fontSizePt: 22 }); window.__reader.book = await S.getBook(window.__reader.book.id); const { applyAppearance } = await import('./js/reader.js'); applyAppearance(); });
    await waitFoot((f) => f.total > base.total * 1.4, 8000, 'override → more pages'); await page.evaluate(async () => { const S = await import('./js/store.js'); window.__reader.book = await S.resetOverrides(window.__reader.book.id); (await import('./js/reader.js')).applyAppearance(); });
    await waitFoot((f) => Math.abs(f.total - base.total) / base.total < 0.1, 8000, 'override reset');
  });
  await step('Readable under all 8 themes (contrast ≥ 4.5:1, toolbar shown and hidden)', async () => {
    const themes = await page.evaluate(async () => Object.keys((await import('./js/settings.js')).THEMES)); const bad = [];
    const lum = (c) => { const v = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    for (const t of themes) { await setS({ theme: t }); await sleep(250);
      for (const hidden of [false, true]) { await page.evaluate((h) => document.querySelector('#reader').classList.toggle('chrome-hidden', h), hidden);
        const cs = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#r-foot')); return { c: s.color, b: s.backgroundColor, o: s.opacity }; }); const a = lum(cs.c), b = lum(cs.b); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); if (ratio < 4.5 || cs.o !== '1') bad.push(`${t}/${hidden ? 'hidden' : 'shown'} ${ratio.toFixed(2)}`); } }
    await page.evaluate(() => document.querySelector('#reader').classList.remove('chrome-hidden')); await setS({ theme: 'night' }); await sleep(300); await page.screenshot({ path: '/tmp/shot-footer-night.png' }); await setS({ theme: 'light' });
    assert(!bad.length, 'low contrast: ' + bad.join(', '));
  });
  await step('Footer stays visible and un-overlapped with toolbars shown or hidden (tap centre toggles)', async () => {
    await page.evaluate(() => document.querySelector('#reader').classList.remove('chrome-hidden')); await sleep(400);
    let foot_ = await rect('#r-foot'), bar = await rect('.r-bar.bottom'), v = await rect('#viewer'); assert(bar.bottom <= foot_.top + 1 && v.bottom <= bar.top + 1, JSON.stringify({ foot_, bar, v })); assert(Math.abs(foot_.bottom - 844) < 1.5, 'footer not at the bottom edge');
    await page.evaluate(() => window.__reader.el.classList.add('chrome-hidden')); await sleep(500); foot_ = await rect('#r-foot'); v = await rect('#viewer'); assert(v.bottom <= foot_.top + 1, 'viewer overlaps footer when chrome hidden ' + JSON.stringify({ foot_, v })); assert((await foot()).page !== null, 'footer text missing'); await page.screenshot({ path: '/tmp/shot-footer-hidden.png' });
    await page.evaluate(() => window.__reader.el.classList.remove('chrome-hidden')); await sleep(300);
  });
  await step('iPhone safe areas: footer height/padding follow --sab/--sal/--sar', async () => {
    await page.evaluate(() => { const r = document.documentElement.style; r.setProperty('--sab', '34px'); r.setProperty('--sal', '20px'); r.setProperty('--sar', '24px'); }); await sleep(300);
    const m = await page.evaluate(() => { const f = getComputedStyle(document.querySelector('#r-foot')); const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); return { h: document.querySelector('#r-foot').getBoundingClientRect().height, rem, pb: parseFloat(f.paddingBottom), pl: parseFloat(f.paddingLeft), pr: parseFloat(f.paddingRight), vl: document.querySelector('#viewer').getBoundingClientRect().left, vr: 390 - document.querySelector('#viewer').getBoundingClientRect().right }; });
    assert(Math.abs(m.h - (1.5 * m.rem + 34)) < 1.5 && m.pb === 34 && m.pl >= 20 + 8 && m.pr >= 24 + 8 && m.vl === 20 && m.vr === 24, JSON.stringify(m));
    const bar = await rect('.r-bar.bottom'), f = await rect('#r-foot'); assert(bar.bottom <= f.top + 1, 'bar overlaps footer with safe area');
    await page.evaluate(() => { const r = document.documentElement.style; ['--sab', '--sal', '--sar'].forEach((k) => r.removeProperty(k)); });
  });
  await step('Settings: footer parts can be switched off in the reader (Appearance) and in Settings; synced keys', async () => {
    await page.evaluate(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#foot-pages'); await page.evaluate(() => document.querySelector('#foot-pages').click()); await sleep(200);
    let f = await foot(); assert(f.pageHidden && !f.leftHidden && f.sepHidden && f.has, 'page part should hide: ' + JSON.stringify(f));
    await page.evaluate(() => document.querySelector('#foot-left').click()); await sleep(200); f = await foot(); assert(!f.has && f.disp === 'none', 'footer should vanish: ' + JSON.stringify(f));
    const v = await rect('#viewer'); const sab = 0; assert(Math.abs(v.bottom - (844 - 3.6 * 16 - sab)) < 2, 'viewer bottom should be back to 3.6rem: ' + v.bottom);
    await page.evaluate(() => document.querySelector('#foot-pages').click()); await sleep(200); f = await foot(); assert(!f.pageHidden && f.leftHidden && f.has, 'only page numbers: ' + JSON.stringify(f));
    await page.evaluate(() => document.querySelector('#foot-left').click()); await sleep(200); f = await foot(); assert(!f.pageHidden && !f.leftHidden, JSON.stringify(f));
    const sy = await page.evaluate(async () => { const st = await import('./js/settings.js'); return st.SYNCED.includes('footerPages') && st.SYNCED.includes('footerLeft') && st.DEFAULTS.footerPages === true && st.DEFAULTS.footerLeft === true; }); assert(sy, 'not synced / defaults');
    await page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  });
  await step('Scroll mode: equivalent pages from scroll height / viewport; X advances while scrolling; left shrinks', async () => {
    await page.evaluate(() => document.querySelector('#r-aa').click()); await page.waitForSelector('[data-flow=scrolled]'); const pagTotal = (await foot()).total;
    await page.evaluate(() => document.querySelector('[data-flow=scrolled]').click()); await sleep(1500); await page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
    const a = await waitFoot((f) => f.page !== null && f.left !== null, 10000, 'scroll footer'); assert(a.total > pagTotal * 0.5 && a.total < pagTotal * 1.8, `scroll total ${a.total} vs paginated ${pagTotal}`);
    const cont = () => page.evaluate(() => window.__reader.rendition.manager.container); await page.evaluate(() => { const c = window.__reader.rendition.manager.container; c.scrollTop += c.clientHeight * 2.05; }); await sleep(900);
    const b = await foot(); assert(b.page >= a.page + 1 && b.left <= a.left, `scrolling: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    await page.evaluate(() => { const c = window.__reader.rendition.manager.container; c.scrollTop += c.clientHeight * 30; }); await sleep(1200); const c2 = await foot(); assert(c2.page > b.page + 10, 'deep scroll ' + JSON.stringify(c2)); await page.screenshot({ path: '/tmp/shot-footer-scroll.png' });
    await page.evaluate(() => document.querySelector('#r-aa').click()); await page.waitForSelector('[data-flow=paginated]'); await page.evaluate(() => document.querySelector('[data-flow=paginated]').click()); await sleep(1200); await page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
    const p = await waitFoot((f) => f.page !== null, 8000, 'back to pages'); return `${pagTotal} pages vs ${a.total} scroll-pages; deep scroll → ${c2.page}`;
  });
  await step('Reopen: cached counts show immediately — no "Calculating pages…" flash', async () => {
    await closeBook(); await page.evaluate(() => { window.__pagesDelay = 0; window.__ft = []; }); await openBook('Long Test Book'); const f = await waitFoot((f) => f.page !== null, 8000, 'page numbers'); await sleep(300);
    const seq = await page.evaluate(() => window.__ft); assert(!seq.some((t) => /Calculating/.test(t)), 'placeholder flashed: ' + JSON.stringify(seq)); assert(f.total >= 20); return seq.join(' → ');
  });
  await step('Deleting the book removes its page caches', async () => {
    await closeBook(); const before = await cacheKeys(); assert(before.length >= 3);
    await page.evaluate(async () => { const S = await import('./js/store.js'); await S.deleteBooks((await S.getBooks()).map((b) => b.id)); }); assert((await cacheKeys()).length === 0, 'caches linger: ' + (await cacheKeys()).join());
  });

  /* ---------- PDF ---------- */
  await step('PDF with outline: real page numbers + pages left in the outline section', async () => {
    await (await page.$('#file-input')).uploadFile(fx('test-doc.pdf'), fx('plain-4pp.pdf')); for (let i = 0; i < 40; i++) { if ((await page.$$('.tile.book')).length >= 2) break; await sleep(300); } await sleep(600);
    await openBook('Folio Test PDF'); const f = await waitFoot((x) => x.page === 1, 10000, 'pdf page 1'); assert(f.total === 6, 'total ' + f.total); await sleep(800);
    const sections = await page.evaluate(() => window.__pdf.sections); assert(Array.isArray(sections) && sections.length >= 1 && sections[0] >= 1, 'sections ' + JSON.stringify(sections));
    for (let p = 1; p <= 6; p++) { await page.evaluate((p) => { const n = document.querySelector('#pdf-page-num'); n.value = p; n.dispatchEvent(new Event('change')); }, p); await sleep(450);
      const g = await foot(); const nextStart = sections.find((s) => s > p); const expect = (nextStart || 7) - 1 - p; assert(g.page === p && g.total === 6 && g.left === expect, `p${p}: got ${JSON.stringify({ page: g.page, left: g.left, txt: g.leftText })} expected left ${expect} (sections ${sections})`); assert(/section$/.test(g.leftText), g.leftText); }
    await page.screenshot({ path: '/tmp/shot-footer-pdf.png' }); return 'sections ' + sections.join(',');
  });
  await step('PDF footer survives hidden toolbar and respects the toggles', async () => {
    await page.evaluate(() => { document.querySelector('#reader').classList.add('chrome-hidden'); }); await sleep(300); const f = await foot(); assert(f.has && f.disp === 'flex' && f.page !== null, JSON.stringify(f));
    const v = await rect('#viewer'), r = await rect('#r-foot'); assert(v.bottom <= r.top + 1, 'viewer overlaps footer'); await page.evaluate(() => document.querySelector('#reader').classList.remove('chrome-hidden'));
    await page.evaluate(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#foot-left'); await page.evaluate(() => document.querySelector('#foot-left').click()); await sleep(200); const g = await foot(); assert(g.leftHidden && !g.pageHidden, JSON.stringify(g)); await page.evaluate(() => document.querySelector('#foot-left').click());
    await page.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  });
  await step('PDF without an outline: page numbers only (chapter part hidden)', async () => {
    await closeBook(); await openBook('plain'); const f = await waitFoot((x) => x.page === 1, 10000, 'plain pdf'); await sleep(900); const g = await foot();
    assert(g.total === 4 && g.leftText === '' && g.leftHidden && g.sepHidden && !g.pageHidden, JSON.stringify(g)); await closeBook();
  });
  await step('Settings tab has a Reader footer section with both toggles', async () => {
    await page.evaluate(() => document.querySelector('[data-tab=settings]').click()); await page.waitForSelector('#sec-footer #foot-pages'); assert(await page.$('#sec-footer #foot-left'));
    await page.evaluate(() => document.querySelector('#sec-footer #foot-pages').click()); assert((await page.evaluate(async () => (await import('./js/settings.js')).settings.get('footerPages'))) === false); await page.evaluate(() => document.querySelector('#sec-footer #foot-pages').click());
  });
  await step('No page errors', async () => assert(!errs.length, errs.join(' | ')));
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

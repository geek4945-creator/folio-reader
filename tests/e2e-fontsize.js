// v0.5.3 audit: the Text size setting must really size the book text in every format & flow — hard-coded px/pt/rem, !important (class / id / inline), <font size>, tables, lists, links …
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); });
  const ev = (f, ...a) => page.evaluate(f, ...a); const cdp = await page.createCDPSession();
  await page.goto(APP, { waitUntil: 'networkidle0' });
  const SK = await ev(() => Object.keys(localStorage).find((k) => /\.settings$/.test(k)) || null);
  const fresh = await ev(async () => { const { settings } = await import('./js/settings.js'); return { pt: settings.get('fontSizePt'), lh: settings.get('lineHeight') }; });
  // a PDF with real headings + wrapped paragraphs, made by Chrome itself
  const pdfPath = '/tmp/fontsize-text.pdf';
  { const p2 = await browser.newPage(); const para = (n) => '<p>' + ('Amber river stone quiet harbour ember linen. ').repeat(n) + '</p>';
    await p2.setContent(`<html><body style="font:11pt Georgia"><title>Text Layer Test</title><h1 style="font-size:26pt">Chapter One</h1>${para(14)}${para(10)}<h2 style="font-size:18pt">A Section</h2>${para(12)}<div style="page-break-before:always"></div><h1 style="font-size:26pt">Chapter Two</h1>${para(16)}</body></html>`);
    fs.writeFileSync(pdfPath, await p2.pdf({ format: 'A5' })); await p2.close(); }
  await (await page.$('#file-input')).uploadFile(...['font-nasty.epub', 'font-fixed.epub', 'saga-mobi6.mobi', 'saga-kf8.azw3', 'frankenstein.epub'].map(fx), pdfPath);
  for (let i = 0; i < 60; i++) { if ((await ev(async () => (await (await import('./js/store.js')).getBooks()).length)) >= 6) break; await sleep(300); }
  const idOf = (re) => ev(async (re) => (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re, 'i').test(b.title))?.id, re);
  const set = (p) => ev(async (p) => { (await import('./js/settings.js')).settings.set(p); }, p);
  const open = async (re) => { const id = await idOf(re); await ev(async (id) => { (await import('./js/reader.js')).openReader(id); }, id);
    await page.waitForFunction(() => !document.querySelector('#reader .r-loading') && (!!document.querySelector('#viewer iframe') || !!document.querySelector('#viewer .pdf-page, #viewer .pdf-tpage')) && (!!window.__reader?.loc || !!window.__pdf?.ready), { timeout: 30000 }); await sleep(1200); return id; };
  const close = async () => { await ev(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(400); };
  const px = (pt) => pt * 4 / 3;
  const measure = () => ev(() => { const out = {}, lh = {}; let html = null; for (const f of document.querySelectorAll('#viewer iframe')) { const d = f.contentDocument; if (!d || !d.body) continue; html = parseFloat(getComputedStyle(d.documentElement).fontSize);
      for (const e of d.body.querySelectorAll('[id^=t-]')) { const cs = getComputedStyle(e); out[e.id] = +parseFloat(cs.fontSize).toFixed(2); lh[e.id] = cs.lineHeight; } } return { html, ids: out, lh, pad: document.querySelector('#viewer').style.paddingLeft }; });
  const shown = async () => { await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#fs-num'); const v = await ev(() => +document.querySelector('#fs-num').value); await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); return v; };
  const BODY = ['t-p', 't-id', 't-big', 't-inline', 't-inline-imp', 't-rem', 't-deep', 't-span', 't-em', 't-td', 't-li', 't-bq', 't-a', 't-dt', 't-dd', 't-aside', 't-cap', 't-center'];
  const checkNasty = (m, pt, tag) => { const e = px(pt); const bad = BODY.filter((k) => m.ids[k] === undefined || Math.abs(m.ids[k] - e) > 0.11).map((k) => k + '=' + m.ids[k]); assert(!bad.length, `${tag} ${pt}pt expect ${e}px: ${bad.join(' ')}`);
    const r = (k) => +(m.ids[k] / e).toFixed(2); assert(r('t-h1') === 1.6 && r('t-h2') === 1.35 && r('t-h3') === 1.15, `headings ${r('t-h1')} ${r('t-h2')} ${r('t-h3')}`); assert(r('t-small') === 0.85 && r('t-sup') === 0.75 && r('t-sub') === 0.75 && r('t-pre') === 0.9, `small/sup/pre ${r('t-small')} ${r('t-sup')} ${r('t-pre')}`);
    assert(r('t-font') === 0.9 && r('t-font7') === 1.8, `font tags ${r('t-font')} ${r('t-font7')}`); };

  await step('Fresh install: default text size 15 pt = 20 px in the page; line spacing default applies', async () => {
    assert(fresh.pt === 15, 'default ' + fresh.pt); await set({ flow: 'scrolled', flowChosen: true }); await open('^Font Nasty'); const m = await measure(); assert(m.html === 20, 'html ' + m.html); assert(Math.abs(m.ids['t-p'] - 20) < 0.11, 'p ' + m.ids['t-p']); await close(); return JSON.stringify(fresh);
  });
  for (const flow of ['scrolled', 'paginated']) await step(`EPUB with hard-coded px/pt/rem, class/id/inline !important, <font>, td/li/a/aside — ${flow}: every text element follows the global size (12 pt and 24 pt); headings stay proportional; displayed pt = computed`, async () => {
    await set({ flow, flowChosen: true, lineHeight: 1.5 }); const out = [];
    for (const pt of [12, 24]) { await set({ fontSizePt: pt }); await open('^Font Nasty'); const m = await measure(); checkNasty(m, pt, flow);
      const lhOk = ['t-p', 't-id', 't-inline-imp', 't-td'].every((k) => Math.abs(parseFloat(m.lh[k]) - 1.5 * px(pt)) < 0.6); assert(lhOk, 'line-height ' + JSON.stringify(m.lh)); const sh = await shown(); assert(Math.abs(px(sh) - m.ids['t-p']) < 0.11, `Aa shows ${sh} pt but p is ${m.ids['t-p']} px`); await close(); out.push(pt); }
    return out.join('/');
  });
  await step('Changing the global size updates the OPEN book (live) and the next-opened book; reload keeps it', async () => {
    await set({ flow: 'scrolled', fontSizePt: 15 }); await open('^Font Nasty'); await set({ fontSizePt: 20 }); await sleep(1500); const m = await measure(); checkNasty(m, 20, 'live'); await close();
    await open('Frankenstein'); const f = await ev(() => { for (const fr of document.querySelectorAll('#viewer iframe')) { const e = fr.contentDocument && fr.contentDocument.querySelector('p'); if (e) return parseFloat(getComputedStyle(e).fontSize); } return 0; }); assert(Math.abs(f - px(20)) < 0.11, 'next book ' + f); await close();
    await page.reload({ waitUntil: 'networkidle0' }); assert((await ev(async () => (await import('./js/settings.js')).settings.get('fontSizePt'))) === 20, 'not persisted'); await open('^Font Nasty'); checkNasty(await measure(), 20, 'reload'); await close();
  });
  await step('Per-book override wins over the global size (in both flows) and global changes then leave that book alone; Use-global returns', async () => {
    for (const flow of ['scrolled', 'paginated']) { await set({ flow, flowChosen: true, fontSizePt: 12 }); const id = await open('^Font Nasty'); await ev(async (id) => { const S = await import('./js/store.js'); const b = await S.setOverride(id, { fontSizePt: 18 }); window.__reader.book = b; (await import('./js/reader.js')).applyAppearance(); }, id); await sleep(1500);
      checkNasty(await measure(), 18, 'override ' + flow); await set({ fontSizePt: 30 }); await sleep(1200); checkNasty(await measure(), 18, 'override vs global ' + flow); const sh = await shown(); assert(sh === 18, 'Aa shows ' + sh);
      await ev(async (id) => { const S = await import('./js/store.js'); window.__reader.book = await S.resetOverrides(id); (await import('./js/reader.js')).applyAppearance(); }, id); await sleep(1500); checkNasty(await measure(), 30, 'back to global ' + flow); await close(); }
    await set({ fontSizePt: 15 });
  });
  await step('Margins and line spacing (incl. the book’s own p { line-height: 12px !important }) still apply, globally and per book', async () => {
    await set({ flow: 'scrolled', fontSizePt: 15, lineHeight: 1.9, margin: 40 }); const id = await open('^Font Nasty'); let m = await measure(); assert(m.pad === '40px', 'margin ' + m.pad); assert(Math.abs(parseFloat(m.lh['t-p']) - 1.9 * 20) < 0.6, 'lh ' + m.lh['t-p']);
    await ev(async (id) => { const S = await import('./js/store.js'); window.__reader.book = await S.setOverride(id, { lineHeight: 1.2, margin: 10 }); (await import('./js/reader.js')).applyAppearance(); }, id); await sleep(1200); m = await measure(); assert(m.pad === '10px' && Math.abs(parseFloat(m.lh['t-id']) - 24) < 0.6, JSON.stringify([m.pad, m.lh['t-id']]));
    await ev(async (id) => { const S = await import('./js/store.js'); await S.resetOverrides(id); }, id); await close(); await set({ lineHeight: 1.5, margin: 20 });
  });
  await step('After a pinch (live restyle, then re-layout): computed size == the pt shown in Aa, in both flows; big/small elements stay in proportion', async () => {
    const pinch = async (from, to) => { const pts = (d) => [{ x: 195 - d / 2, y: 420, id: 1 }, { x: 195 + d / 2, y: 420, id: 2 }]; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
      for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + (to - from) * i / 12) }); await sleep(35); } await sleep(500); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(1800); };
    for (const flow of ['scrolled', 'paginated']) { await set({ flow, flowChosen: true, fontSizePt: 15, pinchSens: 'slow' }); await open('^Font Nasty'); await pinch(100, 260); const g = await ev(async () => (await import('./js/settings.js')).settings.get('fontSizePt')); assert(g > 17, 'pinch did nothing ' + g);
      const m = await measure(); checkNasty(m, g, 'pinch ' + flow); const sh = await shown(); assert(sh === g, `Aa ${sh} vs ${g}`); await close(); }
    await set({ fontSizePt: 15 });
  });
  for (const [re, label] of [['^Saga Book One$', 'MOBI/AZW3/KF8 (converted)']]) await step(`${label}: all text follows the setting (flows × sizes); only headings / <font size> differ, proportionally`, async () => {
    const books = await ev(async () => (await (await import('./js/store.js')).getBooks()).filter((b) => b.origFormat).map((b) => [b.id, b.origFormat])); assert(books.length >= 2, 'mobi+kf8 imported: ' + books.length); const seen = [];
    for (const [id, kind] of books) for (const flow of ['scrolled', 'paginated']) for (const pt of [12, 24]) {
      await set({ flow, flowChosen: true, fontSizePt: pt }); await ev(async (id) => { (await import('./js/reader.js')).openReader(id); }, id); await page.waitForFunction(() => !!document.querySelector('#viewer iframe') && !!window.__reader?.loc, { timeout: 25000 }); await sleep(1000);
      const r = await ev(() => { const bad = []; let n = 0; for (const f of document.querySelectorAll('#viewer iframe')) { const d = f.contentDocument; const base = parseFloat(getComputedStyle(d.documentElement).fontSize); for (const e of d.body.querySelectorAll('*')) { if (![...e.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())) continue; n++; const k = +(parseFloat(getComputedStyle(e).fontSize) / base).toFixed(2); if (![1, 1.6, 1.35, 1.15, 1.8, 0.85, 0.75, 0.9].includes(k)) bad.push(e.tagName + '@' + k); } } return { bad, n, html: parseFloat(getComputedStyle(document.querySelector('#viewer iframe').contentDocument.documentElement).fontSize) }; });
      assert(r.n > 0 && !r.bad.length && Math.abs(r.html - px(pt)) < 0.11, `${kind} ${flow} ${pt}: ${JSON.stringify(r)}`); seen.push(kind + ':' + flow[0] + pt); await close(); }
    return seen.length + ' combos';
  });
  await step('Fixed-layout EPUB: the publisher’s design (26 px / 44 px, absolute) is kept; Aa explains it', async () => {
    for (const flow of ['scrolled', 'paginated']) { await set({ flow, flowChosen: true, fontSizePt: 22 }); await open('^Font Fixed'); const m = await ev(() => { const d = document.querySelector('#viewer iframe').contentDocument; return { p: parseFloat(getComputedStyle(d.getElementById('t-fx-p')).fontSize), h: parseFloat(getComputedStyle(d.getElementById('t-fx-h')).fontSize), pos: getComputedStyle(d.getElementById('t-fx-p')).position, fixed: !!window.__reader.fixed }; });
      assert(m.p === 26 && m.h === 44 && m.pos === 'absolute' && m.fixed, flow + ' ' + JSON.stringify(m)); await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#fixed-note'); await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); await close(); }
    await set({ fontSizePt: 15 });
  });
  await step('PDF, Original pages: global text size doesn’t (and can’t) resize the page — the Appearance sheet says so and points to Zoom / Text view', async () => {
    await set({ flow: 'scrolled', flowChosen: true, fontSizePt: 15 }); await open('^Text Layer Test|Chapter'); await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('#pdf-note'); const t = await ev(() => document.querySelector('#pdf-note').textContent + '|' + [...document.querySelectorAll('#pdf-view-seg button')].map((b) => b.textContent).join()); assert(/Zoom/.test(t) && /Text \(reflow\)/.test(t), t);
    await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); await close();
  });
  await step('PDF, Text view (reflow): text size / font / line spacing / margins apply — headings and paragraphs rebuilt; pt shown == computed; global change, per-book scope, pinch, reload', async () => {
    await set({ flow: 'scrolled', flowChosen: true, fontSizePt: 15, lineHeight: 1.5, margin: 20 }); const id = await open('^Text Layer Test|Chapter'); await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('[data-pdfview=text]'); await ev(() => document.querySelector('[data-pdfview=text]').click());
    await page.waitForFunction(() => document.querySelectorAll('.pdf-tpage[data-filled]').length >= 2, { timeout: 20000 }); await sleep(500);
    const q = () => ev(() => { const v = document.querySelector('#viewer'); const p = v.querySelector('.pdf-tpage p'); return { p: parseFloat(getComputedStyle(p).fontSize), h: v.querySelector('.pdf-tpage h3') ? parseFloat(getComputedStyle(v.querySelector('.pdf-tpage h3')).fontSize) : 0, nh: v.querySelectorAll('h3').length, np: v.querySelectorAll('.pdf-tpage p').length, lh: parseFloat(getComputedStyle(p).lineHeight), pad: parseFloat(getComputedStyle(v.querySelector('.pdf-tstage')).paddingLeft), longest: Math.max(...[...v.querySelectorAll('.pdf-tpage p')].map((x) => x.textContent.length)) }; });
    let m = await q(); assert(Math.abs(m.p - 20) < 0.11 && m.nh >= 2 && m.np >= 3 && m.longest > 300 && m.h > m.p, 'text view ' + JSON.stringify(m)); assert(Math.abs(m.lh - 30) < 0.6 && m.pad === 20, 'lh/margin ' + JSON.stringify(m));
    const sh = await shown(); assert(sh === 15, 'Aa ' + sh);
    await set({ fontSizePt: 24, lineHeight: 1.8, margin: 40 }); await sleep(500); m = await q(); assert(Math.abs(m.p - 32) < 0.11 && Math.abs(m.lh - 57.6) < 0.7 && m.pad === 40, 'global change ' + JSON.stringify(m));
    await ev(async (id) => { const S = await import('./js/store.js'); window.__pdf.book = await S.setOverride(id, { fontSizePt: 12 }); const { settings } = await import('./js/settings.js'); settings.set({ margin: 41 }); }, id); await sleep(500); m = await q(); assert(Math.abs(m.p - 16) < 0.11, 'per-book override ' + m.p); await set({ fontSizePt: 30 }); await sleep(400); m = await q(); assert(Math.abs(m.p - 16) < 0.11, 'override must win ' + m.p);
    // pinch in text view writes the book's own size (it has one)
    const pts = (d) => [{ x: 195 - d / 2, y: 420, id: 1 }, { x: 195 + d / 2, y: 420, id: 2 }]; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(100) }); for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(100 + 160 * i / 12) }); await sleep(35); } await sleep(500); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(900);
    m = await q(); const ov = await ev(async (id) => (await (await import('./js/store.js')).getBook(id)).overrides.fontSizePt, id); assert(m.p > 17 && Math.abs(m.p - px(ov)) < 0.11, `pinch ${m.p}px vs book ${ov}pt`);
    await ev(async (id) => { await (await import('./js/store.js')).resetOverrides(id); window.__pdf.book.overrides = null; }, id); await close(); await page.reload({ waitUntil: 'networkidle0' }); await open('^Text Layer Test|Chapter'); const mode = await ev(() => document.querySelector('#viewer').classList.contains('pdf-text-mode')); assert(mode, 'text view not remembered'); await sleep(800); m = await q(); assert(Math.abs(m.p - 40) < 0.11, 'after reload ' + m.p);
    await set({ fontSizePt: 15, margin: 20, lineHeight: 1.5 }); await ev(() => document.querySelector('#r-aa').click()); await page.waitForSelector('[data-pdfview=pages]'); await ev(() => document.querySelector('[data-pdfview=pages]').click()); await sleep(1500); const back = await ev(() => ({ canvas: document.querySelectorAll('#viewer canvas').length, t: document.querySelectorAll('.pdf-tpage').length })); assert(back.canvas >= 1 && back.t === 0, 'back to pages ' + JSON.stringify(back)); await ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); await close();
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  await browser.close(); const f = results.filter((r) => !r[0]); console.log(`\n${results.length - f.length}/${results.length} passed`); process.exit(f.length ? 1 : 0);
})();

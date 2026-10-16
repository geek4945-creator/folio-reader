// v0.5.8 highlights & notes: arbitrary ranges (phrase, nested markup, several paragraphs, across page boundaries via drag handles), colours, notes, tap-to-edit,
// the Contents "Highlights & Notes" tab (excerpt + expand, jump, edit, delete, copy / export), scroll mode, word-hold coexistence, persistence, Drive sync, backup.
const puppeteer = require('puppeteer-core'); const path = require('path'); const { execSync } = require('child_process');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const PFX = /flimsy/i.test(APP) ? 'flimsy' : 'folio';
execSync(`node ${path.join(__dirname, 'make-notes-epub.js')} /tmp/notes-epub`, { stdio: 'ignore' }); const BOOK = '/tmp/notes-epub/notes-book.epub';
const S = makeState(); const C = S.cloud;
S.dict = { calls: [], reply() { return { status: 200, body: [{ word: 'harbour', phonetic: '', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A sheltered port.' }] }] }] }; } };

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = [];
  const mk = async (ctx, { login = false } = {}) => {
    const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); }); await install(page, S); if (login) await page.evaluateOnNewDocument(fakeLogin());
    await page.goto(APP, { waitUntil: 'networkidle0' }); return page;
  };
  const until = async (fn, ms = 15000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(120); } };
  const importFiles = async (page, ...files) => { const n0 = await page.evaluate(async () => (await (await import('./js/store.js')).getBooks()).length); await (await page.$('#file-input')).uploadFile(...files); await until(() => page.evaluate(async (n) => (await (await import('./js/store.js')).getBooks()).length >= n, n0 + files.length), 20000, 'import'); };
  const open = (page) => page.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => /Notes Book/.test(b.title)); (await import('./js/reader.js')).openReader(b.id); });
  const close = (page) => page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
  const rendered = (page) => until(() => page.evaluate(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc && window.__reader.ready), 20000, 'reader');
  const recs = (page) => page.evaluate(async () => (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => x.kind === 'hl' && !x.del).map((x) => ({ id: x.id, text: x.text, note: x.note, color: x.color, chapter: x.chapter, cfi: x.cfiRange, sec: x.sec })).sort((a, b) => a.sec - b.sec));
  // select by text: from the start of `from` to the end of `to` (both strings inside the visible section document); native selection, so the real selectionchange path runs
  const selectText = (page, from, to) => page.evaluate((from, to) => {
    const c = window.__reader.rendition.getContents().find((k) => k.document.body.textContent.includes(from)); const doc = c.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
    const flat = nodes.map((x) => x.data).join(''); const s = flat.indexOf(from), e = flat.indexOf(to, s) + to.length; const at = (pos, end) => { let acc = 0; for (const x of nodes) { if (pos < acc + x.data.length || (end && pos === acc + x.data.length)) return [x, pos - acc]; acc += x.data.length; } return [nodes[nodes.length - 1], nodes[nodes.length - 1].data.length]; };
    const [sn, so] = at(s, false), [en, eo] = at(e, true); const sel = c.window.getSelection(); sel.setBaseAndExtent(sn, so, en, eo); return sel.toString().length;
  }, from, to);
  const menu = (page) => until(() => page.evaluate(() => { const m = document.querySelector('#an-menu'); return m && m.style.visibility !== 'hidden' ? { n: m.querySelectorAll('.an-dot').length, text: m.textContent } : null; }), 5000, 'selection menu');
  const noMenu = (page) => until(() => page.evaluate(() => !document.querySelector('#an-menu')), 4000, 'menu gone');
  const colorBtn = (page, c) => page.evaluate((c) => document.querySelector(`#an-menu .an-dot[data-color=${c}]`).click(), c);
  const painted = (page, color) => page.evaluate((color) => window.__reader.rendition.getContents().reduce((a, k) => { const h = k.window.CSS.highlights.get('folio-hl-' + color); return a + (h ? [...h].map((r) => r.toString()).join('|').length : 0); }, 0), color);
  const paintedText = (page, color) => page.evaluate((color) => window.__reader.rendition.getContents().flatMap((k) => { const h = k.window.CSS.highlights.get('folio-hl-' + color); return h ? [...h].map((r) => r.toString().replace(/\s+/g, ' ').trim()) : []; }), color);
  const handlePos = (page, which) => page.evaluate((which) => { const e = document.querySelector('#an-h-' + which); if (!e || e.style.visibility === 'hidden') return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, which);
  const selLen = (page) => page.evaluate(() => window.__reader.rendition.getContents().map((k) => k.window.getSelection().toString().length).reduce((a, b) => a + b, 0));
  const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const toStart = async (page) => { await page.evaluate(() => window.__reader.rendition.display(window.__reader.epub.spine.get(0).href)); await sleep(700); };
  const wordXY = (page, word) => page.evaluate((word) => { for (const c of window.__reader.rendition.getContents()) { const doc = c.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(word); if (i < 0) continue; const r = doc.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const b = r.getBoundingClientRect(); const f = c.window.frameElement.getBoundingClientRect(); if (b.left + f.left < 10 || b.right + f.left > 380 || b.top + f.top < 60 || b.bottom + f.top > 740) continue; return { x: b.left + b.width / 2 + f.left, y: b.top + b.height / 2 + f.top }; } } return null; }, word);
  const pageNo = (page) => page.evaluate(() => window.__reader.rendition.currentLocation().start.displayed.page);

  let A = await mk(await browser.createBrowserContext());
  await step('Import the test book and open it (scroll mode, the default); selecting a phrase shows the menu with colours, Note, Define, Copy and two handles', async () => {
    await importFiles(A, BOOK); await open(A); await rendered(A);
    const n = await selectText(A, 'Paragraph 1.1 begins here', 'quiet'); assert(n > 20, 'selection ' + n);
    const m = await menu(A); assert(m.n === 5 && /Note/.test(m.text) && /Define/.test(m.text) && /Copy/.test(m.text), JSON.stringify(m));
    assert(await handlePos(A, 'start') && await handlePos(A, 'end'), 'handles missing');
  });
  await step('Tapping a colour saves a highlight (full excerpt, CFI range, chapter, colour), paints it and clears the selection', async () => {
    await colorBtn(A, 'yellow'); await noMenu(A); await sleep(300);
    const r = await recs(A); assert(r.length === 1, JSON.stringify(r)); const x = r[0];
    assert(x.text.startsWith('Paragraph 1.1 begins here') && x.text.endsWith('quiet') && x.color === 'yellow' && x.chapter === 'Chapter One' && /^epubcfi\(.*,.*,.*\)$/.test(x.cfi), JSON.stringify(x));
    const ns = (t) => t.replace(/\s+/g, ''); const pt = await paintedText(A, 'yellow'); assert(pt.length === 1 && ns(pt[0]) === ns(x.text), JSON.stringify(pt)); assert((await selLen(A)) === 0, 'selection not cleared');
  });
  await step('Multi-paragraph selection (nested <em>/<b> markup, three paragraphs) saves as ONE range with the whole text and paints all of it', async () => {
    await selectText(A, 'Paragraph 1.2 begins', 'Paragraph 1.3 ends here'); await menu(A); await colorBtn(A, 'green'); await noMenu(A); await sleep(300);
    const r = (await recs(A)).find((x) => x.color === 'green'); assert(r && /Paragraph 1\.2 begins/.test(r.text) && /Paragraph 1\.2 ends here/.test(r.text) && /Paragraph 1\.3 begins/.test(r.text) && r.text.endsWith('Paragraph 1.3 ends here') && r.text.length > 500, r && r.text.length);
    const pt = await paintedText(A, 'green'); assert(pt.length === 1 && pt[0].replace(/\s+/g, '') === r.text.replace(/\s+/g, '') && / Paragraph 1\.3 begins/.test(r.text), 'painted ' + pt.map((x) => x.length));
  });
  await step('Drag the end handle: the selection grows word by word on the page (touch handle, no native menu needed)', async () => {
    await selectText(A, 'Paragraph 1.1 begins', 'Paragraph 1.1 begins'); await menu(A); const l0 = await selLen(A);
    const h = await handlePos(A, 'end'); assert(h, 'no end handle');
    await A.mouse.move(h.x, h.y); await A.mouse.down(); await A.mouse.move(h.x + 120, h.y + 4, { steps: 6 }); await A.mouse.move(h.x + 150, h.y + 40, { steps: 6 }); const during = await selLen(A); await A.mouse.up(); await sleep(250);
    const l1 = await selLen(A); assert(l1 > l0 + 40 && during > l0, `${l0} -> ${during} -> ${l1}`); await menu(A);
    // the start handle moves the other end
    const hs = await handlePos(A, 'start'); await A.mouse.move(hs.x, hs.y); await A.mouse.down(); await A.mouse.move(hs.x - 30, hs.y, { steps: 4 }); await A.mouse.up(); await sleep(250);
    return `${l0} → ${l1}`;
  });
  await step('Scroll mode: dragging a handle to the bottom edge auto-scrolls and keeps extending the selection past the visible text', async () => {
    await selectText(A, 'Paragraph 1.4 begins', 'Paragraph 1.4 begins'); await menu(A); const sc = () => A.evaluate(() => window.__reader.rendition.manager.container.scrollTop); const t0 = await sc(); const l0 = await selLen(A);
    const h = await handlePos(A, 'end'); await A.mouse.move(h.x, h.y); await A.mouse.down(); await A.mouse.move(h.x, 740, { steps: 8 }); await sleep(1600); const t1 = await sc(); await A.mouse.up(); await sleep(300);
    const l1 = await selLen(A); assert(t1 > t0 + 80 && l1 > l0 + 300, `scroll ${t0}→${t1}, len ${l0}→${l1}`); await menu(A); await click(A, '#an-x'); await noMenu(A); assert((await selLen(A)) === 0, 'not cleared');
    return `scrollTop ${t0}→${t1}`;
  });
  await step('Switch to Pages (paginated) and reopen', async () => {
    await close(A); await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ flow: 'paginated', flowChosen: true })); await open(A); await rendered(A); await A.evaluate(() => window.__reader.rendition.display(window.__reader.epub.spine.get(0).href)); await sleep(700);
    assert((await paintedText(A, 'yellow')).length >= 1, 'saved highlights are painted after reopening');
  });
  await step('Dragging a handle to the page edge turns the page and keeps extending: one range across the page boundary is saved and painted whole', async () => {
    await selectText(A, 'Paragraph 1.1 begins', 'Paragraph 1.1 begins'); await menu(A); const p0 = await pageNo(A); const l0 = await selLen(A);
    const h = await handlePos(A, 'end'); await A.mouse.move(h.x, h.y); await A.mouse.down(); await A.mouse.move(370, h.y, { steps: 8 });
    await until(async () => (await pageNo(A)) > p0, 6000, 'auto page turn'); await sleep(900);
    const p1 = await pageNo(A); const mid = 300; await A.mouse.move(150, mid, { steps: 6 }); await A.mouse.up(); await sleep(300);
    const l1 = await selLen(A); assert(p1 > p0 && l1 > l0 + 400, `pages ${p0}→${p1}, len ${l0}→${l1}`); await menu(A);
    await colorBtn(A, 'blue'); await noMenu(A); await sleep(300);
    const r = (await recs(A)).find((x) => x.color === 'blue'); assert(r && r.text.startsWith('Paragraph 1.1 begins') && r.text.length > l0 + 400, JSON.stringify(r && r.text.length));
    const pt = await paintedText(A, 'blue'); assert(pt.length === 1 && pt[0].replace(/\s+/g, '') === r.text.replace(/\s+/g, ''), 'painted pieces: ' + pt.length + ' ' + (pt[0] || '').length + ' vs ' + r.text.length);
    return `pages ${p0}→${p1}, ${r.text.length} characters`;
  });
  await step('Selection menu: Define opens the word bubble without a stale menu', async () => {
    await toStart(A);
    await selectText(A, 'Paragraph 1.1 begins', 'begins'); await menu(A); await click(A, '#an-define'); await A.waitForSelector('#wl-bubble', { timeout: 8000 }); await noMenu(A);
    await A.evaluate(() => window.__folioBack()); await sleep(200); assert(!(await A.$('#wl-bubble')), 'bubble still open');
  });
  await step('Note: the ✎ Note button saves a highlight and opens the editor on the note; saving stores it and underlines the highlight', async () => {
    await toStart(A); await selectText(A, 'Paragraph 1.2 ends', 'here'); await menu(A); await click(A, '#an-note'); await A.waitForSelector('#an-note-text', { timeout: 5000 }); await sleep(250);
    assert(await A.evaluate(() => document.activeElement && document.activeElement.id === 'an-note-text'), 'note field not focused');
    await A.type('#an-note-text', 'Remember this line'); await click(A, '#an-save'); await sleep(400);
    const r = (await recs(A)).find((x) => x.note); assert(r && r.note === 'Remember this line' && r.text === 'Paragraph 1.2 ends here', JSON.stringify(r));
    assert((await A.evaluate(() => window.__reader.rendition.getContents().some((k) => k.window.CSS.highlights.get('folio-hl-noted')))), 'noted underline missing');
  });
  await step('Tap a highlight: its editor opens (no page turn); change the colour and save; the painting follows', async () => {
    const p0 = await pageNo(A);
    const xy = await A.evaluate(() => { for (const k of window.__reader.rendition.getContents()) { const h = k.window.CSS.highlights.get('folio-hl-' + 'yellow'); const noted = k.window.CSS.highlights.get('folio-hl-noted'); if (noted) { const r = [...noted][0].getClientRects()[0]; const f = k.window.frameElement.getBoundingClientRect(); return { x: r.left + r.width / 2 + f.left, y: r.top + r.height / 2 + f.top }; } void h; } return null; });
    assert(xy, 'no noted highlight on screen'); await A.mouse.click(xy.x, xy.y); await A.waitForSelector('#an-save', { timeout: 4000 });
    assert((await pageNo(A)) === p0, 'the tap turned the page'); assert((await A.evaluate(() => document.querySelector('#an-note-text').value)) === 'Remember this line', 'note not shown');
    await click(A, '.an-colors .an-dot[data-color=purple]'); await click(A, '#an-save'); await sleep(400);
    const r = (await recs(A)).find((x) => x.note); assert(r.color === 'purple', r.color); assert((await paintedText(A, 'purple')).includes('Paragraph 1.2 ends here'), 'repaint missing');
  });
  await step('Contents → Highlights & Notes: tab count, excerpts (long ones truncated with Show more), colour stripe, note; filters', async () => {
    await click(A, '#r-toc'); await A.waitForSelector('.seg [data-tab=notes]'); const lab = await A.evaluate(() => document.querySelector('[data-tab=notes]').textContent); assert(/Highlights & Notes/.test(lab), lab);
    const tabs = await A.evaluate(() => [...document.querySelectorAll('.sheet .seg [data-tab]')].map((b) => b.dataset.tab)); assert(tabs.join() === 'toc,bookmarks,notes,words', tabs.join());
    await click(A, '[data-tab=notes]'); await A.waitForSelector('#an-list .an-item', { timeout: 5000 });
    const items = await A.evaluate(() => [...document.querySelectorAll('#an-list .an-item')].map((e) => ({ t: e.querySelector('.an-text').textContent, c: e.dataset.color, n: e.querySelector('.an-notebox')?.textContent || '', more: !!e.querySelector('.an-more') })));
    assert(items.length === 4, JSON.stringify(items.map((x) => x.t.slice(0, 30)))); const long = items.find((x) => x.more); assert(long && long.t.endsWith('…') && long.t.length < 260, 'long excerpt not truncated: ' + (long && long.t.length));
    assert(items.some((x) => /Remember this line/.test(x.n) && x.c === 'purple'), JSON.stringify(items));
    await click(A, '.an-more'); await sleep(250); const full = await A.evaluate(() => [...document.querySelectorAll('#an-list .an-text')].map((e) => e.textContent.length).sort((a, b) => b - a)[0]); assert(full > 1000, 'Show more did not expand: ' + full);
    await click(A, '[data-filter=notes]'); await sleep(300); assert((await A.evaluate(() => document.querySelectorAll('#an-list .an-item').length)) === 1, 'notes filter'); await click(A, '[data-filter=all]'); await sleep(300); await A.evaluate(() => window.__folioBack()); await sleep(300);
  });
  await step('Tapping a list item jumps to the highlight (closes the sheet, reader at that place); edit and delete from the list', async () => {
    await A.evaluate(() => { const rn = window.__reader.rendition; return rn.display(rn.book.spine.get(1).href); }); await sleep(600);
    await click(A, '#r-toc'); await A.waitForSelector('[data-tab=notes]'); await click(A, '[data-tab=notes]'); await A.waitForSelector('#an-list .an-item');
    await A.evaluate(() => { const it = [...document.querySelectorAll('#an-list .an-item')].find((e) => /Remember/.test(e.textContent)); it.querySelector('.an-main').click(); }); await sleep(900);
    assert(!(await A.$('.sheet')), 'sheet still open: ' + await A.evaluate(() => document.querySelector('#overlay').innerHTML.slice(0, 400))); const href = await A.evaluate(() => window.__reader.rendition.currentLocation().start.href); assert(/c1/.test(href), 'did not jump back to chapter 1: ' + href);
    assert((await paintedText(A, 'purple')).length === 1, 'highlight not visible after jump');
    await click(A, '#r-toc'); await A.waitForSelector('[data-tab=notes]'); await click(A, '[data-tab=notes]'); await A.waitForSelector('#an-list .an-item');
    await A.evaluate(() => { const it = [...document.querySelectorAll('#an-list .an-item')].find((e) => /Remember/.test(e.textContent)); it.querySelector('.an-edit').click(); }); await A.waitForSelector('#an-save'); await A.evaluate(() => { document.querySelector('#an-note-text').value = 'Edited from the list'; }); await click(A, '#an-save'); await sleep(400);
    assert((await recs(A)).some((x) => x.note === 'Edited from the list'), 'edit lost');
    await A.waitForSelector('#an-list .an-item'); await A.evaluate(() => { const it = [...document.querySelectorAll('#an-list .an-item')].find((e) => /Edited from/.test(e.textContent)); it.querySelector('.an-rm').click(); }); await sleep(500);
    assert((await recs(A)).length === 3, 'delete failed: ' + (await recs(A)).length); assert((await paintedText(A, 'purple')).length === 0, 'deleted highlight still painted');
    await A.evaluate(() => window.__folioBack());
  });
  await step('Word hold and highlights coexist: holding a word opens the bubble (no selection menu); “Highlight…” in the bubble turns the word into a selection with handles; a colour saves it', async () => {
    await toStart(A); const p = await wordXY(A, 'harbour'); assert(p, 'word not visible');
    await A.mouse.move(p.x, p.y); await A.mouse.down(); await sleep(1100); await A.mouse.up(); await A.waitForSelector('#wl-bubble', { timeout: 8000 }); await sleep(500);
    assert(!(await A.$('#an-menu')), 'selection menu appeared next to the bubble'); await A.waitForSelector('#wl-hl'); await click(A, '#wl-hl'); await menu(A); assert(!(await A.$('#wl-bubble')), 'bubble still open');
    assert(await handlePos(A, 'start') && await handlePos(A, 'end'), 'handles missing'); assert((await selLen(A)) === 'harbour'.length, 'selection is ' + (await selLen(A)));
    await colorBtn(A, 'pink'); await noMenu(A); await sleep(300); const r = (await recs(A)).find((x) => x.color === 'pink'); assert(r && r.text === 'harbour', JSON.stringify(r));
  });
  await step('Selecting by double-tap / mouse also works with word lookup on (native selection is not suppressed outside a hold)', async () => {
    await toStart(A); const p = await wordXY(A, 'travellers'); assert(p, 'word not visible'); await A.mouse.click(p.x, p.y, { clickCount: 2 }); await sleep(600); await menu(A); assert((await selLen(A)) >= 'travellers'.length, 'no selection'); await click(A, '#an-x'); await noMenu(A);
  });
  await step('Reload: highlights and notes persist and are painted again; Back closes the selection menu first', async () => {
    const before = await recs(A); await A.reload({ waitUntil: 'networkidle0' }); await open(A); await rendered(A); await toStart(A);
    const after = await recs(A); assert(after.length === before.length && before.length >= 4, before.length + ' vs ' + after.length); assert((await paintedText(A, 'yellow')).length >= 1 && (await paintedText(A, 'pink')).includes('harbour'), 'not painted after reload');
    await selectText(A, 'Paragraph 1.1 begins', 'begins'); await menu(A); await A.evaluate(() => window.__folioBack()); await sleep(250); assert(await A.$('#r-toc'), 'reader closed by the first Back'); assert(!(await A.$('#an-menu')), 'menu still open'); assert((await selLen(A)) === 0, 'selection kept');
  });
  await step('Copy all / Export produce Markdown with chapter heading, quoted excerpt and note', async () => {
    const md = await A.evaluate(async () => { const An = await import('./js/annots.js'); const S = await import('./js/store.js'); const b = (await S.getBooks())[0]; return An.toMarkdown(await An.forBook(b), b); });
    assert(/^# Notes Book/.test(md) && /## Chapter One/.test(md) && /> Paragraph 1\.1 begins here/.test(md), md.slice(0, 200));
    assert(await A.$('#r-toc'), 'no reader toolbar: ' + await A.evaluate(() => document.body.className + ' | ' + document.querySelector('#reader').className + ' | ' + document.querySelector('#reader').children.length)); await click(A, '#r-toc'); await A.waitForSelector('[data-tab=notes]'); await click(A, '[data-tab=notes]'); await A.waitForSelector('#an-export'); assert(!(await A.$eval('#an-export', (e) => e.disabled)) && !(await A.$eval('#an-copy-all', (e) => e.disabled)), 'buttons disabled'); await A.evaluate(() => window.__folioBack());
  });
  /* ---------------- PDF Text (reflow) view ---------------- */
  await step('PDF Text view: select across paragraphs and pages (native selection, same menu), save, paint, reload, tap to edit, notes list from the toolbar', async () => {
    await close(A); await importFiles(A, path.join(__dirname, 'fixtures', 'plain-4pp.pdf'));
    const openPdf = async () => { await A.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => b.format === 'pdf'); (await import('./js/reader.js')).openReader(b.id); }); await until(() => A.evaluate(() => document.querySelector('#reader.pdf-mode') && !document.querySelector('#reader .r-loading')), 20000, 'pdf'); await A.evaluate(async () => (await import('./js/pdfreader.js')).setTextMode(true)); await until(() => A.evaluate(() => document.querySelectorAll('.pdf-tpage[data-filled]').length >= 2), 15000, 'text view'); await sleep(400); };
    await openPdf();
    await A.evaluate(() => { const bs = [...document.querySelectorAll('.pdf-tpage[data-filled] > p')]; const a = bs[0], b = bs[bs.length - 1]; const s = document.createTreeWalker(a, NodeFilter.SHOW_TEXT).nextNode(); const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let e, n; while ((n = w.nextNode())) e = n; window.getSelection().setBaseAndExtent(s, 2, e, Math.max(1, e.data.length - 2)); window.__expect = window.getSelection().toString().replace(/\s+/g, ' ').trim(); });
    await menu(A); await colorBtn(A, 'green'); await noMenu(A); await sleep(300);
    const r = await A.evaluate(async () => (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => x.kind === 'hl' && x.fmt === 'pdf' && !x.del).map((x) => ({ text: x.text, loc: x.loc, color: x.color })));
    const ex = await A.evaluate(() => window.__expect); assert(r.length === 1 && r[0].color === 'green' && r[0].loc.ep.page >= r[0].loc.sp.page && !/Page \d/.test(r[0].text) && r[0].text.replace(/\s+/g, '') === (await A.evaluate(() => window.__expect)).replace(/PAGE\s*\d+/g, '').replace(/\s+/g, ''), JSON.stringify(r).slice(0, 300) + ' EXPECT ' + JSON.stringify(ex));
    const pt = await A.evaluate(() => [...(CSS.highlights.get('folio-hl-green') || [])].map((x) => x.toString().replace(/\s+/g, ' ').trim())); assert(pt.length === 1, 'painted ' + pt.length);
    await close(A); await openPdf(); const pt2 = await A.evaluate(() => [...(CSS.highlights.get('folio-hl-green') || [])].length); assert(pt2 === 1, 'not repainted after reopening: ' + pt2);
    const xy = await A.evaluate(() => { const r = [...CSS.highlights.get('folio-hl-green')][0]; const b = r.getClientRects()[0]; return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await A.mouse.click(xy.x, xy.y); await A.waitForSelector('#an-save', { timeout: 4000 }); await click(A, '#an-save'); await sleep(300);
    await click(A, '#r-notes'); await A.waitForSelector('#an-list .an-item'); assert((await A.evaluate(() => document.querySelectorAll('#an-list .an-item').length)) === 1, 'list'); await A.evaluate(() => window.__folioBack()); await sleep(200); await close(A);
  });
  /* ---------------- sync between two devices + backup ---------------- */
  const P1 = await mk(await browser.createBrowserContext(), { login: true }), P2 = await mk(await browser.createBrowserContext(), { login: true });
  const sync = (p, o = {}) => p.evaluate(async (o) => { const g = await import('./js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 200)); return r; }, o);
  await step('Sync: highlights (CFI range, full text, colour, note) travel through the glossary Drive file; the other device paints them; library file stays free of them', async () => {
    await importFiles(P1, BOOK); await importFiles(P2, BOOK); for (const p of [P1, P2]) await p.evaluate(async () => (await import('./js/google.js')).syncTuning.minGap = 3600e3);
    await P1.evaluate(async () => (await import('./js/settings.js')).settings.set({ flow: 'paginated', flowChosen: true })); await open(P1); await rendered(P1); await toStart(P1);
    await selectText(P1, 'Paragraph 1.1 begins', 'Paragraph 1.2 begins'); await menu(P1); await colorBtn(P1, 'green'); await noMenu(P1); await sleep(300);
    await selectText(P1, 'Paragraph 1.2 ends', 'here'); await menu(P1); await click(P1, '#an-note'); await P1.waitForSelector('#an-note-text'); await sleep(250); await P1.type('#an-note-text', 'synced note'); await click(P1, '#an-save'); await sleep(300);
    await close(P1); await sync(P1); const names = C.names(); assert(names.includes(PFX + '-glossary.json'), names.join());
    const gf = C.json(PFX + '-glossary.json'); const hl = gf.glossary.filter((x) => x.kind === 'hl'); assert(hl.length === 2 && hl.some((x) => x.note === 'synced note' && x.cfiRange && x.text), JSON.stringify(gf).slice(0, 300));
    assert(!JSON.stringify(C.json(PFX + '-sync.json')).includes('synced note'), 'highlights leaked into the library file');
    await sync(P2); const r2 = await recs(P2); assert(r2.length === 2 && r2.some((x) => x.note === 'synced note' && x.color === 'purple' || x.note === 'synced note'), JSON.stringify(r2.map((x) => x.text.slice(0, 20))));
    await P2.evaluate(async () => (await import('./js/settings.js')).settings.set({ flow: 'paginated', flowChosen: true })); await open(P2); await rendered(P2); await toStart(P2); await sleep(500);
    const pt = await paintedText(P2, 'green'); assert(pt.length === 2 && /^Paragraph 1\.1 begins/.test(pt[0]) && /Paragraph 1\.2 begins/.test(pt[0]) && pt[1] === 'Paragraph 1.2 ends here', 'device 2 paints: ' + pt.map((x) => x.slice(0, 30)).join('|'));
    return 'file: ' + hl.length + ' highlights';
  });
  await step('Sync conflicts: a colour/note edit on one device and a deletion on the other converge (newest edit wins, tombstone removes)', async () => {
    await close(P2);
    await P2.evaluate(async () => { const An = await import('./js/annots.js'); const x = (await (await import('./js/db.js')).DB.all('glossary')).find((r) => r.kind === 'hl' && r.note); await An.update(x.id, { note: 'edited on device 2', color: 'blue' }); });
    await P1.evaluate(async () => { const An = await import('./js/annots.js'); const x = (await (await import('./js/db.js')).DB.all('glossary')).find((r) => r.kind === 'hl' && !r.note && !r.del); await An.remove(x.id); });
    await sync(P2); await sync(P1); await sync(P2);
    const a = await recs(P1), b = await recs(P2); assert(a.length === 1 && b.length === 1 && a[0].note === 'edited on device 2' && a[0].color === 'blue' && b[0].id === a[0].id, JSON.stringify([a.map((x) => [x.note, x.color]), b.length]));
    const calls0 = C.calls.length; await sync(P1); await sync(P2); assert(C.calls.slice(calls0).filter((c) => /patch|post/.test(c)).length === 0, 'idle syncs wrote');
  });
  await step('Backup export includes highlights & notes (summary counts them); Merge restores a deleted one, Replace drops one added since', async () => {
    const r = await P1.evaluate(async () => {
      const B = await import('./js/backup.js'); const { DB } = await import('./js/db.js'); const An = await import('./js/annots.js'); const S = await import('./js/store.js');
      const { manifest, stream } = await B.exportBackupStream({}); const parts = []; for await (const c of stream) parts.push(c); const file = new File([new Blob(parts, { type: 'application/zip' })], 'b.zip');
      const inManifest = (manifest.snapshot.glossary || []).filter((x) => !x.del && x.kind === 'hl').length;
      const book = (await S.getBooks())[0]; for (const x of await An.forBook(book)) await DB.del('glossary', x.id);   // lose it entirely (a plain loss, not a deletion)
       const extra = await An.add(book, { text: 'Added after the backup', cfiRange: 'epubcfi(/6/2!/4/2,/1:0,/1:5)', color: 'pink', chapter: 'Chapter One' });
      let P = await B.readBackup(file); const summary = P.summary.highlights; await B.importBackup(P, { mode: 'merge' }); const merged = (await An.forBook(book)).map((x) => x.text.slice(0, 15) + ':' + x.note);
      P = await B.readBackup(file); await B.importBackup(P, { mode: 'replace' }); const replaced = (await An.forBook((await S.getBooks())[0])).map((x) => x.text.slice(0, 15));
      return { inManifest, summary, merged, replaced, extra: extra.id };
    });
    assert(r.inManifest === 1 && r.summary === 1, JSON.stringify(r)); assert(r.merged.some((x) => /edited on device 2/.test(x)) && r.merged.some((x) => /Added after/.test(x)), 'merge: ' + r.merged.join('|')); assert(r.replaced.length === 1 && !r.replaced.some((x) => /Added after/.test(x)), 'replace: ' + r.replaced.join('|'));
    return JSON.stringify(r.replaced);
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

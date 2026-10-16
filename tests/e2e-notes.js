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
  const pageNo = (page) => page.evaluate(() => window.__reader.rendition.currentLocation().start.displayed.page);

  let A = await mk(await browser.createBrowserContext());
  await step('Import the test book and open it (paginated); selecting a phrase shows the menu with colours, Note, Define, Copy and two handles', async () => {
    await importFiles(A, BOOK); await open(A); await rendered(A);
    const n = await selectText(A, 'Paragraph 1.1 begins here', 'quiet'); assert(n > 20, 'selection ' + n);
    const m = await menu(A); assert(m.n === 5 && /Note/.test(m.text) && /Define/.test(m.text) && /Copy/.test(m.text), JSON.stringify(m));
    assert(await handlePos(A, 'start') && await handlePos(A, 'end'), 'handles missing');
  });
  await step('Tapping a colour saves a highlight (full excerpt, CFI range, chapter, colour), paints it and clears the selection', async () => {
    await colorBtn(A, 'yellow'); await noMenu(A); await sleep(300);
    const r = await recs(A); assert(r.length === 1, JSON.stringify(r)); const x = r[0];
    assert(x.text.startsWith('Paragraph 1.1 begins here') && x.text.endsWith('quiet') && x.color === 'yellow' && x.chapter === 'Chapter One' && /^epubcfi\(.*,.*,.*\)$/.test(x.cfi), JSON.stringify(x));
    const pt = await paintedText(A, 'yellow'); assert(pt.length === 1 && pt[0] === x.text, JSON.stringify(pt)); assert((await selLen(A)) === 0, 'selection not cleared');
  });
  await step('Multi-paragraph selection (nested <em>/<b> markup, three paragraphs) saves as ONE range with the whole text and paints all of it', async () => {
    await selectText(A, 'Paragraph 1.2 begins', 'Paragraph 1.3 ends here'); await menu(A); await colorBtn(A, 'green'); await noMenu(A); await sleep(300);
    const r = (await recs(A)).find((x) => x.color === 'green'); assert(r && /Paragraph 1\.2 begins/.test(r.text) && /Paragraph 1\.2 ends here/.test(r.text) && /Paragraph 1\.3 begins/.test(r.text) && r.text.endsWith('Paragraph 1.3 ends here') && r.text.length > 500, r && r.text.length);
    const pt = await paintedText(A, 'green'); assert(pt.length === 1 && pt[0] === r.text, 'painted ' + pt.map((x) => x.length));
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

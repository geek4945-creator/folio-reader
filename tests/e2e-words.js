// v0.5.6 word lookup + per-book glossary (dictionary APIs and Drive are mocked): press-and-hold bubble, glossary first, save to book, saved words, offline cache,
// web link, Back button, auto-extract + review, paste / CSV import, series sharing, highlight, PDF text view, Drive sync between two devices, backup export / import.
const puppeteer = require('puppeteer-core'); const path = require('path'); const { execSync } = require('child_process'); const fs = require('fs');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const PFX = /flimsy/i.test(APP) ? 'flimsy' : 'folio';
execSync(`node ${path.join(__dirname, 'make-words-epubs.js')} /tmp/words-epubs`, { stdio: 'ignore' }); const ONE = '/tmp/words-epubs/ash-one.epub', TWO = '/tmp/words-epubs/ash-two.epub';
const S = makeState(); const C = S.cloud;
const DEFS = {
  ephemeral: { phonetic: '/ɪˈfɛm(ə)ɹəl/', meanings: [{ partOfSpeech: 'adjective', definitions: ['Lasting for a short period of time.', 'Of a plant: short-lived.', 'Existing only briefly.'] }, { partOfSpeech: 'noun', definitions: ['Something short-lived.', 'A mayfly.', 'A passing thing.'] }] },
  serendipity: { phonetic: '', meanings: [{ partOfSpeech: 'noun', definitions: ['The phenomenon of finding good things by chance.'] }] },
  run: { phonetic: '/ɹʌn/', meanings: [{ partOfSpeech: 'verb', definitions: ['To move swiftly on foot.'] }] },
  harbour: { phonetic: '', meanings: [{ partOfSpeech: 'noun', definitions: ['A sheltered port for ships.'] }] },
};
S.dict = { calls: [], serendipityApiDown: true, reply(u) {
  const api = /dictionaryapi/.test(u), wik = /wiktionary/.test(u), dm = /datamuse/.test(u); const q = /sp=([^&]+)/.exec(u); const word = decodeURIComponent(q ? q[1] : u.split('?')[0].split('/').pop()).toLowerCase(); const d = DEFS[word];
  if (api && word === 'serendipity' && this.serendipityApiDown) return { status: 522, body: {} };
  if (!d || (api && word === 'harbour' && false)) return dm ? { status: 200, body: [] } : { status: 404, body: { title: 'No Definitions Found' } };
  if (api) return { status: 200, body: [{ word, phonetic: d.phonetic, meanings: d.meanings.map((m) => ({ partOfSpeech: m.partOfSpeech, definitions: m.definitions.map((x) => ({ definition: x, example: x.startsWith('Lasting') ? 'An ephemeral pleasure.' : undefined })) })) }] };
  if (wik) return { status: 200, body: { en: d.meanings.map((m) => ({ partOfSpeech: m.partOfSpeech, language: 'English', definitions: m.definitions.map((x) => ({ definition: '<a href="/wiki/x">' + x.split(' ')[0] + '</a> ' + x.split(' ').slice(1).join(' ') })) })) } };
  return { status: 200, body: [{ word, defs: d.meanings.flatMap((m) => m.definitions.map((x) => m.partOfSpeech[0] + '\t' + x)) }] };
} };

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
  const open = (page, re) => page.evaluate(async (re) => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re, 'i').test(b.title)); (await import('./js/reader.js')).openReader(b.id); }, re);
  const close = (page) => page.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); });
  const rendered = (page) => until(() => page.evaluate(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc && window.__reader.ready), 20000, 'reader');
  const wordXY = (page, word) => page.evaluate((word) => { for (const c of window.__reader.rendition.getContents()) { const doc = c.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(word); if (i >= 0) { const r = doc.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const b = r.getBoundingClientRect(); const f = c.window.frameElement.getBoundingClientRect(); return { x: f.left + b.left + b.width / 2, y: f.top + b.top + b.height / 2 }; } } } return null; }, word);
  const hold = async (page, x, y, ms = 1000) => { await page.mouse.move(x, y); await page.mouse.down(); await sleep(ms); await page.mouse.up(); };
  const holdWord = async (page, word, ms) => { const p = await wordXY(page, word); assert(p, 'word not found: ' + word); await hold(page, p.x, p.y, ms); };
  const bubble = (page) => page.evaluate(() => { const b = document.querySelector('#wl-bubble'); return b ? { word: document.querySelector('#wl-word')?.textContent, text: b.textContent, gloss: document.querySelector('#wl-gloss')?.textContent || '', dict: document.querySelector('#wl-dict')?.textContent || '', miss: document.querySelector('#wl-miss')?.textContent || '', src: document.querySelector('.wl-src')?.textContent || '', saveLabel: document.querySelector('#wl-save')?.textContent } : null; });
  const waitBubble = (page) => until(async () => { const b = await bubble(page); return b && (b.dict || b.miss) ? b : null; }, 12000, 'bubble');
  const noBubble = async (page) => assert(!(await bubble(page)), 'a bubble is open');
  const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const rec = (page, kind) => page.evaluate(async (kind) => (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => !x.del && x.kind === kind).map((x) => ({ id: x.id, term: x.term, def: x.def, src: x.src, bookKey: x.bookKey, pos: x.pos, ctx: x.ctx, shared: x.shared })), kind);

  let A = await mk(await browser.createBrowserContext());
  await step('Import two books (a series of two); open the first — hold on a word is wired up', async () => {
    await importFiles(A, ONE, TWO);
    await A.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const set = await S.createSet('Saga of Ash'); for (const [i, b] of bs.entries()) await S.assignSet(b.id, set.id, i + 1); });
    await open(A, 'Ash One'); await rendered(A); const p = await wordXY(A, 'ephemeral'); assert(p && p.y > 40 && p.y < 800, JSON.stringify(p));
  });
  await step('Press and hold a word (0.7 s): a bubble shows the word and its dictionary definition; no page turn, toolbars unchanged', async () => {
    const chrome0 = await A.evaluate(() => window.__reader.chrome); await holdWord(A, 'ephemeral');
    const b = await waitBubble(A); assert(b.word === 'ephemeral' && /short period of time/.test(b.dict) && /adjective/.test(b.dict), JSON.stringify(b));
    assert(/ɪˈfɛm/.test(b.text), 'phonetic missing'); assert(/dictionaryapi\.dev/.test(b.src), b.src);
    assert((await A.evaluate(() => window.__reader.chrome)) === chrome0, 'toolbar toggled by the release');
    return b.src;
  });
  await step('Back closes the bubble first (reader stays open); a second Back closes the reader', async () => {
    await A.evaluate(() => window.__folioBack()); await sleep(250); assert(!(await bubble(A)), 'Back did not close the bubble'); assert(await A.evaluate(() => !!window.__reader && !document.querySelector('#reader').hidden), 'reader closed too early');
    await holdWord(A, 'ephemeral'); await waitBubble(A); await A.keyboard.press('Escape'); await sleep(200); assert(!(await bubble(A)), 'Escape did not close the bubble');
    await holdWord(A, 'ephemeral'); await waitBubble(A); const r = await A.evaluate(async () => { document.querySelector('#wl-backdrop, .wl-backdrop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await new Promise((x) => setTimeout(x, 150)); return !document.querySelector('#wl-bubble'); }); assert(r, 'tap outside did not close it'); await sleep(100);
    return 'back / Escape / tap outside';
  });
  await step('A quick tap or a drag does not open the bubble; the setting turns it off; hold time is adjustable', async () => {
    const p = await wordXY(A, 'ephemeral'); await A.mouse.move(p.x, p.y); await A.mouse.down(); await sleep(120); await A.mouse.up(); await sleep(900); await noBubble(A);
    await A.mouse.move(p.x, p.y); await A.mouse.down(); await A.mouse.move(p.x + 40, p.y + 30, { steps: 4 }); await sleep(1000); await A.mouse.up(); await noBubble(A);
    await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ wordLookup: false })); await holdWord(A, 'ephemeral', 1100); await sleep(300); await noBubble(A);
    await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ wordLookup: true, wordHoldSec: 0.3 })); await holdWord(A, 'ephemeral', 450); await waitBubble(A);
    await A.evaluate(() => window.__folioBack()); await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ wordHoldSec: 0.7 }));
    await holdWord(A, 'ephemeral', 450); await sleep(300); await noBubble(A); return 'tap / drag / off / 0.3 s / 0.7 s';
  });
  await step('Dictionary fallback: a dead first source (HTTP 522) falls through to Wiktionary and is then skipped; results are cached', async () => {
    S.dict.calls.length = 0; await holdWord(A, 'serendipity'); const b = await waitBubble(A); assert(/finding good things by chance/.test(b.dict) && /Wiktionary/.test(b.src), JSON.stringify(b));
    const c1 = S.dict.calls.slice(); assert(/dictionaryapi/.test(c1[0]) && /wiktionary/.test(c1[1]), c1.join('\n'));
    await A.evaluate(() => window.__folioBack()); S.dict.calls.length = 0; await holdWord(A, 'serendipity'); await waitBubble(A); assert(S.dict.calls.length === 0, 'cached word hit the network: ' + S.dict.calls.join());
    await A.evaluate(() => window.__folioBack());
    S.dict.calls.length = 0; await holdWord(A, 'harbour'); await waitBubble(A); assert(!/dictionaryapi/.test(S.dict.calls[0]) && /wiktionary/.test(S.dict.calls[0]), 'the dead source was not skipped: ' + S.dict.calls.join());
    await A.evaluate(() => window.__folioBack()); return c1.map((u) => u.split('/')[2]).join(' → ');
  });
  await step('Inflected words fall back to their stem (“running” → “run”); unknown words say so', async () => {
    await holdWord(A, 'running'); const b = await waitBubble(A); assert(/move swiftly/.test(b.dict) && /Showing “run”/.test(b.src), JSON.stringify(b)); await A.evaluate(() => window.__folioBack());
    await holdWord(A, 'zzzqx'); const m = await waitBubble(A); assert(/No dictionary entry for “zzzqx”/.test(m.miss), JSON.stringify(m)); await A.evaluate(() => window.__folioBack());
  });
  await step('Offline: cached words answer from this device; an unseen word says so; “Search the web” link is there', async () => {
    await A.setOfflineMode(true); await A.evaluate(() => window.dispatchEvent(new Event('offline')));
    await holdWord(A, 'ephemeral'); const b = await waitBubble(A); assert(/short period of time/.test(b.dict) && /Saved copy/.test(b.src), JSON.stringify(b)); await A.evaluate(() => window.__folioBack());
    await A.evaluate(async () => { const { DB } = await import('./js/db.js'); await DB.del('dict', 'harbour'); }); await holdWord(A, 'harbour'); const m = await waitBubble(A); assert(/offline/i.test(m.miss), JSON.stringify(m));
    const href = await A.evaluate(() => document.querySelector('#wl-web').href); assert(/google\.com\/search\?q=define(%20|\+)harbour/.test(href), href);
    await A.evaluate(() => window.__folioBack()); await A.setOfflineMode(false);
  });
  await step('Save to book: the word, its definition and the sentence are stored; “Saved” toggles; the Saved words list shows it', async () => {
    await holdWord(A, 'ephemeral'); await waitBubble(A); await click(A, '#wl-save'); await sleep(300); let b = await bubble(A); assert(/Saved/.test(b.saveLabel), b.saveLabel);
    const w = await rec(A, 'word'); assert(w.length === 1 && w[0].term === 'ephemeral' && /short period/.test(w[0].def) && /ephemeral light of the lamp/.test(w[0].ctx) && w[0].pos === 'adjective', JSON.stringify(w));
    await click(A, '#wl-words'); await A.waitForSelector('#sw-list .gl-item', { timeout: 5000 });
    const t = await A.evaluate(() => document.querySelector('#sw-list').textContent); assert(/ephemeral/.test(t) && /short period of time/.test(t) && /lamp/.test(t), t);
    await A.evaluate(() => window.__folioBack());
    await holdWord(A, 'ephemeral'); await waitBubble(A); await click(A, '#wl-save'); await sleep(300); assert((await rec(A, 'word')).length === 0, 'unsave failed'); await click(A, '#wl-save'); await sleep(300); await A.evaluate(() => window.__folioBack()); return t.slice(0, 80);
  });
  await step('Glossary entry from the bubble (＋ Glossary): multi-word term “Aes Sedai”; holding either word then shows the glossary entry FIRST', async () => {
    await holdWord(A, 'Aes'); await waitBubble(A); await click(A, '#wl-gadd'); await A.waitForSelector('#gl-term');
    await A.evaluate(() => { const t = document.querySelector('#gl-term'); const d = document.querySelector('#gl-def'); t.value = 'Aes Sedai'; d.value = 'A member of the order of women who channel the One Power.'; document.querySelector('#gl-save').click(); }); await sleep(400);
    const g = await rec(A, 'term'); assert(g.length === 1 && g[0].term === 'Aes Sedai', JSON.stringify(g));
    await holdWord(A, 'Sedai'); const b = await until(async () => { const x = await bubble(A); return x && x.gloss ? x : null; }, 8000, 'glossary in bubble'); assert(/order of women/.test(b.gloss) && b.word === 'Aes Sedai', JSON.stringify(b));
    const order = await A.evaluate(() => { const k = [...document.querySelector('#wl-bubble').children]; return k.findIndex((e) => e.id === 'wl-gloss') < k.findIndex((e) => e.id === 'wl-dict' || e.id === 'wl-loading' || e.id === 'wl-miss'); }); assert(order, 'glossary must be above the dictionary');
    await click(A, '#wl-gadd'); await A.waitForSelector('#gl-del'); await A.evaluate(() => { document.querySelector('#gl-def').value = 'Edited definition.'; document.querySelector('#gl-save').click(); }); await sleep(400);
    assert((await rec(A, 'term'))[0].def === 'Edited definition.', 'edit failed'); return 'edit ok';
  });
  await step('Words & glossary manager: add / edit / delete / search entries', async () => {
    await A.evaluate(async () => { document.querySelector('[aria-label="Table of contents"]')?.click(); }); await A.waitForSelector('#toc-words', { timeout: 5000 }); await click(A, '#toc-words'); await A.waitForSelector('#gl-root #gl-list');
    await click(A, '#gl-add'); await A.waitForSelector('#gl-term'); await A.evaluate(() => { document.querySelector('#gl-term').value = 'Shayol Ghul'; document.querySelector('#gl-def').value = 'A mountain in the Blight.'; document.querySelector('#gl-save').click(); }); await sleep(500);
    const n = await A.evaluate(() => document.querySelectorAll('#gl-list .gl-item').length); assert(n === 2, 'entries: ' + n);
    await A.evaluate(() => { const s = document.querySelector('#gl-search'); s.value = 'shayol'; s.dispatchEvent(new Event('input')); }); assert((await A.evaluate(() => document.querySelectorAll('#gl-list .gl-item').length)) === 1, 'search');
    await A.evaluate(() => document.querySelector('#gl-list .gl-item .grow').click()); await A.waitForSelector('#gl-del'); await click(A, '#gl-del'); await sleep(500);
    assert((await rec(A, 'term')).length === 1, 'delete failed'); const tomb = await A.evaluate(async () => (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => x.del && x.kind === 'term').length); assert(tomb === 1, 'tombstone missing'); return 'tombstones: ' + tomb;
  });
  await step('Auto-extract: “Find in this book” reads the Glossary + Dramatis Personae pages (dl, bold-term paragraphs, <br> lists) into a review screen', async () => {
    await A.evaluate(() => { document.querySelector('#gl-search').value = ''; }); await click(A, '#gl-find'); await A.waitForSelector('#rv-list .rv-row', { timeout: 15000 });
    const rows = await A.evaluate(() => [...document.querySelectorAll('#rv-list .rv-row')].map((r) => ({ t: r.querySelector('.rv-term').value, d: r.querySelector('.rv-def').value })));
    const names = rows.map((r) => r.t).sort(); const want = ['Aiel', 'Egwene', 'Moiraine', 'Nynaeve', 'Saidar', 'Saidin', 'Ta’veren', 'Warder']; assert(JSON.stringify(names) === JSON.stringify(want), names.join() + ' ≠ ' + want.join());
    assert(rows.find((r) => r.t === 'Saidar').d === 'The female half of the True Source.' && rows.find((r) => r.t === 'Aiel').d === 'A people of the Waste.' && /bonded protector/.test(rows.find((r) => r.t === 'Warder').d) && rows.find((r) => r.t === 'Moiraine').d === 'an Aes Sedai', JSON.stringify(rows));
    await A.evaluate(() => { document.querySelector('#rv-none').click(); }); await A.waitForSelector('#rv-list .rv-row'); await A.evaluate(() => { for (const r of document.querySelectorAll('#rv-list .rv-row')) { const t = r.querySelector('.rv-term').value; if (/^(Saidar|Saidin|Aiel)$/.test(t)) r.querySelector('.rv-on').click(); } });
    const lbl = await A.evaluate(() => document.querySelector('#rv-import').textContent); assert(lbl === 'Import 3', lbl);
    await A.evaluate(() => { const r = [...document.querySelectorAll('#rv-list .rv-row')].find((x) => x.querySelector('.rv-term').value === 'Aiel'); const d = r.querySelector('.rv-def'); d.value = 'Desert people of the Waste.'; d.dispatchEvent(new Event('input')); });
    await click(A, '#rv-import'); await sleep(600); const g = await rec(A, 'term'); const ts = g.map((x) => x.term).sort(); assert(JSON.stringify(ts) === JSON.stringify(['Aes Sedai', 'Aiel', 'Saidar', 'Saidin']), ts.join());
    assert(g.find((x) => x.term === 'Aiel').def === 'Desert people of the Waste.' && g.find((x) => x.term === 'Saidar').src === 'auto', JSON.stringify(g));
    await click(A, '#gl-find'); await A.waitForSelector('#rv-list .rv-row', { timeout: 15000 }); const dup = await A.evaluate(() => [...document.querySelectorAll('#rv-list .rv-row')].map((r) => [r.querySelector('.rv-term').value, r.classList.contains('dupe'), r.querySelector('.rv-on').checked]));
    assert(dup.filter((x) => x[1]).length === 3 && dup.filter((x) => x[1]).every((x) => !x[2]), 'duplicates should be flagged and unticked: ' + JSON.stringify(dup)); await A.evaluate(() => window.__folioBack()); return 'imported ' + (ts.length - 1);
  });
  await step('Import: pasted “term – definition” lines, CSV with quotes + header, and a CSV file; Export CSV round-trips', async () => {
    const lib = await A.evaluate(async () => { const G = await import('./js/glossary.js'); return { t: G.parseText('Dragonmount – a volcano\nShadar Logoth: a ruined city\n  that is cursed\nLoial\ttook an Ogier\n\nnot a pair'), c: G.parseCsv('term,definition,note\n"Tar Valon","City of the White Tower, on an island","note one"\nCaemlyn,"Capital of Andor",\n'), a: G.parseAny('a,b\n"x","y"\n') }; });
    assert(lib.t.length === 3 && lib.t[0].term === 'Dragonmount' && lib.t[1].def === 'a ruined city that is cursed' && lib.t[2].term === 'Loial', JSON.stringify(lib.t));
    assert(lib.c.length === 2 && lib.c[0].def === 'City of the White Tower, on an island' && lib.c[0].note === 'note one', JSON.stringify(lib.c));
    await click(A, '#gl-import'); await A.waitForSelector('#imp-text'); await A.evaluate(() => { const t = document.querySelector('#imp-text'); t.value = 'Dragonmount – a volcano\nShadar Logoth: a ruined city'; }); await click(A, '#imp-go'); await A.waitForSelector('#rv-list .rv-row');
    assert((await A.evaluate(() => document.querySelectorAll('#rv-list .rv-row').length)) === 2, 'paste review'); await click(A, '#rv-import'); await sleep(500);
    fs.writeFileSync('/tmp/words.csv', 'word,meaning\n"Tar Valon","City on an island, home of the Tower"\nCaemlyn,Capital of Andor\nAiel,Should be kept as is\n');
    await click(A, '#gl-import'); await A.waitForSelector('#imp-file'); await (await A.$('#imp-file')).uploadFile('/tmp/words.csv'); await until(() => A.evaluate(() => document.querySelector('#imp-text').value.includes('Caemlyn')), 5000, 'file read'); await click(A, '#imp-go'); await A.waitForSelector('#rv-list .rv-row');
    const unticked = await A.evaluate(() => [...document.querySelectorAll('#rv-list .rv-row')].filter((r) => !r.querySelector('.rv-on').checked).map((r) => r.querySelector('.rv-term').value)); assert(JSON.stringify(unticked) === JSON.stringify(['Aiel']), 'existing term must be unticked: ' + unticked.join());
    await click(A, '#rv-import'); await sleep(500); const g = await rec(A, 'term'); assert(g.length === 8 && g.find((x) => x.term === 'Tar Valon').def === 'City on an island, home of the Tower' && g.find((x) => x.term === 'Aiel').def === 'Desert people of the Waste.', g.map((x) => x.term).join());
    const csv = await A.evaluate(async () => { const G = await import('./js/glossary.js'); const b = (await (await import('./js/store.js')).getBooks()).find((x) => /Ash One/.test(x.title)); return G.toCsv((await G.forBook(b)).own); }); const back = await A.evaluate(async (csv) => (await import('./js/glossary.js')).parseCsv(csv).length, csv); assert(back === 8, 'csv round trip ' + back);
    return '8 entries';
  });
  await step('Series sharing: another book of the series sees the glossary only when sharing is on; holding a word there shows the entry', async () => {
    await A.evaluate(() => window.__folioBack()); await A.evaluate(() => window.__folioBack()); await sleep(300); await close(A).catch(() => {});
    let n = await A.evaluate(async () => { const G = await import('./js/glossary.js'); const b = (await (await import('./js/store.js')).getBooks()).find((x) => /Ash Two/.test(x.title)); return (await G.forBook(b)).terms.length; }); assert(n === 0, 'not shared yet: ' + n);
    await open(A, 'Ash One'); await rendered(A); await A.evaluate(() => { document.querySelector('[aria-label="Table of contents"]').click(); }); await A.waitForSelector('#toc-words'); await click(A, '#toc-words'); await A.waitForSelector('#gl-share'); assert(await A.evaluate(() => !document.querySelector('#gl-share').disabled), 'share toggle disabled');
    await click(A, '#gl-share'); await sleep(500); n = await A.evaluate(async () => { const G = await import('./js/glossary.js'); const b = (await (await import('./js/store.js')).getBooks()).find((x) => /Ash Two/.test(x.title)); return (await G.forBook(b)).terms.length; }); assert(n === 8, 'shared: ' + n);
    await A.evaluate(() => window.__folioBack()); await close(A); await open(A, 'Ash Two'); await rendered(A); await holdWord(A, 'Sedai'); const b = await until(async () => { const x = await bubble(A); return x && x.gloss ? x : null; }, 8000, 'shared glossary'); assert(/Edited definition/.test(b.gloss) && /Ash One/.test(b.gloss), b.gloss);
    await A.evaluate(() => window.__folioBack()); return 'visible in Ash Two';
  });
  await step('Optional highlight: glossary terms are underlined via the CSS Custom Highlight API (no DOM changes)', async () => {
    const dom0 = await A.evaluate(() => window.__reader.rendition.getContents()[0].document.body.innerHTML.length);
    await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ glossaryHighlight: true })); await sleep(700);
    const n = await A.evaluate(() => { const k = window.__reader.rendition.getContents()[0]; const h = k.window.CSS.highlights.get('folio-gl'); return h ? h.size : 0; }); assert(n >= 1, 'no highlight ranges');
    assert((await A.evaluate(() => window.__reader.rendition.getContents()[0].document.body.innerHTML.length)) === dom0, 'the page DOM changed');
    await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ glossaryHighlight: false })); await sleep(500); assert((await A.evaluate(() => { const k = window.__reader.rendition.getContents()[0]; return k.window.CSS.highlights.has('folio-gl'); })) === false, 'highlight not removed'); return n + ' range(s)';
  });
  await step('PDF Text view: hold on a word opens the bubble too', async () => {
    await close(A); await importFiles(A, fx('plain-4pp.pdf')); await open(A, 'plain|pdf|4'); await until(() => A.evaluate(() => document.querySelector('#reader.pdf-mode') && !document.querySelector('#reader .r-loading')), 20000, 'pdf');
    await A.evaluate(async () => (await import('./js/pdfreader.js')).setTextMode(true)); await until(() => A.evaluate(() => document.querySelector('.pdf-tpage p')), 15000, 'text view');
    const pos = await A.evaluate(() => { const p = document.querySelector('.pdf-tpage p'); const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const m = /[A-Za-z]{4,}/.exec(n.data); const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, word: m[0] }; });
    await hold(A, pos.x, pos.y); const b = await waitBubble(A); assert(b.word.toLowerCase() === pos.word.toLowerCase(), JSON.stringify([b.word, pos.word])); await A.evaluate(() => window.__folioBack()); await sleep(200); assert(await A.evaluate(() => !document.querySelector('#reader').hidden), 'pdf closed'); await close(A);
  });
  await step('Settings → Word lookup: toggle, hold-time slider, highlight, Saved words & glossaries list, clear offline definitions', async () => {
    await A.evaluate(() => document.querySelector('[data-tab=settings]').click()); await A.waitForSelector('#sec-words');
    assert(await A.evaluate(() => !!document.querySelector('#word-lookup') && !!document.querySelector('#word-hold') && !!document.querySelector('#gl-highlight')), 'controls missing');
    await A.evaluate(() => { const r = document.querySelector('#word-hold'); r.value = '1.5'; r.dispatchEvent(new Event('input')); }); assert((await A.evaluate(async () => (await import('./js/settings.js')).settings.get('wordHoldSec'))) === 1.5, 'hold time not saved');
    await click(A, '#saved-words-all'); await A.waitForSelector('#aw-root .list-item'); const t = await A.evaluate(() => document.querySelector('#aw-root').textContent); assert(/Saga of Ash One/.test(t) && /8 glossary/.test(t), t); await A.evaluate(() => window.__folioBack());
    await click(A, '#dict-clear'); await sleep(300); assert((await A.evaluate(async () => (await import('./js/dict.js')).cacheSize())) === 0, 'cache not cleared'); await A.evaluate(async () => (await import('./js/settings.js')).settings.set({ wordHoldSec: 0.7 }));
  });

  /* ---------------- sync between two devices + backup ---------------- */
  const P1 = await mk(await browser.createBrowserContext(), { login: true }), P2 = await mk(await browser.createBrowserContext(), { login: true });
  const sync = (p, o = {}) => p.evaluate(async (o) => { const g = await import('./js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 200)); return r; }, o);
  await step('Sync: glossary entries, saved words and the share flag travel through their own Drive file (folio-glossary.json); the library file stays free of them', async () => {
    await importFiles(P1, ONE, TWO); await importFiles(P2, ONE, TWO);
    await P1.evaluate(async () => { const S = await import('./js/store.js'); const bs = await S.getBooks(); const set = await S.createSet('Saga of Ash'); for (const [i, b] of bs.entries()) await S.assignSet(b.id, set.id, i + 1); });
    for (const p of [P1, P2]) await p.evaluate(async () => (await import('./js/google.js')).syncTuning.minGap = 3600e3);
    await P1.evaluate(async () => { const G = await import('./js/glossary.js'); const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Ash One/.test(x.title)); await G.addTerm(b, { term: 'Saidar', def: 'The female half of the True Source.' }); await G.addTerm(b, { term: 'Aiel', def: 'A people of the Waste.', note: 'desert' }); await G.saveWord(b, { term: 'ephemeral', def: 'Lasting a short time.', pos: 'adjective', ctx: 'The ephemeral light.' }); await G.setShared(b, true); });
    await sync(P1); const names = C.names(); assert(names.includes(PFX + '-glossary.json'), names.join());
    const gf = C.json(PFX + '-glossary.json'); assert(gf.domain === 'glossary' && gf.glossary.filter((x) => x.kind === 'term').length === 2 && gf.glossary.filter((x) => x.kind === 'word').length === 1 && gf.glossary.some((x) => x.kind === 'meta' && x.shared), JSON.stringify(gf).slice(0, 300));
    assert(!JSON.stringify(C.json(PFX + '-sync.json')).includes('Saidar'), 'glossary leaked into the library file');
    await sync(P2); const g2 = await rec(P2, 'term'), w2 = await rec(P2, 'word'); assert(g2.length === 2 && w2.length === 1 && w2[0].term === 'ephemeral' && g2.find((x) => x.term === 'Aiel').def === 'A people of the Waste.', JSON.stringify([g2, w2]));
    assert(await P2.evaluate(async () => { const G = await import('./js/glossary.js'); const b = (await (await import('./js/store.js')).getBooks()).find((x) => /Ash Two/.test(x.title)); return (await G.forBook(b)).terms.length === 2; }), 'the shared flag did not travel');
    return 'file: ' + gf.glossary.length + ' records';
  });
  await step('Sync conflicts: the newest edit wins per entry; a deletion on one device removes it on the other (tombstone); edits on both devices merge', async () => {
    await P2.evaluate(async () => { const G = await import('./js/glossary.js'); const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Ash One/.test(x.title)); const t = (await G.forBook(b)).own.find((x) => x.term === 'Aiel'); await G.updateTerm(t.id, { def: 'Desert warriors (edited on the tablet).' }); await G.addTerm(b, { term: 'Warder', def: 'A protector.' }); });
    await P1.evaluate(async () => { const G = await import('./js/glossary.js'); const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Ash One/.test(x.title)); const t = (await G.forBook(b)).own.find((x) => x.term === 'Saidar'); await G.removeEntry(t.id); await G.addTerm(b, { term: 'Saidin', def: 'The male half.' }); });
    await sync(P2); await sync(P1); await sync(P2);
    const a = await rec(P1, 'term'), b = await rec(P2, 'term'); const names = (x) => x.map((e) => e.term).sort().join(); assert(names(a) === 'Aiel,Saidin,Warder' && names(a) === names(b), names(a) + ' | ' + names(b));
    assert(a.find((x) => x.term === 'Aiel').def === 'Desert warriors (edited on the tablet).' && b.find((x) => x.term === 'Aiel').def === a.find((x) => x.term === 'Aiel').def, 'newest edit lost');
    const calls0 = C.calls.length; await sync(P1); await sync(P2); const extra = C.calls.slice(calls0).filter((c) => /patch|post/.test(c)); assert(extra.length === 0, 'idle syncs wrote: ' + extra.join());
    return 'converged: ' + names(a);
  });
  await step('Settings → Sync lists “Glossaries, saved words, highlights & notes”; switching it off stops syncing it', async () => {
    await P1.evaluate(() => document.querySelector('[data-tab=settings]').click()); await P1.waitForSelector('#sec-sync, [id^=sync-dom]', { timeout: 8000 }).catch(() => {});
    const txt = await P1.evaluate(() => document.body.textContent); assert(/Glossaries, saved words, highlights & notes/.test(txt), 'toggle missing from Settings → Sync');
    await P1.evaluate(async () => (await import('./js/google.js')).setDomainEnabled('glossary', false));
    await P1.evaluate(async () => { const G = await import('./js/glossary.js'); const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Ash One/.test(x.title)); await G.addTerm(b, { term: 'Local only', def: 'x' }); }); await sync(P1);
    assert(!JSON.stringify(C.json(PFX + '-glossary.json')).includes('Local only'), 'synced although switched off'); await P1.evaluate(async () => (await import('./js/google.js')).setDomainEnabled('glossary', true)); await sync(P1);
    assert(JSON.stringify(C.json(PFX + '-glossary.json')).includes('Local only'), 'not synced after switching on');
  });
  await step('Backup export includes glossaries; Merge restores them, Replace drops what the backup lacks', async () => {
    const r = await P1.evaluate(async () => {
      const B = await import('./js/backup.js'); const { DB } = await import('./js/db.js'); const { manifest, stream } = await B.exportBackupStream({}); const parts = []; for await (const c of stream) parts.push(c); const blob = new Blob(parts, { type: 'application/zip' }); const file = new File([blob], 'b.zip');
      const before = (await DB.all('glossary')).filter((x) => !x.del && x.kind !== 'meta').length; const inManifest = (manifest.snapshot.glossary || []).filter((x) => !x.del && x.kind !== 'meta').length;
      for (const x of await DB.all('glossary')) if (x.term === 'Aiel') await DB.del('glossary', x.id);   // lose one
      const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /Ash One/.test(x.title)); const G = await import('./js/glossary.js'); await G.addTerm(b, { term: 'Extra after backup', def: 'z' });
      let P = await B.readBackup(file); const summary = P.summary.glossary; await B.importBackup(P, { mode: 'merge' }); const merged = (await DB.all('glossary')).filter((x) => !x.del && x.kind === 'term').map((x) => x.term).sort();
      P = await B.readBackup(file); await B.importBackup(P, { mode: 'replace' }); const replaced = (await DB.all('glossary')).filter((x) => !x.del && x.kind === 'term').map((x) => x.term).sort();
      return { before, inManifest, summary, merged, replaced };
    });
    assert(r.inManifest === r.before && r.summary === r.before, JSON.stringify(r)); assert(r.merged.includes('Aiel') && r.merged.includes('Extra after backup'), 'merge: ' + r.merged.join()); assert(r.replaced.includes('Aiel') && !r.replaced.includes('Extra after backup'), 'replace: ' + r.replaced.join());
    return JSON.stringify(r.replaced);
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

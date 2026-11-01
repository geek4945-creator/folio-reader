// v0.5.20 postponed bundle: reading stats (active time only, synced), the Libby button, "＋ Glossary" from the selection bar + book menu,
// and the experimental KyBook 3 import (tolerant CSV/JSON/.kb parse → preview → apply → summary; unknown files → "send us the file details").
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs'); const { execSync } = require('child_process');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
execSync(`node ${path.join(__dirname, 'make-notes-epub.js')} /tmp/notes-epub`, { stdio: 'ignore' }); const BOOK = '/tmp/notes-epub/notes-book.epub';
// KyBook fixtures (synthetic — no real KyBook 3 export exists to test against)
const KD = '/tmp/kyb-fx'; fs.mkdirSync(KD, { recursive: true });
fs.writeFileSync(KD + '/list.csv', 'Title,Author,Status,Collections,Progress\n"Notes Book","",Finished,"Favourites; Sci-fi",100%\nStats Book,Statler,Reading,Sci-fi,42%\nNot Here,Nobody,Want to read,Later,0\n');
fs.writeFileSync(KD + '/list.json', JSON.stringify({ books: [{ title: 'Stats Book', authors: ['Statler'], state: 'want', tags: ['Winter'] }] }));
fs.writeFileSync(KD + '/Library.sqlite', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200, 7)]));
fs.writeFileSync(KD + '/odd.txt', 'just some words\nnothing tabular here at all\n');
(function tar() { const data = Buffer.from(JSON.stringify({ title: 'Stats Book', author: 'Statler', lang: 'en' })); const hd = Buffer.alloc(512); hd.write('_manifest.json'); hd.write('0000644\0', 100); hd.write('0000000\0', 108); hd.write('0000000\0', 116);
  hd.write(data.length.toString(8).padStart(11, '0') + '\0', 124); hd.write('00000000000\0', 136); hd.write('        ', 148); hd.write('0', 156); hd.write('ustar\0', 257); hd.write('00', 263);
  let sum = 0; for (const b of hd) sum += b; hd.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  fs.writeFileSync(KD + '/book.kb', Buffer.concat([hd, data, Buffer.alloc(512 - (data.length % 512)), Buffer.alloc(1024)])); })();

const S = makeState();
async function mk(ctx, name) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => { if (e.message !== 'Object') page.errs.push(e.message); });
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin()); await page.evaluateOnNewDocument((n) => localStorage.setItem('folio.deviceName', n), name);
  await page.goto(APP, { waitUntil: 'networkidle0' }); await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await sleep(1800);
  await page.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; window.open = (u) => { window.__opened = u; return null; }; }); return page;
}
const sync = (p) => p.evaluate(async () => { await (await import('./js/google.js')).syncNow({}); await new Promise((x) => setTimeout(x, 200)); });
const until = async (fn, ms = 15000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(120); } };
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const closeSheets = (p) => p.evaluate(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
const bookId = (p, re) => p.evaluate(async (re) => (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re).test(b.title)).id, re);
const bookMenu = (p, re) => p.evaluate(async (re) => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((b) => new RegExp(re).test(b.title)); (await import('./js/library.js')).bookMenu(b, {}); }, re);
const rendered = (page) => until(() => page.evaluate(() => !document.querySelector('#reader .r-loading') && !!document.querySelector('#viewer iframe') && !!window.__reader?.loc && window.__reader.ready), 20000, 'reader');
const selectText = (page, from, to) => page.evaluate((from, to) => {
  const c = window.__reader.rendition.getContents().find((k) => k.document.body.textContent.includes(from)); const doc = c.document; const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
  const flat = nodes.map((x) => x.data).join(''); const s = flat.indexOf(from), e = flat.indexOf(to, s) + to.length; const at = (pos, end) => { let acc = 0; for (const x of nodes) { if (pos < acc + x.data.length || (end && pos === acc + x.data.length)) return [x, pos - acc]; acc += x.data.length; } return [nodes[nodes.length - 1], nodes[nodes.length - 1].data.length]; };
  const [sn, so] = at(s, false), [en, eo] = at(e, true); const sel = c.window.getSelection(); sel.setBaseAndExtent(sn, so, en, eo); return sel.toString().length;
}, from, to);
// a fake session on a fake clock: steps = [[secondsAfterStart, progress], ...], then end at endAt
const fakeSession = (p, re, startMs, steps, endAt) => p.evaluate(async (re, startMs, steps, endAt) => {
  const ST = await import('./js/stats.js'); let b = (await (await import('./js/store.js')).getBooks()).find((b) => new RegExp(re).test(b.title));
  if (!b) { const r = (await ST.allStats()).find((x) => new RegExp(re).test(x.bookTitle)); b = { id: 'synced-only', title: r.bookTitle, author: r.bookAuthor, syncKey: r.bookKey }; }   // the book's file isn't on this device yet: same sync key
  const real = Date.now; let t = startMs; Date.now = () => t;
  try { ST.startSession(b); for (const [s, pr] of steps) { t = startMs + s * 1000; ST.activity(b, pr); } t = startMs + endAt * 1000; ST.endSession(); await ST.flush(); await new Promise((r) => setTimeout(r, 300)); }
  finally { Date.now = real; }
  return (await ST.allStats()).filter((r) => r.bookKey === (b.syncKey || r.bookKey) || true).map((r) => ({ id: r.id, secs: r.secs, pages: r.pages, day: r.day, dev: r.devName })); }, re, startMs, steps, endAt);

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const A = await mk(await browser.createBrowserContext(), 'Laptop'); const B = await mk(await browser.createBrowserContext(), 'iPhone');
  const today0 = await A.evaluate(() => { const d = new Date(); d.setHours(9, 0, 0, 0); return d.getTime(); });

  await step('Glossary from the selection bar: “＋ Glossary” opens the term editor prefilled with the selected phrase; saved entry shows in the book menu’s Glossary', async () => {
    await (await A.$('#file-input')).uploadFile(BOOK); await until(() => A.evaluate(async () => (await (await import('./js/store.js')).getBooks()).some((b) => /Notes Book/.test(b.title))), 20000, 'import');
    await A.evaluate(async () => { const b = (await (await import('./js/store.js')).getBooks()).find((b) => /Notes Book/.test(b.title)); (await import('./js/reader.js')).openReader(b.id); }); await rendered(A);
    const n = await selectText(A, 'Paragraph 1.1 begins', 'begins'); assert(n > 5, 'sel ' + n);
    await until(() => A.evaluate(() => { const m = document.querySelector('#an-menu'); return m && m.style.visibility !== 'hidden' && document.querySelector('#an-gloss'); }), 5000, '＋ Glossary button');
    await click(A, '#an-gloss'); await A.waitForSelector('#gl-term', { timeout: 5000 }); const v = await A.$eval('#gl-term', (e) => e.value); assert(/^Paragraph 1\.1 begins$/.test(v), 'term=' + v);
    await A.evaluate(() => { document.querySelector('#gl-def').value = 'The first paragraph opener'; }); await click(A, '#gl-save'); await sleep(500);
    const rec = await A.evaluate(async () => (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => x.kind === 'term' && !x.del).map((x) => x.term + '=' + x.def)); assert(rec.includes('Paragraph 1.1 begins=The first paragraph opener'), rec.join());
    await A.evaluate(async () => { await (await import('./js/reader.js')).closeReader(); }); await sleep(500); await A.evaluate(() => window.__folio.show('library')); await sleep(500);
    await bookMenu(A, 'Notes Book'); await A.waitForSelector('#menu-glossary'); await click(A, '#menu-glossary'); await A.waitForSelector('#gl-list'); const t = await A.$eval('#gl-list', (e) => e.textContent); assert(/Paragraph 1\.1 begins/.test(t), t); await closeSheets(A); return v;
  });
  await step('Opening and paging a book records active reading time for it (reader → stats), closing ends the session', async () => {
    const recs = await A.evaluate(async () => (await (await import('./js/stats.js')).allStats()).map((r) => r.bookTitle + ':' + r.secs)); assert(recs.some((r) => /^Notes Book:/.test(r)), 'no stat for the opened book: ' + recs.join()); return recs.join();
  });
  await step('Active time only: a 20-min pause counts as 3 min; page turns counted; long gaps and the screen-off time don’t count', async () => {
    await A.evaluate(() => window.__mk({ title: 'Stats Book', author: 'Statler' })); await sleep(300);
    await fakeSession(A, '^Stats Book', today0, [[0, 0.10], [60, 0.11], [120, 0.12], [120 + 1200, 0.13]], 1320 + 10);
    const r = await A.evaluate(async () => (await (await import('./js/stats.js')).allStats()).filter((x) => x.bookTitle === 'Stats Book'));
    assert(r.length === 1 && r[0].secs === 310 && r[0].pages === 3 && r[0].devName === 'Laptop', JSON.stringify(r)); return `${r[0].secs}s, ${r[0].pages} pages`;
  });
  await step('Stats screen: today / week / year / streak (3 days) / finished this year / pages, per-book list, note says active time only', async () => {
    await A.evaluate(async (t) => { const { DB } = await import('./js/db.js'); const ST = await import('./js/stats.js'); const S = await import('./js/store.js'); const b = (await S.getBooks()).find((b) => b.title === 'Stats Book');
      for (const k of [1, 2]) { const day = ST.dayOf(t - k * 864e5); await DB.put('glossary', { id: 'st:old:' + S.bookSyncKey(b) + ':' + day, kind: 'stat', bookKey: S.bookSyncKey(b), bookTitle: b.title, bookAuthor: b.author, day, dev: 'old', devName: 'Old phone', secs: 600, pages: 10, p0: 0, p1: 0.1 }); }
      await S.setStatus((await S.getBooks()).find((b) => /Notes Book/.test(b.title)).id, 'finished'); }, today0);
    await A.evaluate(() => window.__folio.show('library')); await A.waitForSelector('#lib-menu'); await click(A, '#lib-menu'); await A.waitForSelector('#menu-stats'); await click(A, '#menu-stats'); await A.waitForSelector('#st-today', { timeout: 8000 });
    const g = await A.evaluate(() => Object.fromEntries(['st-today', 'st-week', 'st-year', 'st-streak', 'st-finished', 'st-pages'].map((i) => [i, document.querySelector('#' + i).textContent])).concat ? 0 : Object.fromEntries(['st-today', 'st-week', 'st-year', 'st-streak', 'st-finished', 'st-pages'].map((i) => [i, document.querySelector('#' + i + ' strong').textContent])));
    const note = await A.$eval('#stats-note', (e) => e.textContent); const books = await A.$$eval('#st-books .st-book', (els) => els.map((e) => e.textContent));
    assert(/^5 min$/.test(g['st-today']) && /^25 min$/.test(g['st-week']) && /^3 days$/.test(g['st-streak']) && g['st-finished'] === '1' && +g['st-pages'] >= 23, JSON.stringify(g));
    assert(/Active reading time only/.test(note) && books.some((t) => /Stats Book/.test(t)), books.join('|')); await closeSheets(A); return JSON.stringify(g);
  });
  await step('Book menu → Reading stats: time, pages, %, days, time-left estimate', async () => {
    await bookMenu(A, '^Stats Book'); await A.waitForSelector('#menu-book-stats'); await click(A, '#menu-book-stats'); await A.waitForSelector('#bs-time', { timeout: 8000 });
    const t = await A.evaluate(() => ['bs-time', 'bs-pages', 'bs-pct', 'bs-days'].map((i) => document.querySelector('#' + i + ' strong').textContent)); assert(t[0] === '25 min' && t[1] === '23' && t[3] === '3', t.join()); await closeSheets(A); return t.join(' · ');
  });
  await step('Stats sync: the iPhone sees the laptop’s time; reading there adds up per device (never double-counted)', async () => {
    const today = (p) => p.evaluate(async (t) => (await (await import('./js/stats.js')).summary(t + 3 * 3600e3)).today, today0);
    await sync(A); await sync(B); const a0 = await today(A); let s = await today(B); assert(s === a0 && a0 >= 310, 'iPhone today=' + s + ' laptop=' + a0);
    await fakeSession(B, '^Stats Book', today0 + 2 * 3600e3, [[0, 0.2], [100, 0.21]], 110); await sync(B); await sync(A); await sync(B);
    s = await today(A); const s2 = await today(B);
    const devs = await A.evaluate(async (t) => (await (await import('./js/stats.js')).summary(t)).books.find((b) => b.title === 'Stats Book').devices, today0); assert(Math.abs(s - a0 - 110) < 0.01 && s2 === s && devs.includes('iPhone') && devs.includes('Laptop'), JSON.stringify({ s, s2, devs })); return `${s}s on both · ${devs.join(', ')}`;
  });
  await step('Glossary entry and stats are in the backup summary', async () => {
    const m = await A.evaluate(async () => { const { manifest } = await (await import('./js/backup.js')).exportBackupStream(); const g = manifest.snapshot.glossary || []; return { stat: g.filter((x) => x.kind === 'stat').length, term: g.filter((x) => x.kind === 'term' && /Paragraph 1\.1/.test(x.term)).length, keys: Object.keys(manifest.snapshot).join() }; });
    assert(m.stat >= 3 && m.term === 1, JSON.stringify(m)); return `${m.stat} stat-days, ${m.term} glossary term`;
  });
  await step('Libby: no library → libbyapp.com; with a library → Libby’s own title search; guide has “Open Libby”; book menu “Find in Libby” opens the search', async () => {
    const r = await A.evaluate(async () => { const P = await import('./js/publib.js'); const a = P.libbyUrl('Dune'); (await import('./js/settings.js')).settings.set({ publicLibrary: { key: 'lapl', name: 'LA Public Library' } }); const b = P.libbyUrl('Dune Frank Herbert'); return { a, b }; });
    assert(r.a === 'https://libbyapp.com/' && r.b === 'https://libbyapp.com/search/lapl/search/scope-auto/query-Dune%20Frank%20Herbert/page-1', JSON.stringify(r));
    await A.evaluate(async () => (await import('./js/publib.js')).openPublicLibraryGuide()); await A.waitForSelector('#plib-open-libby'); const href = await A.$eval('#plib-open-libby', (e) => e.href + '|' + e.target); assert(href === 'https://libbyapp.com/library/lapl|_blank', href); await closeSheets(A);
    await bookMenu(A, '^Stats Book'); await A.waitForSelector('#menu-libby'); await click(A, '#menu-libby'); await sleep(300); const o = await A.evaluate(() => [window.__libbyOpened, window.__opened]);
    assert(o[0] === 'https://libbyapp.com/search/lapl/search/scope-auto/query-Stats%20Book%20Statler/page-1' && o[1] === o[0], o.join()); return o[0];
  });
  const kybPick = async (file) => { await A.evaluate(() => window.__folio.show('settings')); await A.waitForSelector('#kyb-import'); await click(A, '#kyb-import'); await A.waitForSelector('#kyb-file'); await (await A.$('#kyb-file')).uploadFile(file); };
  await step('KyBook 3 import (CSV): honest note, preview with matches/missing, apply → statuses + shelves, summary', async () => {
    await A.evaluate(() => window.__folio.show('settings')); await A.waitForSelector('#kyb-import'); await click(A, '#kyb-import'); await A.waitForSelector('#kyb-note'); const note = await A.$eval('#kyb-note', (e) => e.textContent); assert(/not yet tested with real KyBook 3 data/.test(note), note); await closeSheets(A);
    await A.evaluate(async () => { const S = await import('./js/store.js'); await S.setStatus((await S.getBooks()).find((b) => /Notes Book/.test(b.title)).id, 'want'); });
    await kybPick(KD + '/list.csv'); await A.waitForSelector('#kyb-matched', { timeout: 8000 }); const c = await A.$eval('#kyb-counts', (e) => e.textContent); assert(/3 books in the file · 2 match your library · 1 not in Folio/.test(c), c);
    await click(A, '#kyb-apply'); await A.waitForSelector('#kyb-summary'); const sum = await A.$eval('#kyb-summary', (e) => e.textContent);
    const st = await A.evaluate(async () => { const S = await import('./js/store.js'); const sh = await S.getShelves(); const nm = (id) => sh.find((s) => s.id === id)?.name; return (await S.getBooks()).filter((b) => /Notes Book|Stats Book/.test(b.title)).map((b) => b.title + ':' + b.status + ':' + (b.shelves || []).map(nm).sort().join('+')).sort(); });
    assert(st.join() === 'Notes Book:finished:Favourites+Sci-fi,Stats Book:reading:Sci-fi', st.join()); assert(/2 books matched/.test(sum) && /1 skipped/.test(sum) && /Favourites/.test(sum), sum); await closeSheets(A); return st.join(' | ');
  });
  await step('KyBook import also reads JSON lists and a KyBook 2 .kb manifest (tolerant keys)', async () => {
    await kybPick(KD + '/list.json'); await A.waitForSelector('#kyb-matched', { timeout: 8000 }); let m = await A.$eval('#kyb-matched', (e) => e.textContent); assert(m === '1', 'json ' + m);
    const row = await A.$eval('#kyb-list', (e) => e.textContent); assert(/Stats Book — Statler/.test(row) && /Want to Read · Winter/.test(row), row); await closeSheets(A);
    await kybPick(KD + '/book.kb'); await A.waitForSelector('#kyb-matched', { timeout: 8000 }); m = await A.$eval('#kyb-matched', (e) => e.textContent); assert(m === '1', 'kb ' + m); await closeSheets(A); return 'json + .kb';
  });
  await step('Unreadable files (KyBook’s SQLite library, random text) → “send us a sample”: shows only structure, sends it as a suggestion', async () => {
    await kybPick(KD + '/Library.sqlite'); await A.waitForSelector('#kyb-unknown', { timeout: 8000 }); const t = await A.$eval('#kyb-unknown', (e) => e.textContent); assert(/SQLite/.test(t), t); await closeSheets(A);
    await kybPick(KD + '/odd.txt'); await A.waitForSelector('#kyb-report', { timeout: 8000 }); const rep = await A.$eval('#kyb-report', (e) => e.textContent); assert(/odd\.txt/.test(rep) && /Columns: just some words/.test(rep), rep);
    const n0 = (S.suggest?.calls || []).length; await click(A, '#kyb-send-sample'); await until(() => (S.suggest?.calls || []).length > n0, 8000, 'suggestion sent'); const body = S.suggest.calls[S.suggest.calls.length - 1];
    assert(/KyBook 3 import sample/.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 300)); await closeSheets(A); return 'sent ' + rep.split('\n').length + ' lines';
  });
  await step('No page errors', async () => { const e = [...A.errs, ...B.errs]; assert(!e.length, e.join(' | ')); });
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); for (const f of fails) console.log('✗', f[1], '→', f[2]); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

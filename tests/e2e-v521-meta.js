// v0.5.21 book info that sticks. Haley's exact sequence: hours of edits on the laptop (titles, authors, sets/series, volume numbers, order, covers),
// sync the laptop, then the iPhone pulls 50 more books with "Get missing books" (synced in chunks while it downloads), then laptop → phone → laptop.
// Both devices must end with every laptop edit and cover. Also: a fresh phone with a clock 3 h fast, a later edit on the phone, interrupted cover
// uploads (resumed), a pull that would undo many edits (asks; "Keep this device's edits" is the default), "Make this device the source of truth",
// and "Restore book info from an earlier sync" (Drive's earlier versions + this device's own history).
const puppeteer = require('puppeteer-core');
const JSZip = require('../vendor/jszip.min.js');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState(); const C = S.cloud; S.userDrive = new Map();
const N = 60;
const opfSeries = (i) => Math.ceil(i / 5), opfIdx = (i) => ((i - 1) % 5) + 1;
async function epub(i) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>Raw Title ${i}</dc:title><dc:creator>Raw Author</dc:creator><dc:identifier id="id">urn:v521:${i}</dc:identifier><dc:language>en</dc:language><meta name="calibre:series" content="Default Saga ${opfSeries(i)}"/><meta name="calibre:series_index" content="${opfIdx(i)}"/></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  z.file('OEBPS/c1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>Book ${i}</p></body></html>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
const FILES = [];
/** What Haley's laptop edits look like (books 1–50 edited, 51–60 untouched). */
function expected(i) {
  const e = { title: i <= 50 ? `Fixed Title ${i}` : `Raw Title ${i}`, author: i <= 50 && i % 5 === 0 ? `Right Author ${i}` : 'Raw Author', description: i <= 50 && i % 7 === 0 ? `Desc ${i}` : null };
  if (i <= 20) Object.assign(e, { set: `Correct Saga ${opfSeries(i)}`, idx: opfIdx(i) });
  else if (i <= 30) Object.assign(e, { set: 'Haley Picks', idx: 31 - i });
  else if (i <= 35) Object.assign(e, { set: null, idx: null });
  else if (i <= 50) Object.assign(e, { set: `Default Saga ${opfSeries(i)}`, idx: 6 - opfIdx(i) });
  else Object.assign(e, { set: `Default Saga ${opfSeries(i)}`, idx: opfIdx(i) });
  return e;
}
const ORDER1 = [5, 3, 1, 2, 4];
async function mk(ctx, name, { scope, skew = 0 } = {}) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  if (skew) await page.evaluateOnNewDocument((s) => { const o = Date.now.bind(Date); Date.now = () => o() + s; }, skew);
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.evaluateOnNewDocument((n, sc) => { localStorage.setItem('folio.deviceName', n); if (sc) { const a = JSON.parse(localStorage.getItem('folio.google')); a.scope = sc; localStorage.setItem('folio.google', JSON.stringify(a)); } }, name, scope || 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.readonly');
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(1500);
  await page.evaluate(async () => { (await import('./js/google.js')).syncTuning.minGap = 3600e3; (await import('./js/drivebatch.js')).BATCH.gap = 0; });
  return page;
}
const sync = (p, o = {}) => p.evaluate(async (o) => { const g = await import('./js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 150)); return r && { conflict: r.conflict || null, coversUploaded: r.coversUploaded, coversFetched: r.coversFetched, domains: r.domains }; }, o);
const runBatch = (p, files) => p.evaluate(async (files) => { const r = await (await import('./js/drivebatch.js')).runBatch('book', files); return { imported: r.imported.length, skipped: r.skipped.length, failed: r.failed.map((x) => x.why) }; }, files);
/** Everything about each book that Haley edits, keyed by book number. */
const info = (p) => p.evaluate(async () => {
  const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); const books = await S.getBooks(); const sets = new Map((await DB.all('sets')).map((s) => [s.id, s]));
  const out = {}; const byId = new Map();
  for (const b of books) { const n = +(/urn:v521:(\d+)/.exec(b.identifier || '') || [])[1]; if (!n) continue; byId.set(b.id, n);
    out[n] = { title: b.title, author: b.author, description: b.description || null, set: b.setId ? (sets.get(b.setId)?.name ?? '?missing ' + b.setId) : null, idx: b.setId ? (b.seriesIndex ?? null) : null, coverId: b.coverId || null, coverSource: b.coverSource || null, hasBlob: !!b.coverBlob }; }
  const orders = {}; for (const o of await DB.all('orders')) { const m = /^set:(.+)$/.exec(o.key); if (!m || !sets.get(m[1])) continue; orders[sets.get(m[1]).name] = o.ids.map((x) => byId.get(x.slice(2)) || x); }
  return { books: out, orders, setsInUse: [...new Set(books.map((b) => b.setId && sets.get(b.setId)?.name).filter(Boolean))].sort() };
});
/** The same steps as Edit book → Save (library.js). vals: {title, author, description, set: name|null, idx}. */
const edit = (p, list) => p.evaluate(async (list) => {
  const S = await import('./js/store.js'); const { markEdits } = await import('./js/metasync.js'); const { DB } = await import('./js/db.js');
  for (const [n, v] of list) {
    const b0 = (await S.getBooks()).find((b) => b.identifier === 'urn:v521:' + n); const bk = await S.getBook(b0.id);
    if (v.title) bk.title = v.title; const t = {}; if (v.author) t.author = v.author; if (v.description) t.description = v.description; if (Object.keys(t).length) markEdits(bk, { author: bk.author, description: bk.description || '', year: bk.year ?? '', language: bk.language || '', ...t });
    if ('set' in v || 'idx' in v) {
      const prevSet = bk.setId || '', prevIdx = bk.seriesIndex ?? null; let setId = bk.setId || '';
      if ('set' in v) { if (v.set === null) setId = ''; else { const s = (await DB.all('sets')).find((x) => x.name === v.set); setId = s ? s.id : (await S.createSet(v.set)).id; } }
      bk.setId = setId || null; bk.seriesIndex = setId && v.idx != null ? v.idx : (setId ? bk.seriesIndex : null);
      if ((bk.setId || '') !== prevSet || bk.seriesIndex !== prevIdx) bk.userSet = { ...(bk.userSet || {}), series: true };
    }
    await S.saveBook(bk); await S.pruneSets();
  }
}, list);
const renameSets = (p, pairs) => p.evaluate(async (pairs) => { const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); for (const [a, b] of pairs) { const s = (await DB.all('sets')).find((x) => x.name === a); await S.renameSet(s.id, b); } }, pairs);
const setOrder = (p, setName, nums) => p.evaluate(async (setName, nums) => { const S = await import('./js/store.js'); const { DB } = await import('./js/db.js'); const s = (await DB.all('sets')).find((x) => x.name === setName); const bs = await S.getBooks(); await S.saveOrder('set:' + s.id, nums.map((n) => 'b:' + bs.find((b) => b.identifier === 'urn:v521:' + n).id)); S.emitChange(); }, setName, nums);
const setCovers = (p, nums) => p.evaluate(async (nums) => {
  const S = await import('./js/store.js'); const { setUserCover } = await import('./js/covers.js'); const bs = await S.getBooks();
  for (const n of nums) { const c = document.createElement('canvas'); c.width = 60; c.height = 90; const x = c.getContext('2d'); x.fillStyle = `hsl(${(n * 47) % 360},70%,50%)`; x.fillRect(0, 0, 60, 90); x.fillStyle = '#fff'; x.fillText('#' + n + ' ' + Date.now(), 4, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); await setUserCover('book', bs.find((b) => b.identifier === 'urn:v521:' + n).id, blob); }
}, nums);
const panel = async (p) => { await p.evaluate(() => { window.__folio.show('settings'); }); await sleep(700); return p.evaluate(() => document.body.innerText); };
function diff(got, nums, exp = expected) { const bad = []; for (const n of nums) { const e = exp(n), g = got.books[n]; if (!g) { bad.push(`#${n} missing`); continue; } for (const k of Object.keys(e)) if ((g[k] ?? null) !== (e[k] ?? null)) bad.push(`#${n}.${k}=${JSON.stringify(g[k])} want ${JSON.stringify(e[k])}`); } return bad; }
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const COVERED = [1, 2, 3, 4, 5, 41, 42, 43, 44, 45];   // some on the iPhone already, some only arriving with "Get missing books"
/** She worked for hours: first the sets / volume numbers, later the titles, authors and info (separate saves, separate times). */
const SET_EDITS = () => { const list = []; for (let i = 21; i <= 50; i++) { if (i <= 30) list.push([i, { set: 'Haley Picks', idx: 31 - i }]); else if (i <= 35) list.push([i, { set: null }]); else list.push([i, { idx: 6 - opfIdx(i) }]); } return list; };
const TEXT_EDITS = () => { const list = []; for (let i = 1; i <= 50; i++) { const v = { title: `Fixed Title ${i}` }; if (i % 5 === 0) v.author = `Right Author ${i}`; if (i % 7 === 0) v.description = `Desc ${i}`; list.push([i, v]); } return list; };

(async () => {
  for (let i = 1; i <= N; i++) { const id = 'D' + i; S.userDrive.set(id, await epub(i)); FILES.push({ id, name: `Raw Title ${i}.epub`, size: S.userDrive.get(id).length }); }
  C.coverAge = 2 * 3600e3;   // covers on Drive look a couple of hours old (she edited for hours)
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const PH = await mk(await browser.createBrowserContext(), 'iPhone');
  const LT = await mk(await browser.createBrowserContext(), 'Chrome on Laptop');
  let lt0;
  await step('Setup: iPhone has 10 books and syncs; laptop imports all 60 and syncs', async () => {
    const r = await runBatch(PH, FILES.slice(0, 10)); assert(r.imported === 10, JSON.stringify(r)); await sync(PH);
    await sync(LT); const r2 = await runBatch(LT, FILES); assert(r2.imported === N, JSON.stringify(r2)); await sync(LT);
    const g = await info(LT); assert(g.books[1].set === 'Default Saga 1' && g.books[1].idx === 1, JSON.stringify(g.books[1])); return 'sets from the files: ' + g.setsInUse.length;
  });
  await step('Laptop: Haley fixes 50 books (titles, authors, info, sets renamed / moved / cleared, volume numbers, an order, 10 covers) and syncs', async () => {
    await renameSets(LT, [1, 2, 3, 4].map((k) => [`Default Saga ${k}`, `Correct Saga ${k}`]));
    await edit(LT, SET_EDITS()); await setOrder(LT, 'Correct Saga 1', ORDER1); await sleep(400); await edit(LT, TEXT_EDITS()); await sleep(200); await setCovers(LT, COVERED);
    lt0 = await info(LT); const bad = diff(lt0, range(1, N)); assert(!bad.length, 'laptop itself: ' + bad.slice(0, 6).join('; '));
    await sync(LT); assert(C.covers.size >= 10, 'covers on Drive ' + C.covers.size); return `covers on Drive ${C.covers.size}`;
  });
  await step('iPhone: syncs, then "Get missing books" downloads the other 50 in chunks (a sync after each chunk, like the auto-sync while it downloads)', async () => {
    await sync(PH);
    for (let k = 10; k < N; k += 10) { const r = await runBatch(PH, FILES.slice(k, k + 10)); assert(r.imported === 10, JSON.stringify(r)); if (process.env.DBG) console.log('Qpre', k, await PH.evaluate(() => localStorage.getItem('folio.coverQ')), await PH.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('folio.pendingMeta') || '{}')).length)); const sr = await sync(PH); if (process.env.DBG) console.log('Qpost', k, sr.coversFetched, JSON.stringify(await PH.evaluate(async () => { const S = await import('./js/store.js'); const b = (await S.getBooks()).find((x) => /41$/.test(x.title)); return b && { src: b.coverSource, id: b.coverId, mat: b.metaAt, blob: !!b.coverBlob }; }))); const cb = Object.values(C.json('folio-sync.json').books).filter((b) => b.title !== undefined).length; assert(cb === N, `chunk ${k}: the cloud library shrank to ${cb} books`); if (process.env.DBG) console.log('chunk', k, JSON.stringify(sr.domains), 'cloud books', Object.keys(C.json('folio-sync.json').books).length, 'covers', C.covers.size, 'deleted', C.deletes.length, 'pending', await PH.evaluate(async () => Object.keys((await import('./js/store.js')).getPending()).length), JSON.stringify((await info(PH)).books[31])); }
    const g = await info(PH); const bad = diff(g, range(1, N)); assert(!bad.length, `right after downloading, the iPhone shows defaults (${bad.length}): ` + bad.slice(0, 6).join('; '));
    for (const n of COVERED) assert(g.books[n].coverSource === 'user' && g.books[n].hasBlob, `cover #${n} not on the iPhone: ` + JSON.stringify(g.books[n]) + (process.env.DBG ? ' Q=' + await PH.evaluate(() => localStorage.getItem('folio.coverQ')) : ''));
    assert(!C.deletes.length, 'covers deleted from Drive: ' + C.deletes.join(', '));
    return 'iPhone already matches the laptop (60/60, 10 covers) before the laptop syncs again';
  });
  await step('Laptop → iPhone → laptop sync: BOTH devices end with every laptop edit (title, author, info, set, volume), the order and the covers', async () => {
    await sync(LT); await sync(PH); await sync(LT);
    const l = await info(LT), p = await info(PH); const bl = diff(l, range(1, N)), bp = diff(p, range(1, N));
    assert(!bl.length, `laptop reverted (${bl.length}): ` + bl.slice(0, 6).join('; ')); assert(!bp.length, `iPhone wrong (${bp.length}): ` + bp.slice(0, 6).join('; '));
    for (const n of COVERED) { assert(p.books[n].coverSource === 'user' && p.books[n].hasBlob && p.books[n].coverId === l.books[n].coverId, `cover #${n} iPhone ${JSON.stringify(p.books[n])} laptop ${l.books[n].coverId}`); }
    assert(JSON.stringify(p.orders['Correct Saga 1']) === JSON.stringify(ORDER1) && JSON.stringify(l.orders['Correct Saga 1']) === JSON.stringify(ORDER1), 'order ' + JSON.stringify([p.orders['Correct Saga 1'], l.orders['Correct Saga 1']]));
    const want = ['Correct Saga 1', 'Correct Saga 2', 'Correct Saga 3', 'Correct Saga 4', 'Default Saga 10', 'Default Saga 11', 'Default Saga 12', 'Default Saga 8', 'Default Saga 9', 'Haley Picks'];
    assert(JSON.stringify(p.setsInUse) === JSON.stringify(want), 'iPhone sets ' + p.setsInUse.join(', ')); assert(JSON.stringify(l.setsInUse) === JSON.stringify(want), 'laptop sets ' + l.setsInUse.join(', '));
    return `60/60 books match on both · 10/10 covers (5 on books the iPhone already had, 5 it downloaded) · order kept · sets: ${p.setsInUse.length}`;
  });
  const PH2 = await mk(await browser.createBrowserContext(), 'iPad (clock 3 h fast)', { skew: 3 * 3600e3 });
  await step('Fresh device with a clock 3 h fast: imports all 60 itself (file defaults), renames #52, first sync → gets every laptop edit, keeps its own #52 edit', async () => {
    const r = await runBatch(PH2, FILES); assert(r.imported === N, JSON.stringify(r));
    await edit(PH2, [[52, { title: 'Skewed edit 52' }]]);
    await sync(PH2); await sync(LT); await sync(PH2);
    const exp = (n) => (n === 52 ? { ...expected(52), title: 'Skewed edit 52' } : expected(n));
    const b2 = diff(await info(PH2), range(1, N), exp), bl = diff(await info(LT), range(1, N), exp);
    assert(!b2.length, 'iPad: ' + b2.slice(0, 6).join('; ')); assert(!bl.length, 'laptop: ' + bl.slice(0, 6).join('; ')); return 'both match, #52 = Skewed edit 52';
  });
  await step('Clock skew: the laptop renames #52 AFTER the fast-clock edit → the laptop wins on every device (a fast clock can’t pin a value)', async () => {
    await sleep(50); await edit(LT, [[52, { title: 'Laptop later 52' }]]); await sync(LT); await sync(PH2); await sync(PH);
    const t = [(await info(LT)).books[52].title, (await info(PH2)).books[52].title, (await info(PH)).books[52].title]; assert(t.every((x) => x === 'Laptop later 52'), JSON.stringify(t)); return t.join(' / ');
  });
  await step('A later edit on the iPhone (#3 title, #4 out of its set) wins everywhere', async () => {
    await edit(PH, [[3, { title: 'Phone later 3' }], [4, { set: null }]]); await sync(PH); await sync(LT); await sync(PH2);
    for (const p of [LT, PH, PH2]) { const g = await info(p); assert(g.books[3].title === 'Phone later 3' && g.books[4].set === null && g.books[52].title === 'Laptop later 52', JSON.stringify([g.books[3], g.books[4]])); } return 'all three agree';
  });
  await step('Interrupted cover uploads: Drive drops every upload → the info syncs, the panel shows "3 waiting to upload" / "3 waiting to download"; next time the upload resumes where it stopped and both devices get the covers', async () => {
    const startsBefore = C.coverStarts || 0;
    C.coverFailPuts = 1000; await setCovers(LT, [11, 12, 13]); await sync(LT);
    const pl = await panel(LT); assert(/3 waiting to upload/.test(pl), 'laptop panel: ' + (pl.match(/.*cover.*/gi) || []).join(' | '));
    await sync(PH); const pp = await panel(PH); assert(/3 waiting to download/.test(pp), 'iPhone panel: ' + (pp.match(/.*cover.*/gi) || []).join(' | '));
    C.coverFailPuts = 2; await sync(LT); assert((C.coverResumed || 0) > 0, 'resumed ' + C.coverResumed);
    const pl2 = await panel(LT); assert(!/waiting to upload/.test(pl2), 'laptop still waiting: ' + (pl2.match(/.*cover.*/gi) || []).join(' | '));
    await sync(PH); const g = await info(PH), l = await info(LT);
    for (const n of [11, 12, 13]) assert(g.books[n].coverSource === 'user' && g.books[n].hasBlob && g.books[n].coverId === l.books[n].coverId, `#${n} ${JSON.stringify(g.books[n])}`);
    const pp2 = await panel(PH); assert(!/waiting to download/.test(pp2), 'iPhone still waiting'); return `cut ${C.coverCuts}× · resumed ${C.coverResumed}× · sessions ${(C.coverStarts || 0) - startsBefore}`;
  });
  await step('Safety: the laptop has 8 unsynced edits and the iPhone synced newer ones → the laptop ASKS (examples shown, nothing applied yet), "Keep this device’s edits" is the default', async () => {
    await edit(LT, range(41, 48).map((n) => [n, { title: 'Laptop keeps ' + n }]));
    await sleep(30); await edit(PH, range(41, 48).map((n) => [n, { title: 'Phone newer ' + n }])); await sync(PH);
    await LT.evaluate(() => { window.__folio.show('library'); }); await sleep(300);
    const r = await sync(LT); assert(r && r.conflict && r.conflict.kind === 'meta', 'conflict: ' + JSON.stringify(r && r.conflict));
    await LT.waitForSelector('#sc-local', { timeout: 5000 }); const txt = await LT.evaluate(() => document.querySelector('.sheet, [role=dialog]')?.innerText || document.body.innerText);
    assert(/Keep this device.s edits/.test(txt) && /Laptop keeps 41|Phone newer 41/.test(txt), 'prompt: ' + txt.slice(0, 400));
    const primary = await LT.$eval('#sc-local', (b) => b.classList.contains('primary')); assert(primary, 'Keep is the primary button');
    const t = (await info(LT)).books[41].title; assert(t === 'Laptop keeps 41', 'applied before choosing: ' + t);
    await LT.click('#sc-local'); await sleep(1500);
    await sync(PH); const g = await info(PH), l = await info(LT); assert(range(41, 48).every((n) => g.books[n].title === 'Laptop keeps ' + n && l.books[n].title === 'Laptop keeps ' + n), 'after keep: ' + g.books[41].title + ' / ' + l.books[41].title);
    return txt.split('\n').filter(Boolean).slice(0, 3).join(' · ');
  });
  await step('Settings → Sync → "Make this device the source of truth for book info": the iPhone’s stray edits are replaced by the laptop’s on every device', async () => {
    await edit(PH, range(21, 26).map((n) => [n, { title: 'Oops ' + n, set: null }])); await sync(PH);
    await LT.evaluate(() => { window.__folio.show('settings'); }); await sleep(700);
    await LT.waitForSelector('#sync-truth'); await LT.click('#sync-truth'); await LT.waitForSelector('#truth-go'); await LT.click('#truth-go');
    await LT.waitForFunction(() => /is now the source of truth/i.test(document.body.innerText) && !/Syncing/.test(document.querySelector('#sync-status')?.textContent || ''), { timeout: 30000 }); await sleep(1500);
    await sync(PH); const g = await info(PH);
    for (const n of range(21, 26)) assert(g.books[n].title === expected(n).title && g.books[n].set === 'Haley Picks', `#${n} ${JSON.stringify(g.books[n])}`);
    const r = await sync(PH); assert(!r.conflict, 'no prompt'); return 'iPhone follows the laptop';
  });
  await step('Settings → Sync → "Restore book info from an earlier sync": after bad edits came in, pick a time before them → preview → Restore; both devices go back', async () => {
    const before = Date.now(); await sleep(1100);
    await edit(PH, range(1, 12).map((n) => [n, { title: 'Junk ' + n }])); await sync(PH); await sync(LT);
    assert((await info(LT)).books[1].title === 'Junk 1', 'junk reached the laptop');
    await LT.evaluate(() => { window.__folio.show('settings'); }); await sleep(700);
    await LT.click('#sync-restore'); await LT.waitForSelector('#rs-date');
    await LT.waitForFunction(() => !/Looking for earlier/.test(document.querySelector('#rs-list')?.textContent || 'Looking for earlier'), { timeout: 15000 });
    const local = await LT.$$eval('#rs-list [data-src=local]', (x) => x.length); assert(local > 0, 'this device’s own history listed');
    const d = new Date(before); const pad = (x) => String(x).padStart(2, '0'); const val = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    await LT.$eval('#rs-date', (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, val); await sleep(800);
    await LT.waitForSelector('#rs-list [data-src=drive]'); await LT.click('#rs-list [data-src=drive]');
    await LT.waitForFunction(() => /would change/.test(document.querySelector('#rs-preview')?.textContent || ''), { timeout: 15000 }); const pv = await LT.$eval('#rs-preview', (e) => e.textContent);
    assert(/1[2-9] books? would change|12 books/.test(pv) || /would change/.test(pv), pv);
    await LT.click('#rs-apply'); await LT.waitForFunction(() => /Restored/.test(document.body.innerText), { timeout: 30000 }); await sleep(1500);
    await sync(PH); const g = await info(PH), l = await info(LT);
    for (const n of range(1, 12)) { const want = n === 3 ? 'Phone later 3' : expected(n).title; assert(l.books[n].title === want && g.books[n].title === want, `#${n} laptop ${l.books[n].title} iPhone ${g.books[n].title} want ${want}`); }
    return pv.trim();
  });
  await step('No page errors', async () => { const e = [...PH.errs, ...LT.errs, ...PH2.errs]; assert(!e.length, e.slice(0, 3).join(' | ')); });
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); for (const f of fails) console.log('✗', f[1], '→', f[2]);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// v0.5.5 full cross-device sync (Drive appData, mocked): two simulated devices ("Phone" and "Tablet") share one fake Drive.
// Per-domain files, positions with device names + "Continue from <device>", per-key settings, per-book overrides, independent structure/position merging,
// loans / links / tombstones, rate limits + offline queue, debounce/throttle, Settings → Sync UI, v0.5.4 file migration.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState(); const C = S.cloud; const PFX = /flimsy/i.test(APP) ? 'flimsy' : 'folio';
const F = { lib: PFX + '-sync.json', pos: PFX + '-positions.json', set: PFX + '-settings.json', dev: PFX + '-devices.json' };

async function mk(ctx, name, { login = true } = {}) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message)); page.devName = name;
  await install(page, S); if (login) await page.evaluateOnNewDocument(fakeLogin());
  await page.evaluateOnNewDocument((n) => { localStorage.setItem('folio.deviceName', n); localStorage.setItem('flimsy.deviceName', n); }, name);
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`);
  await sleep(2200);   // let the boot sync finish, then stop automatic syncs getting in the way of the scenarios (they are tested separately)
  await page.evaluate(async () => { (await import('/js/google.js')).syncTuning.minGap = 3600e3; });
  return page;
}
const ev = (p, fn, ...a) => p.evaluate(fn, ...a);
const sync = (p, opts = {}) => p.evaluate(async (o) => { const g = await import('/js/google.js'); const r = await g.syncNow(o); await new Promise((x) => setTimeout(x, 150)); return r; }, opts);
const books = (p) => p.evaluate(async () => (await (await import('/js/store.js')).getBooks()).map((b) => ({ id: b.id, title: b.title, progress: b.progress, cfi: b.cfi, status: b.status, shelves: b.shelves, ov: b.overrides, ovAt: b.ovAt, posAt: b.posAt, posDev: b.posDevName, borrowed: b.borrowed, dueAt: b.dueAt, page: b.pdfPage })));
const book = async (p, t) => (await books(p)).find((b) => b.title === t);
const audios = (p) => p.evaluate(async () => (await (await import('/js/audiostore.js')).getAudiobooks()).map((b) => ({ id: b.id, title: b.title, position: b.position, progress: b.progress, status: b.status, shelves: b.shelves, posDev: b.posDevName })));
const setPos = (p, title, progress, cfi) => p.evaluate(async (title, progress, cfi) => { const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === title); b.progress = progress; b.cfi = cfi || 'epubcfi(/6/' + Math.round(progress * 100) + ')'; b.lastOpened = Date.now(); if (b.status === 'want') b.status = 'reading'; await S.saveBook(b); }, title, progress, cfi);
const setAudioPos = (p, title, position) => p.evaluate(async (title, position) => { const A = await import('/js/audiostore.js'); const a = (await A.getAudiobooks()).find((x) => x.title === title); a.position = position; a.progress = position / 3; a.lastOpened = Date.now(); await A.saveAudiobook(a); }, title, position);
const importBook = (p, o) => p.evaluate((o) => window.__mk(o), o);
const importAudio = (p) => p.evaluate(async () => { const f = new File([await (await fetch('/tests/fixtures/audio/tone.ogg')).arrayBuffer()], 'tone.ogg', { type: 'audio/ogg' }); await (await import('/js/audiostore.js')).importAudioFiles([f], 'each'); });
const waitFor = async (page, fn, arg, t = 12000) => { const end = Date.now() + t; while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(100); } throw new Error('timeout: ' + fn.toString().slice(0, 120)); };
const set = (p, patch) => p.evaluate(async (patch) => (await import('/js/settings.js')).settings.set(patch), patch);
const get = (p, k) => p.evaluate(async (k) => (await import('/js/settings.js')).settings.get(k), k);
const lib = () => C.json(F.lib), pos = () => C.json(F.pos), setf = () => C.json(F.set);

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const A = await mk(await browser.createBrowserContext(), 'Phone'); const B = await mk(await browser.createBrowserContext(), 'Tablet');
  const T = { alpha: { title: 'Alpha Tale', author: 'Ann Author' }, beta: { title: 'Beta Tale', author: 'Bob Writer' } };

  await step('Phone: seed two books + an audiobook; first sync creates the per-domain files (library, positions, settings, devices) in appDataFolder', async () => {
    await importBook(A, T.alpha); await importBook(A, T.beta); await importAudio(A);
    await setPos(A, 'Alpha Tale', 0.4); await setAudioPos(A, 'Ogg Tone', 600); await set(A, { theme: 'sepia', fontSizePt: 18 });
    await sync(A); const names = C.names().sort(); assert(JSON.stringify(names) === JSON.stringify(Object.values(F).sort()), names.join());
    return names.join(', ');
  });
  await step('Library file holds structure only (no positions, no settings); positions file has position + timestamp + device name; settings file has per-key stamps', async () => {
    const L = lib(), P = pos(), St = setf();
    const lb = Object.values(L.books).find((b) => b.title === 'Alpha Tale'); assert(lb && lb.status === 'reading' && lb.progress === undefined && lb.cfi === undefined && !L.settings, 'library: ' + JSON.stringify(lb) + ' settings:' + !!L.settings);
    const pa = Object.values(P.books).find((b) => b.progress === 0.4); assert(pa && pa.dev && pa.devName === 'Phone' && pa.posAt > 1e12, JSON.stringify(P.books));
    const au = Object.values(P.audio)[0]; assert(au && au.position === 600 && au.devName === 'Phone', JSON.stringify(P.audio));
    assert(St.flat.theme.v === 'sepia' && St.flat.theme.at > 1e12 && St.flat.fontSizePt.v === 18 && St.flat.margin.at === 0, JSON.stringify(St.flat.theme) + JSON.stringify(St.flat.margin));
    assert(!/token|secret/i.test(JSON.stringify([L, P, St])), 'no secrets');
    return `lib ${JSON.stringify(L).length} B, positions ${JSON.stringify(P).length} B, settings ${JSON.stringify(St).length} B`;
  });

  await step('Tablet (new device): imports the same books → positions of books and audiobooks arrive, with settings; opening shows "Continued from Phone"', async () => {
    await importBook(B, T.alpha); await importBook(B, T.beta); await importAudio(B);
    await sync(B);
    const a = await book(B, 'Alpha Tale'); assert(a.progress === 0.4 && a.posDev === 'Phone', JSON.stringify(a));
    const au = (await audios(B))[0]; assert(au.position === 600 && au.posDev === 'Phone', JSON.stringify(au));
    assert((await get(B, 'theme')) === 'sepia' && (await get(B, 'fontSizePt')) === 18, 'settings');
    await B.evaluate(async () => { const P = await import('/js/positions.js'); const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Alpha Tale'); window.__open = P.beforeOpen('book', b.id); await window.__open; });
    const t = await B.$eval('#toast', (e) => e.innerText); assert(/Continued from Phone/.test(t) && /40%/.test(t), t);
    return t.replace(/\n/g, ' ');
  });

  await step('Auto-apply: Phone moved on, Tablet untouched since the last sync → Tablet silently follows (no prompt)', async () => {
    await sleep(30); await setPos(A, 'Alpha Tale', 0.6); await sync(A); await sync(B);
    const a = await book(B, 'Alpha Tale'); assert(a.progress === 0.6, JSON.stringify(a)); assert(!await B.$('#pos-continue'), 'no prompt expected');
  });

  await step('Conflict: both devices moved → nothing is overwritten; opening asks "Continue from Phone?"; Continue applies the other place', async () => {
    await sleep(30); await setPos(B, 'Alpha Tale', 0.5); await sleep(60); await setPos(A, 'Alpha Tale', 0.8); await sync(A); await sync(B);
    const a = await book(B, 'Alpha Tale'); assert(a.progress === 0.5, 'Tablet keeps its own place until asked: ' + a.progress);
    assert(await B.evaluate(async () => (await import('/js/positions.js')).conflictCount()) === 1, 'conflict recorded');
    const opening = B.evaluate(async () => { const P = await import('/js/positions.js'); const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Alpha Tale'); await P.beforeOpen('book', b.id); return 'done'; });
    await B.waitForSelector('#pos-continue', { timeout: 8000 }); const txt = await B.$eval('.sheet', (e) => e.innerText); assert(/Continue from Phone/.test(txt) && /80%/.test(txt) && /50%/.test(txt), txt);
    await B.screenshot({ path: '/tmp/shot-continue.png' });
    await B.click('#pos-continue'); await opening; const b2 = await book(B, 'Alpha Tale'); assert(b2.progress === 0.8 && b2.posDev === 'Phone', JSON.stringify(b2));
    assert(await B.evaluate(async () => (await import('/js/positions.js')).conflictCount()) === 0, 'conflict cleared');
  });

  await step('Conflict → "Stay here": Tablet keeps its place and it becomes the newest, so Phone follows it', async () => {
    await sleep(30); await setPos(B, 'Alpha Tale', 0.3); await sleep(60); await setPos(A, 'Alpha Tale', 0.9); await sync(A); await sync(B);
    const opening = B.evaluate(async () => { const P = await import('/js/positions.js'); const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Alpha Tale'); await P.beforeOpen('book', b.id); });
    await B.waitForSelector('#pos-stay', { timeout: 8000 }); await B.click('#pos-stay'); await opening;
    assert((await book(B, 'Alpha Tale')).progress === 0.3, 'stayed'); await sync(B); await sync(A);
    const a = await book(A, 'Alpha Tale'); assert(a.progress === 0.3 && a.posDev === 'Tablet', JSON.stringify(a));
  });

  await step('Audiobook position syncs the same way (listening 25:00 on Tablet → Phone follows)', async () => {
    await sleep(30); await setAudioPos(B, 'Ogg Tone', 1500); await sync(B); await sync(A);
    const au = (await audios(A))[0]; assert(au.position === 1500 && au.posDev === 'Tablet', JSON.stringify(au));
  });

  await step('Structure and position merge independently: shelf change on Phone + reading on Tablet → both kept', async () => {
    const shelf = await A.evaluate(async () => (await (await import('/js/store.js')).createShelf('Favourites')).id);
    await sleep(30); await A.evaluate(async (sid) => { const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Beta Tale'); await S.toggleShelf(b.id, sid); }, shelf);
    await sleep(60); await setPos(B, 'Beta Tale', 0.25);   // newer than the shelf change, on a record the Tablet hasn't seen change
    await sync(A); await sync(B); await sync(A);
    for (const [name, p] of [['Phone', A], ['Tablet', B]]) { const b = await book(p, 'Beta Tale'); assert(b.shelves.length === 1 && b.progress === 0.25, name + ' ' + JSON.stringify(b)); }
  });

  await step('Settings: per-key last-write-wins (font on one device, theme on the other both survive; same key → newest), nested per-shelf sorts, pinch + hold time sync', async () => {
    await set(A, { fontSizePt: 22 }); await sleep(40); await set(B, { theme: 'dark', pinchSens: 'fast', holdSec: 2.5 }); await sleep(40); await set(A, { margin: 30 }); await sleep(40); await set(B, { margin: 44 });
    await set(A, { sorts: { 'shelf:x': { field: 'title', dir: 'asc' } } }); await sleep(40); await set(B, { sorts: { 'shelf:y': { field: 'author', dir: 'desc' } } });
    await sync(A); await sync(B); await sync(A);
    for (const [n, p] of [['Phone', A], ['Tablet', B]]) { const g = async (k) => get(p, k); assert(await g('fontSizePt') === 22 && await g('theme') === 'dark' && await g('margin') === 44 && await g('pinchSens') === 'fast' && await g('holdSec') === 2.5, n + ' ' + JSON.stringify([await g('fontSizePt'), await g('theme'), await g('margin'), await g('pinchSens'), await g('holdSec')])); const s = await g('sorts'); assert(s['shelf:x'] && s['shelf:y'], n + ' sorts ' + JSON.stringify(s)); }
  });

  await step('Device-specific settings: device-only never sync (chip, flowChosen) and a group marked "keep on this device" stays local', async () => {
    await set(A, { chip: 'shelf-q' }); await sync(A); await sync(B); assert(await get(B, 'chip') !== 'shelf-q', 'chip is device-only');
    await B.evaluate(async () => (await import('/js/settings.js')).setDeviceOnlyGroups(['reading']));
    await set(A, { tapZones: 'inverted', fontSizePt: 24 }); await sleep(30); await set(B, { holdSec: 1 }); await sync(B); await sync(A); await sync(B);
    assert(await get(B, 'tapZones') !== 'inverted' && await get(B, 'fontSizePt') === 24, 'B keeps reading-behaviour local but follows appearance');
    assert(await get(A, 'holdSec') !== 1, 'B’s hold time stayed on B'); await B.evaluate(async () => (await import('/js/settings.js')).setDeviceOnlyGroups([]));
  });

  await step('Per-book reading settings merge key by key (font size on Phone, margin on Tablet for the same book)', async () => {
    const id = async (p) => (await book(p, 'Alpha Tale')).id;
    await A.evaluate(async (id) => (await import('/js/store.js')).setOverride(id, { fontSizePt: 30 }), await id(A)); await sleep(40);
    await B.evaluate(async (id) => (await import('/js/store.js')).setOverride(id, { margin: 12 }), await id(B));
    await sync(A); await sync(B); await sync(A);
    for (const [n, p] of [['Phone', A], ['Tablet', B]]) { const b = await book(p, 'Alpha Tale'); assert(b.ov && b.ov.fontSizePt === 30 && b.ov.margin === 12, n + ' ' + JSON.stringify(b.ov)); }
    await A.evaluate(async (id) => (await import('/js/store.js')).setOverride(id, { fontSizePt: null }), await id(A)); await sleep(30); await sync(A); await sync(B);
    const b = await book(B, 'Alpha Tale'); assert(b.ov && b.ov.fontSizePt === undefined && b.ov.margin === 12, 'removing one key propagates: ' + JSON.stringify(b.ov));
  });

  await step('Borrowed flag + due date, audiobook ↔ ebook link, a rejected pairing, and deletions (tombstone) all travel', async () => {
    const due = Date.now() + 5 * 864e5;
    await A.evaluate(async (due) => { const L = await import('/js/loans.js'); const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Beta Tale'); await L.setLoan('book', b.id, { borrowed: true, dueAt: due }); const K = await import('/js/links.js'); const a = (await (await import('/js/audiostore.js')).getAudiobooks())[0]; const alpha = (await S.getBooks()).find((x) => x.title === 'Alpha Tale'); await K.link(alpha, a, { by: 'user' }); await K.reject(K.bookKey(b), K.audioKey(a), { bookTitle: b.title, audioTitle: a.title }); }, due);
    await sync(A); await sync(B);
    const b = await book(B, 'Beta Tale'); assert(b.borrowed && Math.abs(b.dueAt - due) < 5, JSON.stringify(b));
    const links = await B.evaluate(async () => (await (await import('/js/links.js')).getLinks()).map((l) => l.state).sort()); assert(links.join() === 'linked,rejected', links.join());
    await A.evaluate(async () => { const S = await import('/js/store.js'); const b = (await S.getBooks()).find((x) => x.title === 'Beta Tale'); await S.deleteBooks([b.id]); });
    await sync(A); await sync(B); assert(!(await book(B, 'Beta Tale')) && (await book(B, 'Alpha Tale')), 'deleted on Tablet too'); assert(lib().tombstones.some((t) => t.t === 'book'), 'tombstone in library file');
  });

  await step('Efficient: with nothing changed a sync is one list call and no writes; moving a position rewrites only the (small) positions file', async () => {
    await sync(A); await sync(A); C.calls.length = 0; const w0 = { ...C.writesBy };
    await sync(A); assert(C.calls.join() === 'list', 'idle sync calls: ' + C.calls.join());
    await sleep(30); await setPos(A, 'Alpha Tale', 0.55); C.calls.length = 0; await sync(A);
    const w1 = C.writesBy; assert(w1[F.pos] === w0[F.pos] + 1 && w1[F.lib] === w0[F.lib] && w1[F.set] === w0[F.set], JSON.stringify([w0, w1]));
    assert(C.calls.filter((c) => /patch|post/.test(c)).join() === 'patch ' + F.pos, C.calls.join()); return C.calls.join(' | ');
  });

  await step('Debounce + throttle: 25 rapid position changes cause at most 2 uploads in 6 s (not 25)', async () => {
    await A.evaluate(async () => { (await import('/js/google.js')).syncTuning.minGap = 2500; }); await sync(A); const w0 = C.writesBy[F.pos] || 0;
    for (let i = 1; i <= 25; i++) { await setPos(A, 'Alpha Tale', 0.5 + i / 100); await sleep(80); }
    await sleep(7500); const n = (C.writesBy[F.pos] || 0) - w0; assert(n >= 1 && n <= 3, 'uploads ' + n); assert(pos() && Object.values(pos().books).some((b) => b.progress === 0.75), 'last position reached Drive');
    await A.evaluate(async () => { (await import('/js/google.js')).syncTuning.minGap = 3600e3; }); return n + ' upload(s)';
  });

  await step('Offline queue: changes made offline are kept and uploaded when the network returns (Drive down → status "Offline", then recovers)', async () => {
    C.offline = true; await sleep(30); await setPos(A, 'Alpha Tale', 0.33);
    const r = await A.evaluate(async () => { const g = await import('/js/google.js'); const r = await g.syncNow({ quiet: true }); return { r, st: g.getStatus(), dirty: g.isDirty() }; });
    assert(r.st.state === 'offline' || r.st.state === 'error', JSON.stringify(r.st)); assert(r.dirty, 'dirty flag kept');
    assert(!Object.values(pos().books).some((b) => b.progress === 0.33), 'not uploaded yet');
    C.offline = false; await A.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor(A, async () => !(await import('/js/google.js')).isDirty(), null, 15000); assert(Object.values(pos().books).some((b) => b.progress === 0.33), 'uploaded after coming back');
  });

  await step('Rate limits: 429 / 403 rateLimitExceeded are retried with back-off (Retry-After honoured) and the sync still completes', async () => {
    await sleep(30); await setPos(A, 'Alpha Tale', 0.44); C.fail = { status: 429, times: 2, retryAfter: 1, match: /GET .*files\?/ }; const t0 = Date.now(); await sync(A); const dt = Date.now() - t0;
    assert(Object.values(pos().books).some((b) => b.progress === 0.44) && C.fail.times === 0, 'completed; remaining failures ' + C.fail.times); assert(dt >= 1800, 'waited for Retry-After: ' + dt + ' ms');
    C.fail = { status: 403, times: 1, match: /PATCH/ }; await sleep(30); await setPos(A, 'Alpha Tale', 0.45); await sync(A); assert(Object.values(pos().books).some((b) => b.progress === 0.45), 'rate-limit 403 retried'); return dt + ' ms with two 429s';
  });

  await step('Settings → Sync UI: status, what-to-sync toggles, this device’s name, devices list (both devices), keep-on-device groups', async () => {
    await A.evaluate(() => window.__folio.show('settings')); await A.waitForSelector('#sync-details'); await A.evaluate(() => document.querySelector('#sync-options').open = true); await sleep(900);
    const txt = await A.$eval('.account', (e) => e.innerText); assert(/Last synced/.test(txt), txt.slice(0, 200));
    const tog = await A.$$eval('#sync-details input[type=checkbox]', (els) => els.map((e) => e.id + ':' + e.checked)); assert(['sync-on-positions:true', 'sync-on-library:true', 'sync-on-settings:true', 'ask-continue:false'].every((x) => tog.includes(x)) && tog.some((x) => /^dev-only-reading/.test(x)), tog.join());
    const devs = await A.$$eval('#sync-devices .list-item', (e) => e.map((x) => x.innerText.replace(/\n/g, ' '))); assert(devs.length === 2 && devs[0].includes('Phone (this device)') && devs.some((d) => /^Tablet/.test(d)), JSON.stringify(devs));
    await A.screenshot({ path: '/tmp/shot-sync-ui.png' }); return devs.join(' | ');
  });

  await step('Toggle off "Reading positions": nothing is sent or received for that domain; on again → catches up', async () => {
    await A.click('#sync-on-positions'); await sleep(100); assert(!(await A.evaluate(async () => (await import('/js/google.js')).domainEnabled('positions'))), 'off');
    await sleep(30); await setPos(A, 'Alpha Tale', 0.61); const w0 = C.writesBy[F.pos]; await sync(A); assert(C.writesBy[F.pos] === w0, 'positions file untouched while off');
    await A.click('#sync-on-positions'); await sync(A); assert(Object.values(pos().books).some((b) => b.progress === 0.61), 'caught up');
  });

  await step('Device name: rename this device → shows in the devices list on the other device', async () => {
    await A.$eval('#device-name', (e) => { e.value = 'Pixel 8'; e.dispatchEvent(new Event('change')); }); await sync(A, { force: true }); await sync(B); const devs = await B.evaluate(async () => (await (await import('/js/google.js')).listDevices({ refresh: true })).map((d) => d.name));
    assert(devs.includes('Pixel 8') && devs.includes('Tablet'), devs.join()); await setPos(A, 'Alpha Tale', 0.7); await sync(A); assert(Object.values(pos().books).some((b) => b.devName === 'Pixel 8'), 'positions carry the new name');
  });

  await step('Upgrade from a v0.5.4 snapshot (one big file with positions + settings inside): a fresh device reads it, applies positions + settings, and writes the new per-domain files', async () => {
    const old = lib(); const P = pos(); const St = setf();
    const legacy = { ...old, books: Object.fromEntries(Object.entries(old.books).map(([k, b]) => [k, { ...b, ...(P.books[k] || {}) }])), settings: { values: { theme: 'forest', fontSizePt: 33 }, updatedAt: Date.now() + 1000 } };
    C.files.clear(); C.put(F.lib, Buffer.from(JSON.stringify(legacy)));
    const D = await mk(await browser.createBrowserContext(), 'Laptop'); await importBook(D, T.alpha); await sync(D);
    const a = await book(D, 'Alpha Tale'); assert(a.progress === 0.7, 'position from legacy file: ' + a.progress); assert((await get(D, 'theme')) === 'forest' && (await get(D, 'fontSizePt')) === 33, 'settings from legacy file');
    assert(C.files.has(F.pos) && C.files.has(F.set) && !lib().settings && lib().books && Object.values(lib().books).every((b) => b.progress === undefined), 'new files written, library slimmed down');
  });

  console.log('  page errors:', JSON.stringify([A.errs, B.errs]));
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); await browser.close(); process.exit(fails.length ? 1 : 0);
})();

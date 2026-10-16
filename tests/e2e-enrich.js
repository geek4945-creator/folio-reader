// v0.4.0 "Fix missing info": scan → lookup (Open Library + Google Books mocked, with rate limiting + 429 back-off) → review → apply; user-set fields are never
// overwritten; covers via the proxy when CORS blocks; automatic enrichment on import (off by default, high confidence only); audiobooks; Drive appData sync
// of metadata + covers across two devices (user-set precedence, newest wins, restore on a new device, tombstones, cover GC).
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState();

async function mk(ctx, { login = false } = {}) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await install(page, S); if (login) await page.evaluateOnNewDocument(fakeLogin());
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await page.evaluate(async () => { (await import('/js/enrich.js')).setRate(60); });
  return page;
}
const dbAll = (page, store) => page.evaluate((store) => new Promise((res) => { const r = indexedDB.open('folio-reader'); r.onsuccess = () => { const a = r.result.transaction(store).objectStore(store).getAll(); a.onsuccess = () => res(a.result.map((x) => { const o = { ...x }; if (o.coverBlob) { o.hasCover = true; o.coverType = o.coverBlob.type; o.coverSize = o.coverBlob.size; } delete o.coverBlob; return o; })); }; }), store);
const book = async (page, title, store = 'books') => (await dbAll(page, store)).find((b) => b.title === title);
const coverDims = (page, id, store = 'books') => page.evaluate(async (id, store) => { const b = await (await import('/js/db.js')).DB.get(store, id); const bmp = await createImageBitmap(b.coverBlob); return [bmp.width, bmp.height, b.coverBlob.type]; }, id, store);
const waitFor = async (page, fn, arg, t = 15000) => { const end = Date.now() + t; while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(120); } throw new Error('timeout: ' + fn.toString().slice(0, 140)); };
const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
const clickText = (page, sel, re) => page.evaluate((s, r) => { const el = [...document.querySelectorAll(s)].find((x) => new RegExp(r, 'i').test(x.innerText || x.textContent)); if (!el) throw new Error('no ' + s + ' ~ ' + r + ' in ' + [...document.querySelectorAll(s)].map((x) => x.innerText).join('|').slice(0, 200)); el.click(); }, sel, re);
const tileMenu = async (page, title) => { await page.evaluate((t) => { const tile = [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.t')?.innerText === t); if (!tile) throw new Error('no tile ' + t); tile.querySelector('.tile-more').click(); }, title); await sleep(200); };
const closeSheets = (page) => page.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; });
const odOf = async (p) => (await dbAll(p, 'books')).find((x) => x.identifier === 'urn:test:The Test Odyssey');
const syncNow = (page, force = false) => page.evaluate(async (force) => { const g = await import('/js/google.js'); const r = await g.syncNow({ force }); await new Promise((x) => setTimeout(x, 250)); return r; }, force);

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const A = await mk(await browser.createBrowserContext());

  await step('Fuzzy matching: normalisation, typos, subtitles, author order, ISBN, series strings', async () => {
    const r = await A.evaluate(async () => { const E = await import('/js/enrich.js'); return {
      same: E.titleSim('The Test Odyssey', 'Test Odyssey'), typo: E.titleSim('Test Odysey', 'Test Odyssey'), sub: E.titleSim('Dune: Special Edition', 'Dune'), diff: E.titleSim('Dune', 'Emma'), acc: E.titleSim('Café Society', 'Cafe Society'),
      authOrder: E.authorSim('Herbert, Frank', ['Frank Herbert']), authNone: E.authorSim('Frank Herbert', ['Jane Austen']),
      exact: E.confidence({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune', authors: ['Frank Herbert'] }), wrongAuthor: E.confidence({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune', authors: ['Someone Else'] }),
      noAuthor: E.confidence({ title: 'Dune', author: 'Unknown author' }, { title: 'Dune', authors: ['Frank Herbert'] }), isbn: E.confidence({ title: 'x', isbn: '978-0-306-40615-7' }, { title: 'totally different', authors: [], isbns: ['9780306406157'] }), unrelated: E.confidence({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Emma', authors: ['Jane Austen'] }),
      s1: E.parseSeries('The Test Saga ; 2'), s2: E.parseSeries('Discworld, #4'), s3: E.parseSeries('Foundation (Book 3)'), s4: E.parseSeries('Just A Name'), lv: [E.levelOf(0.9), E.levelOf(0.7), E.levelOf(0.3)] }; });
    assert(r.same >= 0.88 && r.typo > 0.9 && r.sub === 1 && r.diff < 0.3 && r.acc === 1, JSON.stringify(r)); assert(r.authOrder === 1 && r.authNone === 0, JSON.stringify(r));
    assert(r.exact === 1 && r.wrongAuthor === 0.65 && r.noAuthor === 0.7 && r.isbn === 0.99 && r.unrelated < 0.3, JSON.stringify(r));
    assert(r.s1.name === 'The Test Saga' && r.s1.index === 2 && r.s2.name === 'Discworld' && r.s2.index === 4 && r.s3.name === 'Foundation' && r.s3.index === 3 && r.s4.name === 'Just A Name' && r.s4.index === null && r.lv.join() === 'high,medium,low', JSON.stringify(r));
    return 'exact 1.0, wrong author 0.65, unknown author 0.7, ISBN 0.99';
  });

  await step('Seed: metadata-poor books + one audiobook (and no network lookups happen on import while auto-enrich is off)', async () => {
    assert(await A.evaluate(async () => (await import('/js/settings.js')).settings.get('autoEnrich')) === false, 'autoEnrich should default to off');
    for (const o of [{ title: 'The Test Odyssey', author: 'Ada Writer' }, { title: 'Mystery Tome' }, { title: 'Wrong Match', author: 'Real Author', language: 'en', description: 'Has one', date: '2000' }, { title: 'Zzz No Hits', author: 'Nobody Here' },
      { title: 'Edited Book', author: 'Eddie Tor', description: 'Original blurb' }, { title: 'Saga Part Two', author: 'Sage Teller' }, { title: 'Isbn Book', author: 'Isbn Person', identifier: 'urn:isbn:9780306406157', language: 'en' }])
      await A.evaluate((o) => window.__mk(o), o);
    await A.evaluate(async () => { const f = new File([await (await fetch('./tests/fixtures/audio/tone.ogg')).arrayBuffer()], 'tone.ogg', { type: 'audio/ogg' }); const r = await (await import('/js/audiostore.js')).importAudioFiles([f], 'each'); if (!r.ok.length) throw new Error(JSON.stringify(r.errs)); });
    const bs = await dbAll(A, 'books'); assert(bs.length === 7 && S.log.ol.length === 0 && S.log.gb.length === 0, `books ${bs.length}, lookups ${S.log.ol.length}`);
    const a = (await dbAll(A, 'audiobooks'))[0]; assert(a.title === 'Ogg Tone' && a.author === 'Ogg Artist' && !a.description && a.coverSource === 'file', JSON.stringify({ t: a.title, a: a.author, s: a.coverSource }));
    return '7 books + "Ogg Tone"';
  });

  await step('Hand edit through the Edit sheet (description) marks the field user-set', async () => {
    await A.evaluate(() => window.__folio.show('library')); await sleep(400); await tileMenu(A, 'Edited Book'); await clickText(A, '.sheet .list-item, .sheet button', 'Edit details'); await A.waitForSelector('#edit-description');
    assert(await A.$eval('#edit-description', (e) => e.value) === 'Original blurb', 'description not prefilled'); await A.$eval('#edit-description', (e) => { e.value = 'My own notes'; }); await click(A, '#save-book'); await sleep(500);
    const b = await book(A, 'Edited Book'); assert(b.description === 'My own notes' && b.userSet?.description === true && b.metaAt?.description > 0 && !b.userSet.author, JSON.stringify({ d: b.description, u: b.userSet }));
    return 'userSet.description = true';
  });

  await step('Settings: "Missing info" section, auto-enrich off by default, Fix missing info opens the scan with per-field counts', async () => {
    await A.evaluate(() => window.__folio.show('settings')); await A.waitForSelector('#sec-metadata'); assert(await A.$eval('#auto-enrich', (e) => !e.checked), 'toggle should be off');
    await click(A, '#settings-fix-missing'); await A.waitForSelector('#fm-counts-book');
    const c = await A.$$eval('#fm-counts-book .fm-chip', (e) => Object.fromEntries(e.map((x) => [x.dataset.field, +x.querySelector('b').innerText]))); const ca = await A.$$eval('#fm-counts-audio .fm-chip', (e) => Object.fromEntries(e.map((x) => [x.dataset.field, +x.querySelector('b').innerText])));
    assert(c.cover === 7 && c.description === 5 && c.series === 7 && c.year >= 5 && c.author === 1, JSON.stringify(c)); assert(ca.cover === 1 && ca.description === 1 && !('series' in ca), JSON.stringify(ca));
    const sum = await A.$eval('#fm-summary', (e) => e.innerText); assert(/8 items to look up/.test(sum), sum); return JSON.stringify(c);
  });

  await step('Lookup: progress UI, rate-limited requests, then a review screen with a confidence per match', async () => {
    await click(A, '#fm-start'); await A.waitForSelector('#fm-progress-text'); const seen = []; const t0 = Date.now();
    while (Date.now() - t0 < 60000) { const t = await A.evaluate(() => document.querySelector('#fm-progress-text')?.innerText || null); if (t === null) break; if (!seen.includes(t)) seen.push(t); await sleep(25); }
    assert(seen.some((t) => /Looking up \d+ of 8/.test(t)), 'no progress text: ' + seen.join('|')); assert(await A.$('#fm-review'), 'no review screen');
    const gaps = S.log.olTimes.slice(1).map((t, i) => t - S.log.olTimes[i]); assert(gaps.length >= 7 && Math.min(...gaps) >= 50, 'rate limit gaps: ' + gaps.join());
    const cards = await A.$$eval('.fm-card', (e) => e.map((x) => ({ t: x.querySelector('strong').innerText, level: x.dataset.level, state: x.dataset.state, conf: x.querySelector('.fm-conf').innerText, fields: [...x.querySelectorAll('.fm-field')].map((f) => f.dataset.field) })));
    const by = Object.fromEntries(cards.map((c) => [c.t, c])); assert(cards.length === 7 && !by['Zzz No Hits'], cards.map((c) => c.t).join());
    assert(by['The Test Odyssey'].level === 'high' && by['The Test Odyssey'].state === 'accept' && /100%/.test(by['The Test Odyssey'].conf), JSON.stringify(by['The Test Odyssey']));
    assert(by['Mystery Tome'].level === 'medium' && by['Mystery Tome'].state === 'pending' && by['Wrong Match'].level === 'medium' && by['Wrong Match'].state === 'pending', JSON.stringify([by['Mystery Tome'], by['Wrong Match']]));
    assert(by['Isbn Book'].level === 'high' && /99%/.test(by['Isbn Book'].conf), JSON.stringify(by['Isbn Book']));
    assert(!by['Edited Book'].fields.includes('description') && by['Edited Book'].fields.includes('cover'), 'Edited Book offered a description: ' + by['Edited Book'].fields);
    assert(by['Saga Part Two'].fields.includes('series') && by['The Test Odyssey'].fields.includes('description'), JSON.stringify(by['Saga Part Two']));
    return `7 matches (${seen.length} progress states, min gap ${Math.min(...gaps)} ms)`;
  });

  await step('Review: accept / skip / edit, then apply fills only what was accepted', async () => {
    const card = (t) => `.fm-card:has(strong)`; const act = (t, a) => A.evaluate((t, a) => { const c = [...document.querySelectorAll('.fm-card')].find((x) => x.querySelector('strong').innerText === t); c.querySelector(`[data-act=${a}]`).click(); }, t, a);
    await act('Mystery Tome', 'edit'); await A.waitForSelector('#fm-edit-author'); await A.$eval('#fm-edit-author', (e) => { e.value = 'Zed Edited'; }); await click(A, '#fm-edit-save'); await sleep(200);
    assert(await A.evaluate(() => [...document.querySelectorAll('.fm-card')].find((x) => x.querySelector('strong').innerText === 'Mystery Tome').dataset.state) === 'accept', 'edit should accept');
    await act('Wrong Match', 'skip'); assert(await A.$eval('#fm-apply', (e) => e.innerText) === 'Apply 6 matches', await A.$eval('#fm-apply', (e) => e.innerText));
    await click(A, '#fm-apply'); await waitFor(A, () => /Updated 6 items/.test(document.querySelector('#toast')?.innerText || ''), null, 20000); return await A.$eval('#toast', (e) => e.innerText);
  });

  await step('Applied: description (HTML stripped), year, language, series, ~400px JPEG covers; typed edits are user-set; skipped item untouched', async () => {
    const od = await book(A, 'The Test Odyssey'); assert(od.author === 'Ada Writer' && od.description === 'An epic test voyage.' && od.year === 1999 && od.language === 'en' && od.coverSource === 'enrich' && !Object.keys(od.userSet || {}).length, JSON.stringify({ ...od, enriched: undefined }));
    const [w, h, type] = await coverDims(A, od.id); assert(type === 'image/jpeg' && w === 300 && h === 450, `${w}x${h} ${type}`);   // 300px-wide source is not upscaled
    const ed = await book(A, 'Edited Book'); assert(ed.description === 'My own notes' && ed.userSet.description && ed.hasCover && ed.coverSource === 'enrich' && ed.year === 2001, JSON.stringify({ d: ed.description, c: ed.hasCover }));
    const my = await book(A, 'Mystery Tome'); assert(my.author === 'Zed Edited' && my.userSet.author === true && my.description === 'A tome of mystery.' && my.year === 1980 && my.language === 'fr' && my.hasCover, JSON.stringify({ a: my.author, u: my.userSet, d: my.description }));
    const wr = await book(A, 'Wrong Match'); assert(!wr.hasCover && wr.author === 'Real Author' && wr.enrichTried > 0, 'skipped book changed: ' + JSON.stringify({ c: wr.hasCover, a: wr.author }));
    const sg = await book(A, 'Saga Part Two'); const sets = await dbAll(A, 'sets'); const set = sets.find((s) => s.id === sg.setId); assert(set && set.name === 'The Test Saga' && sg.seriesIndex === 2 && sg.description === 'Saga from the Open Library work record.', JSON.stringify({ set, i: sg.seriesIndex, d: sg.description }));
    const isb = await book(A, 'Isbn Book'); assert(isb.year === 1990 && isb.language === 'en' && isb.author === 'Isbn Person' && isb.hasCover, JSON.stringify({ y: isb.year, l: isb.language }));
    const og = await book(A, 'Ogg Tone', 'audiobooks'); assert(og.description === 'A tone, recorded in ogg.' && og.year === 2012 && og.language === 'en' && og.hasCover && og.coverSource === 'enrich', JSON.stringify({ d: og.description, y: og.year }));
    assert(S.log.proxy.some((u) => /books\.google\.com\/books\/content/.test(u)), 'Google Books thumbnail should have been fetched through the proxy (no CORS): ' + S.log.proxy.join('|'));
    assert(S.log.ol.some((u) => /works\/OL5W\/editions\.json/.test(u)) && S.log.gb.every((u) => !/key=/.test(u)), 'editions lookup / no API key expected');
    return 'proxy used for the CORS-less thumbnail; GB queries use no key';
  });

  await step('Second scan: items checked recently with no match are not re-proposed; "Look up all again" is offered', async () => {
    await A.evaluate(async () => { (await import('/js/enrich.js')).openFixMissing(); }); await A.waitForSelector('#fm-summary'); const t = await A.$eval('#fm-summary', (e) => e.innerText);
    assert(/checked recently/.test(t) && await A.$('#fm-retry') && await A.$eval('#fm-start', (e) => e.disabled), t); await closeSheets(A); return t;
  });

  await step('Rate limiting: Google Books 429 is retried with back-off; a persistent 429 degrades to Open Library only (no crash)', async () => {
    await A.evaluate(() => window.__mk({ title: 'The Test Odyssey', author: 'Ada Writer', identifier: 'urn:other-copy' })); const id = (await dbAll(A, 'books')).find((b) => b.identifier === 'urn:other-copy').id;
    S.gb429 = 2; const before = S.log.gb.length; const p1 = await A.evaluate(async (id) => (await import('/js/enrich.js')).lookupItem({ kind: 'book', id }), id);
    assert(S.log.gb.length - before === 3 && p1.fields.description?.value === 'An epic test voyage.' && !p1.rateLimited, `gb calls ${S.log.gb.length - before}`);
    S.gbAlways429 = true; const p2 = await A.evaluate(async (id) => (await import('/js/enrich.js')).lookupItem({ kind: 'book', id }), id); S.gbAlways429 = false;
    assert(p2.rateLimited === true && p2.fields.year?.value === 1999 && !p2.fields.description, JSON.stringify(p2.fields).slice(0, 200)); return '429 ×2 → success; always-429 → Open Library fields only';
  });

  await step('Auto-enrich on import: off by default (no requests); on → high-confidence applied, medium left alone', async () => {
    const olBefore = S.log.ol.length; await A.evaluate(() => window.__mk({ title: 'Auto High Book', author: 'Hannah High' })); await sleep(1200); assert(S.log.ol.length === olBefore, 'lookup happened while auto-enrich is off');
    await A.evaluate(() => window.__folio.show('settings')); await A.waitForSelector('#auto-enrich'); await click(A, '#auto-enrich'); assert(await A.evaluate(async () => (await import('/js/settings.js')).settings.get('autoEnrich')) === true, 'toggle did not stick');
    await A.evaluate(() => window.__mk({ title: 'Auto High Book', author: 'Hannah High', identifier: 'urn:auto-2' })); await A.evaluate(() => window.__mk({ title: 'Auto Medium Book' }));
    await waitFor(A, async () => { const bs = await (await import('/js/store.js')).getBooks(); const b = bs.find((x) => x.identifier === 'urn:auto-2'); return b && b.description === 'Auto-filled description.' && b.coverBlob; }, null, 20000);
    const hi = (await dbAll(A, 'books')).find((x) => x.identifier === 'urn:auto-2'); assert(hi.year === 2015 && hi.coverSource === 'enrich', JSON.stringify({ y: hi.year }));
    await waitFor(A, () => true); await sleep(1500); const md = await book(A, 'Auto Medium Book'); assert(S.log.ol.some((u) => /Auto\+Medium\+Book|Auto%20Medium%20Book/.test(u)), 'medium book was never looked up');
    assert(!md.hasCover && !md.description && md.author === 'Unknown author', 'medium-confidence match was applied automatically: ' + JSON.stringify({ c: md.hasCover, a: md.author })); return 'High Book filled; Medium Book untouched';
  });

  await step('User-set audiobook description (Edit sheet) is never replaced by a lookup', async () => {
    await A.evaluate(() => window.__folio.show('audiobooks')); await sleep(500); await tileMenu(A, 'Ogg Tone'); await click(A, '#audio-menu-edit'); await A.waitForSelector('#audio-edit-description');
    assert(await A.$eval('#audio-edit-description', (e) => e.value) === 'A tone, recorded in ogg.', 'prefill'); await A.$eval('#audio-edit-description', (e) => { e.value = 'Mine, not Google’s'; }); await click(A, '#audio-save'); await sleep(400);
    const og = await book(A, 'Ogg Tone', 'audiobooks'); assert(og.userSet.description === true && og.description === 'Mine, not Google’s', JSON.stringify(og.userSet));
    // force it to look "missing" again: the user-set flag must still protect it (a deliberately cleared field stays cleared)
    await A.evaluate(async (id) => { const { DB } = await import('/js/db.js'); const b = await DB.get('audiobooks', id); b.description = ''; b._noTouch = true; await DB.put('audiobooks', b); }, og.id);
    const scan = await A.evaluate(async () => (await import('/js/enrich.js')).scanLibrary({ books: false })); assert(!scan.some((e) => e.missing.includes('description')), JSON.stringify(scan));
    const res = await A.evaluate(async (id) => { const E = await import('/js/enrich.js'); const p = await E.lookupItem({ kind: 'audio', id }); return p; }, og.id); assert(!res || !res.fields.description, 'description proposed for a user-set field');
    await A.evaluate(async (id) => { const E = await import('/js/enrich.js'); await E.applyProposal({ kind: 'audio', id, fields: { description: { value: 'sneaky', source: 'x', conf: 1 } } }, { description: true }); }, og.id);
    assert((await book(A, 'Ogg Tone', 'audiobooks')).description === '', 'applyProposal overwrote a user-set field');
    await A.evaluate(async (id) => { const { DB } = await import('/js/db.js'); const b = await DB.get('audiobooks', id); b.description = 'Mine, not Google’s'; b._noTouch = true; await DB.put('audiobooks', b); }, og.id); return 'protected, even when cleared';
  });

  /* ---------------- sync ---------------- */
  await step('Sync (device A): metadata + downsized covers go to appDataFolder as cover-<sha1>.jpg; book and audio files never uploaded', async () => {
    await A.evaluate(fakeLogin().replace(/^/, '')); await A.reload({ waitUntil: 'networkidle0' }); await A.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await A.evaluate(async () => (await import('/js/enrich.js')).setRate(60));
    const r = await syncNow(A); const snap = JSON.parse(S.cloud.sync);
    const keys = Object.keys(snap.meta); const odk = keys.find((k) => /Test Odyssey/.test(k)); const edk = keys.find((k) => /Edited Book/.test(k));
    assert(snap.meta[odk].description.v === 'An epic test voyage.' && snap.meta[odk].description.u === false && snap.meta[odk].cover.id && snap.meta[odk].cover.u === false, JSON.stringify(snap.meta[odk]));
    assert(snap.meta[edk].description.u === true && snap.meta[edk].description.v === 'My own notes', JSON.stringify(snap.meta[edk]));
    const mk = keys.find((k) => /Mystery/.test(k)); assert(snap.meta[mk].author.u === true && snap.meta[mk].author.v === 'Zed Edited', JSON.stringify(snap.meta[mk]));
    const ak = Object.keys(snap.audioMeta); assert(ak.length === 1 && snap.audioMeta[ak[0]].description.u === true, JSON.stringify(snap.audioMeta));
    const ids = new Set([...Object.values(snap.meta), ...Object.values(snap.audioMeta)].map((e) => e.cover?.id).filter(Boolean)); const names = [...S.cloud.covers.keys()];
    assert(ids.size >= 2 && names.length === ids.size && names.every((n) => /^cover-[0-9a-f]{20}\.jpg$/.test(n)) && S.cloud.uploads === ids.size && r.coversUploaded === ids.size, JSON.stringify({ ids: ids.size, names, up: S.cloud.uploads, r }));
    for (const f of S.cloud.covers.values()) assert(f.buf[0] === 0xff && f.buf[1] === 0xd8 && f.buf.length < 120000, 'cover bytes are not a small JPEG');
    assert(!S.cloud.sync.includes('Hello ') && S.cloud.parents === true && !S.cloud.auth.some((a) => !a), 'unexpected content / no auth'); return `${ids.size} distinct cover file(s), ${Object.keys(snap.meta).length} book entries`;
  });

  const B = await mk(await browser.createBrowserContext(), { login: true });
  await step('Sync (device B, restore): same books get enriched fields + covers; user-set flags travel; books not imported yet keep their metadata pending', async () => {
    for (const o of [{ title: 'The Test Odyssey', author: 'Ada Writer' }, { title: 'Edited Book', author: 'Eddie Tor', description: 'Original blurb' }]) await B.evaluate((o) => window.__mk(o), o);
    const r = await syncNow(B); const od = await book(B, 'The Test Odyssey'); const ed = await book(B, 'Edited Book');
    assert(od.description === 'An epic test voyage.' && od.year === 1999 && od.language === 'en' && od.hasCover && od.coverSource === 'enrich' && od.coverId, JSON.stringify({ d: od.description, y: od.year, c: od.hasCover, r }));
    assert(ed.description === 'My own notes' && ed.userSet.description === true && ed.hasCover, 'user-set description did not restore');
    const pend = await B.evaluate(() => JSON.parse(localStorage.getItem('folio.pendingMeta') || '{}')); const pk = Object.keys(pend).find((k) => /Mystery/.test(k)); assert(pk && pend[pk].author.v === 'Zed Edited', JSON.stringify(Object.keys(pend)));
    await B.evaluate(() => window.__mk({ title: 'Mystery Tome' })); const my = await book(B, 'Mystery Tome'); assert(my.author === 'Zed Edited' && my.userSet.author === true, JSON.stringify({ a: my.author, u: my.userSet }));
    await B.evaluate(async () => { const f = new File([await (await fetch('./tests/fixtures/audio/tone.ogg')).arrayBuffer()], 'tone.ogg', { type: 'audio/ogg' }); await (await import('/js/audiostore.js')).importAudioFiles([f], 'each'); });
    const og = await book(B, 'Ogg Tone', 'audiobooks'); assert(og.description === 'Mine, not Google’s' && og.userSet.description === true, JSON.stringify({ d: og.description })); await syncNow(B);
    const og2 = await book(B, 'Ogg Tone', 'audiobooks'); assert(og2.hasCover && og2.coverSource === 'enrich', 'audiobook cover did not restore'); return 'description, year, language, cover, user flags restored; pending applied at import';
  });

  await step('Conflicts: a user-set value beats a newer automatic one; between two user edits the newest wins', async () => {
    // B: the user edits the Odyssey description (user-set, "later")
    await B.evaluate(async () => { const M = await import('/js/metasync.js'); const S2 = await import('/js/store.js'); const b = (await S2.getBooks()).find((x) => x.identifier === 'urn:test:The Test Odyssey'); M.markEdits(b, { description: 'B user text' }); await S2.saveBook(b); });
    // A: an *automatic* update stamped even later
    await A.evaluate(async () => { const S2 = await import('/js/store.js'); const { DB } = await import('/js/db.js'); const b = (await S2.getBooks()).find((x) => x.identifier === 'urn:test:The Test Odyssey'); b.description = 'auto text, newer'; b.metaAt.description = Date.now() + 60000; delete b.userSet.description; b._noTouch = true; await DB.put('books', b); });
    await syncNow(B); await syncNow(A); await syncNow(B);
    const a1 = await odOf(A), b1 = await odOf(B); assert(a1.description === 'B user text' && b1.description === 'B user text' && a1.userSet.description && b1.userSet.description, JSON.stringify({ a: a1.description, b: b1.description }));
    // two user edits of the year: B's is newer
    await A.evaluate(async () => { const M = await import('/js/metasync.js'); const S2 = await import('/js/store.js'); const b = (await S2.getBooks()).find((x) => x.identifier === 'urn:test:The Test Odyssey'); M.markEdits(b, { year: 2001 }); await S2.saveBook(b); }); await syncNow(A); await sleep(30);
    await B.evaluate(async () => { const M = await import('/js/metasync.js'); const S2 = await import('/js/store.js'); const b = (await S2.getBooks()).find((x) => x.identifier === 'urn:test:The Test Odyssey'); M.markEdits(b, { year: 2002 }); await S2.saveBook(b); }); await syncNow(B); await syncNow(A);
    const a2 = await odOf(A), b2 = await odOf(B); assert(a2.year === 2002 && b2.year === 2002, JSON.stringify({ a: a2.year, b: b2.year })); return 'user beats auto; newest user edit wins';
  });

  await step('Tombstones + cover GC: deleting items drops their synced metadata; orphaned covers are deleted only once older than an hour', async () => {
    // a unique custom cover on Wrong Match
    const wm = await book(A, 'Wrong Match'); await A.evaluate(async (id) => { const C = await import('/js/covers.js'); const r = await fetch('./tests/fixtures/img/big.jpg'); await C.setUserCover('book', id, await C.resizeCover(await r.blob())); }, wm.id); await syncNow(A);
    const cid = (await book(A, 'Wrong Match')).coverId; assert(cid && S.cloud.covers.has(`cover-${cid}.jpg`), 'unique cover not uploaded');
    await A.evaluate(async (id) => (await import('/js/store.js')).deleteBooks([id]), wm.id); const og = await book(A, 'Ogg Tone', 'audiobooks'); await A.evaluate(async (id) => (await import('/js/audiostore.js')).deleteAudiobooks([id]), og.id);
    await A.evaluate(async () => { const S2 = await import('/js/store.js'); const b = (await S2.getBooks()).find((x) => x.title === 'Saga Part Two'); await S2.deleteBooks([b.id]); });
    await syncNow(A); let snap = JSON.parse(S.cloud.sync);
    assert(!Object.keys(snap.meta).some((k) => /Wrong Match|Saga/.test(k)) && !Object.keys(snap.audioMeta).length, JSON.stringify(Object.keys(snap.meta)));
    assert(snap.tombstones.some((t) => t.t === 'book') && snap.tombstones.some((t) => t.t === 'audio'), 'tombstones missing: ' + JSON.stringify(snap.tombstones.map((t) => t.t)));
    assert(S.cloud.covers.has(`cover-${cid}.jpg`) && !S.cloud.deletes.length, 'a fresh orphan cover must not be deleted yet');
    S.cloud.covers.get(`cover-${cid}.jpg`).createdTime = new Date(Date.now() - 2 * 3600e3).toISOString(); await syncNow(A, true);
    assert(S.cloud.deletes.includes(`cover-${cid}.jpg`) && !S.cloud.covers.has(`cover-${cid}.jpg`), 'old orphan cover not garbage-collected'); assert(S.cloud.covers.size >= 1, 'referenced covers must survive GC');
    await syncNow(B); snap = JSON.parse(S.cloud.sync); assert(!Object.keys(snap.audioMeta).length, 'device B re-published metadata of an audiobook deleted on A'); return 'meta removed, tombstones kept, orphan cover GC\'d after 1 h';
  });

  await step('No page errors on either device', async () => { assert(!A.errs.length && !B.errs.length, A.errs.concat(B.errs).join(' | ')); });
  await browser.close();
  const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

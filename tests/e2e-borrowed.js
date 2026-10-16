// v0.5.0 "Borrowed": library-loan items live in their own filter (Library + Audiobooks), outside the owned library and its counts, with a due date
// (OPDS availability or manual), "due in N days" badges, a reminder banner with one-tap Remove / Remove all expired, manual marking, sync of flag + date,
// downloads from a catalog marked "public library", and DRM-protected files still refused.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const JSZip = require('../vendor/jszip.min.js');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const DAY = 864e5; const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
async function epub(title, author) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:identifier id="id">urn:loan:${title}</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  z.file('OEBPS/c1.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${title}</p></body></html>`);
  return z.generateAsync({ type: 'nodebuffer' });
}
(async () => {
  const dueIso = new Date(Date.now() + 9 * DAY).toISOString();
  const files = { 'a.epub': await epub('Loaned Book', 'Lia Loan'), 'b.epub': await epub('Flagged Plain', 'Fay Plain'), 'c.epub': await epub('Unflagged With Date', 'Una Date'), 'd.epub': await epub('Unflagged Plain', 'Ned Plain'), 'drm.mobi': fs.readFileSync(fx('drm-flagged.mobi')) };
  const E = (id, title, file, type, av) => `<entry><id>urn:loan:${id}</id><title>${title}</title><author><name>An Author</name></author><content type="text">x</content><link rel="http://opds-spec.org/acquisition" href="https://library.test/files/${file}" type="${type}">${av ? `<opds:availability status="available" until="${dueIso}"/>` : ''}</link></entry>`;
  const feed = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><title>City Library</title><id>urn:lib</id>${entries}</feed>`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.setRequestInterception(true);
  let feedXml = feed(E(1, 'Loaned Book', 'a.epub', 'application/epub+zip', true) + E(2, 'Flagged Plain', 'b.epub', 'application/epub+zip', false) + E(3, 'Unflagged With Date', 'c.epub', 'application/epub+zip', true) + E(4, 'Unflagged Plain', 'd.epub', 'application/epub+zip', false) + E(5, 'DRM Loan', 'drm.mobi', 'application/x-mobipocket-ebook', true));
  page.on('request', (req) => { const u = req.url(); if (!u.startsWith('https://library.test/')) return req.continue(); if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
    if (u.endsWith('/opds')) return req.respond({ status: 200, headers: CORS, contentType: 'application/atom+xml', body: feedXml });
    const f = files[u.split('/').pop()]; if (f) return req.respond({ status: 200, headers: CORS, contentType: 'application/octet-stream', body: f }); req.respond({ status: 404, headers: CORS, body: 'nf' }); });
  await page.goto(APP, { waitUntil: 'networkidle0' });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ev((s) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click(); }, sel);
  const clickText = (sel, re) => ev((s, r) => { const e = [...document.querySelectorAll(s)].find((x) => new RegExp(r, 'i').test(x.innerText)); if (!e) throw new Error('no ' + s + ' ~ ' + r); e.click(); }, sel, re);
  const show = async (t) => { await ev((t) => window.__folio.show(t), t); await sleep(450); };
  const foot = () => ev(() => document.querySelector('#lib-count')?.innerText || null);
  const titles = () => ev(() => [...document.querySelectorAll('.tile .t')].map((x) => x.innerText));
  const chipText = (id) => ev((id) => document.querySelector(`.chip[data-chip="${id}"]`)?.innerText || null, id);
  const books = () => ev(async () => (await (await import('./js/store.js')).getBooks()).map((b) => ({ id: b.id, title: b.title, borrowed: !!b.borrowed, dueAt: b.dueAt || null, src: b.loanSource || '' })));
  const audios = () => ev(async () => (await (await import('./js/audiostore.js')).getAudiobooks()).map((b) => ({ id: b.id, title: b.title, borrowed: !!b.borrowed, dueAt: b.dueAt || null })));
  const bookId = async (t) => (await books()).find((b) => b.title.startsWith(t))?.id;
  const setLoan = (kind, id, o) => ev(async (k, i, o) => (await import('./js/loans.js')).setLoan(k, i, o), kind, id, o);
  const tileMenu = async (t) => { await ev((t) => [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.t')?.innerText.startsWith(t)).querySelector('.tile-more').click(), t); await sleep(250); };

  await step('Setup: 3 owned books + 2 audiobooks', async () => {
    await show('library'); await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), fx('saga-1.epub'), fx('standalone.epub')); for (let i = 0; i < 60 && (await books()).length < 3; i++) await sleep(300); await show('library');
    await ev(async () => { const A = await import('./js/audiostore.js'); for (const [t, a] of [['Zed Owned Audio', 'Zed One'], ['Zed Loan Audio', 'Zed Two']]) await A.saveAudiobook({ id: 'au-' + t.split(' ')[1], kind: 'audio', title: t, author: a, description: '', addedAt: Date.now(), lastOpened: 0, position: 0, progress: 0, status: 'want', shelves: [], speed: null, source: 'import', sourceKey: null, syncKey: (t + '|' + a).toLowerCase(), coverBlob: null, tracks: [{ name: 't.mp3', title: t, size: 1, duration: 600, type: 'audio/mpeg', stored: false }], chapters: [], duration: 600, size: 1 }); });
    assert((await books()).length === 3 && (await audios()).length === 2); assert((await foot()) === '3 books', await foot());
  });

  await step('Mark a book as Borrowed from its ⋯ menu with a due date: leaves All, owned counts and chips; gets its own Borrowed filter', async () => {
    await tileMenu('Saga Book One'); await clickText('.sheet .list-item', 'Mark as borrowed'); await page.waitForSelector('#borrow-date'); await click('.loan-quick[data-days="14"]'); await click('#borrow-save'); await sleep(500);
    const b = (await books()).find((x) => x.title.startsWith('Saga')); assert(b.borrowed && b.dueAt > Date.now() + 13 * DAY, JSON.stringify(b));
    assert(!(await titles()).some((t) => t.startsWith('Saga')), 'borrowed book still in All'); assert((await foot()) === '2 books', 'owned footer: ' + await foot()); assert(/Borrowed\s*1/.test(await chipText('borrowed')), await chipText('borrowed'));
    const wants = await ev(() => +(/\d+/.exec(document.querySelector('.chip[data-chip="want"] small')?.innerText || '')?.[0] || -1)); assert(wants === 2, 'Want-to-read chip count excludes it: ' + wants);
  });

  await step('Borrowed filter lists it with a “Due in 14 days” badge and its own count; no banner yet', async () => {
    await click('.chip[data-chip="borrowed"]'); await sleep(400); assert((await titles()).length === 1 && /^Saga/.test((await titles())[0]), (await titles()).join());
    const badge = await ev(() => document.querySelector('.loan-badge')?.innerText); assert(badge === 'Due in 14 days', badge); assert((await foot()) === '1 book', await foot()); assert(!(await ev(() => !!document.querySelector('#loan-banner'))), 'banner too early');
  });

  await step('Reminder banner: due soon + expired; one-tap Remove; “Remove all expired”', async () => {
    const saga = await bookId('Saga'), stand = await bookId('A Standalone'), fr = await bookId('Frankenstein');
    await setLoan('book', saga, { borrowed: true, dueAt: Date.now() + 2 * DAY }); await setLoan('book', stand, { borrowed: true, dueAt: Date.now() - 3 * DAY }); await setLoan('book', fr, { borrowed: true, dueAt: null }); await sleep(500);
    const sum = await ev(() => document.querySelector('#loan-summary')?.innerText); assert(/1 expired/.test(sum) && /1 due soon/.test(sum), sum);
    const rows = await ev(() => [...document.querySelectorAll('.loan-row')].map((r) => r.innerText.replace(/\s+/g, ' '))); assert(rows.length === 2 && rows.some((r) => /Expired 3 days ago/.test(r)) && rows.some((r) => /Due in 2 days/.test(r)), rows.join(' | '));
    assert(/Borrowed\s*3/.test(await chipText('borrowed')), await chipText('borrowed'));
    await ev((id) => document.querySelector(`.loan-row[data-id="${id}"] .loan-remove`).click(), saga); await sleep(600); assert(!(await books()).some((b) => b.id === saga), 'one-tap Remove did not delete');
    assert(await ev(() => !!document.querySelector('#loan-remove-expired')), 'no remove-all-expired button'); await click('#loan-remove-expired'); await sleep(600);
    const left = await books(); assert(left.length === 1 && left[0].id === fr, 'left: ' + left.map((b) => b.title).join()); assert(!(await ev(() => !!document.querySelector('#loan-banner'))), 'banner should be gone');
  });

  await step('A borrowed item without a due date has no reminder; “Not borrowed” moves it back into the library', async () => {
    await tileMenu('Frankenstein'); await clickText('.sheet .list-item', 'Not borrowed'); await sleep(600);
    assert(!(await chipText('borrowed')), 'Borrowed chip should disappear when nothing is borrowed'); await click('.chip[data-chip="all"]'); await sleep(300); assert((await titles()).some((t) => /Frankenstein/.test(t)), 'back in All'); assert((await foot()) === '1 book', await foot());
  });

  await step('Audiobooks tab: Borrowed filter, banner and Remove all expired work the same way', async () => {
    await show('audiobooks'); await ev(() => [...document.querySelectorAll('.tile')].find((x) => x.querySelector('.t')?.innerText.startsWith('Zed Loan')).querySelector('.tile-more').click()); await sleep(250); await clickText('.sheet .list-item', 'Mark as borrowed'); await page.waitForSelector('#borrow-date'); await click('#borrow-clear'); await sleep(500);
    assert(/Borrowed\s*1/.test(await ev(() => document.querySelector('.chip[data-chip="borrowed"]')?.innerText)), 'chip'); assert(!(await ev(() => [...document.querySelectorAll('.tile .t')].some((x) => /Zed Loan/.test(x.innerText)))), 'borrowed audiobook still in All');
    await setLoan('audio', 'au-Loan', { borrowed: true, dueAt: Date.now() - DAY }); await sleep(500); assert(/Expired 1 day ago/.test(await ev(() => document.querySelector('.loan-row')?.innerText)), 'audio banner');
    await click('#loan-remove-expired'); await sleep(600); assert((await audios()).length === 1 && (await audios())[0].title === 'Zed Owned Audio', 'audio not removed'); assert(!(await ev(() => !!document.querySelector('.chip[data-chip="borrowed"]'))), 'chip should be gone');
  });

  await step('OPDS availability dates are parsed (Atom opds:availability and OPDS 2 properties.availability)', async () => {
    const r = await ev(async (feedXml) => { const O = await import('./js/opds.js'); const a = O.parseFeedText(feedXml, 'https://library.test/opds', 'application/atom+xml');
      const j = O.parseFeedText(JSON.stringify({ metadata: { title: 'J' }, publications: [{ metadata: { title: 'JB', identifier: 'x' }, links: [{ rel: 'http://opds-spec.org/acquisition', href: 'https://library.test/files/a.epub', type: 'application/epub+zip', properties: { availability: { state: 'available', until: '2031-01-02T03:04:05Z' } } }] }, { metadata: { title: 'NoDate', identifier: 'y' }, links: [{ rel: 'http://opds-spec.org/acquisition', href: 'https://library.test/files/a.epub', type: 'application/epub+zip' }] }] }), 'https://library.test/o.json', 'application/opds+json');
      return { a: a.entries.map((e) => [e.title, e.dueAt || null, !!e.loan]), j: j.entries.map((e) => [e.title, e.dueAt || null, !!e.loan]) }; }, feedXml);
    assert(r.a[0][1] === Date.parse(dueIso) && r.a[0][2] && r.a[1][1] === null && !r.a[1][2], JSON.stringify(r.a)); assert(r.j[0][1] === Date.parse('2031-01-02T03:04:05Z') && r.j[1][1] === null, JSON.stringify(r.j));
  });

  await step('A catalog marked “public library”: its downloads land in Borrowed (with the OPDS due date); other catalogs stay owned unless the feed carries a loan date', async () => {
    await ev(async () => { const S = await import('./js/store.js'); await S.addSource({ id: 'src-city', name: 'City Library', kind: 'opds', url: 'https://library.test/opds', note: 'OPDS catalog' }); });
    await ev(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(500);
    await ev(() => [...document.querySelectorAll('.source')].find((x) => /City Library/.test(x.innerText)).querySelector('.btn-icon').click()); await sleep(250); await click('#src-borrowed'); await sleep(400);
    assert((await ev(async () => (await (await import('./js/store.js')).getSources()).find((s) => s.id === 'src-city').borrowed)) === true, 'flag not saved');
    await ev(() => [...document.querySelectorAll('.source')].find((x) => /City Library/.test(x.innerText)).click()); await page.waitForSelector('.dl', { timeout: 8000 });
    const dl = async (title) => { await ev((t) => [...document.querySelectorAll('.dl')].find((b) => b.closest('.list-item, .entry, .card, li, div')?.parentElement?.innerText.includes(t) || b.closest('[class]')?.innerText.includes(t)).click(), title); for (let i = 0; i < 40; i++) { if ((await books()).some((b) => b.title === title)) return; await sleep(250); } throw new Error('not imported: ' + title); };
    const dlNth = async (n, title) => { await ev((n) => document.querySelectorAll('.dl')[n].click(), n); for (let i = 0; i < 40; i++) { if ((await books()).some((b) => b.title === title)) return; await sleep(250); } throw new Error('not imported: ' + title); };
    await dlNth(0, 'Loaned Book'); await dlNth(1, 'Flagged Plain');
    let bs = await books(); const lb = bs.find((b) => b.title === 'Loaned Book'), fp = bs.find((b) => b.title === 'Flagged Plain');
    assert(lb.borrowed && Math.abs(lb.dueAt - Date.parse(dueIso)) < 1000 && lb.src === 'City Library', JSON.stringify(lb)); assert(fp.borrowed && !fp.dueAt, JSON.stringify(fp));
    // turn the flag off: only the entry with an availability date is still treated as a loan
    await ev(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300); await ev(() => [...document.querySelectorAll('.source')].find((x) => /City Library/.test(x.innerText)).querySelector('.btn-icon').click()); await sleep(250); await clickText('.sheet .list-item', 'Public library: ON'); await sleep(300);
    await ev(() => [...document.querySelectorAll('.source')].find((x) => /City Library/.test(x.innerText)).click()); await page.waitForSelector('.dl', { timeout: 8000 });
    await dlNth(2, 'Unflagged With Date'); await dlNth(3, 'Unflagged Plain'); bs = await books();
    assert(bs.find((b) => b.title === 'Unflagged With Date').borrowed && !bs.find((b) => b.title === 'Unflagged Plain').borrowed, 'unflagged handling');
    await show('library'); const owned = await titles(); assert(!owned.includes('Loaned Book') && !owned.includes('Flagged Plain') && !owned.includes('Unflagged With Date') && owned.includes('Unflagged Plain'), owned.join()); assert(/Borrowed\s*3/.test(await chipText('borrowed')), await chipText('borrowed'));
    await click('.chip[data-chip="borrowed"]'); await sleep(300); assert(/Due in 9 days/.test(await ev(() => document.body.innerText)), 'due badge for OPDS date');
  });

  await step('DRM-protected loans are still refused (nothing is imported)', async () => {
    const before = (await books()).length; await ev(() => document.querySelector('[data-tab=catalogs]').click()); await sleep(300); if (!(await page.$('.dl'))) { await ev(() => [...document.querySelectorAll('.source')].find((x) => /City Library/.test(x.innerText)).click()); } await page.waitForSelector('.dl', { timeout: 8000 });
    await ev(() => [...document.querySelectorAll('.dl')].pop().click()); await sleep(1500); const toast = await ev(() => document.querySelector('#toast')?.innerText || ''); assert((await books()).length === before, 'DRM book was imported'); assert(/DRM|protected|can.t/i.test(toast), 'toast: ' + toast);
  });

  await step('Sync: borrowed flag + due date travel in the snapshot; the newest change wins; older snapshots without loans still merge', async () => {
    const r = await ev(async () => {
      const G = await import('./js/google.js'), S = await import('./js/store.js'), Lo = await import('./js/loans.js');
      const b = (await S.getBooks()).find((x) => x.title === 'Loaned Book'); const key = 'book:' + S.bookSyncKey(b);
      const local = await G.buildSnapshot(); const mine = local.loans[key];
      const remoteNewer = structuredClone(local); remoteNewer.loans[key] = { b: 0, due: null, src: '', at: Date.now() + 5000 };
      const m1 = G.mergeSnapshots(local, remoteNewer); await G.applySnapshot(m1, {}); const after1 = await S.getBook(b.id);
      const remoteOlder = structuredClone(await G.buildSnapshot()); const cur = (await G.buildSnapshot()).loans[key]; remoteOlder.loans[key] = { b: 1, due: 12345, src: 'x', at: 1 };
      const m2 = G.mergeSnapshots(await G.buildSnapshot(), remoteOlder); await G.applySnapshot(m2, {}); const after2 = await S.getBook(b.id);
      const legacy = structuredClone(local); delete legacy.loans; delete legacy.links; const m3 = G.mergeSnapshots(local, legacy);
      return { mine, borrowed1: after1.borrowed, due1: after1.dueAt, borrowed2: after2.borrowed, keptLegacy: Object.keys(m3.loans).length === Object.keys(local.loans).length && Array.isArray(m3.links) };
    });
    assert(r.mine && r.mine.b === 1 && Math.abs(r.mine.due - Date.parse(dueIso)) < 1000, JSON.stringify(r.mine)); assert(r.borrowed1 === false && r.due1 === null, 'newer remote should win: ' + JSON.stringify(r)); assert(r.borrowed2 === false, 'older remote must not win'); assert(r.keptLegacy, 'legacy snapshot merge');
  });

  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

// v0.5.24: duplicate detector — find groups in a ~450-book library, prefer the edited copy, merge highlights
// and furthest progress, remember "Not duplicates", undo a removal, and do not re-add the dropped Drive file after a simulated sync.
const puppeteer = require('puppeteer-core');
const APP = process.env.URL || 'http://localhost:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const N = 450;
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(800);

  await step(`seed a library of ${N} books with exact, likely, and "not duplicates" pairs`, async () => {
    const r = await page.evaluate(async (N) => {
      const S = await import('./js/store.js'); const { DB } = await import('./js/db.js');
      for (const st of ['books', 'files', 'bookmarks', 'glossary', 'links', 'orders', 'sets', 'shelves']) await DB.clear(st);
      const base = { language: 'en', description: '', identifier: null, year: null, isbn: null, addedAt: Date.now(), lastOpened: 0, progress: 0, cfi: null, status: 'want', shelves: [], setId: null, seriesIndex: null, coverBlob: null, format: 'epub', source: 'import', overrides: null, locations: null, _noTouch: true };
      const put = (b) => DB.put('books', b);
      // unique fillers
      for (let i = 0; i < N - 6; i++) await put({ ...base, id: 'u' + i, title: 'Unique ' + i, author: 'Author ' + (i % 40), syncKey: 'k:u' + i, size: 10000 + i, filename: 'unique-' + i + '.epub' });
      // exact: same size + "Pride and Prejudice" / "Pride and Prejudice (1).epub" — edited copy has less progress; other has highlights + more progress + a Drive source
      const keepE = { ...base, id: 'ex-keep', title: 'Pride and Prejudice', author: 'Jane Austen', filename: 'Pride and Prejudice.epub', size: 424242, syncKey: 'k:pride-keep', progress: 0.1, sourceKey: 'gdrive:keepfile', uo: { title: { v: 'Pride and Prejudice', at: 100, d: 'dev' } }, _noTouch: true };
      const dropE = { ...base, id: 'ex-drop', title: 'Pride and Prejudice', author: 'Jane Austen', filename: 'Pride and Prejudice (1).epub', size: 424242, syncKey: 'k:pride-drop', progress: 0.8, cfi: '/6/8', sourceKey: 'gdrive:dropfile', inDrive: true, _noTouch: true };
      await put(keepE); await put(dropE);
      await DB.put('glossary', { id: 'hl1', kind: 'hl', bookKey: 'k:pride-drop', bookTitle: 'Pride and Prejudice', cfiRange: 'epubcfi(/6/8,/6/10)', text: 'It is a truth', note: 'opening', at: Date.now() });
      await S.addBookmark({ bookId: 'ex-drop', cfi: '/6/8', label: 'ch 1', progress: 0.8 });
      // likely: same title+author, different files
      await put({ ...base, id: 'lk-a', title: 'The Hobbit', author: 'J.R.R. Tolkien', filename: 'The Hobbit.epub', size: 111000, syncKey: 'k:hobbit-a' });
      await put({ ...base, id: 'lk-b', title: 'Hobbit, The', author: 'Tolkien, J.R.R.', filename: 'hobbit-illustrated.epub', size: 222000, syncKey: 'k:hobbit-b' });
      // a pair she will mark "Not duplicates"
      await put({ ...base, id: 'nd-a', title: 'Common Title', author: 'Same Author', filename: 'common-a.epub', size: 50100, syncKey: 'k:nd-a' });
      await put({ ...base, id: 'nd-b', title: 'Common Title', author: 'Same Author', filename: 'common-b.epub', size: 50200, syncKey: 'k:nd-b' });
      return (await S.getBooks()).length;
    }, N);
    assert(r === N, 'seeded ' + r + ' not ' + N);
    return r + ' books';
  });

  await step('detection is memory-light (never reads file blobs) and groups exact first; suggested keep prefers the edited copy', async () => {
    const r = await page.evaluate(async () => {
      window.__fileReads = 0;
      const get = IDBObjectStore.prototype.get, ga = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.get = function (k) { if (this.name === 'files') window.__fileReads++; return get.call(this, k); };
      IDBObjectStore.prototype.getAll = function (...a) { if (this.name === 'files') window.__fileReads++; return ga.apply(this, a); };
      const S = await import('./js/store.js'); const D = await import('./js/dupes.js');
      const groups = D.findDuplicates(await S.getBooks());
      IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.getAll = ga;
      return { n: groups.length, kinds: groups.map((g) => g.kind), titles: groups.map((g) => g.books.map((b) => b.id)), keep: groups.map((g) => g.keepId), files: window.__fileReads, edits: D.hasManualEdits };
    });
    assert(r.files === 0, 'read files x' + r.files);
    assert(r.n === 3, 'groups ' + r.n + ' ' + JSON.stringify(r.titles));
    assert(r.kinds[0] === 'exact', 'exact not first: ' + r.kinds.join());
    const pride = r.titles.find((ids) => ids.includes('ex-keep'));
    assert(pride && pride.includes('ex-drop'), 'exact pair missing');
    const prideKeep = r.keep[r.titles.indexOf(pride)];
    assert(prideKeep === 'ex-keep', 'suggested keep was ' + prideKeep + ' (edits should win over progress)');
    const hobbit = r.titles.find((ids) => ids.includes('lk-a'));
    assert(hobbit && hobbit.includes('lk-b'), 'likely pair missing');
    assert(r.kinds[r.titles.indexOf(hobbit)] === 'likely', 'hobbit not likely');
    return JSON.stringify({ n: r.n, kinds: r.kinds, keep: r.keep });
  });

  await step('library shows a non-blocking “possible duplicates” note; Settings opens the review (edited copy is suggested)', async () => {
    await page.evaluate(async () => { await window.__folio.show('library'); });
    await page.waitForSelector('#dupe-banner', { timeout: 8000 });
    const banner = await page.$eval('#dupe-banner-text', (e) => e.textContent);
    assert(/possible duplicate/.test(banner) && /Review/i.test(banner), banner);
    await page.evaluate(async () => { await window.__folio.show('settings'); });
    await page.waitForSelector('#settings-find-dupes', { timeout: 5000 });
    await page.click('#settings-find-dupes');
    await page.waitForSelector('#dupe-sheet', { timeout: 5000 });
    const ui = await page.evaluate(() => ({
      groups: document.querySelectorAll('.dupe-group').length,
      suggested: document.querySelector('#dupe-sug-ex-keep')?.textContent || '',
      exactFirst: document.querySelector('#dupe-group-0')?.dataset.kind,
    }));
    assert(ui.groups === 3, 'ui groups ' + ui.groups);
    assert(/Suggested keep/.test(ui.suggested), 'no suggested label: ' + ui.suggested);
    assert(ui.exactFirst === 'exact', 'first group ' + ui.exactFirst);
    return JSON.stringify(ui);
  });

  await step('“Not duplicates” is remembered; removing merges highlights and furthest progress; Undo restores', async () => {
    // mark the Common Title group (last) as not duplicates
    const nGroups = await page.$$eval('.dupe-group', (els) => els.length);
    let ndIdx = -1;
    for (let i = 0; i < nGroups; i++) {
      const has = await page.$(`#dupe-group-${i} #dupe-keep-nd-a`);
      if (has) { ndIdx = i; break; }
    }
    assert(ndIdx >= 0, 'not-dupe group missing from sheet');
    await page.click('#dupe-not-' + ndIdx);
    await sleep(400);
    await page.click('#dupe-remove');
    await page.waitForSelector('#dlg-ok', { timeout: 5000 });
    const confirm = await page.$eval('#dlg-ok', (e) => e.textContent);
    assert(/Remove 2/.test(confirm) || /Remove 3/.test(confirm) || /Remove \d/.test(confirm), confirm);
    // exact + likely = 2 removed (one each); not-dupes is off
    await page.click('#dlg-ok');
    await sleep(800);
    const toast = await page.evaluate(() => { const e = document.querySelector('#toast'); return e && !e.hidden ? e.textContent : ''; });
    assert(/Removed/.test(toast) && /Undo/.test(toast), 'toast: ' + toast);
    const after = await page.evaluate(async () => {
      const S = await import('./js/store.js'); const D = await import('./js/dupes.js');
      const books = await S.getBooks();
      const keep = books.find((b) => b.id === 'ex-keep');
      const hls = (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => x.kind === 'hl' && !x.del && x.bookKey === (keep && (keep.syncKey || 'k:pride-keep')));
      const bms = keep ? await S.getBookmarks(keep.id) : [];
      return {
        n: books.length,
        hasDrop: books.some((b) => b.id === 'ex-drop' || b.id === 'lk-b' || b.id === 'lk-a' && false),
        ids: { dropE: books.some((b) => b.id === 'ex-drop'), dropL: books.some((b) => b.id === 'lk-b' || b.id === 'lk-a'), nd: books.filter((b) => b.id === 'nd-a' || b.id === 'nd-b').length, hobbit: books.filter((b) => b.id === 'lk-a' || b.id === 'lk-b').length },
        progress: keep && keep.progress, merged: keep && keep.mergedSources, mergedKeys: keep && keep.mergedSyncKeys,
        hls: hls.length, notes: hls[0] && hls[0].note, bms: bms.length,
        again: D.findDuplicates(books).map((g) => g.books.map((b) => b.id)),
      };
    });
    assert(after.ids.dropE === false, 'exact drop still there');
    assert(after.ids.hobbit === 1, 'likely pair not reduced: ' + after.ids.hobbit);
    assert(after.ids.nd === 2, 'not-dupes were removed');
    assert(after.progress >= 0.8, 'progress not merged: ' + after.progress);
    assert((after.merged || []).includes('gdrive:dropfile'), 'mergedSources ' + JSON.stringify(after.merged));
    assert((after.mergedKeys || []).includes('k:pride-drop'), 'mergedSyncKeys ' + JSON.stringify(after.mergedKeys));
    assert(after.hls >= 1 && after.notes === 'opening', 'highlights not merged: ' + JSON.stringify({ hls: after.hls, notes: after.notes }));
    assert(after.bms >= 1, 'bookmark not merged');
    assert(after.again.every((ids) => !ids.includes('nd-a') && !ids.includes('nd-b')), 'not-dupes flagged again: ' + JSON.stringify(after.again));
    // Undo
    await page.click('#toast-action');
    await sleep(800);
    const undone = await page.evaluate(async () => {
      const S = await import('./js/store.js'); const D = await import('./js/dupes.js');
      const books = await S.getBooks();
      const keep = books.find((b) => b.id === 'ex-keep');
      const dropHls = (await (await import('./js/db.js')).DB.all('glossary')).filter((x) => x.kind === 'hl' && !x.del && x.bookKey === 'k:pride-drop');
      return { n: books.length, dropE: books.some((b) => b.id === 'ex-drop'), hobbit: books.filter((b) => b.id === 'lk-a' || b.id === 'lk-b').length, progress: keep && keep.progress, dropHls: dropHls.length, again: D.findDuplicates(books).map((g) => g.books.map((b) => b.id)) };
    });
    assert(undone.n === N, 'undo count ' + undone.n);
    assert(undone.dropE && undone.hobbit === 2, 'drops not restored');
    assert(undone.progress === 0.1, 'keep progress not restored: ' + undone.progress);
    assert(undone.dropHls >= 1, 'highlight not restored to drop');
    assert(undone.again.length === 2, 'not-dupes should still be remembered; groups=' + JSON.stringify(undone.again));
    return JSON.stringify({ afterN: after.n, progress: after.progress, undone: undone.n });
  });

  await step('removing again, a simulated sync does not re-add the dropped Drive file', async () => {
    // remove the exact+likely pairs again via the API (sheet may have closed)
    const removed = await page.evaluate(async () => {
      const S = await import('./js/store.js'); const D = await import('./js/dupes.js');
      const groups = D.findDuplicates(await S.getBooks());
      const pack = await D.removeDuplicates(groups);
      const books = await S.getBooks();
      const keep = books.find((b) => b.id === 'ex-keep');
      // simulate the other device still carrying the dropped book in cloud state
      const G = await import('./js/google.js');
      const snap = await G.buildSnapshot();
      const droppedState = { title: 'Pride and Prejudice', author: 'Jane Austen', addedAt: 1, status: 'want', shelves: [], progress: 0.8, updatedAt: 1, src: { kind: 'gdrive', id: 'dropfile', name: 'Pride and Prejudice (1).epub', size: 424242, fmt: 'epub' } };
      snap.books['k:pride-drop'] = droppedState;
      // drop the tombstone temporarily to prove absorbed keys, not just tombs, block the re-add
      const tombs = snap.tombstones || [];
      snap.tombstones = tombs.filter((t) => t.id !== 'k:pride-drop');
      await G.applySnapshot(snap);
      const pending = S.getPending();
      const miss = (await import('./js/syncfetch.js')).missingBooks();
      const known = await (await import('./js/drivebatch.js')).knownIds('book');
      let stubErr = '';
      try { await S.addDriveStub({ id: 'dropfile', name: 'Pride and Prejudice (1).epub', size: 424242, syncKey: 'k:pride-drop' }); } catch (e) { stubErr = e.message; }
      return {
        n: (await S.getBooks()).length,
        pending: !!pending['k:pride-drop'],
        missDrive: (miss.drive || []).some((f) => f.id === 'dropfile'),
        known: known.has('dropfile'),
        stubErr,
        stillDrop: (await S.getBooks()).some((b) => b.id === 'ex-drop'),
        merged: keep && (keep.mergedSources || []).includes('gdrive:dropfile'),
      };
    });
    assert(!removed.stillDrop, 'drop still in library');
    assert(!removed.pending, 'pending re-added the drop');
    assert(!removed.missDrive, 'missing-books lists the drop');
    assert(removed.known, 'knownIds missed the absorbed Drive id');
    assert(/already in your library/i.test(removed.stubErr), 'stub: ' + removed.stubErr);
    return JSON.stringify(removed);
  });

  await step('no page errors', async () => { assert(!page.errs.length, page.errs.join(' | ')); });
  await browser.close(); const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); process.exit(bad.length ? 1 : 0);
})();

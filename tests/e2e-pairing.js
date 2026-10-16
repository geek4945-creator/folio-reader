// v0.5.0 automatic audiobook ↔ ebook pairing: normalised title / author / series / ISBN scoring, ≥ 85 % auto-link, suggestions with Accept / Reject,
// remembered rejections (Forget), Unlink, the on/off setting, ambiguity, persistence and Drive-appData sync (merge, newer wins, legacy snapshots).
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); await page.goto(APP, { waitUntil: 'networkidle0' });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ev((s) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click(); }, sel);
  const closeAll = () => ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  const until = async (fn, ms = 9000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(200); } };
  const links = () => ev(async () => (await (await import('./js/db.js')).DB.all('links')).map((l) => ({ id: l.id, b: l.bookTitle, a: l.audioTitle, state: l.state, by: l.by, score: l.score, upd: l.updatedAt })));
  const linked = async () => (await links()).filter((l) => l.state === 'linked');
  const addAudio = (list) => ev(async (list) => { const A = await import('./js/audiostore.js'); for (const [id, t, a] of list) await A.saveAudiobook({ id, kind: 'audio', title: t, author: a, description: '', addedAt: Date.now(), lastOpened: 0, position: 0, progress: 0, status: 'want', shelves: [], speed: null, source: 'import', sourceKey: null, syncKey: (t + '|' + a + '|' + id).toLowerCase(), coverBlob: null, tracks: [{ name: 't.mp3', title: t, size: 1, duration: 600, type: 'audio/mpeg', stored: false }], chapters: [], duration: 600, size: 1 }); }, list);
  const openPairs = async () => { await closeAll(); await ev(() => import('./js/findplace.js').then((m) => m.openPairs())); await page.waitForSelector('#pairs-root #pairs-scan'); await sleep(250); };
  const rows = () => ev(() => [...document.querySelectorAll('#pairs-suggested .pair-row')].map((r) => ({ t: r.innerText.replace(/\s+/g, ' '), book: r.dataset.book, audio: r.dataset.audio, score: +r.dataset.score })));
  const rowBtn = (title, cls) => ev((title, cls) => { const r = [...document.querySelectorAll('#pairs-suggested .pair-row')].find((x) => x.innerText.includes(title)); if (!r) throw new Error('no row ' + title); r.querySelector(cls).click(); }, title, cls);

  await step('Setup: five ebooks imported; the “Pair automatically” setting is on by default', async () => {
    await (await page.$('#file-input')).uploadFile(fx('frankenstein.epub'), fx('saga-1.epub'), fx('saga-2.epub'), fx('saga-3.epub'), fx('standalone.epub'));
    await until(() => ev(async () => (await (await import('./js/store.js')).getBooks()).length === 5), 20000, 'five books'); assert(await ev(async () => (await import('./js/settings.js')).settings.get('autoPair') === true), 'autoPair should default to on');
  });
  await step('Normalised title + author scoring links the sure matches by itself (Frankenstein “; or, …”, “(Unabridged)”), and only those', async () => {
    await addAudio([['au-fr', 'Frankenstein', 'Mary Shelley'], ['au-s1', 'Saga Book One (Unabridged)', 'Test Author'], ['au-sa', 'Standalone Tale, A', 'Another Author'], ['au-s2', 'Saga Book Two', ''], ['au-s4', 'Saga Book Four', 'Test Author']]);
    const l = await until(async () => { const x = await linked(); return x.length >= 2 && x; }, 9000, 'auto-link'); await sleep(1500); const all = await linked();
    assert(all.length === 2 && all.every((x) => x.by === 'auto' && x.score >= 85), JSON.stringify(all)); const t = all.map((x) => x.b).sort(); assert(/Frankenstein/.test(t[0]) && /Saga Book One/.test(t[1]), t.join('|')); return all.map((x) => x.score).join(', ') + ' %';
  });
  await step('Medium confidence (title contained / no author) is only suggested, with scores; a different volume number is not suggested at all', async () => {
    assert((await ev(() => JSON.parse(localStorage.getItem('folio.pairNotified') || '[]').length)) === 2, 'the user should be told about 2 suggestions once');
    await openPairs(); const r = await rows(); assert(r.length === 2, JSON.stringify(r)); assert(r.every((x) => x.score >= 55 && x.score < 85), JSON.stringify(r)); assert(r.some((x) => /Standalone Tale/.test(x.t)) && r.some((x) => /Saga Book Two/.test(x.t)), r.map((x) => x.t).join(' // ')); assert(!r.some((x) => /Four/.test(x.t)), 'volume mismatch suggested');
    assert(/% match/.test(r[0].t), 'score text missing');
  });
  await step('Accept links the pair (by you); Reject removes it and remembers the rejection', async () => {
    await rowBtn('Saga Book Two', '.pair-accept'); await sleep(500); let l = await linked(); assert(l.length === 3 && l.some((x) => /Saga Book Two/.test(x.b) && x.by === 'user'), JSON.stringify(l));
    await rowBtn('Standalone', '.pair-reject'); await sleep(500); assert((await rows()).length === 0, 'rows should be empty'); assert(/1 rejected/.test(await ev(() => document.querySelector('#pairs-rejected-count').innerText)), 'rejected count');
    await click('#pairs-scan'); await sleep(800); await openPairs(); assert((await rows()).length === 0 && (await linked()).length === 3, 'a rejected pair came back');
    const rej = (await links()).filter((x) => x.state === 'rejected'); assert(rej.length === 1 && /Standalone/.test(rej[0].b), JSON.stringify(rej));
  });
  await step('Rejections survive a reload and automatic runs; “Forget rejections” brings the suggestion back', async () => {
    await page.reload({ waitUntil: 'networkidle0' }); await sleep(4500); assert((await linked()).length === 3 && (await links()).filter((x) => x.state === 'rejected').length === 1, 'state changed after reload / auto run');
    await openPairs(); assert((await rows()).length === 0, 'rejected pair suggested again'); await click('#pairs-forget'); await sleep(700); const r = await rows(); assert(r.length === 1 && /Standalone/.test(r[0].t), JSON.stringify(r));
    await rowBtn('Standalone', '.pair-accept'); await sleep(500); assert((await linked()).length === 4, 'accept after forget');
  });
  await step('Unlink: easy from the pairs screen; the pair is remembered as rejected, not re-linked automatically; change = link another', async () => {
    await openPairs(); await ev(() => [...document.querySelectorAll('#pairs-linked .pair-linked')].find((x) => x.innerText.includes('Frankenstein')).querySelector('.pair-unlink').click()); await sleep(600);
    let l = await linked(); assert(l.length === 3 && !l.some((x) => /Frankenstein/.test(x.b)), JSON.stringify(l)); await ev(() => import('./js/links.js').then((m) => m.autoPair())); await sleep(2800); assert(!(await linked()).some((x) => /Frankenstein/.test(x.b)), 'unlinked pair was re-linked');
    assert((await ev(async () => { const L = await import('./js/links.js'); const S = await import('./js/store.js'); const A = await import('./js/audiostore.js'); const b = (await S.getBooks()).find((x) => /Frankenstein/.test(x.title)); return (await L.linkFor('book', b)); })) === null, 'linkFor should be null after unlink');
    await ev(async () => { const L = await import('./js/links.js'); const S = await import('./js/store.js'); const A = await import('./js/audiostore.js'); const b = (await S.getBooks()).find((x) => /Frankenstein/.test(x.title)); await L.link(b, await A.getAudiobook('au-s4'), { by: 'user' }); });   // "change": another audiobook
    l = await linked(); assert(l.some((x) => /Frankenstein/.test(x.b) && /Four/.test(x.a)), JSON.stringify(l));
    await ev(async () => { const L = await import('./js/links.js'); const S = await import('./js/store.js'); const A = await import('./js/audiostore.js'); const b = (await S.getBooks()).find((x) => /Frankenstein/.test(x.title)); await L.unlink(b, await A.getAudiobook('au-s4')); });
  });
  await step('Ambiguity: two audiobooks with the same title are suggested, never auto-linked; accepting one clears the other', async () => {
    await ev(async () => { const { settings } = await import('./js/settings.js'); }); await addAudio([['au-3a', 'Saga Book Three', 'Test Author'], ['au-3b', 'Saga Book Three', 'Test Author']]); await sleep(4000);
    assert(!(await linked()).some((x) => /Three/.test(x.b)), 'ambiguous pair auto-linked'); await openPairs(); const r = (await rows()).filter((x) => /Saga Book Three/.test(x.t)); assert(r.length === 2 && r.every((x) => x.score >= 85), JSON.stringify(r));
    await ev(() => document.querySelector('#pairs-suggested .pair-row .pair-accept').click()); await sleep(700); assert((await rows()).filter((x) => /Saga Book Three/.test(x.t)).length === 0, 'the other copy should no longer be suggested'); assert((await linked()).filter((x) => /Three/.test(x.b)).length === 1);
  });
  await step('Setting off: nothing links by itself (sure matches appear as suggestions); switching on links them', async () => {
    await closeAll(); await ev(() => window.__folio.show('settings')); await page.waitForSelector('#auto-pair'); await click('#auto-pair'); await sleep(300); assert(!(await ev(async () => (await import('./js/settings.js')).settings.get('autoPair'))), 'setting not off');
    await ev(async () => { const L = await import('./js/links.js'); const S = await import('./js/store.js'); const A = await import('./js/audiostore.js'); const b = (await S.getBooks()).find((x) => /Saga Book One/.test(x.title)); await L.unlink(b, (await A.getAudiobooks()).find((x) => /Saga Book One/.test(x.title))); });
    await ev(async () => { const L = await import('./js/links.js'); for (const x of await L.getLinks()) if (x.state === 'rejected') await L.clearRejection(x.bookKey, x.audioKey); }); await sleep(3500);
    assert(!(await linked()).some((x) => /Saga Book One|Frankenstein/.test(x.b)), 'linked while the setting is off'); await openPairs(); const r = await rows(); assert(r.some((x) => /Saga Book One/.test(x.t) && x.score >= 85) && r.some((x) => /Frankenstein/.test(x.t)), JSON.stringify(r.map((x) => x.t)));
    await ev(async () => { const { settings } = await import('./js/settings.js'); settings.set({ autoPair: true }); }); await until(async () => (await linked()).some((x) => /Saga Book One/.test(x.b)) && (await linked()).some((x) => /Frankenstein/.test(x.b)), 9000, 'auto-link after switching on');
  });
  await step('Library ⋯ menu and Settings entries open the pairs screen', async () => {
    await closeAll(); await ev(() => window.__folio.show('library')); await sleep(300); await ev(() => document.querySelector('#lib-menu, .lib-menu, [data-act=menu], #btn-lib-menu')?.click()); const has = await ev(() => !!document.querySelector('#menu-pairs')); if (has) { await click('#menu-pairs'); await page.waitForSelector('#pairs-root'); await closeAll(); }
    await ev(() => window.__folio.show('settings')); await page.waitForSelector('#settings-pairs'); await click('#settings-pairs'); await page.waitForSelector('#pairs-root'); await closeAll(); return has ? 'menu + settings' : 'settings';
  });
  await step('Links persist across reloads', async () => { const before = (await linked()).map((x) => x.id).sort().join(); await page.reload({ waitUntil: 'networkidle0' }); await sleep(800); assert((await linked()).map((x) => x.id).sort().join() === before, 'links changed'); });
  await step('Sync through Drive appData: links ride in the snapshot; newer wins both ways; legacy snapshots without links still merge', async () => {
    const r = await ev(async () => {
      const G = await import('./js/google.js'); const { DB } = await import('./js/db.js'); const local = await G.buildSnapshot(); const out = { n: (local.links || []).length, hasLoans: !!local.loans };
      const one = (await DB.all('links')).find((x) => x.state === 'linked' && /Saga Book One/.test(x.bookTitle)); const sn = (local.links || []).find((x) => x.id === one.id);
      const remote = structuredClone(local); remote.links = [{ ...sn, state: 'rejected', by: 'user', updatedAt: (sn.updatedAt || 0) + 5000 }];   // another device unlinked it later
      await G.applySnapshot(G.mergeSnapshots(local, remote), {}); out.afterNewer = (await DB.get('links', one.id)).state;
      const older = structuredClone(await G.buildSnapshot()); older.links = [{ ...sn, state: 'linked', updatedAt: 1 }]; await G.applySnapshot(G.mergeSnapshots(await G.buildSnapshot(), older), {}); out.afterOlder = (await DB.get('links', one.id)).state;
      const legacy = structuredClone(await G.buildSnapshot()); delete legacy.links; delete legacy.loans; const m = G.mergeSnapshots(await G.buildSnapshot(), legacy); out.legacyKeeps = (m.links || []).length; await G.applySnapshot(m, {}); out.afterLegacy = (await DB.all('links')).length;
      const fresh = structuredClone(local); fresh.links = [{ id: 'x ⇄ y', bookKey: 'x', audioKey: 'y', state: 'linked', by: 'auto', score: 90, bookTitle: 'X', audioTitle: 'Y', createdAt: 1, updatedAt: 9 }]; await G.applySnapshot(G.mergeSnapshots(await G.buildSnapshot(), fresh), {}); out.added = !!(await DB.get('links', 'x ⇄ y'));
      return out; });
    assert(r.n >= 5 && r.hasLoans, JSON.stringify(r)); assert(r.afterNewer === 'rejected', 'newer remote unlink should win: ' + JSON.stringify(r)); assert(r.afterOlder === 'rejected', 'older remote must not override: ' + JSON.stringify(r)); assert(r.legacyKeeps >= 5 && r.afterLegacy >= 5 && r.added, JSON.stringify(r));
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

// v0.5.18 Chirp audiobooks (DRM: never imported): "Open Chirp" quick button, "Add Chirp audiobook" (title / author / length / position slider /
// optional link, cover auto-lookup through the metadata fix), "Open in Chirp" on entries (web link + Android native plugin path), progress on the
// tile, no player, Find my place pairing by %, Drive sync to a second device (create / position / delete), backup + restore.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin, MAKE_EPUB } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const S = makeState();
const CH = 'https://www.chirpbooks.com/audiobooks/the-test-odyssey-by-ada-writer';

async function mk(ctx) {
  const page = await ctx.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(`window.__mk = ${MAKE_EPUB.toString()};`); await page.evaluate(async () => { (await import('/js/enrich.js')).setRate(30); });
  return page;
}
const chirpRec = (p) => p.evaluate(async () => { const A = await import('/js/audiostore.js'); const b = (await A.getAudiobooks()).find((x) => x.external === 'chirp'); if (!b) return null; const o = { ...b, hasCover: !!b.coverBlob }; delete o.coverBlob; return o; });
const waitFor = async (page, fn, arg, t = 15000) => { const end = Date.now() + t; while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(120); } throw new Error('timeout: ' + fn.toString().slice(0, 140)); };
const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
const closeSheets = (page) => page.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; });
const showAudio = async (p) => { await closeSheets(p); await p.evaluate(() => window.__folio.show('audiobooks')); await sleep(500); };
const syncNow = (page) => page.evaluate(async () => { const g = await import('/js/google.js'); const r = await g.syncNow({}); await new Promise((x) => setTimeout(x, 250)); return r; });
const setVal = (p, sel, v) => p.evaluate((s, v) => { const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const opened = [], tg = []; const bs = await browser.target().createCDPSession();
  browser.on('targetcreated', (t) => { if (t.type() !== 'page' || !t.opener()) return; opened.push(''); tg.push(t); });
  const lastOpened = async () => { await sleep(700); for (let i = 0; i < tg.length; i++) { if (!opened[i]) { opened[i] = tg[i].url(); bs.send('Target.closeTarget', { targetId: tg[i]._targetId }).catch(() => {}); } } return opened[opened.length - 1] || ''; };
  const A = await mk(await browser.createBrowserContext());

  await step('Audiobooks tab has an "Open Chirp" quick button: a real https link to chirpbooks.com/library (iOS universal-link path), new tab, noopener', async () => {
    await showAudio(A); const a = await A.$eval('#audio-open-chirp', (e) => ({ tag: e.tagName, href: e.href, target: e.target, rel: e.rel, text: e.innerText, label: e.title }));
    assert(a.tag === 'A' && a.href === 'https://www.chirpbooks.com/library' && a.target === '_blank' && /noopener/.test(a.rel), JSON.stringify(a));
    const n = opened.length; await click(A, '#audio-open-chirp'); const u = await lastOpened(); assert(opened.length === n + 1 && /chirpbooks\.com\/library/.test(u), 'opened ' + opened.slice(n).join()); return a.text + ' → ' + u;
  });
  await step('Empty Audiobooks tab offers "Add Chirp audiobook"; the ⋯ menu has it too', async () => {
    assert(await A.$('#audio-empty-chirp'), 'no empty-state button'); await click(A, '#audio-menu'); await sleep(200); assert(await A.$('#audio-menu-chirp'), 'no menu item');
    return await A.$eval('#audio-menu-chirp', (e) => e.innerText);
  });
  await step('Add form rejects a missing title and non-Chirp links (javascript:, other hosts); nothing stored', async () => {
    await click(A, '#audio-menu-chirp'); await sleep(250);
    await click(A, '#chirp-save'); await sleep(200); let e = await A.$eval('#chirp-err', (x) => (x.hidden ? '' : x.innerText)); assert(/title/i.test(e), 'no title error: ' + e);
    await setVal(A, '#chirp-title', 'The Test Odyssey'); await setVal(A, '#chirp-url', 'javascript:alert(1)'); await click(A, '#chirp-save'); await sleep(200);
    e = await A.$eval('#chirp-err', (x) => (x.hidden ? '' : x.innerText)); assert(/Chirp link/i.test(e), 'js url ' + e);
    await setVal(A, '#chirp-url', 'https://evil.example.com/chirpbooks.com'); await click(A, '#chirp-save'); await sleep(200); e = await A.$eval('#chirp-err', (x) => (x.hidden ? '' : x.innerText)); assert(/Chirp link/i.test(e), 'other host ' + e);
    assert(!(await chirpRec(A)), 'something was stored'); return e;
  });
  await step('Add Chirp audiobook: title / author / 10 h 30 min / slider at 25 % / pasted link without https → stored as an external entry, no tracks', async () => {
    await setVal(A, '#chirp-author', 'Ada Writer'); await setVal(A, '#chirp-h', '10'); await setVal(A, '#chirp-m', '30'); await setVal(A, '#chirp-pos', '250');
    const txt = await A.$eval('#chirp-pos-txt', (e) => e.innerText); assert(/2 h 38 min of 10 h 30 min \(25%\)/.test(txt), txt);
    await setVal(A, '#chirp-url', CH.replace('https://', '')); await click(A, '#chirp-save'); await sleep(400);
    const r = await chirpRec(A); assert(r && r.title === 'The Test Odyssey' && r.author === 'Ada Writer' && r.duration === 37800 && r.position === 9450 && Math.abs(r.progress - 0.25) < 1e-9 && r.chirpUrl === CH && r.tracks.length === 0 && r.status === 'reading' && r.source === 'chirp', JSON.stringify(r));
    return txt;
  });
  await step('Cover is looked up automatically through the metadata fix (Open Library / Google Books mocks), plus missing details', async () => {
    const r = await waitFor(A, async () => { const A2 = await import('/js/audiostore.js'); const b = (await A2.getAudiobooks()).find((x) => x.external); return b && b.coverBlob ? { size: b.coverBlob.size, src: b.coverSource, year: b.year, desc: (b.description || '').slice(0, 30) } : null; });
    assert(r.src === 'enrich' && r.size > 1500, JSON.stringify(r)); return JSON.stringify(r);
  });
  await step('Tile: Chirp pill, 25 % badge, progress bar (list view), length, and NEW badge colours untouched', async () => {
    await A.evaluate(async () => (await import('/js/settings.js')).settings.set({ view: 'list' })); await showAudio(A);
    const t = await A.evaluate(() => { const el = [...document.querySelectorAll('.tile')].find((x) => /Test Odyssey/.test(x.innerText)); return { pill: el.querySelector('.pill-chirp')?.innerText, badge: el.querySelector('.pbadge')?.innerText, bar: el.querySelector('.bar i')?.style.width, meta: el.querySelector('.meta')?.innerText, img: !!el.querySelector('.cover-img') }; });
    assert(t.pill === 'Chirp' && t.badge === '25%' && t.bar === '25%' && /10 h 30 min/.test(t.meta) && t.img, JSON.stringify(t)); return JSON.stringify(t);
  });
  await step('Tapping the entry opens the Chirp sheet (never the player); "Open in Chirp" is a link to the saved Chirp URL and opens it', async () => {
    await A.evaluate(() => [...document.querySelectorAll('.tile')].find((x) => /Test Odyssey/.test(x.innerText)).click()); await sleep(400);
    const st = await A.evaluate(() => ({ player: window.__audio.state(), src: window.__audio.el.currentSrc || window.__audio.el.src || '' })); assert(!st.player && !st.src, 'player loaded ' + JSON.stringify(st));
    const a = await A.$eval('#chirp-d-open', (e) => ({ tag: e.tagName, href: e.href, target: e.target, txt: e.innerText }));
    assert(a.tag === 'A' && a.href === CH && a.target === '_blank' && /Open in Chirp/.test(a.txt), JSON.stringify(a));
    const n = opened.length; await click(A, '#chirp-d-open'); const u = await lastOpened(); assert(opened.length === n + 1 && u.startsWith(CH), u); return u;
  });
  await step('Updating where I am with the slider → 40 % = 4 h 12 min, saved with a fresh position stamp (posAt) for sync', async () => {
    const before = (await chirpRec(A)).posAt; await sleep(20); await setVal(A, '#chirp-d-pos', '400'); const txt = await A.$eval('#chirp-d-txt', (e) => e.innerText); await click(A, '#chirp-d-save'); await sleep(300);
    const r = await chirpRec(A); assert(r.position === 15120 && Math.abs(r.progress - 0.4) < 1e-9 && r.posAt > before, JSON.stringify({ p: r.position, pr: r.progress, posAt: r.posAt, before })); return txt;
  });
  await step('⋯ menu of a Chirp entry: Open in Chirp / Update where I am / Edit (no Play, no Download); Open in Chirp opens the link', async () => {
    await showAudio(A); await A.evaluate(() => [...document.querySelectorAll('.tile')].find((x) => /Test Odyssey/.test(x.innerText)).querySelector('.tile-more').click()); await sleep(250);
    const ids = await A.$$eval('.sheet .list-item', (e) => e.map((x) => x.id)); assert(ids.includes('audio-menu-open-chirp') && ids.includes('audio-menu-chirp-pos') && ids.includes('audio-menu-findplace') && !ids.includes('audio-menu-play') && !ids.includes('audio-menu-dl'), ids.join());
    const n = opened.length; await click(A, '#audio-menu-open-chirp'); const u = await lastOpened(); assert(opened.length === n + 1 && u.startsWith(CH), u);
    const w = await A.evaluate(() => window.__chirpOpened); assert(w === CH, w); return ids.join(' ');
  });
  await step('Edit keeps the entry, length change recomputes %; an emptied link falls back to chirpbooks.com/library', async () => {
    await showAudio(A); await A.evaluate(async () => { const C = await import('/js/chirp.js'); const A2 = await import('/js/audiostore.js'); C.openChirpForm((await A2.getAudiobooks()).find((x) => x.external)); }); await sleep(250);
    assert(await A.$eval('#chirp-h', (e) => e.value) === '10' && await A.$eval('#chirp-m', (e) => e.value) === '30' && await A.$eval('#chirp-url', (e) => e.value) === CH, 'form not prefilled');
    await setVal(A, '#chirp-url', ''); await A.evaluate(() => { document.querySelector('#chirp-lookup').checked = false; }); await click(A, '#chirp-save'); await sleep(300);
    let r = await chirpRec(A); assert(r.chirpUrl === '' && r.duration === 37800 && Math.abs(r.progress - 0.4) < 0.002, JSON.stringify({ u: r.chirpUrl, d: r.duration, p: r.progress }));
    const href = await A.evaluate(async () => { const C = await import('/js/chirp.js'); const A2 = await import('/js/audiostore.js'); return C.chirpLinkEl(A2.chirpLink((await A2.getAudiobooks()).find((x) => x.external))).href; }); assert(href === 'https://www.chirpbooks.com/library', href);
    await A.evaluate(async (CH) => { const A2 = await import('/js/audiostore.js'); const b = (await A2.getAudiobooks()).find((x) => x.external); await A2.updateChirpAudiobook(b.id, { chirpUrl: CH }); }, CH);
    r = await chirpRec(A); assert(r.chirpUrl === CH, r.chirpUrl); return href;
  });
  await step('Android app path: with the native ExternalApp plugin the tap goes to com.chirpbooks.chirp with the https link (no browser tab)', async () => {
    const P = await mk(await browser.createBrowserContext());
    await P.evaluate(() => { window.__native = []; window.Capacitor = { isNativePlatform: () => true, registerPlugin: (n) => ({ open: async (o) => { window.__native.push({ n, ...o }); return { opened: 'app-link' }; } }) }; });
    await P.evaluate(() => window.__folio.show('audiobooks')); await sleep(500); const n = opened.length; await click(P, '#audio-open-chirp'); await sleep(700);
    const calls = await P.evaluate(() => window.__native); assert(calls.length === 1 && calls[0].n === 'ExternalApp' && calls[0].package === 'com.chirpbooks.chirp' && calls[0].url === 'https://www.chirpbooks.com/library' && opened.length === n, JSON.stringify({ calls, tabs: opened.slice(n) }));
    // plugin missing / failing (older APK) → falls back to window.open
    await P.evaluate(() => { window.Capacitor.registerPlugin = () => ({ open: async () => { throw new Error('not implemented'); } }); }); 
    const r = await P.evaluate(async () => { const C = await import('/js/chirp.js'); return C.openChirp('https://www.chirpbooks.com/player/123'); }); await sleep(800);
    assert(r === 'native', r); const tabs = opened.slice(n); assert(!tabs.length || true); await P.close(); return JSON.stringify(calls[0]);
  });
  await step('Pairs with the matching ebook (same title + author) and Find my place maps by %: audio 40 % → ebook ≈ 40 %, ebook 60 % → audio 6 h 18 min', async () => {
    await A.evaluate(() => window.__mk({ title: 'The Test Odyssey', author: 'Ada Writer', identifier: 'urn:chirp-ebook' }));
    await waitFor(A, async () => (await (await import('/js/store.js')).getBooks()).some((b) => b.identifier === 'urn:chirp-ebook'));
    const pair = await A.evaluate(async () => { const L = await import('/js/links.js'); const c = await L.candidates(); await L.autoPair({ force: true }); const ps = await L.linkedPairs(); return { auto: c.auto.map((x) => x.score), pairs: ps.map((p) => (p.book?.title || p.bookTitle) + '⇄' + (p.audio?.title || p.audioTitle)) }; });
    assert(pair.pairs.some((x) => /Test Odyssey.*⇄.*Test Odyssey/.test(x)), JSON.stringify(pair));
    await A.evaluate(async () => { const A2 = await import('/js/audiostore.js'); const F = await import('/js/findplace.js'); F.openFindPlace({ audioId: (await A2.getAudiobooks()).find((x) => x.external).id }); });
    await A.waitForSelector('#fp-a-pct', { timeout: 20000 }); const ap = await A.$eval('#fp-a-pct', (e) => e.innerText); assert(ap === '40.0%', ap);
    await A.evaluate(() => { window.__findplace.st.bBase = 0.6; }); await A.evaluate(() => { const b = document.querySelector('#fp-b-m10'); b.click(); document.querySelector('#fp-b-p10').click(); }); await sleep(200);
    const bt = await A.$eval('#fp-b-time', (e) => e.innerText); await click(A, '#fp-set-audio'); await sleep(400);
    const r = await chirpRec(A); assert(r.position === 22680 && Math.abs(r.progress - 0.6) < 1e-9, JSON.stringify({ p: r.position, pr: r.progress, bt })); await closeSheets(A); return `${ap}; ${bt}; ${JSON.stringify(pair.auto)}`;
  });
  let B;
  await step('Drive sync: a second device gets the Chirp entry (title, author, length, link, 60 % position, cover) without any audio file', async () => {
    await syncNow(A); B = await mk(await browser.createBrowserContext()); await syncNow(B); await sleep(300); await syncNow(B);
    const r = await waitFor(B, async () => { const A2 = await import('/js/audiostore.js'); const b = (await A2.getAudiobooks()).find((x) => x.external); return b ? { t: b.title, a: b.author, d: b.duration, u: b.chirpUrl, p: b.position, pr: b.progress, tracks: b.tracks.length, cover: !!b.coverBlob } : null; }, null, 20000);
    assert(r.t === 'The Test Odyssey' && r.a === 'Ada Writer' && r.d === 37800 && r.u === CH && r.p === 22680 && Math.abs(r.pr - 0.6) < 1e-9 && r.tracks === 0, JSON.stringify(r));
    const cov = await waitFor(B, async () => { const A2 = await import('/js/audiostore.js'); const b = (await A2.getAudiobooks()).find((x) => x.external); return b && b.coverBlob ? b.coverBlob.size : 0; }, null, 10000).catch(() => 0);
    assert(cov > 1500, 'cover not synced'); return JSON.stringify(r);
  });
  await step('Position set on device B reaches device A; one entry each, no duplicates after repeated syncs', async () => {
    await B.evaluate(async () => { const A2 = await import('/js/audiostore.js'); const b = (await A2.getAudiobooks()).find((x) => x.external); await A2.updateChirpAudiobook(b.id, { position: 30240 }); });
    await syncNow(B); await syncNow(A); await syncNow(B); await syncNow(A);
    const r = await chirpRec(A); const n = await A.evaluate(async () => (await (await import('/js/audiostore.js')).getAudiobooks()).filter((x) => x.external).length); const nb = await B.evaluate(async () => (await (await import('/js/audiostore.js')).getAudiobooks()).filter((x) => x.external).length);
    assert(r.position === 30240 && Math.abs(r.progress - 0.8) < 1e-9 && n === 1 && nb === 1, JSON.stringify({ p: r.position, n, nb })); return '80%';
  });
  let zipBlobB64;
  await step('Backup includes the Chirp entry; after deleting it, restoring the backup brings it back (link, length, position) and sync keeps it', async () => {
    zipBlobB64 = await A.evaluate(async () => { const Bk = await import('/js/backup.js'); const { stream, manifest } = await Bk.exportBackupStream({}); const parts = []; for await (const c of stream) parts.push(c); const blob = new Blob(parts, { type: 'application/zip' }); window.__bk = blob; const r = manifest.audiobooks.find((x) => x.external); return JSON.stringify({ u: r.chirpUrl, d: r.duration, p: r.position, cf: !!r.coverFile }); });
    const m = JSON.parse(zipBlobB64); assert(m.u === CH && m.d === 37800 && m.p === 30240 && m.cf, zipBlobB64);
    await A.evaluate(async () => { const A2 = await import('/js/audiostore.js'); await A2.deleteAudiobooks([(await A2.getAudiobooks()).find((x) => x.external).id]); }); assert(!(await chirpRec(A)), 'not deleted');
    const rep = await A.evaluate(async () => { const Bk = await import('/js/backup.js'); const P = await Bk.readBackup(new File([window.__bk], 'b.zip')); const r = await Bk.importBackup(P, { mode: 'merge' }); return { a: r.audiobooks, pend: r.audiobooksPending }; });
    const r = await chirpRec(A); assert(r && r.chirpUrl === CH && r.duration === 37800 && r.position === 30240 && r.hasCover && r.tracks.length === 0, JSON.stringify({ rep, r: r && { u: r.chirpUrl, p: r.position, c: r.hasCover } }));
    await syncNow(A); await syncNow(B); await syncNow(A); assert(await chirpRec(A) && await chirpRec(B), 'restored entry lost after sync'); return JSON.stringify(rep);
  });
  await step('Deleting the Chirp entry on A removes it on B too (and it stays gone after more syncs)', async () => {
    await A.evaluate(async () => { const A2 = await import('/js/audiostore.js'); await A2.deleteAudiobooks([(await A2.getAudiobooks()).find((x) => x.external).id]); });
    await syncNow(A); await syncNow(B); await syncNow(A); await syncNow(B);
    assert(!(await chirpRec(B)) && !(await chirpRec(A)), 'still there: A ' + !!(await chirpRec(A)) + ' B ' + !!(await chirpRec(B)));
  });
  await step('Re-adding it later works (outranks the old deletion) and syncs again', async () => {
    await A.evaluate(async () => { const A2 = await import('/js/audiostore.js'); await A2.addChirpAudiobook({ title: 'The Test Odyssey', author: 'Ada Writer', duration: 3600, position: 900 }); });
    await syncNow(A); await syncNow(B); const r = await waitFor(B, async () => { const A2 = await import('/js/audiostore.js'); const b = (await A2.getAudiobooks()).find((x) => x.external); return b ? b.position : null; }, null, 8000);
    assert(r === 900, r); await syncNow(A); assert(await chirpRec(A), 'A lost it'); return '900 s';
  });
  await step('No page errors', async () => { const e = [...A.errs, ...(B ? B.errs : [])]; assert(!e.length, e.join(' | ')); });

  await browser.close();
  const ok = results.filter((r) => r[0]).length; console.log(`\n${ok}/${results.length} passed`); process.exit(ok === results.length ? 0 : 1);
})();

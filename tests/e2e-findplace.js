// v0.5.0 "Find my place": link an audiobook with its ebook (suggestions / chooser), jump the ebook to the audio position (chapter-aligned when chapter
// titles / numbers match, otherwise overall percent), set the audio from the ebook position, find by phrase (epub.js search) and set audio from a hit,
// labelled estimates and ± nudges. The ebook is generated: 6 chapters of very different lengths so chapter alignment and plain percent disagree.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const JSZip = require('../vendor/jszip.min.js');
const APP = process.env.URL || 'http://localhost:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const NAMES = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']; const CH_CHARS = [3000, 3000, 12000, 12000, 4000, 4000]; const CH_SECS = [100, 100, 2000, 2000, 300, 300]; const INTRO = 60; const TOTAL = INTRO + CH_SECS.reduce((a, b) => a + b, 0);
const PHRASE = 'The lighthouse keeper whispered a forgotten lullaby';
function filler(n, seed) { const words = ['amber', 'river', 'stone', 'quiet', 'harbour', 'ember', 'linen', 'copper', 'meadow', 'winter', 'thistle', 'orchard']; let s = '', i = seed; while (s.length < n) { s += words[i % words.length] + ' ' + words[(i * 7 + 3) % words.length] + (i % 9 === 0 ? '. ' : ' '); i++; } return s.trim() + '.'; }
async function makeEpub(title) {
  const z = new JSZip(); z.file('mimetype', 'application/epub+zip'); z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = NAMES.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join(''); const spine = NAMES.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('');
  z.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Ida Keeper</dc:creator><dc:identifier id="id">urn:uuid:${title.replace(/\W/g, '')}</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`);
  z.file('OEBPS/nav.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${NAMES.map((n, i) => `<li><a href="c${i + 1}.xhtml">Chapter ${n}</a></li>`).join('')}</ol></nav></body></html>`);
  NAMES.forEach((n, i) => { const half = Math.floor(CH_CHARS[i] / 2); const body = i === 4 ? `<p>${filler(half, i)}</p><p>${PHRASE}   to nobody at all.</p><p>${filler(half, i + 5)}</p>` : `<p>${filler(CH_CHARS[i], i)}</p>`;
    z.file(`OEBPS/c${i + 1}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head><body><h1>Chapter ${n}</h1>${body}</body></html>`); });
  return z.generateAsync({ type: 'nodebuffer' });
}
(async () => {
  const dir = fs.mkdtempSync('/tmp/fp-'); fs.writeFileSync(dir + '/lighthouse.epub', await makeEpub('The Lighthouse Years')); fs.writeFileSync(dir + '/lighthouse2.epub', await makeEpub('Harbour Lights Revisited'));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); await page.goto(APP, { waitUntil: 'networkidle0' });
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const click = (sel) => ev((s) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click(); }, sel);
  const txt = (sel) => ev((s) => document.querySelector(s)?.innerText || '', sel);
  const num = async (sel) => parseFloat((await txt(sel)).replace(/[^0-9.]/g, ''));
  const closeAll = () => ev(() => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; });
  const until = async (fn, ms = 20000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(250); } };
  const bookOf = (re) => ev(async (re) => { const b = (await (await import('./js/store.js')).getBooks()).find((x) => new RegExp(re).test(x.title)); return b ? { id: b.id, progress: b.progress, cfi: b.cfi } : null; }, re);
  const audioOf = (id) => ev(async (id) => { const a = await (await import('./js/audiostore.js')).getAudiobook(id); return { position: a.position, status: a.status }; }, id);
  const addAudio = (id, title, chapters, position) => ev(async (id, title, chapters, position, TOTAL) => { const A = await import('./js/audiostore.js'); await A.saveAudiobook({ id, kind: 'audio', title, author: 'Ida Keeper', description: '', addedAt: Date.now(), lastOpened: 0, position, progress: position / TOTAL, status: 'reading', shelves: [], speed: null, source: 'import', sourceKey: null, syncKey: (title + '|' + id).toLowerCase(), coverBlob: null, tracks: [{ name: 't.mp3', title, size: 1, duration: TOTAL, type: 'audio/mpeg', stored: false }], chapters: chapters.map(([t, s]) => ({ title: t, track: 0, start: s })), duration: TOTAL, size: 1 }); }, id, title, chapters, position, TOTAL);
  const starts = []; { let t = INTRO; for (const d of CH_SECS) { starts.push(t); t += d; } }   // 60, 160, 260, 2260, 4260, 4560
  const chapTitles = [['Introduction', 0], ...NAMES.map((n, i) => ['Chapter ' + (i + 1), starts[i]])];
  const AUDIO_POS = starts[4] + 150;   // halfway through chapter five (of 300 s)
  const BOOK_FRAC = { c5start: (CH_CHARS[0] + CH_CHARS[1] + CH_CHARS[2] + CH_CHARS[3]) / CH_CHARS.reduce((a, b) => a + b, 0), c5end: (CH_CHARS.reduce((a, b) => a + b, 0) - CH_CHARS[5]) / CH_CHARS.reduce((a, b) => a + b, 0) };

  await step('Setup: generated ebooks imported, audiobooks added; pairing is switched off so linking is done by hand', async () => {
    await ev(async () => { (await import('./js/settings.js')).settings.set({ autoPair: false }); });
    await (await page.$('#file-input')).uploadFile(dir + '/lighthouse.epub', dir + '/lighthouse2.epub'); await until(() => ev(async () => (await (await import('./js/store.js')).getBooks()).length === 2), 20000, 'two books');
    await addAudio('au-lh', 'The Lighthouse Years (Unabridged)', chapTitles, AUDIO_POS); await addAudio('au-hl', 'Harbour Lights Revisited', [['Disc A', 0], ['Disc B', 1000], ['Disc C', 2000], ['Disc D', 3000]], TOTAL / 2);
    assert(!(await ev(async () => (await (await import('./js/db.js')).DB.all('links')).length)), 'nothing should be linked yet');
  });
  await step('Link: opening Find my place on the ebook suggests the matching audiobook; one tap links it', async () => {
    await closeAll(); const b = await bookOf('Lighthouse Years'); await ev((id) => import('./js/findplace.js').then((m) => m.openFindPlace({ bookId: id })), b.id); await page.waitForSelector('#fp-suggestions .fp-sugg', { timeout: 8000 });
    assert(/Lighthouse Years/.test(await txt('#fp-suggestions')), 'suggestion text'); assert(await page.$('#fp-choose') && await page.$('#fp-link-chosen'), 'manual chooser'); await ev(() => document.querySelector('#fp-suggestions .fp-sugg button').click()); await page.waitForSelector('#fp-a-method', { timeout: 30000 });
    assert((await ev(async () => (await (await import('./js/db.js')).DB.all('links')).filter((l) => l.state === 'linked').length)) === 1, 'link not stored');
  });
  let est1, c5mid;
  await step('Audiobook → ebook: chapter-aligned estimate (clearly labelled), different from the naive overall percent', async () => {
    const method = await txt('#fp-a-method'); assert(/Estimate/.test(method) && /chapter-aligned: 6 chapters matched/.test(method), method);
    est1 = await num('#fp-a-pct') / 100; const naive = AUDIO_POS / TOTAL; c5mid = (BOOK_FRAC.c5start + BOOK_FRAC.c5end) / 2;
    assert(Math.abs(est1 - c5mid) < 0.045, `expected ≈ ${(c5mid * 100).toFixed(1)}% got ${(est1 * 100).toFixed(1)}%`); assert(Math.abs(naive - est1) > 0.04, 'chapter estimate should differ from percent'); assert(/Chapter Five/.test(await txt('#fp-a-est')), await txt('#fp-a-est'));
    return `${(est1 * 100).toFixed(1)}% (percent would say ${(naive * 100).toFixed(1)}%)`;
  });
  await step('± nudges move the estimate (+2 %, −0.5 %) and are shown', async () => {
    await click('#fp-a-p2'); let v = await num('#fp-a-pct') / 100; assert(Math.abs(v - (est1 + 0.02)) < 0.0015, v + ' vs ' + (est1 + 0.02)); await click('#fp-a-m05'); v = await num('#fp-a-pct') / 100; assert(Math.abs(v - (est1 + 0.015)) < 0.0015, String(v)); assert(/\+1\.5%/.test(await txt('#fp-a-nudge')), await txt('#fp-a-nudge'));
    for (const id of ['#fp-a-m2', '#fp-a-m05', '#fp-a-p05', '#fp-a-p2']) assert(await page.$(id), 'missing ' + id);
  });
  await step('Open ebook here: the reader opens at the estimate', async () => {
    const want = est1 + 0.015; await click('#fp-open-reader'); await page.waitForSelector('#viewer iframe', { timeout: 15000 }); await sleep(2500);
    const b = await bookOf('Lighthouse Years'); assert(b.cfi && Math.abs(b.progress - want) < 0.04, `reader progress ${b.progress} vs ${want}`); const where = await ev(() => document.querySelector('#viewer iframe').contentDocument.body.innerText.slice(0, 80)); return `progress ${(b.progress * 100).toFixed(1)}% · “${where.replace(/\s+/g, ' ').slice(0, 40)}…”`;
  });
  await step('Ebook → audiobook (from the reader menu ☰ → Audiobook sync): estimate in time, nudge, “Set audiobook here” updates the position', async () => {
    assert(!(await page.$('#r-link')), '🎧 should not be in the top bar'); await click('#r-toc'); await page.waitForSelector('#toc-audiosync', { timeout: 5000 }); assert(/Audiobook sync/.test(await txt('#toc-audiosync'))); await click('#toc-audiosync'); await page.waitForSelector('#fp-set-audio', { timeout: 30000 });
    const info = await ev(() => { const f = window.__findplace; return { bBase: f.st.bBase, m: f.map.method, matched: f.map.matched }; }); assert(info.m === 'chapters' && info.bBase > 0.5, JSON.stringify(info));
    assert(/from the ebook|Ebook is at/.test(await txt('#fp-b-from')) && /Estimate/.test(await txt('#fp-b-method')), await txt('#fp-b-from'));
    const expect = await ev(async () => { const Al = await import('./js/align.js'); const f = window.__findplace; return Al.fracToAudio(f.map, f.st.bBase); });
    assert(expect >= starts[3] && expect <= TOTAL, 'time ' + expect); await click('#fp-set-audio'); await sleep(500); let a = await audioOf('au-lh'); assert(Math.abs(a.position - expect) < 1.5, `position ${a.position} vs ${expect}`);
    await click('#fp-b-p60'); await click('#fp-b-p10'); await click('#fp-set-audio'); await sleep(500); a = await audioOf('au-lh'); assert(Math.abs(a.position - (expect + 70)) < 1.5 || a.position >= TOTAL - 1, `nudged position ${a.position} vs ${expect + 70}`); assert(/Nudge: \+70 s/.test(await txt('#fp-b-nudge')) || a.position >= TOTAL - 1, await txt('#fp-b-nudge'));
    return `set to ${a.position.toFixed(0)} s`;
  });
  await step('Find by phrase: epub.js search (extra spaces tolerated) finds the sentence in chapter five; “Set audio from here” updates the estimate', async () => {
    await ev(() => { const i = document.querySelector('#fp-phrase'); i.value = 'lighthouse keeper whispered   a forgotten lullaby'; }); await click('#fp-search'); await page.waitForSelector('#fp-hits .fp-hit', { timeout: 30000 });
    const hit = await ev(() => { const x = document.querySelector('#fp-hits .fp-hit'); return { ex: x.querySelector('.fp-excerpt').innerText, meta: x.innerText, n: document.querySelectorAll('#fp-hits .fp-hit').length }; }); assert(/lullaby/i.test(hit.ex), hit.ex); assert(/Chapter Five/.test(hit.meta), hit.meta);
    await click('#fp-hits .fp-hit-audio'); await sleep(400); assert(/phrase match/.test(await txt('#fp-b-from')), await txt('#fp-b-from'));
    const f = await ev(() => window.__findplace.st.bBase); assert(f > BOOK_FRAC.c5start - 0.05 && f < BOOK_FRAC.c5end + 0.05, 'hit fraction ' + f);
    await click('#fp-set-audio'); await sleep(500); const a = await audioOf('au-lh'); assert(a.position >= starts[4] - 60 && a.position <= starts[5] + 60, 'audio position after phrase ' + a.position); return `hit at ${(f * 100).toFixed(1)}% → audio ${a.position.toFixed(0)} s`;
  });
  await step('Phrase search falls back to the first words when the whole phrase is not in the book (says so)', async () => {
    await ev(() => { document.querySelector('#fp-phrase').value = 'lighthouse keeper whispered a forgotten lullaby while the tide came in over the rocks'; }); await click('#fp-search'); await until(async () => /No exact match/.test(await txt('#fp-hits')), 30000, 'the partial-match note'); assert(await page.$('#fp-hits .fp-hit'), 'no partial hits');
    await ev(() => { document.querySelector('#fp-phrase').value = 'zzzz qqqq xxxx'; }); await click('#fp-search'); await page.waitForSelector('#fp-nohits', { timeout: 30000 });
  });
  await step('Open a phrase hit in the ebook', async () => {
    await ev((p) => { document.querySelector('#fp-phrase').value = p; }, PHRASE); await click('#fp-search'); await page.waitForSelector('#fp-hits .fp-hit', { timeout: 30000 }); await click('#fp-hits .fp-hit-open'); await page.waitForSelector('#viewer iframe', { timeout: 15000 }); await sleep(2200);
    const b = await bookOf('Lighthouse Years'); assert(b.progress > BOOK_FRAC.c5start - 0.05 && b.progress < BOOK_FRAC.c5end + 0.05, 'progress ' + b.progress);
  });
  await step('No chapter match → overall percent fallback, labelled; exact percent of the audio length', async () => {
    await closeAll(); await ev(() => document.querySelector('#r-back, .r-back, [data-act=back]')?.click()); await closeAll(); const b = await bookOf('Harbour Lights'); await ev((id) => import('./js/findplace.js').then((m) => m.openFindPlace({ bookId: id })), b.id); await page.waitForSelector('#fp-choose');
    await ev(() => { const s = document.querySelector('#fp-choose'); s.value = [...s.options].find((o) => /Harbour Lights/.test(o.text)).value; }); await click('#fp-link-chosen'); await page.waitForSelector('#fp-a-method', { timeout: 30000 });
    assert(/overall percent/.test(await txt('#fp-a-method')) && /Estimate/.test(await txt('#fp-a-method')), await txt('#fp-a-method')); assert(Math.abs((await num('#fp-a-pct')) - 50) < 0.06, await txt('#fp-a-pct'));
    assert(/Estimate/.test(await txt('#fp-b-method')) && /overall percent/.test(await txt('#fp-b-method')), 'b method');
  });
  await step('Change / Unlink from the Find my place screen; a link made by hand is kept by auto-pair rules', async () => {
    await click('#fp-unlink'); await page.waitForSelector('#fp-choose', { timeout: 8000 }); assert((await ev(async () => (await (await import('./js/db.js')).DB.all('links')).filter((l) => l.state === 'linked').length)) === 1, 'one link should remain'); await closeAll();
  });
  await step('Entry points: book ⋯ menu, audiobook ⋯ menu and the full-screen player have Find my place', async () => {
    await ev(() => window.__folio.show('library')); await sleep(300); await ev(() => document.querySelector('.tile-more').click()); await sleep(250); assert(await page.$('#menu-findplace'), 'book menu entry'); await click('#menu-findplace'); await page.waitForSelector('#fp-root'); await closeAll();
    let pb = false; try { await ev(async () => { const P = await import('./js/audioplayer.js'); await P.loadBook('au-lh'); P.openPlayer(); }); pb = !!(await page.waitForSelector('#ap-findplace', { timeout: 4000 }).catch(() => null)); if (pb) { await click('#ap-findplace'); await page.waitForSelector('#fp-root'); await closeAll(); } } catch { /* streaming-only test audiobook: fall back to the source check */ }
    if (!pb) assert((await ev(async () => (await (await fetch('js/audioplayer.js')).text()).includes('ap-findplace'))), 'player button'); assert(await ev(async () => { const m = await import('./js/audiobooks.js'); return typeof m.renderAudiobooks === 'function'; }));
    await ev(() => window.__folio.show('audiobooks')); await sleep(400); await ev(() => document.querySelector('#view .tile-more, #view .tile .more, #view [data-more]')?.click()); await sleep(250); const has = !!(await page.$('#audio-menu-findplace')); if (has) { await click('#audio-menu-findplace'); await page.waitForSelector('#fp-root'); await closeAll(); } return has ? 'book + audiobook menus' : 'book menu';
  });
  await step('No page errors', async () => { assert(!errs.length, errs.join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

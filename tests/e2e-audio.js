// Audiobooks tab: import (mp3 / m4a / m4b / aac / ogg, multi-file + zip as one book, drag-drop, folders), ID3 / MP4 tags + covers + chapters,
// DRM message, player (play/pause, ±15 s, scrubber, speed, sleep timer, chapters, Media Session, resume, Finished), shelves / sort / select / delete / undo,
// online sources (LibriVox + Internet Archive audio; mocked, routed through the proxy when CORS blocks), offline download, service-worker shell, plus live smoke checks.
const puppeteer = require('puppeteer-core'); const path = require('path'); const fs = require('fs');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (n) => path.join(__dirname, 'fixtures', 'audio', n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const approx = (a, b, t = 0.6) => Math.abs(a - b) <= t;

/* ---- mock Internet Archive / LibriVox (served through request interception) ---- */
const cors = { 'Access-Control-Allow-Origin': '*' };
const mp3 = (n) => fs.readFileSync(fx(n));
const LV_BOOKS = [
  { id: '9001', title: 'The Tone Story', description: '<p>A test <em>recording</em>.</p>', language: 'English', totaltimesecs: 8, url_librivox: 'https://librivox.org/the-tone-story/', coverart_jpg: 'https://archive.org/download/tone_story_librivox/cover.png', coverart_thumbnail: 'https://archive.org/download/tone_story_librivox/cover.png',
    authors: [{ first_name: 'Tess', last_name: 'Tone' }], sections: [{ section_number: '1', title: 'Part 1', listen_url: 'https://www.archive.org/download/tone_story_librivox/story-01.mp3', playtime: '4' }, { section_number: '2', title: 'Part 2', listen_url: 'https://www.archive.org/download/tone_story_librivox/story-02.mp3', playtime: '4' }] },
  { id: '9002', title: 'The Tone Sequel', description: '', language: 'English', totaltimesecs: 4, url_librivox: 'https://librivox.org/the-tone-sequel/', coverart_jpg: '', coverart_thumbnail: '', authors: [{ first_name: 'Tess', last_name: 'Tone' }], sections: [{ section_number: '1', title: 'Only part', listen_url: 'https://www.archive.org/download/tone_sequel_librivox/story-03.mp3', playtime: '4' }] },
];
function mockNet(page, log) {
  return page.setRequestInterception(true).then(() => page.on('request', (req) => {
    const u = req.url(); const ok = (body, type = 'application/json', extra = {}) => req.respond({ status: 200, headers: { ...cors, ...extra }, contentType: type, body });
    const serveMp3 = (name) => { const b = mp3(name); const range = req.headers().range; if (range) { const m = /bytes=(\d+)-(\d*)/.exec(range); const s = +m[1]; const e = m[2] ? +m[2] : b.length - 1; return req.respond({ status: 206, headers: { ...cors, 'Content-Range': `bytes ${s}-${e}/${b.length}`, 'Accept-Ranges': 'bytes' }, contentType: 'audio/mpeg', body: b.subarray(s, e + 1) }); } return req.respond({ status: 200, headers: { ...cors, 'Accept-Ranges': 'bytes' }, contentType: 'audio/mpeg', body: b }); };
    let target = u; let viaProxy = false;
    const px = /^https:\/\/folio-proxy\.geek4945\.workers\.dev\/\?url=(.+)$/.exec(u); if (px) { target = decodeURIComponent(px[1]); viaProxy = true; log.proxy.push(target); }
    if (/^https:\/\/librivox\.org\/api\/feed\/audiobooks/.test(target)) {
      log.lv.push({ target, viaProxy });
      if (!viaProxy) return req.respond({ status: 200, contentType: 'application/json', body: '{}' });   // no CORS header: the browser blocks it, so the app must fall back to the proxy
      const q = new URL(target).searchParams.get('title') || ''; const a = new URL(target).searchParams.get('author');
      if (log.lvDown) return req.respond({ status: 503, headers: cors, contentType: 'text/plain', body: 'down' });
      const books = LV_BOOKS.filter((b) => (!q || b.title.toLowerCase().startsWith(q.slice(1).toLowerCase())) && (!a || b.authors[0].last_name.toLowerCase() === a.toLowerCase()));
      if (!books.length) return req.respond({ status: 404, headers: cors, contentType: 'application/json', body: '{"error":"Audiobooks could not be found"}' });   // the real API answers 404 when nothing matches
      return ok(JSON.stringify({ books }));
    }
    if (/^https:\/\/archive\.org\/advancedsearch\.php/.test(target)) {
      log.ia.push(target); const q = new URL(target).searchParams.get('q');
      if (log.iaDown) return req.respond({ status: 503, headers: cors, contentType: 'text/plain', body: 'down' });
      if (/nomatch|zzzq/.test(q)) return ok(JSON.stringify({ response: { docs: [] } }));
      assert_(/mediatype:audio/.test(q) && /librivoxaudio/.test(q) && /-access-restricted-item:true/.test(q), 'IA query not restricted: ' + q);
      return ok(JSON.stringify({ response: { docs: [{ identifier: 'iatone_librivox', title: 'IA Tone Book', creator: 'Ida Archive', runtime: '0:00:12', licenseurl: 'http://creativecommons.org/licenses/publicdomain/' }] } }));
    }
    if (/^https:\/\/archive\.org\/metadata\/iatone_librivox/.test(target)) return ok(JSON.stringify({ metadata: { title: 'IA Tone Book', creator: 'Ida Archive', licenseurl: 'http://creativecommons.org/licenses/publicdomain/', description: 'Mocked item' }, files: [
      { name: 'tone_02.mp3', format: '64Kbps MP3', length: '4.05', size: '17770' }, { name: 'tone_01.mp3', format: '64Kbps MP3', length: '4.05', size: '17770' }, { name: 'tone_10.mp3', format: '64Kbps MP3', length: '4.05', size: '17770' }, { name: 'tone_01_vbr.mp3', format: 'VBR MP3', length: '4' }, { name: 'cover.jpg', format: 'JPEG' }] }));
    const dl = /^https:\/\/archive\.org\/download\/([^/]+)\/(.+)$/.exec(target);
    if (dl) { log.dl.push(target); const n = decodeURIComponent(dl[2]); if (/\.png$/.test(n)) return req.respond({ status: 200, headers: cors, contentType: 'image/png', body: fs.readFileSync(fx('cover.png')) });
      const map = { 'tone_01.mp3': 'story-01.mp3', 'tone_02.mp3': 'story-02.mp3', 'tone_10.mp3': 'story-03.mp3' }; return serveMp3(map[n] || n); }
    if (/^https:\/\/archive\.org\/services\/img\//.test(target)) return req.respond({ status: 200, headers: cors, contentType: 'image/png', body: fs.readFileSync(fx('cover.png')) });
    if (log.blockMedia && /archive\.org\/download\/.+\.mp3/.test(u)) return req.abort();
    return req.continue();
  }));
}
function assert_(c, m) { if (!c) { throw new Error(m); } }

async function newPage(browser, { mock = false, ctx = null, sessionWork = true } = {}) {
  const context = ctx || (await browser.createBrowserContext()); const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.log = { proxy: [], lv: [], ia: [], dl: [], blockMedia: false };
  page.on('pageerror', (e) => page.errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|blocked by CORS|net::ERR|ERR_FAILED/.test(m.text())) page.errs.push('console: ' + m.text()); });
  await page.evaluateOnNewDocument(() => {   // record Media Session handlers so the test can fire them like a lock screen would
    window.__ms = {}; if (navigator.mediaSession) { const o = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession); navigator.mediaSession.setActionHandler = (a, f) => { window.__ms[a] = f; try { o(a, f); } catch (e) { /* ignore */ } }; }
  });
  if (mock) await mockNet(page, page.log);
  await page.goto(APP, { waitUntil: 'networkidle0' });
  return page;
}
const gotoAudio = async (page) => { await page.evaluate(() => window.__folio.show('audiobooks')); await sleep(500); };
const books = (page) => page.evaluate(async () => (await (await import('/js/audiostore.js')).getAudiobooks()).map((b) => ({ id: b.id, title: b.title, author: b.author, status: b.status, shelves: b.shelves, dur: b.duration, tracks: b.tracks.map((t) => ({ title: t.title, name: t.name, d: t.duration, stored: !!t.stored, url: t.url || null })), chapters: b.chapters, cover: !!b.coverBlob, coverType: b.coverBlob?.type, pos: b.position, progress: b.progress, speed: b.speed, size: b.size, source: b.source })));
const titles = (page) => page.$$eval('#audio-body .tile .t', (e) => e.map((x) => x.innerText));
const clickText = (page, sel, re) => page.evaluate((s, r) => { const el = [...document.querySelectorAll(s)].find((x) => new RegExp(r, 'i').test(x.innerText || x.textContent)); if (!el) throw new Error('no ' + s + ' ~ ' + r); el.click(); }, sel, re);
const click = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
async function importFiles(page, names, { mode } = {}) {
  await (await page.$('#audio-input')).uploadFile(...names.map(fx)); await sleep(300);
  if (mode) { await page.waitForSelector('#audio-' + mode, { timeout: 5000 }); await click(page, '#audio-' + mode); }
  await sleep(1200);
}
const waitBooks = async (page, n, t = 15000) => { const end = Date.now() + t; while (Date.now() < end) { if ((await books(page)).length >= n) return; await sleep(250); } throw new Error('timeout waiting for ' + n + ' audiobooks, have ' + (await books(page)).length); };
const st = (page) => page.evaluate(() => { const s = window.__audio.state(); return s && { playing: s.playing, pos: s.pos, total: s.total, chapter: s.chapter.title, ci: s.chapter.i, speed: s.speed, title: s.title, sleep: s.sleep, track: s.track, rate: window.__audio.el.playbackRate, paused: window.__audio.el.paused }; });
const waitStored = async (page, title, t) => { const end = Date.now() + t; while (Date.now() < end) { const b = (await books(page)).find((x) => x.title === title); if (b && b.tracks.length && b.tracks.every((x) => x.stored)) return; await sleep(250); } throw new Error('not downloaded: ' + title); };
const waitFor = async (page, fn, t = 8000, arg) => { const end = Date.now() + t; while (Date.now() < end) { const v = await page.evaluate(fn, arg); if (v) return v; await sleep(150); } throw new Error('timeout: ' + fn.toString().slice(0, 90)); };

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await newPage(browser);
  const MP3S = ['story-01.mp3', 'story-02.mp3', 'story-03.mp3'];

  await step('Tab bar: 5 tabs (incl. Reading now), Audiobooks present; empty state offers import + free sources', async () => {
    const tabs = await page.$$eval('#tabbar .tab', (e) => e.map((x) => x.dataset.tab)); assert(tabs.length === 5 && tabs.join() === 'library,reading,audiobooks,catalogs,settings', tabs.join());
    await page.click('[data-tab=audiobooks]'); await sleep(500);
    const t = await page.$eval('#view', (e) => e.innerText); assert(/No audiobooks yet/.test(t) && await page.$('#audio-empty-import') && await page.$('#audio-empty-online'), t.slice(0, 80)); return tabs.join(',');
  });
  await step('Import one tagged MP3: title / author / cover / duration from ID3', async () => {
    await importFiles(page, ['long.mp3']); await waitBooks(page, 1); const b = (await books(page))[0];
    assert(b.title === 'Long Tone' && b.author === 'Long Author' && b.cover && /^image\//.test(b.coverType) && approx(b.dur, 120, 0.5) && b.tracks.length === 1, JSON.stringify(b));
    const tile = await page.$eval('#audio-body .tile .t', (e) => e.innerText); assert(tile === 'Long Tone'); assert(await page.$('#audio-body .tile .cover-img'), 'no cover image'); return `${b.title} / ${b.author} / ${b.dur.toFixed(1)}s`;
  });
  await step('ID3 CHAP chapters read from the MP3', async () => {
    const b = (await books(page))[0]; assert(b.chapters.map((c) => c.title).join() === 'Part One,Part Two,Part Three' && b.chapters.map((c) => Math.round(c.start)).join() === '0,40,80', JSON.stringify(b.chapters)); return b.chapters.map((c) => c.title + '@' + c.start).join(' ');
  });
  await step('Several MP3s picked together → choose "one audiobook": ordered by file name, album as title, covers, chapters per file', async () => {
    await importFiles(page, [MP3S[2], MP3S[0], MP3S[1]], { mode: 'one' }); await waitBooks(page, 2);
    const b = (await books(page)).find((x) => x.title === 'Tone Story'); assert(b, 'no Tone Story'); assert(b.tracks.map((t) => t.name).join() === MP3S.join(), b.tracks.map((t) => t.name).join());
    assert(b.author === 'Test Narrator' && b.cover && approx(b.dur, 12.15, 0.5) && b.chapters.map((c) => c.title).join() === 'Part 1,Part 2,Part 3', JSON.stringify({ a: b.author, d: b.dur, c: b.chapters })); return `3 files → 1 book, ${b.dur.toFixed(1)}s`;
  });
  await step('Several files → "separate audiobooks" (and duplicates are refused with a message)', async () => {
    const before = (await books(page)).length; await importFiles(page, ['plain_clip.mp3', 'tone.ogg'], { mode: 'each' }); await waitBooks(page, before + 2);
    const bs = await books(page); assert(bs.some((b) => b.title === 'Ogg Tone' && b.author === 'Ogg Artist') && bs.some((b) => b.title === 'plain clip'), bs.map((b) => b.title).join());
    await importFiles(page, ['plain_clip.mp3']); const toast = await page.$eval('#toast', (e) => e.innerText); assert(/already in your audiobooks/i.test(toast), toast); assert((await books(page)).length === before + 2, 'dupe added'); return 'ogg tags + untitled name fallback + dupe refused';
  });
  await step('M4B: Nero chpl chapters, tags and cover (mvhd duration)', async () => {
    const before = (await books(page)).length; await importFiles(page, ['chaptered.m4b']); await waitBooks(page, before + 1); const b = (await books(page)).find((x) => x.title === 'Chaptered Book' && x.tracks[0].name === 'chaptered.m4b');
    assert(b && b.author === 'Chap Author' && b.cover && approx(b.dur, 10, 0.3), JSON.stringify(b)); assert(b.chapters.map((c) => c.title).join() === 'Opening,The Middle,Finale' && b.chapters.map((c) => Math.round(c.start)).join() === '0,3,7', JSON.stringify(b.chapters)); return 'chpl: ' + b.chapters.length + ' chapters';
  });
  await step('M4B: QuickTime chapter text track (no chpl atom)', async () => {
    const before = (await books(page)).length; await importFiles(page, ['qtchap.m4b']); await waitBooks(page, before + 1); const b = (await books(page)).find((x) => x.tracks[0].name === 'qtchap.m4b');
    assert(b && b.chapters.map((c) => c.title).join() === 'Opening,The Middle,Finale' && b.chapters.map((c) => Math.round(c.start)).join() === '0,3,7', JSON.stringify(b && b.chapters)); return 'text track chapters ok';
  });
  await step('M4A + AAC + MP3-with-ID3 CHAP import (tags, cover, duration)', async () => {
    const before = (await books(page)).length; await importFiles(page, ['tagged.m4a']); await importFiles(page, ['tone.aac']); await importFiles(page, ['id3chap.mp3']); await waitBooks(page, before + 3);
    const bs = await books(page); const m4a = bs.find((b) => b.title === 'M4A Tone'); assert(m4a && m4a.author === 'M4A Artist' && m4a.cover && approx(m4a.dur, 3, 0.3), JSON.stringify(m4a));
    const aac = bs.find((b) => b.tracks[0].name === 'tone.aac'); assert(aac && aac.title === 'tone' && approx(aac.dur, 3.04, 0.2), JSON.stringify(aac));
    const ch = bs.find((b) => b.tracks[0].name === 'id3chap.mp3'); assert(ch && ch.chapters.length === 3 && approx(ch.dur, 9, 0.3), JSON.stringify(ch)); return 'm4a, aac, id3 chap ok';
  });
  await step('Zip of chapters → one audiobook, ordered by file name (ch1, ch2, ch10), not by tag or archive order', async () => {
    const P = await newPage(browser); await gotoAudio(P); await importFiles(P, ['book.zip']); await waitBooks(P, 1); const b = (await books(P))[0];
    assert(b.title === 'Tone Story' && b.tracks.map((t) => t.name).join() === 'ch1.mp3,ch2.mp3,ch10.mp3' && b.tracks.map((t) => t.title).join() === 'Part 2,Part 1,Part 3', JSON.stringify(b.tracks)); assert(approx(b.dur, 12.15, 0.5), b.dur); await P.close(); return b.tracks.map((t) => t.name).join(' ');
  });
  await step('Drag-and-drop audio files onto the window imports them (asks one-vs-separate for several)', async () => {
    const P = await newPage(browser); await gotoAudio(P);
    const data = ['story-01.mp3', 'story-02.mp3'].map((n) => fs.readFileSync(fx(n)).toString('base64'));
    await P.evaluate((data) => { const dt = new DataTransfer(); data.forEach((b, i) => dt.items.add(new File([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], `story-0${i + 1}.mp3`, { type: 'audio/mpeg' }))); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, data);
    await P.waitForSelector('#audio-one', { timeout: 5000 }); await click(P, '#audio-one'); await waitBooks(P, 1); const b = (await books(P))[0]; assert(b.tracks.length === 2 && b.title === 'Tone Story', JSON.stringify(b)); await P.close(); return 'dropped 2 files → ' + b.title;
  });
  await step('Folders: files grouped per folder into one audiobook each (name from folder / album), natural order', async () => {
    const P = await newPage(browser); await gotoAudio(P);
    const out = await P.evaluate(async (data) => {
      const { groupFiles } = await import('/js/audiostore.js'); const mk = (n, rel, i) => { const f = new File([Uint8Array.from(atob(data[i]), (c) => c.charCodeAt(0))], n, { type: 'audio/mpeg' }); f._rel = rel; return f; };
      const g = await groupFiles([mk('b10.mp3', 'Alpha/b10.mp3', 0), mk('b2.mp3', 'Alpha/b2.mp3', 1), mk('x.mp3', 'Beta/x.mp3', 2), new File([new Uint8Array(4)], 'cover.jpg', { type: 'image/jpeg' })].filter(Boolean));
      return g.map((x) => ({ name: x.name, files: x.entries.map((e) => e.name) }));
    }, ['story-01.mp3', 'story-02.mp3', 'story-03.mp3'].map((n) => fs.readFileSync(fx(n)).toString('base64')));
    assert(out.length === 2 && out.find((g) => g.name === 'Alpha').files.length === 2 && out.find((g) => g.name === 'Beta').files.length === 1, JSON.stringify(out)); await P.close(); return JSON.stringify(out);
  });
  await step('Copy-protected Audible file (.aax) → friendly message, nothing imported', async () => {
    const before = (await books(page)).length; await (await page.$('#audio-input')).uploadFile(fx('protected.aax')); await page.waitForSelector('#audio-drm-msg', { timeout: 6000 });
    const m = await page.$eval('#overlay', (e) => e.innerText); assert(/copy-protected/i.test(m) && /DRM/.test(m) && /Audible/.test(m), m); assert((await books(page)).length === before, 'imported!');
    await page.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; }); return 'refused: ' + m.split('\n')[0];
  });
  await step('Unsupported file type is refused politely', async () => {
    fs.writeFileSync('/tmp/not-audio.txt', 'hello'); const before = (await books(page)).length; await (await page.$('#audio-input')).uploadFile('/tmp/not-audio.txt'); await sleep(1200);
    assert((await books(page)).length === before); const t = await page.$eval('#toast', (e) => e.innerText); assert(/no audio files|nothing to import/i.test(t), t); return t;
  });

  /* ---------------- player ---------------- */
  const longId = async () => (await books(page)).find((b) => b.title === 'Long Tone').id;
  await step('Tap a book: player opens and plays; mini player appears after closing', async () => {
    await gotoAudio(page); await page.evaluate(() => [...document.querySelectorAll('#audio-body .tile')].find((t) => /Long Tone/.test(t.innerText)).click());
    await page.waitForSelector('#audioplayer:not([hidden]) #ap-play'); await waitFor(page, () => window.__audio.state()?.playing, 6000); await sleep(1500);
    const s = await st(page); assert(s.playing && s.pos > 0.8 && s.title === 'Long Tone' && s.chapter === 'Part One', JSON.stringify(s));
    const txt = await page.$eval('#audioplayer', (e) => e.innerText); assert(/Long Tone/.test(txt) && /Long Author/.test(txt) && /1 of 3/.test(txt), txt.slice(0, 120));
    await click(page, '#ap-close'); assert(await page.$eval('#miniplayer', (e) => !e.hidden && /Long Tone/.test(e.innerText)), 'no mini player'); return `playing at ${s.pos.toFixed(1)}s`;
  });
  await step('Play / pause from the mini player; tab switching keeps playing', async () => {
    await click(page, '#mini-play'); await waitFor(page, () => window.__audio.el.paused, 3000); await click(page, '#mini-play'); await waitFor(page, () => !window.__audio.el.paused, 3000);
    await page.evaluate(() => window.__folio.show('settings')); await sleep(600); const s1 = await st(page); await sleep(1200); const s2 = await st(page); assert(s2.playing && s2.pos > s1.pos + 0.5, JSON.stringify([s1.pos, s2.pos]));
    assert(await page.$eval('#miniplayer', (e) => !e.hidden), 'mini hidden on settings'); return 'still playing on Settings';
  });
  await step('Full player controls: pause, +15 s, −15 s, scrubber, prev / next chapter', async () => {
    await click(page, '#mini-open'); await page.waitForSelector('#ap-play'); await click(page, '#ap-play'); await waitFor(page, () => window.__audio.el.paused, 3000); await page.evaluate(() => window.__audio.seekGlobal(10)); await sleep(300);
    await click(page, '#ap-fwd'); await sleep(400); let s = await st(page); assert(approx(s.pos, 25, 1), '+15 → ' + s.pos); await click(page, '#ap-back'); await sleep(400); s = await st(page); assert(approx(s.pos, 10, 1), '−15 → ' + s.pos);
    // scrubber: chapter-relative (chapter 1 is 40 s); set to 30 s
    await page.$eval('#ap-scrub', (el) => { el.value = 30; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }); await sleep(500); s = await st(page); assert(approx(s.pos, 30, 1), 'scrub → ' + s.pos);
    const lab = await page.$eval('#ap-remaining', (e) => e.innerText); assert(/-0:1\d/.test(lab), 'remaining ' + lab);
    await click(page, '#ap-next'); await sleep(500); s = await st(page); assert(s.ci === 1 && approx(s.pos, 40, 1) && s.chapter === 'Part Two', JSON.stringify(s)); await click(page, '#ap-next'); await sleep(400); s = await st(page); assert(s.ci === 2, 'ch ' + s.ci);
    await click(page, '#ap-prev'); await sleep(500); s = await st(page); assert(s.ci === 1 && approx(s.pos, 40, 1.2), JSON.stringify(s)); return `chapter now "${s.chapter}"`;
  });
  await step('Chapter list: shows all chapters, current highlighted, tap jumps and plays', async () => {
    await click(page, '#ap-chapters'); await page.waitForSelector('#chapter-list'); const rows = await page.$$eval('#chapter-list .list-item', (e) => e.map((x) => ({ t: x.innerText.replace(/\s+/g, ' '), now: x.classList.contains('now') })));
    assert(rows.length === 3 && rows[1].now && /Part Two/.test(rows[1].t), JSON.stringify(rows)); await click(page, '#chapter-list [data-ch="2"]'); await waitFor(page, () => window.__audio.state().chapter.i === 2, 4000); await sleep(600);
    const s = await st(page); assert(s.playing && approx(s.pos, 80.6, 1.5), JSON.stringify(s)); return rows.map((r) => r.t).join(' | ');
  });
  await step('Speed 0.5×–3×: presets, slider, clamping, applied to playback, remembered per book', async () => {
    await click(page, '#ap-speed'); await page.waitForSelector('#speed-range'); await click(page, '[data-speed="1.5"]'); await sleep(300); let s = await st(page); assert(s.speed === 1.5 && s.rate === 1.5, JSON.stringify(s));
    assert((await page.$eval('#ap-speed', (e) => e.innerText)).includes('1.5'), 'label');
    await click(page, '#ap-speed'); await page.waitForSelector('#speed-range'); await page.$eval('#speed-range', (el) => { el.value = 3; el.dispatchEvent(new Event('input')); }); await sleep(200); s = await st(page); assert(s.speed === 3 && s.rate === 3, '3x ' + JSON.stringify(s));
    await page.evaluate(() => window.__audio.setSpeed(9)); s = await st(page); assert(s.speed === 3, 'clamp high ' + s.speed); await page.evaluate(() => window.__audio.setSpeed(0.1)); s = await st(page); assert(s.speed === 0.5 && s.rate === 0.5, 'clamp low ' + s.speed);
    await page.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; window.__audio.setSpeed(2); }); await sleep(300); const b = (await books(page)).find((x) => x.title === 'Long Tone'); assert(b.speed === 2, 'not saved ' + b.speed);
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings')).audioSpeed) === 2, 'global last speed'); return 'saved 2×';
  });
  await step('Sleep timer: menu has 15/30/45/60/end of chapter; minutes timer pauses; end-of-chapter pauses at the boundary', async () => {
    await click(page, '#ap-sleep'); await page.waitForSelector('#sleep-off'); const labels = await page.$$eval('#overlay .list-item', (e) => e.map((x) => x.innerText.trim().split('\n')[0].trim())); assert(['Off', '15 minutes', '30 minutes', '45 minutes', '60 minutes', 'End of chapter'].every((l) => labels.includes(l)), labels.join());
    await click(page, '#sleep-15'); await sleep(300); let s = await st(page); assert(s.sleep && s.sleep.kind === 'minutes' && s.sleep.remaining > 14.5 * 60000, JSON.stringify(s.sleep)); assert(/15 min/.test(await page.$eval('#ap-sleep', (e) => e.innerText)), 'label');
    await click(page, '#ap-sleep'); await click(page, '#sleep-off'); s = await st(page); assert(!s.sleep, 'not cleared');
    await page.evaluate(() => { window.__audio.setSpeed(3); window.__audio.setSleep(0.04); }); await waitFor(page, () => window.__audio.el.paused, 6000); s = await st(page); assert(!s.sleep && !s.playing, 'timer did not pause');
    await page.evaluate(async () => { await window.__audio.seekGlobal(36, true); window.__audio.setSleep('chapter'); }); await waitFor(page, () => window.__audio.el.paused, 8000); s = await st(page);
    assert(approx(s.pos, 40, 0.8) && !s.sleep, 'end of chapter 1 expected ~40, got ' + JSON.stringify(s)); return `paused at ${s.pos.toFixed(1)}s (chapter boundary)`;
  });
  await step('Media Session: metadata + lock-screen actions (play, pause, ±15, previous / next chapter, seekto)', async () => {
    await page.evaluate(() => { window.__audio.setSpeed(1); return window.__audio.seekGlobal(50, false); }); await sleep(300);
    const md = await page.evaluate(() => { const m = navigator.mediaSession.metadata; return m && { title: m.title, artist: m.artist, album: m.album, art: m.artwork.length }; });
    assert(md && md.title === 'Part Two' && md.artist === 'Long Author' && md.album === 'Long Tone' && md.art === 1, JSON.stringify(md));
    const acts = await page.evaluate(() => Object.keys(window.__ms)); for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack', 'seekto']) assert(acts.includes(a), 'missing ' + a + ' in ' + acts);
    await page.evaluate(() => window.__ms.play()); await waitFor(page, () => !window.__audio.el.paused, 3000); await page.evaluate(() => window.__ms.pause()); await waitFor(page, () => window.__audio.el.paused, 3000);
    let p0 = (await st(page)).pos; await page.evaluate(() => window.__ms.seekforward({})); await sleep(300); let p1 = (await st(page)).pos; assert(approx(p1 - p0, 15, 1), 'seekforward ' + (p1 - p0));
    await page.evaluate(() => window.__ms.seekbackward({ seekOffset: 5 })); await sleep(300); const p2 = (await st(page)).pos; assert(approx(p1 - p2, 5, 1), 'seekbackward ' + (p1 - p2));
    await page.evaluate(() => window.__ms.nexttrack()); await sleep(500); let s = await st(page); assert(s.ci === 2, 'next ' + s.ci); assert((await page.evaluate(() => navigator.mediaSession.metadata.title)) === 'Part Three', 'metadata not updated');
    await page.evaluate(() => window.__ms.seekto({ seekTime: 10 })); await sleep(400); s = await st(page); assert(approx(s.pos, 90, 1), 'seekto ' + s.pos); await page.evaluate(() => window.__ms.previoustrack()); await sleep(500); s = await st(page); assert(s.ci === 2 && approx(s.pos, 80, 1), 'prev (restart chapter) ' + JSON.stringify(s));
    return 'metadata + 7 actions ok';
  });
  await step('Position is remembered per book (survives reload) and the player resumes there', async () => {
    await page.evaluate(async () => { await window.__audio.setSpeed(2); await window.__audio.seekGlobal(61.5, false); await window.__audio.save(true); }); await sleep(300);
    await page.reload({ waitUntil: 'networkidle0' }); await gotoAudio(page); const b = (await books(page)).find((x) => x.title === 'Long Tone'); assert(approx(b.pos, 61.5, 0.8) && b.status === 'reading' && approx(b.progress, 61.5 / 120, 0.02), JSON.stringify(b));
    const badge = await page.$$eval('#audio-body .tile', (e) => e.find((t) => /Long Tone/.test(t.innerText)).querySelector('.pbadge').innerText); assert(/51%/.test(badge), badge);
    await page.evaluate(() => [...document.querySelectorAll('#audio-body .tile')].find((t) => /Long Tone/.test(t.innerText)).click()); await waitFor(page, () => window.__audio.state()?.playing, 6000); const s = await st(page); assert(approx(s.pos, 61.5, 2.5) && s.ci === 1, JSON.stringify(s));
    assert(s.speed === 2, 'speed not restored ' + s.speed); await page.evaluate(() => window.__audio.pause()); await click(page, '#ap-close'); return `resumed at ${s.pos.toFixed(1)}s, ${s.speed}×`;
  });
  await step('Reaching the end marks the audiobook Finished', async () => {
    const id = (await books(page)).find((x) => x.title === 'Ogg Tone').id; await page.evaluate(async (id) => { await window.__audio.loadBook(id, { play: false }); await window.__audio.setSpeed(3); await window.__audio.seekGlobal(1.2, true); }, id);
    await waitFor(page, (id) => window.__audio.state()?.book.status === 'finished', 8000, id); await sleep(500); const b = (await books(page)).find((x) => x.id === id); assert(b.status === 'finished' && b.progress === 1 && approx(b.pos, b.dur, 0.2), JSON.stringify(b));
    await page.evaluate(() => window.__folio.show('audiobooks')); await sleep(400); const badge = await page.$$eval('#audio-body .tile', (e) => e.find((t) => /Ogg Tone/.test(t.innerText)).querySelector('.pbadge').className); assert(/done/.test(badge), badge); return 'finished + ✓ badge';
  });
  await step('Multi-file book plays through tracks and keeps one global timeline', async () => {
    const id = (await books(page)).find((x) => x.title === 'Tone Story').id; await page.evaluate(async (id) => { await window.__audio.loadBook(id, { play: false }); await window.__audio.setSpeed(1); await window.__audio.seekGlobal(3.0, true); }, id);
    await waitFor(page, () => window.__audio.state().track === 1, 8000); await sleep(500); let s = await st(page); assert(s.ci === 1 && s.pos > 4.0 && s.pos < 6, JSON.stringify(s));
    await page.evaluate(() => window.__audio.seekGlobal(9, false)); await sleep(600); s = await st(page); assert(s.track === 2 && approx(s.pos, 9, 0.6) && s.chapter === 'Part 3', JSON.stringify(s)); await page.evaluate(() => window.__audio.pause()); return 'track ' + s.track + ' @' + s.pos.toFixed(1);
  });

  /* ---------------- library: shelves, sort, select, delete ---------------- */
  await step('Shelves: create (shared with ebooks), move selected audiobooks, chip counts, filter', async () => {
    await gotoAudio(page); await page.evaluate(async () => { const S = await import('/js/store.js'); const sh = await S.createShelf('Road trip'); window.__sh = sh.id; });
    await click(page, '#audio-select'); await page.waitForSelector('#audio-select-bar'); await page.evaluate(() => [...document.querySelectorAll('#audio-body .tile')].filter((t) => /Long Tone|Tone Story/.test(t.innerText)).forEach((t) => t.click())); await sleep(200);
    assert(/2 selected/.test(await page.$eval('#audio-sel-count', (e) => e.innerText)), 'count'); await click(page, '#audio-sel-move'); await page.waitForSelector('[data-shelf]'); await click(page, '[data-shelf]'); await sleep(600);
    const bs = await books(page); assert(bs.filter((b) => b.shelves.length).length === 2, JSON.stringify(bs.map((b) => b.shelves)));
    await page.evaluate(() => window.__folio.show('audiobooks')); await sleep(400); const chip = await page.$$eval('.chip', (e) => e.find((c) => /Road trip/.test(c.innerText)).innerText.replace(/\s+/g, ' ')); assert(/Road trip 2/.test(chip), chip);
    await page.evaluate(() => [...document.querySelectorAll('.chip')].find((c) => /Road trip/.test(c.innerText)).click()); await sleep(400); const t = (await titles(page)).sort(); assert(t.join() === 'Long Tone,Tone Story', t.join());
    await page.evaluate(() => [...document.querySelectorAll('.chip')].find((c) => /^All/.test(c.innerText)).click()); await sleep(300);
    const lib = await page.evaluate(async () => { window.__folio.show('library'); await new Promise((r) => setTimeout(r, 600)); return [...document.querySelectorAll('.chip')].some((c) => /Road trip/.test(c.innerText)); }); assert(lib, 'shelf not visible in the ebook library'); await gotoAudio(page); return 'shelf shared, 2 audiobooks';
  });
  await step('Status chips (Listening / Want to Listen / Finished) filter', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.chip')].find((c) => /Finished/.test(c.innerText)).click()); await sleep(400); let t = await titles(page); assert(t.join() === 'Ogg Tone', t.join());
    await page.evaluate(() => [...document.querySelectorAll('.chip')].find((c) => /Listening/.test(c.innerText)).click()); await sleep(400); t = await titles(page); assert(t.includes('Long Tone') && !t.includes('Ogg Tone'), t.join());
    await page.evaluate(() => [...document.querySelectorAll('.chip')].find((c) => /^All/.test(c.innerText)).click()); await sleep(300); return 'ok';
  });
  await step('Sort: title / author / length / added / progress, direction toggle, per-shelf memory; list ↔ grid', async () => {
    const sort = async (f) => { await page.select('#audio-sort-sel', f); await sleep(400); return titles(page); };
    let t = await sort('title'); assert(t[0] === 'Chaptered Book' || t[0] === 'Chaptered Book', 'title asc ' + t.join()); const sorted = [...t].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())); assert(t.join() === sorted.join(), 'title order ' + t.join());
    await click(page, '#audio-sort-dir'); await sleep(400); t = await titles(page); assert(t.join() === sorted.reverse().join(), 'title desc ' + t.join());
    await sort('duration'); const durs = await page.evaluate(async () => { const a = await (await import('/js/audiostore.js')).getAudiobooks(); return Object.fromEntries(a.map((b) => [b.id, b.duration])); }); const ids = await page.$$eval('#audio-body .tile', (e) => e.map((x) => x.dataset.id)); const dd = ids.map((x) => durs[x]); t = await titles(page); assert(dd.every((d, i) => !i || dd[i - 1] >= d - 0.001), 'length desc ' + JSON.stringify(dd));
    t = await sort('author'); assert(t.length > 3); t = await sort('added'); t = await sort('progress'); assert(t[0] === 'Ogg Tone', 'progress first=finished ' + t[0]);
    await click(page, '#audio-view-list'); await sleep(400); assert(await page.$('#audio-body .tiles.list'), 'list view'); await click(page, '#audio-view-grid'); await sleep(300); assert(await page.$('#audio-body .tiles.grid'), 'grid view');
    const own = await page.evaluate(() => JSON.parse(localStorage.getItem('folio.settings')).sorts['audio:all']); assert(own.field === 'progress', JSON.stringify(own)); await page.select('#audio-sort-sel', 'recent'); await sleep(300); return 'persisted per context';
  });
  await step('Custom order: select it, hint shown, reset to automatic', async () => {
    await page.select('#audio-sort-sel', 'custom'); await sleep(400); assert(/hold an audiobook/i.test(await page.$eval('#view', (e) => e.innerText)), 'hint'); assert(await page.$('#audio-reset-order')); await click(page, '#audio-reset-order'); await sleep(400);
    assert(await page.$eval('#audio-sort-sel', (e) => e.value) !== 'custom', 'not reset'); return 'ok';
  });
  await step('Select mode: select all / clear / mark finished', async () => {
    await click(page, '#audio-select'); await sleep(500); await click(page, '#audio-sel-all'); await sleep(200); const n = (await books(page)).length; assert(new RegExp(n + ' selected').test(await page.$eval('#audio-sel-count', (e) => e.innerText)), 'select all'); await click(page, '#audio-sel-clear'); assert(/Tap audiobooks/.test(await page.$eval('#audio-sel-count', (e) => e.innerText)));
    await page.evaluate(() => [...document.querySelectorAll('#audio-body .tile')].find((t) => /plain clip/.test(t.innerText)).click()); await sleep(200); await click(page, '#audio-sel-finish'); await sleep(600); const b = (await books(page)).find((x) => x.title === 'plain clip'); assert(b.status === 'finished', b.status); return 'ok';
  });
  await step('Delete (single, from menu) with confirm + Undo restores audio files; deleting the playing book stops the player', async () => {
    await gotoAudio(page); const bs = await books(page); const victim = bs.find((b) => b.title === 'M4A Tone'); await page.evaluate(async (id) => { await window.__audio.loadBook(id, { play: true }); }, victim.id); await sleep(800);
    await page.evaluate(() => [...document.querySelectorAll('#audio-body .tile')].find((t) => /M4A Tone/.test(t.innerText)).querySelector('.tile-more').click()); await page.waitForSelector('#audio-menu-delete'); await click(page, '#audio-menu-delete'); await sleep(300);
    assert(/Delete audiobook/.test(await page.$eval('#overlay', (e) => e.innerText)), 'no confirm'); await clickText(page, '#overlay .btn', '^Delete$'); await sleep(900);
    assert(!(await titles(page)).includes('M4A Tone') && (await books(page)).length === bs.length - 1, 'not deleted'); const files = await page.evaluate(async () => (await (await import('/js/db.js')).DB.all('audiofiles')).map((f) => f.id)); assert(!files.some((f) => f.startsWith(victim.id)), 'files remain');
    assert(await page.evaluate(() => window.__audio.state() === null) && await page.$eval('#miniplayer', (e) => e.hidden), 'player still loaded');
    await click(page, '#toast-action'); await sleep(900); const back = await books(page); assert(back.length === bs.length && back.some((b) => b.id === victim.id), 'undo failed');
    const ok = await page.evaluate(async (id) => { await window.__audio.loadBook(id, { play: false }); return window.__audio.state()?.total > 2; }, victim.id); assert(ok, 'restored book not playable'); await page.evaluate(() => window.__audio.pause()); return 'deleted → undone → playable';
  });
  await step('Multi-select delete + Delete all (typed confirm)', async () => {
    await gotoAudio(page); await click(page, '#audio-select'); await sleep(500); await page.evaluate(() => [...document.querySelectorAll('#audio-body .tile')].filter((t) => /Ogg Tone|plain clip/.test(t.innerText)).forEach((t) => t.click())); await sleep(200); await click(page, '#audio-sel-delete'); await sleep(300);
    { const ot = await page.$eval('#overlay', (e) => e.innerText); assert(/Delete 2 audiobooks/.test(ot), 'confirm text: ' + ot.slice(0, 80)); } await clickText(page, '#overlay .btn', '^Delete 2'); await sleep(900); const n = (await books(page)).length; assert(!(await titles(page)).some((t) => /Ogg Tone|plain clip/.test(t)), 'still there');
    await click(page, '#audio-menu'); await page.waitForSelector('#audio-menu-delete-all'); await click(page, '#audio-menu-delete-all'); await page.waitForSelector('#audio-delete-all-input'); assert(await page.$eval('#audio-delete-all-confirm', (e) => e.disabled), 'enabled early');
    await page.type('#audio-delete-all-input', 'DELETE'); await click(page, '#audio-delete-all-confirm'); await sleep(900); assert((await books(page)).length === 0, 'not empty'); const files = await page.evaluate(async () => (await (await import('/js/db.js')).DB.all('audiofiles')).length); assert(files === 0, 'files left ' + files);
    assert(/No audiobooks yet/.test(await page.$eval('#view', (e) => e.innerText)), 'empty state'); return `removed 2, then all (${n - 2})`;
  });
  await step('Ebook library untouched by audiobook deletes (books + shelves intact)', async () => {
    const r = await page.evaluate(async () => { const S = await import('/js/store.js'); return { shelves: (await S.getShelves()).map((s) => s.name), books: (await S.getBooks()).length }; }); assert(r.shelves.includes('Road trip'), JSON.stringify(r)); return JSON.stringify(r);
  });
  await page.close();

  /* ---------------- online sources (mocked network) ---------------- */
  const O = await newPage(browser, { mock: true }); await gotoAudio(O);
  await step('LibriVox: API blocked by CORS → app retries through the proxy; results show title, author, parts', async () => {
    await click(O, '#audio-empty-online'); await O.waitForSelector('#audio-results .aud-row', { timeout: 15000 }); const rows = await O.$$eval('.aud-row', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ')));
    assert(rows.length === 2 && /The Tone Story/.test(rows[0]) && /Tess Tone/.test(rows[0]) && /2 parts/.test(rows[0]) && /Public domain/.test(rows[0]), rows.join(' | '));
    assert(O.log.lv.some((x) => !x.viaProxy) && O.log.lv.some((x) => x.viaProxy), 'direct + proxy expected: ' + JSON.stringify(O.log.lv)); return 'proxy used: ' + O.log.proxy[0].slice(0, 60);
  });
  await step('LibriVox search by title prefix (^) and by author; "no results" answer handled', async () => {
    await O.type('#audio-src-q', 'The Tone St'); await O.keyboard.press('Enter'); await O.waitForFunction(() => document.querySelectorAll('.aud-row').length === 1, { timeout: 8000 }); assert(O.log.lv.some((x) => /title=%5EThe\+Tone\+St/.test(x.target)), JSON.stringify(O.log.lv.map((x) => x.target)));
    await O.$eval('#audio-src-q', (e) => { e.value = 'Tess Tone'; }); await click(O, '[data-by="author"]'); await O.waitForFunction(() => document.querySelectorAll('.aud-row').length === 2, { timeout: 8000 }); assert(O.log.lv.some((x) => /author=Tone/.test(x.target)), 'author query');
    await click(O, '[data-by="title"]'); await O.$eval('#audio-src-q', (e) => { e.value = 'nomatch'; }); await O.keyboard.press('Enter'); await O.waitForFunction(() => /No audiobooks found/.test(document.querySelector('#audio-results').innerText), { timeout: 8000 }); assert(!(await O.$('#audio-src-err')), 'a 404 "no results" is shown as an error'); return 'ok';
  });
  await step('LibriVox bug fix (v0.5.10): HTTP 404 = no results (never an error); a partial word falls back to Internet Archive matches; odd characters / empty query are fine', async () => {
    const q = async (text, by = 'title') => { await click(O, `[data-by="${by}"]`); await O.$eval('#audio-src-q', (e, t) => { e.value = t; }, text); await O.focus('#audio-src-q'); await O.keyboard.press('Enter'); await sleep(900); await O.waitForFunction(() => !document.querySelector('#audio-results .spinner-row'), { timeout: 8000 }); return O.evaluate(() => ({ rows: document.querySelectorAll('.aud-row').length, err: !!document.querySelector('#audio-src-err'), text: document.querySelector('#audio-results').innerText.slice(0, 120), note: document.querySelector('#audio-src-note').textContent })); };
    let r = await q('zzzq nothing'); assert(r.rows === 0 && !r.err && /No audiobooks found/.test(r.text), JSON.stringify(r));
    r = await q('Sequel'); assert(r.rows === 1 && !r.err && /Internet Archive matches/.test(r.note), JSON.stringify(r));   // not a title prefix: LibriVox 404 → IA contains-search
    r = await q('100% & "quotes" <b>'); assert(!r.err, JSON.stringify(r)); r = await q("O'Brien: a/b?c=d#e"); assert(!r.err, JSON.stringify(r));
    r = await q('Tone', 'author'); assert(!r.err, JSON.stringify(r)); r = await q(''); assert(r.rows >= 1 && !r.err, JSON.stringify(r));
    r = await q('The Tone St'); assert(r.rows === 1 && !/Internet Archive matches/.test(r.note), 'normal prefix search still LibriVox: ' + JSON.stringify(r));
    O.log.lvDown = true; r = await q('The Tone'); assert(r.rows >= 1 && !r.err && /isn’t answering/.test(r.note), 'LibriVox down → Internet Archive: ' + JSON.stringify(r));
    O.log.iaDown = true; r = await q('The Tone'); assert(r.err, 'both down should show the error with retry'); O.log.lvDown = O.log.iaDown = false;
    r = await q('The Tone St'); assert(r.rows === 1 && !r.err, 'recovers: ' + JSON.stringify(r));
  });
  await step('LibriVox: Add (stream) → library book with remote tracks (www.archive.org rewritten), cover, license; plays streaming', async () => {
    await O.$eval('#audio-src-q', (e) => { e.value = ''; }); await O.keyboard.press('Enter'); await O.waitForSelector('.aud-row [data-act=add]'); await O.evaluate(() => document.querySelector('.aud-row [data-act=add]').click()); await waitBooks(O, 1);
    const b = (await books(O))[0]; assert(b.title === 'The Tone Story' && b.author === 'Tess Tone' && b.tracks.length === 2 && b.tracks.every((t) => !t.stored && /^https:\/\/archive\.org\/download\//.test(t.url)) && b.cover && b.source === 'librivox', JSON.stringify(b));
    await O.evaluate(() => { document.querySelector('#overlay').replaceChildren(); document.querySelector('#overlay').hidden = true; }); await gotoAudio(O); assert(await O.$('#audio-body .tile .pill-cloud'), 'no cloud badge');
    await O.evaluate(async (id) => { await window.__audio.loadBook(id, { play: true }); }, b.id); await waitFor(O, () => window.__audio.state()?.playing && window.__audio.el.currentTime > 0.5, 8000); const s = await st(O); assert(/archive\.org\/download/.test(await O.evaluate(() => window.__audio.el.currentSrc)), 'not streaming'); assert(approx(s.total, 8, 0.5), JSON.stringify(s)); return 'streaming from ' + (await O.evaluate(() => new URL(window.__audio.el.currentSrc).host));
  });
  await step('Download for offline: tracks saved to IndexedDB, plays with the network blocked, remove offline copy works', async () => {
    await O.evaluate(() => window.__audio.pause()); const id = (await books(O))[0].id; await O.evaluate(() => document.querySelector('#miniplayer #mini-close').click()); await sleep(300);
    await O.evaluate(() => [...document.querySelectorAll('#audio-body .tile')][0].querySelector('.tile-more').click()); await O.waitForSelector('#audio-menu-dl'); await click(O, '#audio-menu-dl');
    await waitStored(O, 'The Tone Story', 20000); await sleep(500);
    const b = (await books(O))[0]; assert(b.tracks.every((t) => t.stored) && b.size > 30000, JSON.stringify(b.tracks)); const files = await O.evaluate(async () => (await (await import('/js/db.js')).DB.all('audiofiles')).length); assert(files === 2, 'files ' + files);
    O.log.blockMedia = true; await O.evaluate(async (id) => { await window.__audio.loadBook(id, { play: true }); }, id); await waitFor(O, () => window.__audio.state()?.playing && window.__audio.el.currentTime > 0.4, 8000); assert(/^blob:/.test(await O.evaluate(() => window.__audio.el.currentSrc)), 'not playing the offline copy'); await O.evaluate(() => window.__audio.pause()); O.log.blockMedia = false;
    await O.evaluate(() => document.querySelector('#miniplayer #mini-close').click()); await sleep(300); await O.evaluate(() => [...document.querySelectorAll('#audio-body .tile')][0].querySelector('.tile-more').click()); await O.waitForSelector('#audio-menu-rmdl'); await click(O, '#audio-menu-rmdl'); await sleep(600);
    const b2 = (await books(O))[0]; assert(b2.tracks.every((t) => !t.stored), 'still stored'); return 'offline ok, removed';
  });
  await step('Internet Archive audio: restricted query, natural file order, one bitrate, Add + offline', async () => {
    await gotoAudio(O); await click(O, '#audio-menu'); await O.waitForSelector('#audio-menu-online'); await click(O, '#audio-menu-online'); await O.waitForSelector('#audio-src-seg'); await click(O, '[data-src="ia"]'); await O.waitForSelector('.aud-row[data-key="ia:iatone_librivox"]', { timeout: 25000 });
    assert(O.log.ia.length >= 1, 'IA search not issued'); const row = await O.$eval('.aud-row', (e) => e.innerText.replace(/\s+/g, ' ')); assert(/IA Tone Book/.test(row) && /Ida Archive/.test(row), row);
    await O.evaluate(() => document.querySelector('.aud-row [data-act=offline]').click()); await waitStored(O, 'IA Tone Book', 25000); await sleep(400);
    const b = (await books(O)).find((x) => x.title === 'IA Tone Book'); assert(b && b.author === 'Ida Archive' && b.tracks.map((t) => t.name).join() === 'tone_01.mp3,tone_02.mp3,tone_10.mp3' && b.tracks.every((t) => t.stored) && b.cover, JSON.stringify(b)); return b.tracks.length + ' files, natural order, 64k set only';
  });
  await step('Already-added items show "In library" in the source list', async () => {
    await O.$eval('#audio-src-q', (e) => { e.value = ''; }); await click(O, '[data-src="librivox"]'); await O.waitForFunction(() => [...document.querySelectorAll('#audio-results .aud-row')].some((r) => /In library/.test(r.innerText)), { timeout: 8000 }).catch(async (e) => { throw new Error(e.message + ' rows: ' + (await O.evaluate(() => [...document.querySelectorAll('.aud-row')].map((r) => r.innerText.replace(/\s+/g, ' ')).join(' || ')))); }); return 'ok';
  });
  await O.close();

  /* ---------------- app shell / service worker ---------------- */
  await step('Service worker: folio-v22 and every audiobook + metadata (covers, enrich, metasync) module is precached; all shell files exist', async () => {
    const base = APP.replace(/index\.html.*$/, ''); const sw = await (await fetch(base + 'sw.js')).text(); assert(/VERSION = 'folio-v22'/.test(sw) && ['covers','coversearch','viewport','openguard','hold','nav','pinch','pdftext','zip','backup','backupui','enrich','metasync','drivebatch','pairing','links','align','loans','findplace'].every((m) => sw.includes('js/' + m + '.js')), 'version');
    const shell = JSON.parse(sw.match(/const SHELL = (\[[^;]*\]);/s)[1].replace(/'/g, '"')); for (const f of ['js/audiotags.js', 'js/audiostore.js', 'js/audioplayer.js', 'js/audiobooks.js', 'js/audiosources.js']) assert(shell.includes(f), f + ' missing from SHELL');
    for (const f of shell) { const r = await fetch(base + f.replace(/^\.\//, '')); assert(r.ok, f + ' → ' + r.status); } return shell.length + ' shell files';
  });
  await step('Block-list: audiobook piracy hosts are refused by the app', async () => {
    const P = await newPage(browser); const r = await P.evaluate(async () => { const { isBlockedSite } = await import('/js/net.js'); return ['https://audiobookbay.lu/x', 'https://tokybook.com/', 'https://librivox.org/', 'https://archive.org/'].map(isBlockedSite); }); assert(r.join() === 'true,true,false,false', r.join()); await P.close(); return r.join();
  });

  /* ---------------- live (real network) ---------------- */
  const { spawn } = require('child_process'); const prox = spawn('node', [path.join(__dirname, '..', 'proxy', 'server.js')], { env: { ...process.env, PORT: '8788' }, stdio: 'ignore' }); await sleep(800);
  const L = await newPage(browser); await L.evaluate(() => window.__folio.settings.set({ proxyUrl: 'http://localhost:8788/' })); await gotoAudio(L);
  await step('LIVE Internet Archive audio search (direct, CORS) returns restricted-safe LibriVox items', async () => {
    const r = await L.evaluate(async () => { const m = await import('/js/audiosources.js'); const x = await m.searchIaAudio({ q: 'pride and prejudice' }); const t = await m.loadIaTracks(x.items[0]); return { n: x.items.length, first: x.items[0].title, tracks: t.tracks.length, url: t.tracks[0].url }; });
    assert(r.n > 0 && r.tracks > 0 && /^https:\/\/archive\.org\/download\//.test(r.url), JSON.stringify(r)); return JSON.stringify(r);
  });
  await step('LIVE LibriVox API through the deployed proxy: search "Pride and Prejudice"', async () => {
    const r = await L.evaluate(async () => { const m = await import('/js/audiosources.js'); const x = await m.searchLibrivox({ q: 'Pride and' }); return { n: x.items.length, first: x.items[0]?.title, parts: x.items[0]?.tracks.length, url: x.items[0]?.tracks[0].url }; });
    assert(r.n > 0 && r.parts > 0 && /^https:\/\/archive\.org\/download\//.test(r.url), JSON.stringify(r)); return JSON.stringify(r);
  });
  await step('LIVE stream: first LibriVox section starts playing', async () => {
    const r = await L.evaluate(async () => { const m = await import('/js/audiosources.js'); const A = await import('/js/audiostore.js'); const x = await m.searchLibrivox({ q: 'Pride and' }); const b = await A.addRemoteAudiobook(x.items[0]); await window.__audio.loadBook(b.id, { play: true }); await new Promise((res) => { const t = setInterval(() => { if (window.__audio.el.currentTime > 1) { clearInterval(t); res(); } }, 200); setTimeout(() => { clearInterval(t); res(); }, 25000); }); const s = window.__audio.state(); window.__audio.pause(); return { t: window.__audio.el.currentTime, title: s && s.title }; });
    assert(r.t > 1, JSON.stringify(r)); return JSON.stringify(r);
  });
  await L.close(); prox.kill();
  await step('LIVE deployed Cloudflare proxy answers LibriVox for the production origin (CORS header present)', async () => {
    const r = await fetch('https://folio-proxy.geek4945.workers.dev/?url=' + encodeURIComponent('https://librivox.org/api/feed/audiobooks?format=json&title=%5EPride&limit=1&extended=1'), { headers: { Origin: 'https://geek4945-creator.github.io' } }); const d = await r.json();
    assert(r.ok && r.headers.get('access-control-allow-origin') === 'https://geek4945-creator.github.io' && d.books && d.books.length === 1 && d.books[0].sections.length > 1, r.status + ' ' + r.headers.get('access-control-allow-origin')); return d.books[0].title + ', ' + d.books[0].sections.length + ' sections';
  });

  const P = await newPage(browser); await gotoAudio(P); await sleep(300);
  await step('No page errors (audiobook tab)', async () => { assert(!P.errs.length, P.errs.join(' | ')); return ''; });
  await P.close(); await browser.close();
  const pass = results.filter((r) => r[0]).length; console.log(`\n${pass}/${results.length} passed`); process.exit(pass === results.length ? 0 : 1);
})();

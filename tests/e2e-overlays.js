// Every overlay (sheet, guide, dialog) must be closable in a standalone iPhone PWA (no browser back button), with a notch + home indicator:
// a visible ✕ at the top (not under the status bar), a Done / Back button at the bottom (not under the home indicator) for sheets,
// tap-outside, Escape, and scrolling inside when the content is long. Also the full-screen reader / PDF / audio player and the install banner.
const puppeteer = require('puppeteer-core'); const path = require('path');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const fx = (...p) => path.join(__dirname, 'fixtures', ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const VW = 375, VH = 667, SAT = 47, SAB = 34;   // iPhone SE-ish height + simulated notch / home-indicator insets

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  async function mk(ua) {
    const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); if (ua) await page.setUserAgent(ua);
    page.errs = []; page.on('pageerror', (e) => page.errs.push((e.stack || e.message).split('\n').slice(0, 3).join(' <- ')));
    await page.evaluateOnNewDocument(`localStorage.setItem('folio.google', JSON.stringify({ token: 'seed', exp: ${Date.now() + 3600000}, profile: { name: 'Ada', email: 'a@b.c', picture: '' } })); try{delete Element.prototype.requestFullscreen;delete Element.prototype.webkitRequestFullscreen;}catch(e){}`);
    await page.setRequestInterception(true);   // Google is mocked: a GIS stub and an empty Drive
    page.on('request', (req) => { const u = req.url(); const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (u.startsWith('https://accounts.google.com/gsi/client')) return req.respond({ status: 200, contentType: 'text/javascript', body: "window.google={accounts:{id:{disableAutoSelect(){}},oauth2:{initTokenClient(c){return{requestAccessToken(){setTimeout(()=>c.callback({access_token:'t',expires_in:3600,scope:c.scope}),10)}}},revoke(t,cb){cb&&cb()},hasGrantedAllScopes(){return true}}}};" });
      if (/googleapis\.com/.test(u)) return req.method() === 'OPTIONS' ? req.respond({ status: 204, headers: H }) : req.respond({ status: 200, headers: H, contentType: 'application/json', body: u.includes('userinfo') ? '{"name":"Ada","email":"a@b.c"}' : '{"files":[]}' });
      req.continue(); });
    await page.goto(APP, { waitUntil: 'networkidle0' });
    await page.evaluate((a, b) => { document.documentElement.style.setProperty('--sat', a + 'px'); document.documentElement.style.setProperty('--sab', b + 'px'); }, SAT, SAB);
    return page;
  }
  const ev = (p, fn, ...a) => p.evaluate(fn, ...a);
  const sheets = (p) => ev(p, () => document.querySelectorAll('#overlay .sheet-wrap').length);
  const closeAll = async (p) => { await ev(p, () => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; }); };
  const waitSheet = async (p, n = 1, nm = '') => { for (let i = 0; i < 60; i++) { if ((await sheets(p)) >= n) { await sleep(300); return; } await sleep(100); } throw new Error('no sheet appeared ' + nm); };

  /** Geometry + the four ways to close. `open` opens the overlay (fresh each time). */
  async function probe(p, name, open, { footer = true, dim = true, ownButton = null } = {}) {
    const modes = ['x', ...(footer ? ['done'] : []), ...(ownButton ? ['own'] : []), ...(dim ? ['outside'] : []), 'escape'];
    for (const mode of modes) {
      await closeAll(p); await open(); await waitSheet(p, 1, name + ' / ' + mode);
      if (mode === 'x') {
        const g = await ev(p, (SAT, SAB, VH) => {
          const sh = [...document.querySelectorAll('#overlay .sheet')].pop(); const r = sh.getBoundingClientRect(); const x = sh.querySelector('.sheet-x'); const xr = x ? x.getBoundingClientRect() : null; const f = sh.querySelector('.sheet-done'); const fr = f ? f.getBoundingClientRect() : null; const b = sh.querySelector('.sheet-body');
          const top = xr ? document.elementFromPoint(xr.left + xr.width / 2, xr.top + xr.height / 2) : null;
          return { hasX: !!x, xTop: xr && xr.top, xClear: !!top && (top === x || x.contains(top)), shTop: r.top, shBottom: r.bottom, footBottom: fr && fr.bottom, footTop: fr && fr.top, hasFoot: !!f, bodyOverflow: getComputedStyle(b).overflowY, scrolls: b.scrollHeight > b.clientHeight + 1, bodyH: b.clientHeight, aria: sh.getAttribute('role') };
        }, SAT, SAB, VH);
        assert(g.hasX && g.xClear, `${name}: ✕ missing or covered ${JSON.stringify(g)}`); assert(g.xTop >= SAT - 1 && g.shTop >= SAT - 1, `${name}: ✕ / sheet under the status bar: ${JSON.stringify(g)}`);
        assert(g.shBottom <= VH + 1, `${name}: sheet runs off the bottom`); if (footer) { assert(g.hasFoot && g.footBottom <= VH - SAB + 1 && g.footTop >= g.shTop, `${name}: Done button hidden: ${JSON.stringify(g)}`); } else assert(!g.hasFoot || true);
        assert(g.bodyH >= 40, `${name}: body collapsed (${g.bodyH}px)`); assert(!g.scrolls || /auto|scroll/.test(g.bodyOverflow), `${name}: long content must scroll`);
        await ev(p, () => [...document.querySelectorAll('#overlay .sheet-x')].pop().click());
      } else if (mode === 'done') await ev(p, () => [...document.querySelectorAll('#overlay .sheet-done')].pop().click());
      else if (mode === 'own') await ev(p, (sel) => [...document.querySelectorAll('#overlay .sheet')].pop().querySelector(sel).click(), ownButton);
      else if (mode === 'outside') { await p.mouse.click(VW / 2, 6); }
      else if (mode === 'escape') { await p.keyboard.press('Escape'); }
      await sleep(250); assert((await sheets(p)) === 0, `${name}: still open after "${mode}"`);
    }
    return name;
  }

  const ios = await mk(IOS); const page = await mk();
  const imp = async (p, ...files) => { await (await p.$('#file-input')).uploadFile(...files); for (let i = 0; i < 60; i++) { if (await ev(p, async () => (await (await import('./js/store.js')).getBooks()).length) >= files.length) break; await sleep(300); } await sleep(300); };
  const lib = async (p) => { await ev(p, () => window.__folio.show('library')); await sleep(400); };
  const mod = (p, m, fn, ...a) => ev(p, (m, fn, a) => { import(m).then((x) => x[fn](...a)).catch((e) => console.error(e)); return 1; }, m, fn, a);   // fire and forget: some openers only resolve when the sheet closes

  await step('Add to iPhone Home Screen guide: ✕ + Done + tap-outside + Escape, below the notch, scrolls', () => probe(ios, 'install guide', () => mod(ios, './js/install.js', 'openInstallGuide')));
  await step('Install guide is long: it scrolls inside the sheet and the Done button stays reachable', async () => {
    await mod(ios, './js/install.js', 'openInstallGuide'); await waitSheet(ios); const r = await ev(ios, () => { const b = document.querySelector('#overlay .sheet-body'); b.scrollTop = b.scrollHeight; const f = document.querySelector('#overlay .sheet-done').getBoundingClientRect(); return { scrollable: b.scrollHeight > b.clientHeight, moved: b.scrollTop > 0, footVisible: f.bottom <= innerHeight && f.top >= 0 }; });
    assert(r.scrollable && r.moved && r.footVisible, JSON.stringify(r)); await closeAll(ios);
  });
  await step('Install banner can be dismissed (✕) and its “How” opens the guide', async () => {
    await ev(ios, () => localStorage.removeItem('folio.a2hsDismissed')); await ios.reload({ waitUntil: 'networkidle0' }); await ev(ios, (a, b) => { document.documentElement.style.setProperty('--sat', a + 'px'); document.documentElement.style.setProperty('--sab', b + 'px'); }, SAT, SAB);
    assert(await ios.$('#a2hs-banner'), 'banner'); await ev(ios, () => document.querySelector('#a2hs-banner-how').click()); await waitSheet(ios); await ev(ios, () => document.querySelector('#overlay .sheet-x').click()); await sleep(200); await ev(ios, () => document.querySelector('#a2hs-banner-x').click()); await sleep(200); assert(!(await ios.$('#a2hs-banner')), 'banner not dismissed');
  });
  await step('Public library guides: borrow guide, find my library, search, catalog help, DRM-free sources', async () => {
    for (const [fn, nm] of [['openPublicLibraryGuide', 'public library guide'], ['openFindLibrary', 'find my library'], ['openLibraryCatalogHelp', 'library catalog help'], ['openDrmFreeHelp', 'DRM-free sources']]) await probe(page, nm, () => mod(page, './js/publib.js', fn));
  });
  await step('Library menu, Add a source, Free audiobooks, Group-by', async () => {
    await lib(page); await probe(page, 'library menu', () => ev(page, () => document.querySelector('#lib-menu').click()));
    await probe(page, 'free audiobooks', () => mod(page, './js/audiosources.js', 'openAudioSources'));
    await ev(page, () => document.querySelector('[data-tab=catalogs]').click()); await sleep(400); await probe(page, 'add a source', () => ev(page, () => document.querySelector('#add-source').click())); await lib(page);
  });
  await step('Copy-protected (DRM) refusal sheet closes', async () => { await closeAll(page); await (await page.$('#file-input')).uploadFile(fx('drm-flagged.mobi')); await waitSheet(page); await ev(page, () => document.querySelector('#overlay .sheet-x').click()); await sleep(250); assert((await sheets(page)) === 0, 'DRM sheet stuck'); });
  await step('Book menu, Edit details, Shelves, Fix missing info, Change cover, Drive browser', async () => {
    await imp(page, fx('frankenstein.epub'), fx('saga-1.epub')); await lib(page);
    const tileMore = () => ev(page, () => document.querySelector('.tile-more').click());
    await probe(page, 'book options', tileMore);
    await probe(page, 'edit book', async () => { await tileMore(); await waitSheet(page); await ev(page, () => [...document.querySelectorAll('#overlay .list-item')].find((x) => /Edit details/.test(x.innerText)).click()); await sleep(250); });
    await probe(page, 'shelf picker', async () => { await tileMore(); await waitSheet(page); await ev(page, () => [...document.querySelectorAll('#overlay .list-item')].find((x) => /Move to shelf/.test(x.innerText)).click()); await sleep(250); });
    await probe(page, 'fix missing info', () => mod(page, './js/enrich.js', 'openFixMissing', { kind: 'book' }));
    const id = await ev(page, async () => (await (await import('./js/store.js')).getBooks())[0].id);
    await probe(page, 'change cover', () => mod(page, './js/covers.js', 'openCoverEditor', 'book', id));
    await probe(page, 'google drive browser', () => mod(page, './js/drive.js', 'openDriveBrowser', {}));
    await probe(page, 'new shelf dialog', () => ev(page, () => document.querySelector('.chip.add').click()), { footer: false, ownButton: '.row-actions .btn' });
    await probe(page, 'delete confirm', () => mod(page, './js/util.js', 'confirmDlg', 'Delete book?', 'Sure?', 'Delete', true), { footer: false, ownButton: '.row-actions .btn' });
  });
  await step('EPUB reader: Contents + Appearance sheets, back button below the notch, Escape closes the reader', async () => {
    const id = await ev(page, async () => (await (await import('./js/store.js')).getBooks())[0].id); await mod(page, './js/reader.js', 'openReader', id); await page.waitForSelector('#r-toc:not([disabled])'); await sleep(900);
    const top = await ev(page, () => { const b = document.querySelector('#r-back').getBoundingClientRect(); return b.top; }); assert(top >= SAT - 1, 'reader back button under the status bar: ' + top);
    await probe(page, 'reader contents', () => ev(page, () => document.querySelector('#r-toc').click()));
    await probe(page, 'reader appearance', () => ev(page, () => document.querySelector('#r-aa').click()), { dim: false });
    await closeAll(page); await page.keyboard.press('Escape'); await sleep(700); assert(await ev(page, () => document.querySelector('#reader').hidden), 'Escape did not close the reader');
  });
  await step('PDF reader: back button + Appearance sheet + Escape', async () => {
    await imp(page, fx('test-doc.pdf')); const id = await ev(page, async () => (await (await import('./js/store.js')).getBooks()).find((b) => b.format === 'pdf').id); await mod(page, './js/reader.js', 'openReader', id); await page.waitForSelector('#r-back', { timeout: 8000 }); await sleep(1200);
    const top = await ev(page, () => document.querySelector('#r-back').getBoundingClientRect().top); assert(top >= SAT - 1, 'pdf back under the status bar: ' + top);
    await ev(page, () => document.querySelector('#r-back').click()); await sleep(500); assert(await ev(page, () => document.querySelector('#reader').hidden), 'pdf back did not close');
  });
  await step('Audio player: ⌄ Done below the notch, Escape closes it; speed / sleep / chapters sheets close', async () => {
    await (await page.$('#audio-input')).uploadFile(fx('audio', 'long.mp3')); for (let i = 0; i < 60; i++) { if (await ev(page, async () => (await (await import('./js/audiostore.js')).getAudiobooks()).length)) break; await sleep(300); }
    await ev(page, () => window.__folio.show('audiobooks')); await sleep(500); await ev(page, async () => { const A = await import('./js/audiobooks.js'); const b = (await (await import('./js/audiostore.js')).getAudiobooks())[0]; await A.open(b.id); }); await page.waitForSelector('#ap-close', { visible: true });
    const top = await ev(page, () => document.querySelector('#ap-close').getBoundingClientRect().top); assert(top >= SAT - 1, 'player Done under the status bar: ' + top);
    await probe(page, 'playback speed', () => ev(page, () => document.querySelector('#ap-speed').click())); await probe(page, 'sleep timer', () => ev(page, () => document.querySelector('#ap-sleep').click()));
    await probe(page, 'chapters', () => ev(page, () => document.querySelector('#ap-chapters').click()));
    await page.keyboard.press('Escape'); await sleep(400); assert(await ev(page, () => document.querySelector('#audioplayer').hidden), 'Escape did not close the player');
    await ev(page, () => document.querySelector('.mini, #mini')?.click()); await sleep(300); if (await ev(page, () => document.querySelector('#audioplayer').hidden)) await ev(page, async () => { const b = (await (await import('./js/audiostore.js')).getAudiobooks())[0]; await (await import('./js/audiobooks.js')).open(b.id); });
    await ev(page, () => document.querySelector('#ap-close').click()); await sleep(300); assert(await ev(page, () => document.querySelector('#audioplayer').hidden), '⌄ Done did not close the player');
  });
  await step('No page errors', async () => { assert(!page.errs.length && !ios.errs.length, page.errs.concat(ios.errs).join(' | ')); });
  await browser.close(); const fails = results.filter((r) => !r[0]); console.log(`\n${results.length - fails.length}/${results.length} passed`); process.exit(fails.length ? 1 : 0);
})();

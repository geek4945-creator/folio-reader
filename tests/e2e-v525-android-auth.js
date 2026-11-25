// v0.5.25: Google sign-in in the Android app (Capacitor). The app opens android-signin.html in the phone's browser; that page runs
// Google's token sign-in and hands the token back via com.folio.reader://oauth. Google is mocked; Capacitor plugins are stubbed.
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'http://localhost:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '→', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const STUB = () => {
  window.__opened = []; window.__listeners = {};
  const ExternalApp = { openBrowser: async (o) => { window.__opened.push(o.url); return { opened: 'browser' }; }, isInstalled: async () => ({ installed: false }) };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', registerPlugin: (n) => (n === 'ExternalApp' ? ExternalApp : new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : async () => ({})) })),
    Plugins: { App: { addListener: (ev, fn) => { window.__listeners[ev] = fn; return { remove() {} }; }, getLaunchUrl: async () => null } } };
};
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.errs = []; page.on('pageerror', (e) => page.errs.push(e.message));
  await page.evaluateOnNewDocument(STUB);
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.url().startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return r.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify({ email: 'haleyrhine20@gmail.com', name: 'Haley' }) });
    if (r.url().startsWith('https://www.googleapis.com/')) return r.respond({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });   // no real Drive traffic in this test
    if (r.url().startsWith('https://accounts.google.com/')) return r.abort();
    r.continue();
  });
  await page.goto(BASE + 'index.html', { waitUntil: 'networkidle0' }); await sleep(800);
  let state;

  await step('Settings shows a working "Sign in with Google" (no "sign in from your browser" block)', async () => {
    await page.evaluate(() => { localStorage.removeItem('folio.google'); });
    await page.click('[data-tab=settings]');
    await page.waitForSelector('#sign-in', { timeout: 8000 });
    const r = await page.evaluate(() => ({ dis: document.querySelector('#sign-in').disabled, note: (document.querySelector('#android-signin-note') || {}).textContent || '', old: /Google doesn’t allow sign-in/.test(document.body.textContent) }));
    assert(!r.dis && !r.old && /opens your browser/.test(r.note), JSON.stringify(r));
  });

  await step('tapping Sign in opens the Folio sign-in page in the browser with the web client ID, Drive app-data scope and a state', async () => {
    await page.click('#sign-in'); await sleep(300);
    const u = await page.evaluate(() => window.__opened[0]);
    assert(u && u.startsWith('https://geek4945-creator.github.io/folio-reader/android-signin.html#'), u);
    const q = new URLSearchParams(u.split('#')[1]); state = q.get('state');
    assert(/drive\.appdata/.test(q.get('scope')) && /apps\.googleusercontent\.com$/.test(q.get('cid')) && state.length === 32 && q.get('prompt') === 'consent', u);
  });

  await step('a forged return link (wrong state) is ignored', async () => {
    const r = await page.evaluate(async () => { window.__listeners.appUrlOpen({ url: 'com.folio.reader://oauth?state=bad&access_token=evil&expires_in=3599&scope=https://www.googleapis.com/auth/drive.appdata' }); await new Promise((r) => setTimeout(r, 200)); return localStorage.getItem('folio.google'); });
    assert(!r, 'stored ' + r);
  });

  await step('the com.folio.reader://oauth return link signs her in (profile, token, connected) and the Settings card shows her account', async () => {
    const r = await page.evaluate(async (state) => {
      window.__listeners.appUrlOpen({ url: 'com.folio.reader://oauth?state=' + state + '&access_token=tok123&expires_in=3599&scope=' + encodeURIComponent('email profile openid https://www.googleapis.com/auth/drive.appdata') });
      for (let i = 0; i < 40 && !document.querySelector('#sync-now'); i++) await new Promise((r) => setTimeout(r, 100));
      const a = JSON.parse(localStorage.getItem('folio.google'));
      return { email: a && a.profile.email, tok: a && a.token, card: !!document.querySelector('#sync-now'), pending: localStorage.getItem('folio.gPending') };
    }, state);
    assert(r.email === 'haleyrhine20@gmail.com' && r.tok === 'tok123' && r.card && !r.pending, JSON.stringify(r));
  });

  await step('an expired token never opens the browser by itself (she may be reading); it asks for Reconnect instead', async () => {
    const r = await page.evaluate(async () => {
      const a = JSON.parse(localStorage.getItem('folio.google')); a.exp = Date.now() - 1000; localStorage.setItem('folio.google', JSON.stringify(a));
      const G = await import('./js/google.js'); const n = window.__opened.length; let err = '';
      try { await G.getToken(); } catch (e) { err = e.message; }
      return { err, opened: window.__opened.length - n, st: G.getStatus().state };
    });
    assert(r.opened === 0 && r.st === 'needs-reauth' && /Reconnect/.test(r.err), JSON.stringify(r));
  });

  await step('Reconnect / cold start: a return link handled at launch renews the token and keeps her profile', async () => {
    const r = await page.evaluate(async () => {
      const G = await import('./js/google.js');
      G.signIn().catch(() => {}); await new Promise((r) => setTimeout(r, 100));
      const st = new URLSearchParams(window.__opened.at(-1).split('#')[1]).get('state');
      const ok = await G.handleAuthLink('com.folio.reader://oauth?state=' + st + '&access_token=tok456&expires_in=3599&scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive.appdata'));
      await new Promise((r) => setTimeout(r, 200));
      const a = JSON.parse(localStorage.getItem('folio.google'));
      return { ok, tok: a.token, email: a.profile.email, fresh: a.exp > Date.now() + 3000000 };
    });
    assert(r.ok && r.tok === 'tok456' && r.email === 'haleyrhine20@gmail.com' && r.fresh, JSON.stringify(r));
  });
  const appErrs = page.errs.filter((e) => !/accounts\.google|Failed to fetch|503/.test(e));

  // the browser half: android-signin.html with Google's token client mocked
  const p2 = await ctx.newPage(); p2.errs = []; p2.on('pageerror', (e) => p2.errs.push(e.message));
  await p2.evaluateOnNewDocument(() => {
    window.google = { accounts: { oauth2: { initTokenClient: (cfg) => { window.__cfg = cfg; return { requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'webtok', expires_in: 3599, scope: cfg.scope }), 50) }; } } } };
  });
  await step('android-signin.html runs Google sign-in and builds the return link back to the app (intent link on Android)', async () => {
    await p2.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36');
    await p2.goto(BASE + 'android-signin.html#' + new URLSearchParams({ cid: 'x.apps.googleusercontent.com', scope: 'openid https://www.googleapis.com/auth/drive.appdata', state: 'abc', prompt: 'consent', hint: 'haleyrhine20@gmail.com' }), { waitUntil: 'load' });
    assert(!p2.url().includes('#'), 'token params left in the URL ' + p2.url());
    await p2.click('#go'); await sleep(300);
    const r = await p2.evaluate(() => ({ ret: window.__folioReturn, hint: window.__cfg.login_hint, back: !document.querySelector('#back').hidden }));
    assert(r.hint === 'haleyrhine20@gmail.com' && r.back && /^intent:\/\/oauth\?access_token=webtok&expires_in=3599&scope=.+&state=abc#Intent;scheme=com\.folio\.reader;package=com\.folio\.reader;end$/.test(r.ret), JSON.stringify(r));
  });
  await step('no page errors', async () => { assert(!appErrs.length && !p2.errs.length, JSON.stringify([appErrs, p2.errs])); });

  await browser.close();
  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

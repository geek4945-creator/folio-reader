// v0.5.15 "Suggest a change": the last section of global Settings; a 16px multi-line field (2000-char limit), Send → mock POST /suggest, "Thanks — sent", a visible recent list with status,
// offline queue + retry (on reconnect, on reload, with the Retry button), server errors (429) → failed-retry, Remove, nothing sent but what is typed, endpoint follows the proxy setting.
const puppeteer = require('puppeteer-core');
const { makeState, install, fakeLogin } = require('./meta-mocks');
const APP = process.env.URL || 'http://localhost:8765/index.html'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const results = [];
const NAME = /flimsy/i.test(process.env.APPNAME || '') ? 'Flimsy Read' : 'Folio Reader';
async function step(name, fn) { try { const v = await fn(); results.push([true, name]); console.log('PASS', name, v === undefined ? '' : '→ ' + v); } catch (e) { results.push([false, name, e.message]); console.log('FAIL', name, '\n', e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), (m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const S = makeState(); S.suggest = { calls: [], mode: 'ok' };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const errs = [];
  const page = await (await browser.createBrowserContext()).newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => { if (e.message !== 'Object') errs.push(e.message); }); await install(page, S); await page.evaluateOnNewDocument(fakeLogin());
  await page.goto(APP, { waitUntil: 'networkidle0' }); await sleep(500);
  const show = async (t) => { await page.evaluate((t) => (window.__flimsy || window.__folio).show(t), t); await sleep(400); };
  const items = () => page.$$eval('#sg-list .sg-item', (e) => e.map((x) => ({ id: x.dataset.sgId, st: x.dataset.sgStatus, text: x.querySelector('.sg-text').innerText, label: x.querySelector('.sg-st').innerText, retry: !!x.querySelector('.sg-retry') })));
  const type = async (t) => { await page.$eval('#sg-text', (el, t) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, t); };
  const msg = () => page.$eval('#sg-msg', (e) => e.innerText);
  const send = async () => { await page.click('#sg-send'); await sleep(900); };
  const sg = () => S.suggest || { calls: [] };
  await show('settings');

  await step('"Suggest a change" is the very last section of global Settings; multi-line field is 16px (no iOS zoom), 2000-char limit, Send disabled while empty', async () => {
    const r = await page.evaluate(() => { const sec = document.querySelector('#sec-suggest'); const ta = sec.querySelector('textarea'); const secs = [...sec.parentElement.children]; return { last: secs[secs.length - 1] === sec, h: sec.querySelector('h3').innerText, fs: getComputedStyle(ta).fontSize, max: ta.maxLength, rows: ta.rows, dis: document.querySelector('#sg-send').disabled, count: document.querySelector('#sg-count').innerText }; });
    eq(r, { last: true, h: 'Suggest a change', fs: '16px', max: 2000, rows: 5, dis: true, count: '0 / 2000' });
    assert(await page.$('#sg-empty'), 'empty-state text'); eq(await items(), []);
  });
  await step('Sending: POST JSON to the proxy’s /suggest with app, version, platform, ua and the text — and nothing else; "Thanks — sent"; the field clears and the list shows it as sent', async () => {
    await type('Please make the page-turn\nanimation optional. Thanks — Ann'); assert(!(await page.$eval('#sg-send', (e) => e.disabled)), 'enabled'); assert((await page.$eval('#sg-count', (e) => e.innerText)) === '58 / 2000', await page.$eval('#sg-count', (e) => e.innerText));
    await send(); eq(await msg(), 'Thanks — sent');
    const c = sg().calls; eq(c.length, 1); eq(c[0].method, 'POST'); assert(/application\/json/.test(c[0].ct), c[0].ct);
    const b = c[0].body; eq(Object.keys(b).sort(), ['app', 'id', 'platform', 'text', 'ua', 'version']); eq(b.app, NAME); eq(b.version, '0.5.16'); eq(b.text, 'Please make the page-turn\nanimation optional. Thanks — Ann'); assert(/^(web|pwa|app)\//.test(b.platform), b.platform); assert(b.ua.length <= 160 && b.ua.length > 5);
    const it = await items(); eq(it.length, 1); eq(it[0].st, 'sent'); eq(it[0].label, '✓ Sent'); assert(/animation optional/.test(it[0].text) && !it[0].retry);
    eq(await page.$eval('#sg-text', (e) => e.value), ''); assert(await page.$eval('#sg-send', (e) => e.disabled));
  });
  await step('Over the limit: counter shows it, Send stays disabled, nothing is posted', async () => {
    await type('x'.repeat(2001)); eq(await page.$eval('#sg-count', (e) => e.innerText), '2001 / 2000'); assert(await page.$eval('#sg-send', (e) => e.disabled)); eq(sg().calls.length, 1);
    await type('   '); assert(await page.$eval('#sg-send', (e) => e.disabled), 'whitespace only'); await type('');
  });
  await step('Offline: the note is kept ("Saved — …"), listed as Waiting to send with Retry/Remove, and survives a reload', async () => {
    S.suggest.mode = 'offline'; await type('Offline idea: bigger covers'); await send();
    assert(/Saved/.test(await msg()), await msg()); let it = await items(); eq(it.map((x) => x.st), ['queued', 'sent']); eq(it[0].label, 'Waiting to send'); assert(it[0].retry);
    S.suggest.mode = 'offline'; await page.reload({ waitUntil: 'networkidle0' }); await sleep(3600); await show('settings'); it = await items(); eq(it.map((x) => x.st), ['queued', 'sent']); assert(sg().calls.filter((c) => /bigger covers/.test(c.body.text)).length >= 2, 'start-up attempt'); assert(/bigger covers/.test(it[0].text));
  });
  await step('Back online: the queued note is sent automatically (once — same id, no duplicate), status flips to sent', async () => {
    const before = sg().calls.length; S.suggest.mode = 'ok'; await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(900);
    const it = await items(); eq(it.map((x) => x.st), ['sent', 'sent']);
    const posted = sg().calls.slice(before).filter((c) => c.body.text === 'Offline idea: bigger covers'); eq(posted.length, 1); eq(posted[0].body.id, it[0].id);
  });
  await step('Server says no (429): shown as Failed — retry with the reason; Retry re-sends the same note and it becomes sent', async () => {
    S.suggest.mode = '429'; await type('Idea three'); await send(); assert(/Couldn’t send/.test(await msg()), await msg());
    let it = await items(); eq(it[0].st, 'failed'); eq(it[0].label, 'Failed — retry'); assert(it[0].retry); assert(/Too many/.test(await page.$eval('#sg-list .sg-item .muted.grow', (e) => e.innerText)));
    const id = it[0].id; S.suggest.mode = 'ok'; await page.click('#sg-list .sg-item .sg-retry'); await sleep(900);
    it = await items(); eq(it[0].st, 'sent'); eq(it[0].id, id); eq(sg().calls.filter((c) => c.body.id === id).length, 2, JSON.stringify(sg().calls.filter((c) => c.body.id === id).map((c) => c.mode + '@' + (c.t % 100000))));
  });
  await step('Remove deletes an unsent note from the list (sent ones can’t be removed here)', async () => {
    S.suggest.mode = '500'; await type('Idea four'); await send(); let it = await items(); eq(it[0].st, 'failed'); eq(it.length, 4);
    await page.click('#sg-list .sg-item .sg-del'); await sleep(300); it = await items(); eq(it.length, 3); assert(it.every((x) => x.st === 'sent') && !(await page.$('#sg-list .sg-item .sg-del')), 'only sent left'); S.suggest.mode = 'ok';
  });
  await step('Unsent notes are retried when the app starts (no tap needed)', async () => {
    S.suggest.mode = 'offline'; await type('Start-up retry note'); await send(); eq((await items())[0].st, 'queued');
    S.suggest.mode = 'ok'; await page.reload({ waitUntil: 'networkidle0' }); await sleep(4200); await show('settings'); await sleep(600); const it = await items(); eq(it[0].st, 'sent'); assert(/Start-up retry/.test(it[0].text));
  });
  await step('Draft survives a Settings re-render (theme change) and the endpoint follows the proxy setting', async () => {
    await type('half written'); await page.evaluate(() => (window.__flimsy || window.__folio).settings.set({ theme: 'dark' })); await sleep(500);
    eq(await page.$eval('#sg-text', (e) => e.value), 'half written'); await type('');
    const e = await page.evaluate(async () => { const m = await import('./js/suggest.js'); const { settings } = await import('./js/settings.js'); const old = settings.get('proxyUrl'); const out = {}; out.def = m.suggestEndpoint();
      settings.set({ proxyUrl: 'my-proxy.example.workers.dev' }); out.bare = m.suggestEndpoint(); settings.set({ proxyUrl: '' }); out.none = m.suggestEndpoint(); settings.set({ proxyUrl: old }); return out; });
    assert(/^https:\/\/(folio|flimsy)-proxy\.geek4945\.workers\.dev\/suggest$/.test(e.def), e.def); eq(e.bare, 'https://my-proxy.example.workers.dev/suggest'); eq(e.none, '');
  });
  await step('Only the 20 most recent sent notes are kept', async () => {
        const r = await page.evaluate(async () => { const m = await import('./js/suggest.js'); for (let i = 0; i < 24; i++) await m.submitSuggestion('bulk ' + i); return m.suggestions().map((x) => x.status + ':' + x.text.slice(0, 12) ); });
    assert(r.length === 20 && r.every((x) => /^sent:/.test(x)), 'kept ' + r.length + ' ' + JSON.stringify(r.slice(0, 3)));
  });
  await step('No page errors', async () => { assert(!errs.length, errs.slice(0, 3).join(' | ')); });
  const bad = results.filter((r) => !r[0]); console.log(`\n${results.length - bad.length}/${results.length} passed`); await browser.close(); process.exit(bad.length ? 1 : 0);
})();

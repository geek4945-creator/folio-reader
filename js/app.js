import { h, $, $$, toast, sheet, confirmDlg } from './util.js';
import { settings, applyUI, THEMES, FONTS, FONT_MIN, FONT_MAX, FONT_STEP, clampPt } from './settings.js';
import { renderLibrary, importFiles } from './library.js';
import { renderCatalogs, resetCatalogs } from './catalogs.js';
import { onLibraryChange, getBooks, pruneSets } from './store.js';
import * as G from './google.js';
import { closeReader, currentReader } from './reader.js';

applyUI();
let tab = localStorage.getItem('folio.tab') || 'library';
const view = $('#view');

async function show(t) {
  tab = t; localStorage.setItem('folio.tab', t);
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  view.scrollTop = 0; view.dataset.screen = t;
  if (t === 'library') await renderLibrary(view);
  else if (t === 'catalogs') await renderCatalogs(view);
  else renderSettings();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'catalogs' && tab === 'catalogs') resetCatalogs(); show(b.dataset.tab); }));

$('#file-input').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await importFiles(files); });
onLibraryChange(() => { if (tab === 'library' && !currentReader() && !$('#overlay').children.length) renderLibrary(view); });
settings.onChange((p) => { if (tab === 'settings' && ('theme' in p)) renderSettings(); });

/* ---------- Settings tab ---------- */
function renderSettings() {
  view.replaceChildren();
  const s = settings.all();
  const num = h('input', { type: 'number', class: 'num', id: 'g-fs-num', min: FONT_MIN, max: FONT_MAX, step: FONT_STEP, value: s.fontSizePt });
  const range = h('input', { type: 'range', id: 'g-fs-range', min: FONT_MIN, max: FONT_MAX, step: FONT_STEP, value: s.fontSizePt });
  const setSize = (v) => { v = clampPt(v); num.value = range.value = v; settings.set({ fontSizePt: v }); };
  num.addEventListener('change', () => setSize(num.value)); range.addEventListener('input', () => setSize(range.value));
  const sample = h('p', { class: 'sample' }, 'The quick brown fox jumps over the lazy dog.');
  const updateSample = () => { const st = settings.all(); sample.style.fontSize = st.fontSizePt + 'pt'; sample.style.lineHeight = st.lineHeight; sample.style.fontFamily = FONTS[st.font].css || 'Georgia, serif'; };
  settings.onChange(updateSample); updateSample();

  view.append(
    h('header', { class: 'topbar' }, h('h1', null, 'Settings')),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'Account & sync'), accountBox()),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'Appearance'),
      h('p', { class: 'muted small' }, 'Global defaults for all books. You can override size, font, spacing and margins per book from the reader’s Aa menu.'),
      h('div', { class: 'themes' }, Object.entries(THEMES).map(([k, t]) => h('button', { class: 'swatch' + (s.theme === k ? ' on' : ''), 'data-theme-pick': k, style: { background: t.bg, color: t.fg, borderColor: t.accent }, onclick: () => settings.set({ theme: k }) || renderSettings() }, 'Aa', h('small', null, t.name)))),
      h('div', { class: 'row-ctl' }, h('label', null, 'Text size ', h('small', { class: 'muted' }, 'pt')), h('div', { class: 'stepper' }, h('button', { class: 'btn', onclick: () => setSize(+num.value - FONT_STEP) }, '−'), num, h('button', { class: 'btn', onclick: () => setSize(+num.value + FONT_STEP) }, '+'))), range,
      h('div', { class: 'row-ctl' }, h('label', null, 'Font')), h('select', { class: 'field', onchange: (e) => settings.set({ font: e.target.value }) }, Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: k === s.font }, f.name))),
      slider('Line spacing', 'lineHeight', 1, 2.4, 0.05, (v) => v.toFixed(2)), slider('Margins', 'margin', 0, 80, 2, (v) => v + ' px'),
      h('div', { class: 'row-ctl' }, h('label', null, 'Reading layout')),
      h('div', { class: 'seg wide' }, [['paginated', 'Pages'], ['scrolled', 'Scroll']].map(([v, n]) => h('button', { class: s.flow === v ? 'on' : '', onclick: () => { settings.set({ flow: v }); renderSettings(); } }, n))),
      sample),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'Network (CORS proxy)'),
      h('p', { class: 'muted small' }, 'Some catalogs (notably Project Gutenberg downloads) don’t allow browser downloads. Deploy the tiny proxy from /proxy and paste its URL here. Leave empty to connect directly.'),
      h('input', { class: 'field', id: 'proxy-url', type: 'url', placeholder: 'https://your-proxy.workers.dev/', value: s.proxyUrl, autocapitalize: 'none', onchange: (e) => { settings.set({ proxyUrl: e.target.value.trim() }); toast('Proxy saved'); } }),
      h('select', { class: 'field', id: 'proxy-mode', onchange: (e) => settings.set({ proxyMode: e.target.value }) }, [['fallback', 'Direct first, proxy if blocked'], ['always', 'Always use proxy'], ['never', 'Never use proxy']].map(([v, n]) => h('option', { value: v, selected: s.proxyMode === v }, n)))),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'About'),
      h('p', { class: 'muted small' }, 'Folio Reader — your books stay on this device (IndexedDB). Only reading state syncs if you sign in with Google. Legal sources only.'),
      h('button', { class: 'btn', onclick: async () => { const books = await getBooks(); toast(`${books.length} books · ${(books.reduce((a, b) => a + (b.size || 0), 0) / 1048576).toFixed(1)} MB stored`); } }, 'Storage usage'),
      ' ', h('button', { class: 'btn', onclick: () => navigator.storage?.persist?.().then((ok) => toast(ok ? 'Persistent storage granted' : 'Browser declined persistent storage')) }, 'Request persistent storage')));
}
function slider(label, key, min, max, step, fmt) {
  const v = settings.get(key); const out = h('span', { class: 'muted' }, fmt(+v));
  const i = h('input', { type: 'range', min, max, step, value: v, id: 'g-' + key, oninput: () => { out.textContent = fmt(+i.value); settings.set({ [key]: +i.value }); } });
  return h('div', null, h('div', { class: 'row-ctl' }, h('label', null, label + ' ', out)), i);
}

function accountBox() {
  const box = h('div', { class: 'account' });
  const draw = () => {
    box.replaceChildren(); const p = G.getProfile(); const st = G.getStatus(); const cid = G.getClientId();
    if (p) {
      box.append(h('div', { class: 'acct-row' }, p.picture ? h('img', { class: 'avatar', src: p.picture, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'avatar ph' }, (p.name || '?')[0]),
        h('div', { class: 'grow' }, h('strong', null, p.name), h('div', { class: 'muted small' }, p.email))),
        h('p', { class: 'muted small', id: 'sync-status' }, ({ syncing: 'Syncing…', error: 'Sync error: ' + st.message, 'needs-reauth': st.message, connected: st.lastSync ? 'Last synced ' + new Date(st.lastSync).toLocaleString() : 'Connected' })[st.state] || ''),
        h('div', { class: 'row-actions wrap' },
          h('button', { class: 'btn primary', id: 'sync-now', onclick: async () => { try { const r = await G.syncNow(); toast(r && r.pending ? `Synced · ${r.pending} books’ state waiting for their files` : 'Synced'); } catch (e) { toast(e.message, 5000); } } }, 'Sync now'),
          st.state === 'needs-reauth' ? h('button', { class: 'btn', onclick: () => G.signIn().then(draw).catch((e) => toast(e.message)) }, 'Reconnect') : null,
          h('button', { class: 'btn', id: 'sign-out', onclick: async () => { G.signOut(); draw(); toast('Signed out on this device'); } }, 'Sign out'),
          h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('Disconnect Google?', 'Revokes Folio’s access to your Google account. Synced data stays in your Drive app data until you remove it in Google account settings.', 'Disconnect', true)) { await G.disconnect(); draw(); } } }, 'Disconnect')),
        h('div', { class: 'row-actions wrap' }, h('button', { class: 'btn', id: 'enable-drive', onclick: async () => { try { await G.enableDriveBrowse(); toast('Drive access enabled'); draw(); } catch (e) { toast(e.message, 5000); } } }, G.canBrowseDrive() ? 'Drive browse access ✓ (re-grant)' : 'Allow browsing my Drive for EPUBs')),
        h('p', { class: 'muted small' }, 'Syncs settings, shelves, sets, custom order, per-book reading settings, positions and bookmarks to a private app-data folder in your Drive. Book files are not uploaded.'));
    } else {
      box.append(h('p', { class: 'muted small' }, 'Sign in with Google to back up and sync your shelves, sets, reading positions and settings across devices (stored privately in your Drive’s hidden app-data folder).'),
        h('button', { class: 'btn primary', id: 'sign-in', disabled: !cid, onclick: () => G.signIn().then(() => { draw(); G.syncNow({ quiet: true }); }).catch((e) => toast(e.message, 5000)) }, 'Sign in with Google'),
        h('details', { open: !cid }, h('summary', null, 'Google OAuth Client ID'), h('p', { class: 'muted small' }, 'Create a Web OAuth client (see README → Google sign-in) and paste its Client ID. Add this site’s origin as an authorized JavaScript origin.'),
          h('input', { class: 'field', id: 'gcid', placeholder: 'xxxxxxxx.apps.googleusercontent.com', value: cid, autocapitalize: 'none', onchange: (e) => { G.setClientId(e.target.value); draw(); } })));
    }
  };
  draw(); G.onSyncStatus(() => { if (tab === 'settings' && box.isConnected) draw(); });
  return box;
}

/* ---------- drag & drop EPUBs onto the window (desktop / iPad) ---------- */
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip');
  if (!files.length) return; e.preventDefault(); await importFiles(files); show('library');
});

/* ---------- boot ---------- */
G.initSync();
show(tab);
navigator.storage?.persist?.();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
window.addEventListener('popstate', () => { if (currentReader()) closeReader(); });
// Test hook
window.__folio = { show, settings, G };

import { syncDetails, statusLine } from './syncui.js';
import { suggestSection, initSuggest } from './suggest.js';
import { appUpdateSection, initAppUpdate } from './appupdate.js';
import { backupSettingsSection } from './backupui.js';
import { h, $, $$, toast, sheet, confirmDlg, initClearButtons } from './util.js';
import { settings, applyUI, THEMES, FONTS, FONT_MIN, FONT_MAX, FONT_STEP, clampPt, SORT_FIELDS, setDefaultSort, resetAllSorts, dirWord } from './settings.js';
import { KINDLE_TYPE_RE } from './kindle.js';
import { renderLibrary, importFiles, deleteAllBooksFlow } from './library.js';
import { renderCatalogs, resetCatalogs } from './catalogs.js';
import { renderAudiobooks, handleAudioFiles, collectDropped, dropLooksAudio } from './audiobooks.js';
import { onAudioChange } from './audiostore.js';
import { initPlayerUI, playerOpen } from './audioplayer.js';
import { onLibraryChange, getBooks, pruneSets } from './store.js';
import * as G from './google.js';
import { closeReader, currentReader, flushPosition, openReader } from './reader.js';
import { initUpdates } from './update.js';
import { openPublicLibraryGuide, openDrmFreeHelp } from './publib.js';
import { initInstall, installMode, installLabel, startInstall } from './install.js';
import { initFullscreen, fsButton } from './fullscreen.js';
import { isInstalledApp } from './env.js';
import { normalizeUrl } from './net.js';
import { enrichSettingsSection, openFixMissing } from './enrich.js';
import { footerToggles, scrubToggle } from './pages.js';
import { initViewport } from './viewport.js';
import { initNav, noteTab } from './nav.js';
import { renderReadingNow } from './readingnow.js';
import { PINCH_LABELS } from './pinch.js';
import { initHold, holdSeconds, HOLD_MIN, HOLD_MAX } from './hold.js';
import { wordHoldSeconds, HOLD_MIN as WHOLD_MIN, HOLD_MAX as WHOLD_MAX, highlightSupported } from './wordbubble.js';
import { openAllWords } from './glossaryui.js';
import * as Dict from './dict.js';
import { pairSettingsSection, pairNotify } from './findplace.js';
import { startAutoPair } from './links.js';
import { handleSharedCover } from './covers.js';

applyUI();
let tab = localStorage.getItem('folio.tab') || 'library';
const view = $('#view');

async function show(t) {
  noteTab(t); tab = t; localStorage.setItem('folio.tab', t);
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  view.scrollTop = 0; view.dataset.screen = t;
  if (t === 'library') await renderLibrary(view);
  else if (t === 'reading') await renderReadingNow(view);
  else if (t === 'audiobooks') await renderAudiobooks(view);
  else if (t === 'catalogs') await renderCatalogs(view);
  else renderSettings();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'catalogs' && tab === 'catalogs') resetCatalogs(); show(b.dataset.tab); }));

$('#file-input').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await importFiles(files); });
$('#audio-input').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await handleAudioFiles(files); });
$('#audio-folder-input').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) await handleAudioFiles(files, { ask: false }); });
onAudioChange(() => { if (tab === 'audiobooks' && !$('#overlay').children.length) renderAudiobooks(view); });
onLibraryChange(() => { if (tab === 'library' && !currentReader() && !$('#overlay').children.length) renderLibrary(view); else if (tab === 'reading' && !currentReader() && !$('#overlay').children.length) renderReadingNow(view); });
window.addEventListener('folio-library-refresh', () => { if (tab === 'reading' && !currentReader()) renderReadingNow(view); });
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
      h('div', { class: 'row-ctl' }, h('label', null, 'Pinch sensitivity ', h('small', { class: 'muted' }, 'pinch in the reader changes the text size')), h('div', { class: 'seg wide', id: 'pinch-seg' }, PINCH_LABELS.map(([v, n]) => h('button', { class: s.pinchSens === v ? 'on' : '', 'data-pinch': v, onclick: () => { settings.set({ pinchSens: v }); renderSettings(); } }, n)))),
      sample),
    h('section', { class: 'pad card-sec', id: 'sec-footer' }, h('h3', null, 'Reader footer'),
      h('p', { class: 'muted small' }, 'The line at the bottom of the reader. EPUB page counts follow your text size, margins and line spacing; PDFs use their real page numbers.'),
      ...footerToggles(), scrubToggle()),
    h('section', { class: 'pad card-sec', id: 'sec-display' }, h('h3', null, 'App & display'),
      isInstalledApp() ? h('p', { class: 'muted small' }, 'You’re running Folio as an installed app, already full screen.') : h('p', { class: 'muted small' }, 'Put Folio on your Home Screen for an app icon and full-screen reading, or hide the browser bars with Full screen.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', id: 'settings-install', 'data-install-btn': '1', hidden: !installMode(), onclick: startInstall }, installLabel()),
        fsButton({ class: 'btn', id: 'settings-fs' }))),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'Help: getting books'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'help-public-library', onclick: () => openPublicLibraryGuide() }, 'Public library guide'), h('button', { class: 'btn', id: 'help-drmfree', onclick: () => openDrmFreeHelp() }, 'Where to get DRM-free books'))),
    h('section', { class: 'pad card-sec', id: 'sec-hold' }, h('h3', null, 'Press and hold'),
      h('p', { class: 'muted small' }, 'Press and hold a book (or audiobook) in the Library for this long to open its ⋯ menu. Moving your finger, scrolling or letting go cancels it.'),
      (() => { const out = h('span', { class: 'muted', id: 'hold-sec-val' }, holdSeconds().toFixed(1) + ' s');
        const r = h('input', { type: 'range', id: 'hold-sec', min: HOLD_MIN, max: HOLD_MAX, step: 0.5, value: holdSeconds(), oninput: (e) => { out.textContent = (+e.target.value).toFixed(1) + ' s'; settings.set({ holdSec: +e.target.value }); } });
        return h('div', { class: 'row-ctl' }, h('label', { for: 'hold-sec' }, 'Hold time'), r, out); })()),
    h('section', { class: 'pad card-sec', id: 'sec-words' }, h('h3', null, 'Word lookup & glossary'),
      h('p', { class: 'muted small' }, 'In the reader, press and hold a word for its definition (the book’s own glossary is checked first). Save words to the book, keep a glossary per book, and look words up offline once they’ve been seen.'),
      h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', id: 'word-lookup', checked: !!s.wordLookup, onchange: (e) => settings.set({ wordLookup: e.target.checked }) }), h('span', null, 'Press and hold a word to look it up')),
      (() => { const out = h('span', { class: 'muted', id: 'word-hold-val' }, wordHoldSeconds().toFixed(1) + ' s');
        const r = h('input', { type: 'range', id: 'word-hold', min: WHOLD_MIN, max: WHOLD_MAX, step: 0.1, value: wordHoldSeconds(), oninput: (e) => { out.textContent = (+e.target.value).toFixed(1) + ' s'; settings.set({ wordHoldSec: +e.target.value }); } });
        return h('div', { class: 'row-ctl' }, h('label', { for: 'word-hold' }, 'Hold time'), r, out); })(),
      h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', id: 'gl-highlight', checked: !!s.glossaryHighlight, onchange: (e) => settings.set({ glossaryHighlight: e.target.checked }) }), h('span', null, 'Underline glossary terms in the text', h('small', { class: 'muted' }, highlightSupported(window) ? '' : ' — not supported by this browser'))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', id: 'saved-words-all', onclick: () => openAllWords() }, 'Saved words & glossaries'),
        h('button', { class: 'btn', id: 'dict-clear', onclick: async () => { const n = await Dict.cacheSize(); await Dict.clearCache(); toast(n ? 'Cleared ' + n + ' saved definition' + (n === 1 ? '' : 's') : 'Nothing to clear'); } }, 'Clear offline definitions'))),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'Library sorting'),
      h('p', { class: 'muted small' }, 'Each shelf (All, Currently Reading, Want to Read, Finished, your own shelves) and each set remembers its own sort. This default applies to any that don’t have one yet.'),
      h('div', { class: 'row-ctl' }, h('label', null, 'Default sort'),
        h('div', { class: 'row-actions' },
          h('select', { class: 'field', id: 'default-sort-field', onchange: (e) => { setDefaultSort({ field: e.target.value }); renderSettings(); } }, SORT_FIELDS.filter(([k]) => k !== 'custom').map(([v, n]) => h('option', { value: v, selected: v === s.defaultSort.field }, n))),
          h('button', { class: 'btn', id: 'default-sort-dir', 'data-dir': s.defaultSort.dir, onclick: () => { setDefaultSort({ dir: s.defaultSort.dir === 'asc' ? 'desc' : 'asc' }); renderSettings(); } }, (s.defaultSort.dir === 'asc' ? '↑ ' : '↓ ') + dirWord(s.defaultSort.field, s.defaultSort.dir)))),
      h('button', { class: 'btn', id: 'reset-all-sorts', onclick: async () => { if (await confirmDlg('Reset all shelves?', 'Every shelf and set will use the default sort again. Custom drag orders are kept for when you switch back to Custom order.', 'Reset', false)) { resetAllSorts(); toast('All shelves use the default sort'); renderSettings(); } } }, 'Reset all shelves to default sort')),
    enrichSettingsSection(() => openFixMissing()),
    pairSettingsSection(),
    backupSettingsSection(() => renderSettings()),
    h('section', { class: 'pad card-sec', id: 'sec-library' }, h('h3', null, 'Library'),
      h('p', { class: 'muted small' }, 'Remove every book from Folio on this device. Your original files on the device or in Google Drive are never touched. To delete a few books, use Select in the Library.'),
      h('button', { class: 'btn danger', id: 'settings-delete-all', onclick: () => deleteAllBooksFlow() }, 'Delete all books…')),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'Network (CORS proxy)'),
      h('p', { class: 'muted small' }, 'Some catalogs (notably Project Gutenberg downloads) don’t allow browser downloads. Deploy the tiny proxy from /proxy and paste its URL here. Leave empty to connect directly.'),
      h('input', { class: 'field', id: 'proxy-url', type: 'text', inputmode: 'url', spellcheck: 'false', placeholder: 'https://your-proxy.workers.dev/', value: s.proxyUrl, autocapitalize: 'none', onchange: (e) => { const v = e.target.value.trim(); if (!v) { settings.set({ proxyUrl: '' }); toast('Proxy cleared'); return; } try { const u = normalizeUrl(v); e.target.value = u; settings.set({ proxyUrl: u }); toast('Proxy saved'); } catch (err) { toast(err.message, 4500); } } }),
      h('select', { class: 'field', id: 'proxy-mode', onchange: (e) => settings.set({ proxyMode: e.target.value }) }, [['fallback', 'Direct first, proxy if blocked'], ['always', 'Always use proxy'], ['never', 'Never use proxy']].map(([v, n]) => h('option', { value: v, selected: s.proxyMode === v }, n)))),
    h('section', { class: 'pad card-sec' }, h('h3', null, 'About'),
      h('p', { class: 'muted small' }, 'Folio Reader — your books stay on this device (IndexedDB). Only reading state syncs if you sign in with Google. Legal sources only.'),
      h('button', { class: 'btn', onclick: async () => { const books = await getBooks(); toast(`${books.length} books · ${(books.reduce((a, b) => a + (b.size || 0), 0) / 1048576).toFixed(1)} MB stored`); } }, 'Storage usage'),
      ' ', h('button', { class: 'btn', onclick: () => navigator.storage?.persist?.().then((ok) => toast(ok ? 'Persistent storage granted' : 'Browser declined persistent storage')) }, 'Request persistent storage')),
    appUpdateSection(),
    suggestSection());
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
        h('p', { class: 'muted small', id: 'sync-status' }, statusLine(st)),
        h('div', { class: 'row-actions wrap' },
          h('button', { class: 'btn primary', id: 'sync-now', onclick: async () => { try { const r = await G.syncNow({ force: true }); toast(r && r.pending ? `Synced · ${r.pending} books’ state waiting for their files` : 'Synced'); } catch (e) { toast(e.message, 5000); } } }, 'Sync now'),
          st.state === 'needs-reauth' ? h('button', { class: 'btn', onclick: () => G.signIn().then(draw).catch((e) => toast(e.message)) }, 'Reconnect') : null,
          h('button', { class: 'btn', id: 'sign-out', onclick: async () => { G.signOut(); draw(); toast('Signed out on this device'); } }, 'Sign out'),
          h('button', { class: 'btn danger', onclick: async () => { if (await confirmDlg('Disconnect Google?', 'Revokes Folio’s access to your Google account. Synced data stays in your Drive app data until you remove it in Google account settings.', 'Disconnect', true)) { await G.disconnect(); draw(); } } }, 'Disconnect')),
        syncDetails(draw),
        h('div', { class: 'row-actions wrap' }, h('button', { class: 'btn', id: 'enable-drive', onclick: async () => { try { await G.enableDriveBrowse(); toast('Drive access enabled'); draw(); } catch (e) { toast(e.message, 5000); } } }, G.canBrowseDrive() ? 'Drive browse access ✓ (re-grant)' : 'Allow browsing my Drive for EPUBs')),
        h('p', { class: 'muted small' }, 'Syncs settings, shelves, sets, custom order, per-book reading settings, positions and bookmarks to a private app-data folder in your Drive. Book files are not uploaded.'));
    } else {
      box.append(h('p', { class: 'muted small' }, 'Sign in with Google to back up and sync your shelves, sets, reading positions and settings across devices (stored privately in your Drive’s hidden app-data folder).'),
        G.signInUnavailableHere() ? h('div', { class: 'plib-warn', id: 'android-signin-note' }, h('strong', null, 'Sign in from your browser. '), 'Google doesn’t allow sign-in inside the Android app. Open Folio in Chrome to sign in and sync: ', h('a', { href: G.webAppUrl(), target: '_blank', rel: 'noopener' }, G.webAppUrl().replace(/^https:\/\//, ''))) : null,
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
  const dt = e.dataTransfer; if (!dt) return;
  const hasDir = [...(dt.items || [])].some((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()?.isDirectory);
  if (hasDir || dropLooksAudio(dt)) { e.preventDefault(); const files = await collectDropped(dt); show('audiobooks'); await handleAudioFiles(files, { ask: !hasDir }); return; }
  const files = [...(dt.files || [])].filter((f) => /\.(epub|pdf|mobi|azw3?|kf8)$/i.test(f.name) || f.type === 'application/epub+zip' || f.type === 'application/pdf' || KINDLE_TYPE_RE.test(f.type));
  if (!files.length) return; e.preventDefault(); await importFiles(files); show('library');
});

/* ---------- boot ---------- */
initViewport(); initHold(); setTimeout(() => import('./backup.js').then((m) => m.expireUndo()).catch(() => {}), 4000);
window.addEventListener('db-blocked', () => toast('Folio is finishing an update. Close any other Folio tab or window and reopen the app.', 8000));
G.initSync(); initSuggest(); initAppUpdate();
show(tab); initNav({ getTab: () => tab, show });
initInstall(); initFullscreen(); initPlayerUI(); startAutoPair(pairNotify);
if (new URLSearchParams(location.search).get('share') === 'cover') setTimeout(() => handleSharedCover(), 400);
navigator.storage?.persist?.();
initUpdates({ readerOpen: () => { const r = currentReader(); return r && r.book ? r.book.id : null; }, flush: flushPosition, reopen: (id) => openReader(id) });   // v0.5.16: non-disruptive updates (update.js)
// Test hook
initClearButtons();
window.__folio = { show, settings, G };

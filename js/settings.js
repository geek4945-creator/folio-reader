// Appearance + app preferences, persisted in localStorage and applied to app UI and reader.
export const THEMES = {
  light:     { name: 'Light',     bg: '#ffffff', fg: '#1b1b1f', card: '#f2f2f6', muted: '#6b6b76', border: '#d9d9e0', accent: '#2f6df6', bar: '#f8f8fb', dark: false },
  sepia:     { name: 'Sepia',     bg: '#f4ecd8', fg: '#5b4636', card: '#eadfc4', muted: '#8a7560', border: '#d8c9a8', accent: '#a0522d', bar: '#efe5cd', dark: false },
  paper:     { name: 'Paper',     bg: '#f7f3ea', fg: '#2b2b2b', card: '#ece6d6', muted: '#76706a', border: '#ddd5c2', accent: '#7a5c2e', bar: '#f1ecdf', dark: false },
  solarized: { name: 'Solarized', bg: '#fdf6e3', fg: '#586e75', card: '#eee8d5', muted: '#93a1a1', border: '#e0d9c1', accent: '#268bd2', bar: '#f5eed9', dark: false },
  dark:      { name: 'Dark',      bg: '#1f2023', fg: '#dcdce0', card: '#2b2c31', muted: '#9a9aa5', border: '#3a3b42', accent: '#6ea1ff', bar: '#25262a', dark: true },
  ocean:     { name: 'Ocean',     bg: '#16232e', fg: '#cfe0ec', card: '#1f3342', muted: '#86a1b5', border: '#2b4559', accent: '#5cc8ff', bar: '#1a2b38', dark: true },
  forest:    { name: 'Forest',    bg: '#1c261f', fg: '#d3e0d0', card: '#26352a', muted: '#8fa58d', border: '#34483a', accent: '#8bd17c', bar: '#202d24', dark: true },
  night:     { name: 'Night',     bg: '#000000', fg: '#c8c8c8', card: '#111114', muted: '#808088', border: '#222226', accent: '#8ab4ff', bar: '#0a0a0c', dark: true },
};

export const FONTS = {
  publisher: { name: 'Publisher default', css: '' },
  georgia:   { name: 'Georgia',     css: 'Georgia, "Times New Roman", serif' },
  palatino:  { name: 'Palatino',    css: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  iowan:     { name: 'Iowan Old Style', css: '"Iowan Old Style", "Palatino Linotype", Georgia, serif' },
  system:    { name: 'San Francisco', css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  avenir:    { name: 'Avenir / Helvetica', css: '"Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif' },
  mono:      { name: 'Monospace',   css: 'Menlo, Consolas, "Courier New", monospace' },
};

export const DEFAULTS = {
  theme: 'light',
  fontSizePt: 15,       // points, 8-60, 0.5 steps (global default; books may override)
  font: 'publisher',
  lineHeight: 1.5,
  margin: 24,           // px, left/right
  flow: 'scrolled',     // 'paginated' | 'scrolled' (v0.5.2: continuous scroll is the default; a stored choice always wins)
  flowChosen: false,    // true once the user picked Pages / Scroll themselves (device-only; used so a default is never synced over someone's explicit choice)
  pdfInvert: true,      // PDF: invert page colors in dark themes
  tapZones: 'on',       // 'on' | 'off' | 'inverted'
  pinchSens: 'slow',    // reader pinch text-size sensitivity: 'slow' | 'normal' | 'fast' (device-only)
  wordLookup: true,     // press and hold a word in the reader → definition bubble (v0.5.6)
  wordHoldSec: 0.7,     // how long to hold on a word (0.3–3 s)
  glossaryHighlight: false,   // underline glossary terms of the open book in the text (needs a browser with the CSS Custom Highlight API)
  holdSec: 4,           // press-and-hold on a Library / Audiobooks tile opens its ⋯ menu after this many seconds (0.5–5; device-only)
  autoPair: true,       // link audiobooks with their ebooks automatically when the match is very confident (≥ 85%)
  autoEnrich: false,    // fill in missing metadata / covers on import (Open Library + Google Books, high-confidence matches only)
  view: 'grid',         // library view: grid | list
  sort: 'recent',       // legacy global sort (kept for old synced data; see sorts/defaultSort)
  lastAutoSort: 'recent',
  defaultSort: { field: 'recent', dir: 'desc' },   // applies to any shelf / set without its own saved sort
  publicLibrary: null,  // chosen OverDrive/Libby library: { name, key, fid, city, region }
  sorts: {},            // per context: 'shelf:all' | 'shelf:reading|want|finished' | 'shelf:<shelfId>' | 'set:<setId>' → { field, dir }
  setGroups: {},        // v0.5.8, per view: 'shelf:all' | 'shelf:<status|shelfId>' → true (series grouped into sets) | false (books shown individually); absent = the global groupSets default
  groupBy: 'status',    // All view: 'status' | 'none' (flat) | 'series' | 'author' | 'type'
  footerPages: true,    // reader footer: "Page X of Y"
  footerLeft: true,     // reader footer: "N pages left in chapter"
  hideScrub: false,     // hide the reading-progress slider at the bottom of the reader (percent, pages left and Page X of Y stay); per-book override like the other reading prefs (v0.5.8)
  groupSets: true,
  audioChip: 'all',     // Audiobooks tab: selected shelf chip (device-only)
  audioSpeed: 1,        // last playback speed (0.5-3x); each audiobook also remembers its own
  showFinished: true,   // show Finished as its own section in the All view
  chip: 'all',          // selected shelf chip
  proxyUrl: (typeof window !== 'undefined' && window.FOLIO_CONFIG && window.FOLIO_CONFIG.proxyUrl) || '',
  setSort: 'volume',
  proxyMode: 'fallback', // 'fallback' (direct first) | 'always' | 'never'
};

export const SYNCED = ['theme', 'fontSizePt', 'font', 'lineHeight', 'margin', 'flow', 'tapZones', 'view', 'sort', 'lastAutoSort', 'groupSets', 'setGroups', 'groupBy', 'footerPages', 'footerLeft', 'hideScrub', 'showFinished', 'setSort', 'defaultSort', 'sorts', 'publicLibrary', 'autoEnrich', 'autoPair', 'wordLookup', 'wordHoldSec', 'glossaryHighlight'];
/* ---------- cross-device sync of settings (v0.5.5): every preference is synced with its own last-write-wins stamp ---------- */
/** Never synced: they describe this device / this moment rather than a preference. */
export const DEVICE_ONLY = ['flowChosen', 'chip', 'audioChip', 'proxyUrl', 'proxyMode', 'fullscreen'];
/** Groups the user can keep device-specific in Settings → Sync (e.g. different page flow or pinch speed on a phone and a tablet). */
export const SETTING_GROUPS = [
  { id: 'appearance', name: 'Appearance', hint: 'theme, font, text size, line spacing, margins', keys: ['theme', 'fontSizePt', 'font', 'lineHeight', 'margin', 'pdfInvert'] },
  { id: 'reading', name: 'Reading behaviour', hint: 'Pages / Scroll, tap zones, footer, pinch, hold time', keys: ['flow', 'tapZones', 'footerPages', 'footerLeft', 'hideScrub', 'pinchSens', 'holdSec', 'wordLookup', 'wordHoldSec', 'glossaryHighlight'] },
  { id: 'library', name: 'Library view & sorting', hint: 'grid / list, sort orders, group by, series sets', keys: ['view', 'sort', 'lastAutoSort', 'defaultSort', 'sorts', 'groupBy', 'groupSets', 'setGroups', 'showFinished', 'setSort'] },
  { id: 'audio', name: 'Audiobooks', hint: 'playback speed', keys: ['audioSpeed'] },
  { id: 'other', name: 'Other', hint: 'public library, auto-link, auto-enrich', keys: ['publicLibrary', 'autoEnrich', 'autoPair'] },
];
export const NESTED = ['sorts', 'setGroups'];   // object-valued settings whose entries are stamped one by one ('sorts/shelf:abc')
const KEYAT = 'folio.settings.keyAt', EXCL = 'folio.sync.deviceOnly';
const readJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
/** Group ids the user keeps device-specific. */
export const deviceOnlyGroups = () => readJ(EXCL, []);
export const setDeviceOnlyGroups = (ids) => localStorage.setItem(EXCL, JSON.stringify(ids));
const baseKeyOf = (flat) => flat.split('/')[0];
/** Setting keys that take part in sync right now. */
export function syncedKeys() {
  const off = new Set([...DEVICE_ONLY, ...SETTING_GROUPS.filter((g) => deviceOnlyGroups().includes(g.id)).flatMap((g) => g.keys)]);
  return Object.keys(DEFAULTS).filter((k) => !off.has(k));
}
let state = { ...DEFAULTS };
try { Object.assign(state, JSON.parse(localStorage.getItem('folio.settings') || '{}')); } catch { /* ignore */ }
const listeners = new Set();

const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Per-key stamps: { key | 'sorts/<ctx>': epoch ms }. Keys that have none fall back to the legacy single stamp (folio.settings.at). */
export const settingStamps = () => readJ(KEYAT, {});
function stampKeys(patch, before) {
  const at = settingStamps(), now = Date.now(); let ch = false;
  for (const [k, v] of Object.entries(patch)) {
    if (NESTED.includes(k)) { const a = before[k] || {}, b = v || {}; for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) if (!jeq(a[sub], b[sub])) { at[k + '/' + sub] = now; ch = true; } }
    else if (!jeq(before[k], v)) { at[k] = now; ch = true; }
  }
  if (ch) localStorage.setItem(KEYAT, JSON.stringify(at));
}
export const settings = {
  get: (k) => state[k],
  all: () => ({ ...state }),
  updatedAt: () => +(localStorage.getItem('folio.settings.at') || 0),
  set(patch, opts = {}) {
    if (!opts.remote) stampKeys(patch, state);
    Object.assign(state, patch);
    if ('flow' in patch && !opts.remote) state.flowChosen = true;
    if (!opts.remote && Object.keys(patch).some((k) => SYNCED.includes(k) || !DEVICE_ONLY.includes(k))) localStorage.setItem('folio.settings.at', String(Date.now()));
    try { localStorage.setItem('folio.settings', JSON.stringify(state)); } catch { /* quota */ }
    applyUI();
    listeners.forEach((fn) => fn(patch));
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

/* ---------- sorting: per shelf / set, with a default ---------- */
export const GROUP_OPTIONS = [['status', 'Status (Reading / Want / Finished)'], ['none', 'None (one flat list)'], ['series', 'Series'], ['author', 'Author'], ['type', 'File type']];
export const SORT_FIELDS = [['recent', 'Recently read'], ['added', 'Recently added'], ['title', 'Title'], ['author', 'Author'], ['series', 'Series'], ['progress', 'Reading progress'], ['type', 'File type'], ['custom', 'Custom order']];
export const SET_SORT_FIELDS = [['volume', 'Volume order'], ['title', 'Title'], ['added', 'Recently added'], ['custom', 'Custom order']];
export const AUDIO_SORT_FIELDS = [['recent', 'Recently played'], ['added', 'Recently added'], ['title', 'Title'], ['author', 'Author'], ['progress', 'Listening progress'], ['duration', 'Length'], ['custom', 'Custom order']];
export const DEFAULT_DIR = { duration: 'desc', recent: 'desc', added: 'desc', progress: 'desc', title: 'asc', author: 'asc', series: 'asc', type: 'asc', volume: 'asc', custom: 'asc' };
export const dirWord = (field, dir) => ({ title: dir === 'asc' ? 'A–Z' : 'Z–A', author: dir === 'asc' ? 'A–Z' : 'Z–A', series: dir === 'asc' ? 'A–Z' : 'Z–A', type: dir === 'asc' ? 'A–Z' : 'Z–A', volume: dir === 'asc' ? '1→N' : 'N→1', recent: dir === 'desc' ? 'newest first' : 'oldest first', added: dir === 'desc' ? 'newest first' : 'oldest first', progress: dir === 'desc' ? 'most read first' : 'least read first', duration: dir === 'desc' ? 'longest first' : 'shortest first' }[field] || dir);
/** Effective sort for a context ('shelf:all', 'shelf:<id>', 'set:<id>'): its own saved sort, else the default sort. */
export function getSort(ctxKey) {
  const isSet = ctxKey.startsWith('set:'); const own = state.sorts && state.sorts[ctxKey]; const isAudio = ctxKey.startsWith('audio:');
  const valid = (f) => (isSet ? SET_SORT_FIELDS : isAudio ? AUDIO_SORT_FIELDS : SORT_FIELDS).some(([k]) => k === f);
  if (own && valid(own.field)) return { field: own.field, dir: own.dir || DEFAULT_DIR[own.field], own: true };
  const d = state.defaultSort || { field: 'recent', dir: 'desc' };
  if (valid(d.field) && d.field !== 'custom') return { field: d.field, dir: d.dir || DEFAULT_DIR[d.field], own: false };
  return { field: isSet ? 'volume' : 'recent', dir: DEFAULT_DIR[isSet ? 'volume' : 'recent'], own: false };
}
export function setSort(ctxKey, patch) {
  const cur = getSort(ctxKey); const next = { field: patch.field || cur.field, dir: patch.dir || (patch.field ? DEFAULT_DIR[patch.field] : cur.dir) };
  settings.set({ sorts: { ...(state.sorts || {}), [ctxKey]: next } });
}
export function clearSort(ctxKey) { const o = { ...(state.sorts || {}) }; delete o[ctxKey]; settings.set({ sorts: o }); }
export function resetAllSorts() { settings.set({ sorts: {} }); }
/** Are series grouped into set tiles in this view ('shelf:all', 'shelf:finished', 'shelf:<id>')? Its own choice, else the global default (groupSets). */
export function setsGrouped(ctxKey) { const o = (state.setGroups || {})[ctxKey]; return o == null ? !!state.groupSets : !!o; }
export function setSetsGrouped(ctxKey, v) { const o = { ...(state.setGroups || {}) }; if (v == null) delete o[ctxKey]; else o[ctxKey] = !!v; settings.set({ setGroups: o }); }
export function setDefaultSort(patch) { const d = state.defaultSort || { field: 'recent', dir: 'desc' }; const field = patch.field || d.field; settings.set({ defaultSort: { field, dir: patch.dir || (patch.field ? DEFAULT_DIR[field] : d.dir) } }); }

try { const saved = JSON.parse(localStorage.getItem('folio.settings') || '{}'); if (!saved.defaultSort && saved.sort && saved.sort !== 'custom' && DEFAULT_DIR[saved.sort]) state.defaultSort = { field: saved.sort, dir: DEFAULT_DIR[saved.sort] }; } catch { /* ignore */ }
export const FONT_MIN = 8, FONT_MAX = 60, FONT_STEP = 0.5;
export const clampPt = (v) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round((Number(v) || 15) * 2) / 2));

export function applyUI() {
  const t = THEMES[state.theme] || THEMES.light;
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  const v = { bg: t.bg, fg: t.fg, card: t.card, muted: t.muted, border: t.border, accent: t.accent, bar: t.bar };
  for (const [k, val] of Object.entries(v)) root.style.setProperty('--' + k, val);
  root.style.colorScheme = t.dark ? 'dark' : 'light';
  // UI text scales gently with the reading size preference.
  root.style.fontSize = Math.round(16 * Math.min(1.35, Math.max(0.9, state.fontSizePt / 15))) + 'px';
  const meta = document.getElementById('meta-theme');
  if (meta) meta.content = t.bar;
}

/* One-time migration (v0.5.5): settings changed before per-key stamps existed get the old single stamp, so they still beat older values on other devices. */
try {
  if (localStorage.getItem(KEYAT) === null) {
    const legacy = +(localStorage.getItem('folio.settings.at') || 0), at = {};
    if (legacy) for (const k of Object.keys(DEFAULTS)) { if (NESTED.includes(k)) { for (const c of Object.keys(state[k] || {})) at[k + '/' + c] = legacy; } else if (!jeq(state[k], DEFAULTS[k])) at[k] = legacy; }
    localStorage.setItem(KEYAT, JSON.stringify(at));
  }
} catch { /* ignore */ }

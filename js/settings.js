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
  flow: 'paginated',    // 'paginated' | 'scrolled'
  tapZones: 'on',       // 'on' | 'off' | 'inverted'
  view: 'grid',         // library view: grid | list
  sort: 'recent',       // title | author | recent | custom
  lastAutoSort: 'recent',
  groupSets: true,
  showFinished: true,   // show Finished as its own section in the All view
  chip: 'all',          // selected shelf chip
  proxyUrl: (typeof window !== 'undefined' && window.FOLIO_CONFIG && window.FOLIO_CONFIG.proxyUrl) || '',
  setSort: 'volume',
  proxyMode: 'fallback', // 'fallback' (direct first) | 'always' | 'never'
};

export const SYNCED = ['theme', 'fontSizePt', 'font', 'lineHeight', 'margin', 'flow', 'tapZones', 'view', 'sort', 'lastAutoSort', 'groupSets', 'showFinished', 'setSort'];
let state = { ...DEFAULTS };
try { Object.assign(state, JSON.parse(localStorage.getItem('folio.settings') || '{}')); } catch { /* ignore */ }
const listeners = new Set();

export const settings = {
  get: (k) => state[k],
  all: () => ({ ...state }),
  updatedAt: () => +(localStorage.getItem('folio.settings.at') || 0),
  set(patch, opts = {}) {
    Object.assign(state, patch);
    if (!opts.remote && Object.keys(patch).some((k) => SYNCED.includes(k))) localStorage.setItem('folio.settings.at', String(Date.now()));
    try { localStorage.setItem('folio.settings', JSON.stringify(state)); } catch { /* quota */ }
    applyUI();
    listeners.forEach((fn) => fn(patch));
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

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

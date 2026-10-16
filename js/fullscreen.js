// Full screen toggle (Fullscreen API with webkit fallback). Hidden in installed / Capacitor mode.
import { h, toast, $ } from './util.js';
import { isIOS, isInstalledApp } from './env.js';
import { openInstallGuide } from './install.js';

const root = () => document.documentElement;
export const fsSupported = () => !!(root().requestFullscreen || root().webkitRequestFullscreen) && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true);
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
/** 'toggle' (real fullscreen), 'guide' (iPhone Safari: not supported → Home Screen guide), or null (hidden). */
export function fsMode() {
  if (isInstalledApp()) return null;
  if (fsSupported()) return 'toggle';
  return isIOS() ? 'guide' : null;
}
export async function toggleFullscreen() {
  const m = fsMode();
  if (m === 'guide') { toast('Full screen isn’t available in iPhone Safari. Add Folio to your Home Screen for a full-screen app.', 5200); openInstallGuide(); return; }
  if (m !== 'toggle') return;
  try {
    if (isFullscreen()) await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
    else { const r = root(); await (r.requestFullscreen ? r.requestFullscreen({ navigationUI: 'hide' }) : r.webkitRequestFullscreen()); }
  } catch (e) { toast('Full screen was blocked by the browser: ' + (e.message || e)); }
}
/** A button wired to the toggle; every instance stays in sync via refresh(). */
export function fsButton(attrs = {}, { icon = false } = {}) {
  const b = h('button', { ...attrs, 'data-fs-btn': icon ? 'icon' : 'text', onclick: toggleFullscreen });
  b.hidden = !fsMode(); paint(b); return b;
}
function paint(b) {
  const on = isFullscreen(); b.hidden = !fsMode(); b.classList.toggle('on', on);
  if (b.dataset.fsBtn === 'icon') { b.textContent = on ? '⤡' : '⛶'; b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); b.title = on ? 'Exit full screen' : (fsMode() === 'guide' ? 'Full screen (not available in iPhone Safari)' : 'Full screen'); }
  else b.textContent = on ? 'Exit full screen' : (fsMode() === 'guide' ? 'Full screen (add to Home Screen)' : 'Full screen');
}
export function refreshFullscreenUI() {
  const on = isFullscreen(); document.body.classList.toggle('is-fullscreen', on);
  document.querySelectorAll('[data-fs-btn]').forEach(paint);
  let x = $('#fs-exit'); if (!x) { x = h('button', { id: 'fs-exit', class: 'fs-exit', 'aria-label': 'Exit full screen', title: 'Exit full screen', onclick: toggleFullscreen }, '⤡ Exit full screen'); document.body.append(x); }
  x.hidden = !on;
}
let lastOn = false;
const onChange = () => { const on = isFullscreen(); refreshFullscreenUI(); if (on && !lastOn) toast('Full screen. Press Esc or tap Exit to leave.', 2800); lastOn = on; };
export function initFullscreen() { document.addEventListener('fullscreenchange', onChange); document.addEventListener('webkitfullscreenchange', onChange); refreshFullscreenUI(); }

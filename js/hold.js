// Press-and-hold on a Library / Audiobooks tile opens the same menu as its ⋯ button (default 4 s, Settings → Press and hold: 0.5–5 s).
// A ring fills while holding; releasing, scrolling or moving more than 10 px cancels. Native long-press menus / callouts / text selection are suppressed on tiles.
// Tiles opt in with `el.__onHold = () => openMenu()`. Off in select mode; a hold in custom-order mode cancels the (350 ms) drag-reorder pickup if the finger has not moved.
import { settings } from './settings.js';

export const HOLD_MIN = 0.5, HOLD_MAX = 5, HOLD_DEFAULT = 4, MOVE_PX = 10;
export const holdSeconds = () => { const v = Number(settings.get('holdSec')); return Math.min(HOLD_MAX, Math.max(HOLD_MIN, Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : HOLD_DEFAULT)); };

let st = null, swallowUntil = 0, inited = false;

function ring(el, ms) {
  const host = el.querySelector('.cover') || el;
  const r = document.createElement('div'); r.className = 'hold-ring'; r.style.setProperty('--hold-ms', ms + 'ms'); r.setAttribute('aria-hidden', 'true');
  r.innerHTML = '<svg viewBox="0 0 44 44"><circle class="hr-bg" cx="22" cy="22" r="19"/><circle class="hr-fg" cx="22" cy="22" r="19" pathLength="100"/></svg>';
  host.append(r); return r;
}
function stop(fired) {
  if (!st) return; clearTimeout(st.timer); clearTimeout(st.showTimer);
  st.el.classList.remove('holding'); if (st.ring) st.ring.remove();
  if (!fired && st.el) st.el.dispatchEvent(new CustomEvent('hold-cancel', { bubbles: true }));
  st = null;
}
export function cancelHold() { stop(false); }
export const isHolding = () => !!st;

function fire() {
  if (!st) return; const { el } = st; stop(true);
  swallowUntil = Date.now() + 1500;     // the release that follows must not open the book / close the menu that just appeared
  try { if (navigator.vibrate) navigator.vibrate(25); } catch { /* unsupported (iOS) */ }
  el.dispatchEvent(new CustomEvent('hold-fire', { bubbles: true }));
  try { el.__onHold && el.__onHold(); } catch (e) { console.warn('hold menu failed', e); }
}

export function initHold() {
  if (inited) return; inited = true;
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !e.isPrimary) return; cancelHold();
    const el = e.target.closest && e.target.closest('.tile, .rn-row'); if (!el || !el.__onHold) return;
    if (e.target.closest('button, a, input, select, textarea') || el.closest('.selecting') || document.body.classList.contains('dragging-now')) return;
    const ms = holdSeconds() * 1000;
    st = { el, id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(fire, ms), ring: null };
    st.showTimer = setTimeout(() => { if (st && st.el === el) { el.classList.add('holding'); st.ring = ring(el, Math.max(100, ms - 250)); } }, 250);   // short taps and scroll starts never flash a ring
  }, true);
  document.addEventListener('pointermove', (e) => { if (st && e.pointerId === st.id && Math.hypot(e.clientX - st.x, e.clientY - st.y) > MOVE_PX) cancelHold(); }, true);
  for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, (e) => { if (st && e.pointerId === st.id) cancelHold(); }, true);
  window.addEventListener('scroll', () => cancelHold(), true);
  window.addEventListener('blur', () => cancelHold());
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelHold(); });
  document.addEventListener('click', (e) => { if (Date.now() < swallowUntil) { e.stopPropagation(); e.preventDefault(); swallowUntil = 0; } }, true);
  // no native long-press UI on tiles: context menu / image save / callout / text selection / image drag
  const stopNative = (e) => { if (e.target.closest && e.target.closest('.tile, .rn-row')) e.preventDefault(); };
  for (const t of ['contextmenu', 'selectstart', 'dragstart']) document.addEventListener(t, stopNative, true);
}

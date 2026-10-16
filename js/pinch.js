// Pinch to change the EPUB text size (v0.5.2). The page itself never zooms (viewport.js); the two-finger spread / pinch is turned into a *slow*, smoothed change of the
// reader's font size: the finger scale is damped (scale^exponent: Slow 0.4, Normal 0.7, Fast 1.0), eased towards its target on every animation frame, snapped to 0.5 pt steps,
// clamped to the 8–60 pt range, and the (expensive) re-layout is throttled. The result is written like the Aa panel does (per-book override if the book has one, else global).
import { settings, FONT_MIN, FONT_MAX, FONT_STEP, clampPt } from './settings.js';

export const PINCH_EXP = { slow: 0.4, normal: 0.7, fast: 1 };
export const PINCH_LABELS = [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']];
export const pinchExp = () => PINCH_EXP[settings.get('pinchSens')] ?? PINCH_EXP.slow;
const snap = (v) => Math.round(v / FONT_STEP) * FONT_STEP;
/** Font size for a pinch that started at `startPt` and has scaled by `scale`. */
export const targetPt = (startPt, scale, exp = pinchExp()) => clampPt(snap(Math.min(FONT_MAX, Math.max(FONT_MIN, startPt * Math.pow(scale, exp)))));

const DEAD = 0.04, EASE = 0.18, APPLY_MS = 120;
let hud = null, hudT = 0;
function showHud(txt) { if (!hud) { hud = document.createElement('div'); hud.id = 'pinch-hud'; hud.setAttribute('aria-hidden', 'true'); document.body.append(hud); } hud.textContent = txt; hud.classList.add('on'); clearTimeout(hudT); }
function hideHud() { clearTimeout(hudT); hudT = setTimeout(() => hud && hud.classList.remove('on'), 700); }
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

/** Attach to a document (the reader viewer, and each EPUB iframe). host: { getPt(): number, apply(pt, final): void, busy?(): boolean } */
export function attachPinch(doc, host) {
  if (!doc || doc.__pinch) return; doc.__pinch = true;
  let g = null;
  const stop = (final) => {
    if (!g) return; cancelAnimationFrame(g.raf); const x = g; g = null;
    if (x.armed) { const pt = targetPt(x.p0, x.last / x.s0, x.exp); host.apply(pt, true); showHud(pt + ' pt'); hideHud(); host.pinched && host.pinched(); }
  };
  const loop = () => {
    if (!g) return;
    g.shown += (g.raw - g.shown) * EASE; const pt = clampPt(snap(g.shown)); const now = Date.now();
    if (pt !== g.applied && now - g.appliedAt >= APPLY_MS) { g.applied = pt; g.appliedAt = now; host.apply(pt, false); }
    showHud((g.applied ?? pt) + ' pt'); g.raf = requestAnimationFrame(loop);
  };
  doc.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { const p0 = host.getPt(); g = { d0: dist(e.touches), p0, exp: pinchExp(), armed: false, s0: 1, last: 1, raw: p0, shown: p0, applied: p0, appliedAt: 0, raf: 0 }; if (host.pinched) host.pinched(); }
    else if (g) stop();
  }, { passive: true });
  doc.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 2) return;
    const scale = dist(e.touches) / (g.d0 || 1); g.last = scale;
    if (!g.armed) { if (Math.abs(Math.log(scale)) < DEAD) return; g.armed = true; g.s0 = scale > 1 ? Math.exp(DEAD) : Math.exp(-DEAD); g.raf = requestAnimationFrame(loop); }   // dead zone: a slight two-finger touch changes nothing; no jump when it starts
    g.raw = Math.min(FONT_MAX, Math.max(FONT_MIN, g.p0 * Math.pow(scale / g.s0, g.exp)));
  }, { passive: true });
  for (const t of ['touchend', 'touchcancel']) doc.addEventListener(t, (e) => { if (g && e.touches.length < 2) stop(true); }, { passive: true });
}

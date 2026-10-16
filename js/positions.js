// Reading / listening positions across devices (v0.5.5). Positions travel in their own small file (folio-positions.json) with a timestamp and the device
// that made them. Rules when a newer position arrives from another device:
//   • this device hasn't moved since the last sync  → it is applied silently (and a note "Continued from <device>" shows when you open the book);
//   • this device moved too (both changed)            → nothing is overwritten; opening the book asks "Continue from <device> at 42%?" (Continue / Stay here);
//   • the book is open right now                      → left alone (it is handled the next time it is opened).
import { DB, posAtOf, posAtOfState } from './db.js';
import { h, toast, sheet } from './util.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import { deviceId } from './device.js';

export const POS_BOOK = ['progress', 'cfi', 'lastOpened', 'pdfPage', 'pdfZoom', 'pdfText'];
export const POS_AUDIO = ['position', 'progress', 'track', 'trackIndex', 'speed', 'lastOpened'];
const BASE = 'folio.posBase', CONF = 'folio.posConflicts', NOTES = 'folio.posNotes', ASK = 'folio.askContinue';
const rd = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };
const fields = (kind) => (kind === 'audio' ? POS_AUDIO : POS_BOOK);
export const itemKey = (kind, it) => (kind === 'audio' ? (it.syncKey || it.id) : S.bookSyncKey(it));
const cid = (kind, key) => kind + ':' + key;

/** Is the position in `st` (a snapshot state) the same place as the one stored on `it`? */
export function samePos(kind, it, st) {
  if (kind === 'audio') return Math.abs((it.position || 0) - (st.position || 0)) < 5;
  if ((it.pdfPage || 0) || (st.pdfPage || 0)) return (it.pdfPage || 0) === (st.pdfPage || 0);
  return (!!it.cfi && it.cfi === st.cfi) || Math.abs((it.progress || 0) - (st.progress || 0)) < 0.002;
}
export const pctOf = (st) => Math.round((st.progress || 0) * 100);
/** Always ask before jumping to another device's position (Settings → Sync). Default: only when both devices moved. */
export const askAlways = () => localStorage.getItem(ASK) === '1';
export const setAskAlways = (on) => (on ? localStorage.setItem(ASK, '1') : localStorage.removeItem(ASK));

const openChecks = [];   // readers / the player register a function (kind, id) → true while that item is open
export const registerOpenCheck = (fn) => openChecks.push(fn);
const isOpen = (kind, id) => openChecks.some((f) => { try { return f(kind, id); } catch { return false; } });

function take(kind, it, st) {
  for (const f of fields(kind)) { if (st[f] === undefined) delete it[f]; else it[f] = st[f]; }
  if (kind === 'book') { it.pdfText = !!st.pdfText; if (st.pdfPage) it.pdfZoom = st.pdfZoom || 1; }
  it.posAt = posAtOfState(st); it.posDev = st.dev || ''; it.posDevName = st.devName || '';
}
/** Apply a position from a merged snapshot state to a local item (mutates it; the caller saves it). Returns 'applied' | 'conflict' | 'same' | null. */
export function applyPosition(kind, it, st, ctx = {}) {
  const R = posAtOfState(st), L = posAtOf(it); const key = itemKey(kind, it);
  if (ctx.force) { take(kind, it, st); return 'applied'; }
  if (R <= L) return null;
  if (samePos(kind, it, st)) { it.posAt = R; it.posDev = st.dev || it.posDev; it.posDevName = st.devName || it.posDevName; if ((st.lastOpened || 0) > (it.lastOpened || 0)) it.lastOpened = st.lastOpened; return 'same'; }
  const fromOther = st.dev && st.dev !== deviceId();
  const moved = L > (rd(BASE)[cid(kind, key)] || 0);   // this device changed its position since the last sync
  if (ctx.sync && fromOther && (moved || isOpen(kind, it.id) || askAlways())) {
    const c = rd(CONF); c[cid(kind, key)] = { kind, key, at: R, dev: st.dev, devName: st.devName || 'another device', st: Object.fromEntries([...fields(kind), 'posAt', 'dev', 'devName'].filter((f) => st[f] !== undefined).map((f) => [f, st[f]])) }; wr(CONF, c);
    return 'conflict';
  }
  take(kind, it, st);
  if (ctx.sync && fromOther) { const n = rd(NOTES); n[cid(kind, key)] = { name: st.devName || 'another device', pct: pctOf(st), at: Date.now() }; wr(NOTES, n); }
  return 'applied';
}
/** After a successful sync: remember each item's position stamp as "in sync", except those waiting for the user's decision. */
export function markSynced(kind, items) {
  const b = rd(BASE), c = rd(CONF);
  for (const it of items) { const k = cid(kind, itemKey(kind, it)); if (!c[k]) b[k] = posAtOf(it); }
  const live = new Set(items.map((it) => cid(kind, itemKey(kind, it)))); for (const k of Object.keys(b)) if (k.startsWith(kind + ':') && !live.has(k)) delete b[k];
  wr(BASE, b);
}
export const conflictCount = () => Object.keys(rd(CONF)).length;
export const getConflict = (kind, key) => rd(CONF)[cid(kind, key)] || null;
function drop(map, kind, key) { const m = rd(map); delete m[cid(kind, key)]; wr(map, m); }

function prompt(title, text, okLabel, noLabel) {
  return new Promise((resolve) => {
    let done = false; const fin = (v, close) => { done = true; close && close(); resolve(v); };
    sheet(title, (close) => [
      h('p', { class: 'muted', id: 'pos-prompt-text' }, text),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'pos-stay', onclick: () => fin('stay', close) }, noLabel), h('button', { class: 'btn primary', id: 'pos-continue', onclick: () => fin('continue', close) }, okLabel)),
    ], { closeLabel: 'Later', noFooter: true, onClose: () => { if (!done) resolve('later'); } });
  });
}
const get = (kind, id) => (kind === 'audio' ? A.getAudiobook(id) : S.getBook(id));
const put = (kind, it) => DB.put(kind === 'audio' ? 'audiobooks' : 'books', { ...it, _noTouch: true });

/** Called when a book / audiobook is about to open: pull the latest positions (short timeout), then settle conflicts and show the "continued from" note. */
export async function beforeOpen(kind, id) {
  try {
    const G = await import('./google.js');
    if (G.isSignedIn() && navigator.onLine && G.domainEnabled('positions')) await Promise.race([G.syncNow({ quiet: true, only: ['positions'] }).catch(() => null), new Promise((r) => setTimeout(r, 2500))]);
    const it = await get(kind, id); if (!it) return;
    const key = itemKey(kind, it), c = rd(CONF)[cid(kind, key)];
    if (c) {
      const where = kind === 'audio' ? 'at ' + fmtTime(c.st.position || 0) : (c.st.pdfPage ? 'on page ' + c.st.pdfPage : 'at ' + pctOf(c.st) + '%');
      const mine = kind === 'audio' ? fmtTime(it.position || 0) : (it.pdfPage ? 'page ' + it.pdfPage : Math.round((it.progress || 0) * 100) + '%');
      const choice = await prompt(`Continue from ${c.devName}?`, `On ${c.devName} you were ${where}${c.at ? ' (' + ago(c.at) + ')' : ''}. Here you are at ${mine}.`, 'Continue there', 'Stay here');
      if (choice === 'continue') { take(kind, it, { ...c.st, posAt: c.at }); await put(kind, it); drop(CONF, kind, key); toast('Continuing from ' + c.devName); }
      else if (choice === 'stay') { it.posAt = Date.now(); it.posDev = deviceId(); it.posDevName = (await import('./device.js')).deviceName(); await put(kind, it); drop(CONF, kind, key); import('./google.js').then((g) => g.scheduleSync(1000)); }
      return;
    }
    const n = rd(NOTES)[cid(kind, key)];
    if (n) { drop(NOTES, kind, key); if (Date.now() - n.at < 7 * 864e5 && (kind === 'audio' ? it.position > 5 : (it.progress || 0) > 0.002)) toast(`Continued from ${n.name} · ${n.pct}%`, 3500); }
  } catch { /* opening must never fail because of sync */ }
}
const fmtTime = (s) => { s = Math.round(s); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
export function ago(t) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }

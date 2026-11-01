// Reading stats (v0.5.20). Counts ACTIVE reading time only: time between page turns / scrolls while a book is open and the screen is on,
// with each gap capped at IDLE (a long pause, the phone in a pocket or the app in the background doesn't count).
// Storage: one record per device × book × day in the synced `glossary` store (kind 'stat', id st:<device>:<bookKey>:<day>), so stats ride
// Drive sync and backups like highlights do. Only this device ever writes its own ids, so a merge never loses time; totals add devices up.
import { DB } from './db.js';
import * as S from './store.js';
import { deviceId, deviceName } from './device.js';
import { h, sheet } from './util.js';

const GL = 'glossary';
export const tuning = { idleMs: 3 * 60e3, flushMs: 30e3, streakMinSecs: 60 };
export const dayOf = (t = Date.now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const live = (x) => x && !x.del && x.kind === 'stat';
let ses = null;   // { book, key, lastAct, lastP, rec, dirty, timer }

function recFor(s, t) {
  const day = dayOf(t);
  if (!s.rec || s.rec.day !== day) {
    if (s.rec && s.dirty) { s.dirty = false; flushRec(s.rec); }
    s.rec = { id: `st:${deviceId()}:${s.key}:${day}`, kind: 'stat', bookKey: s.key, bookTitle: s.book.title || '', bookAuthor: s.book.author || '', day, dev: deviceId(), devName: deviceName(), secs: 0, pages: 0, p0: null, p1: null };
  }
  return s.rec;
}
function credit(s, now, cap = tuning.idleMs) { if (s.lastAct == null) return; const r = recFor(s, now); r.secs += Math.min(Math.max(0, now - s.lastAct), cap) / 1000; s.lastAct = now; s.dirty = true; }

export async function flush() { const s = ses; if (!s || !s.rec || !s.dirty) return; s.dirty = false; await flushRec(s.rec); }
let chain = Promise.resolve();
function flushRec(r) { const dSecs = r.secs, dPages = r.pages; r.secs = 0; r.pages = 0; const snap = { ...r }; chain = chain.then(() => writeRec(snap, dSecs, dPages)); return chain; }
async function writeRec(r, dSecs, dPages) {   // add what this session counted since the last flush to the stored record (only this device writes it)
  let base = null; try { base = await DB.get(GL, r.id); } catch { /* ignore */ } if (!live(base)) base = {};
  const { secs: _a, pages: _b, ...meta } = r;
  const out = { ...meta, secs: Math.round(((base.secs || 0) + dSecs) * 10) / 10, pages: (base.pages || 0) + dPages, p0: base.p0 != null && r.p0 != null ? Math.min(base.p0, r.p0) : (r.p0 ?? base.p0 ?? null), p1: r.p1 ?? base.p1 ?? null };
  try { await DB.put(GL, out); } catch { /* ignore */ }
}
export function startSession(book) {
  if (ses) endSession();
  if (!book) return; ses = { book, key: S.bookSyncKey(book), lastAct: document.hidden ? null : Date.now(), lastP: null, rec: null, dirty: false };
  ses.timer = setInterval(() => { if (ses && ses.dirty) flush(); }, tuning.flushMs);
}
/** A page turn / scroll / position change in the open book. p = progress 0..1. */
export function activity(book, p) {
  if (!book) return; if (!ses || ses.book.id !== book.id) startSession(book);
  const s = ses, now = Date.now(); if (document.hidden) return;
  if (s.lastAct == null) s.lastAct = now; else credit(s, now);
  const r = recFor(s, now);
  if (typeof p === 'number' && isFinite(p)) {
    if (s.lastP != null && Math.abs(p - s.lastP) > 1e-6) { r.pages++; s.dirty = true; }
    s.lastP = p; if (r.p0 == null) r.p0 = p; r.p0 = Math.min(r.p0, p); r.p1 = p; s.dirty = true;
  }
}
export function endSession() { const s = ses; if (!s) return; credit(s, Date.now(), 60e3); clearInterval(s.timer); flush(); ses = null; }
export const current = () => ses;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { const s = ses; if (!s) return; if (document.hidden) { credit(s, Date.now(), 60e3); s.lastAct = null; flush(); } else s.lastAct = Date.now(); });
  window.addEventListener('pagehide', () => { if (ses) { credit(ses, Date.now(), 60e3); ses.lastAct = null; flush(); } });
}

/* ------------------------------------------------------------------ numbers */
export async function allStats() { return (await DB.all(GL)).filter(live); }
export function streaks(days, today = dayOf()) {
  const set = new Set(days); const prev = (d) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() - 1); return dayOf(t.getTime()); };
  let cur = 0, d = set.has(today) ? today : prev(today); while (set.has(d)) { cur++; d = prev(d); }
  let best = 0; for (const x of set) { if (set.has(prev(x))) continue; let n = 0, y = x; const next = (z) => { const t = new Date(z + 'T12:00:00'); t.setDate(t.getDate() + 1); return dayOf(t.getTime()); }; while (set.has(y)) { n++; y = next(y); } best = Math.max(best, n); }
  return { current: cur, best };
}
export async function summary(now = Date.now()) {
  if (ses && ses.dirty) await flush();
  const recs = await allStats(); const books = await S.getBooks(); const byKey = new Map(books.map((b) => [S.bookSyncKey(b), b]));
  const today = dayOf(now), year = String(new Date(now).getFullYear()); const weekAgo = dayOf(now - 6 * 864e5);
  const perDay = new Map(); const per = new Map();
  for (const r of recs) {
    perDay.set(r.day, (perDay.get(r.day) || 0) + (r.secs || 0));
    const b = per.get(r.bookKey) || { key: r.bookKey, title: r.bookTitle, author: r.bookAuthor, secs: 0, pages: 0, days: new Set(), first: r.day, last: r.day, devices: new Set(), gain: 0 };
    b.secs += r.secs || 0; b.pages += r.pages || 0; b.days.add(r.day); if (r.day < b.first) b.first = r.day; if (r.day > b.last) b.last = r.day; b.devices.add(r.devName || r.dev);
    if (r.p0 != null && r.p1 != null) b.gain += Math.max(0, r.p1 - r.p0); per.set(r.bookKey, b);
  }
  const sum = (f) => [...perDay].filter(([d]) => f(d)).reduce((a, [, s]) => a + s, 0);
  const finished = books.filter((b) => b.status === 'finished' && b.finishedAt && String(new Date(b.finishedAt).getFullYear()) === year).sort((a, b) => b.finishedAt - a.finishedAt);
  const list = [...per.values()].map((x) => { const b = byKey.get(x.key); const p = b ? (b.status === 'finished' ? 1 : b.progress || 0) : null; const left = p != null && p < 1 && x.gain > 0.02 && x.secs > 120 ? (x.secs / x.gain) * (1 - p) : null; return { ...x, book: b || null, title: (b && b.title) || x.title, author: (b && b.author) || x.author, progress: p, leftSecs: left, days: x.days.size, devices: [...x.devices] }; }).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : b.secs - a.secs));
  const yearRecs = recs.filter((r) => r.day.startsWith(year));
  return { today: sum((d) => d === today), week: sum((d) => d >= weekAgo && d <= today), year: sum((d) => d.startsWith(year)), total: sum(() => true), pagesYear: yearRecs.reduce((a, r) => a + (r.pages || 0), 0),
    streak: streaks([...perDay].filter(([, s]) => s >= tuning.streakMinSecs).map(([d]) => d), today), finished, books: list, year: +year, yearSecs: sum((d) => d.startsWith(year)) };
}
export const fmtDur = (secs) => { secs = Math.round(secs || 0); if (secs < 60) return secs ? '<1 min' : '0 min'; const m = Math.round(secs / 60); if (m < 60) return m + ' min'; const hh = Math.floor(m / 60), mm = m % 60; return hh + ' h' + (mm ? ' ' + mm + ' min' : ''); };
const pct = (p) => Math.round((p || 0) * 100) + '%';

/* ------------------------------------------------------------------ screens */
export async function openStats() {
  const w = sheet('Reading stats', () => h('div', { id: 'stats-root' }, h('p', { class: 'muted' }, 'Counting…')), { tall: true, closeLabel: 'Done' });
  const s = await summary(); const tile = (id, n, label) => h('div', { class: 'stat-tile', id }, h('strong', null, n), h('span', { class: 'muted small' }, label));
  w.body.firstChild.replaceChildren(
    h('p', { class: 'muted small', id: 'stats-note' }, 'Active reading time only: the time you spend turning pages with a book open. Long pauses and time with the screen off don’t count. Synced across your devices.'),
    h('div', { class: 'stat-grid' },
      tile('st-today', fmtDur(s.today), 'today'), tile('st-week', fmtDur(s.week), 'last 7 days'), tile('st-year', fmtDur(s.yearSecs), 'in ' + s.year),
      tile('st-streak', s.streak.current + (s.streak.current === 1 ? ' day' : ' days'), 'streak (best ' + s.streak.best + ')'), tile('st-finished', String(s.finished.length), 'finished in ' + s.year), tile('st-pages', String(s.pagesYear), 'pages turned in ' + s.year)),
    s.finished.length ? h('details', { class: 'stat-fin', id: 'st-finished-list' }, h('summary', null, 'Finished in ' + s.year + ' (' + s.finished.length + ')'),
      h('ol', null, ...s.finished.map((b) => h('li', null, b.title, b.author ? h('span', { class: 'muted' }, ' · ' + b.author) : null, h('span', { class: 'muted small' }, ' · ' + new Date(b.finishedAt).toLocaleDateString()))))) : null,
    h('h4', null, 'Per book'),
    s.books.length ? h('div', { class: 'list', id: 'st-books' }, ...s.books.map((x) => h('button', { class: 'list-item st-book', 'data-key': x.key, onclick: () => { if (x.book) openBookStats(x.book); } },
      h('span', { class: 'grow' }, h('strong', null, x.title || 'Untitled'), h('span', { class: 'muted small block' }, [fmtDur(x.secs), x.pages + ' pages', x.progress != null ? pct(x.progress) : null, 'last ' + x.last].filter(Boolean).join(' · ')))))) : h('p', { class: 'muted', id: 'st-empty' }, 'Nothing yet. Open a book and read; time starts counting from the first page turn.'),
  );
}
export async function openBookStats(book) {
  const s = await summary(); const key = S.bookSyncKey(book); const x = s.books.find((b) => b.key === key);
  const p = book.status === 'finished' ? 1 : book.progress || 0;
  sheet('Stats · ' + book.title, () => h('div', { id: 'bstats' }, x ? h('div', { class: 'stat-grid' },
    h('div', { class: 'stat-tile', id: 'bs-time' }, h('strong', null, fmtDur(x.secs)), h('span', { class: 'muted small' }, 'active reading')),
    h('div', { class: 'stat-tile', id: 'bs-pages' }, h('strong', null, String(x.pages)), h('span', { class: 'muted small' }, 'pages turned')),
    h('div', { class: 'stat-tile', id: 'bs-pct' }, h('strong', null, pct(p)), h('span', { class: 'muted small' }, book.status === 'finished' ? 'finished' + (book.finishedAt ? ' ' + new Date(book.finishedAt).toLocaleDateString() : '') : 'read')),
    h('div', { class: 'stat-tile', id: 'bs-days' }, h('strong', null, String(x.days)), h('span', { class: 'muted small' }, x.days === 1 ? 'day' : 'days, ' + x.first + ' → ' + x.last)),
    x.leftSecs ? h('div', { class: 'stat-tile', id: 'bs-left' }, h('strong', null, '≈ ' + fmtDur(x.leftSecs)), h('span', { class: 'muted small' }, 'left at your pace')) : null,
  ) : h('p', { class: 'muted', id: 'bs-empty' }, 'No reading time recorded for this book yet (' + pct(p) + ' read).'),
  x && x.devices.length > 1 ? h('p', { class: 'muted small' }, 'Read on: ' + x.devices.join(', ')) : null), { closeLabel: 'Done' });
}

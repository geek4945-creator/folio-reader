// Audiobook player: one <audio> element, a book-wide timeline over one or many tracks, chapters, speed, sleep timer, resume position,
// Media Session (lock-screen / headset controls). The full-screen UI (#audioplayer) and the mini player (#miniplayer) only render state.
import { h, $, toast, sheet, actionSheet, hashHue } from './util.js';
import { settings } from './settings.js';
import * as A from './audiostore.js';
import { DB } from './db.js';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const SLEEP_OPTIONS = [[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '60 minutes'], ['chapter', 'End of chapter']];
const el = (() => { const a = document.createElement('audio'); a.id = 'audio-el'; a.preload = 'auto'; a.setAttribute('playsinline', ''); a.hidden = true; a.preservesPitch = true; document.addEventListener('DOMContentLoaded', () => document.body.append(a)); if (document.body) document.body.append(a); return a; })();

let cur = null;            // { book, offs, total, ch, ti (track index), url, speed }
let loadToken = 0, lastSave = 0, lastMs = 0, sleep = null, sleepTimer = 0, coverUrl = null, closed = true;
const bus = new EventTarget(); const emit = (t) => bus.dispatchEvent(new Event(t));
export const onPlayer = (t, fn) => { bus.addEventListener(t, fn); return () => bus.removeEventListener(t, fn); };

/* ---------- timeline ---------- */
function layout(book) {
  const offs = []; let t = 0; for (const tr of book.tracks) { offs.push(t); t += tr.duration || 0; }
  let ch = (book.chapters || []).map((c, i) => ({ title: c.title || `Chapter ${i + 1}`, start: (offs[c.track] ?? 0) + (c.start || 0), track: c.track }));
  if (!ch.length) ch = [{ title: book.title, start: 0, track: 0 }];
  ch.sort((a, b) => a.start - b.start); ch.forEach((c, i) => { c.i = i; c.end = i + 1 < ch.length ? ch[i + 1].start : t; });
  return { offs, total: t, ch };
}
function chapterCheck() { if (!cur) return; const c = chapterAt(gpos()); if (c && cur.lastCi !== c.i) { cur.lastCi = c.i; updateSession(); emit('state'); } }
const gpos = () => (cur ? cur.offs[cur.ti] + (el.currentTime || 0) : 0);
export const chapterAt = (t) => { if (!cur) return null; let c = cur.ch[0]; for (const x of cur.ch) if (x.start <= t + 0.001) c = x; return c; };
const trackAt = (t) => { let i = 0; for (let k = 0; k < cur.offs.length; k++) if (cur.offs[k] <= t + 0.001) i = k; return i; };
export function getState() {
  if (!cur) return null; const t = gpos(); const c = chapterAt(t);
  return { id: cur.book.id, title: cur.book.title, author: cur.book.author, playing: !el.paused && !el.ended, pos: t, total: cur.total, chapter: c, chapters: cur.ch, speed: cur.speed, track: cur.ti, tracks: cur.book.tracks.length, sleep: sleepState(), book: cur.book, cover: coverUrl };
}
export const current = () => cur;

/* ---------- loading / switching tracks ---------- */
async function setTrack(i, off, autoplay) {
  const token = ++loadToken; const tr = cur.book.tracks[i]; const blob = tr.stored ? await A.getTrackBlob(cur.book, i) : null;
  if (token !== loadToken) return false;
  if (cur.url) { URL.revokeObjectURL(cur.url); cur.url = null; }
  let src = tr.url; if (blob) { cur.url = URL.createObjectURL(blob); src = cur.url; }
  if (!src) { toast('This track isn’t available offline. Connect to the internet or re-import the file.', 5000); return false; }
  cur.ti = i; el.pause(); el.defaultPlaybackRate = cur.speed; el.src = src; el.playbackRate = cur.speed; el.preservesPitch = true;
  const ok = await new Promise((res) => { const done = (v) => { clearTimeout(t); el.removeEventListener('loadedmetadata', ok1); el.removeEventListener('error', bad); res(v); }; const ok1 = () => done(true); const bad = () => done(false); const t = setTimeout(() => done(false), 25000); el.addEventListener('loadedmetadata', ok1); el.addEventListener('error', bad); });
  if (token !== loadToken) return false;
  if (!ok) { toast('Couldn’t play “' + (tr.title || tr.name) + '”. The file may be damaged or in a format this device can’t play.', 6000); emit('state'); return false; }
  if (isFinite(el.duration) && el.duration > 0 && Math.abs(el.duration - (tr.duration || 0)) > 0.75) { tr.duration = el.duration; const lay = layout(cur.book); Object.assign(cur, lay); cur.dirty = true; }
  el.currentTime = Math.max(0, Math.min(off || 0, (el.duration || off) - 0.05)); el.playbackRate = cur.speed;
  if (autoplay) { try { await el.play(); } catch { /* autoplay blocked: stay paused */ } }
  chapterCheck(); emit('state'); updateSession(); return true;
}

/** Open a book in the player (resumes where you stopped). */
export async function loadBook(id, { play = false } = {}) {
  if (cur && cur.book.id === id) { closed = false; if (play) await playNow(); emit('state'); return cur; }
  await save(true);
  const book = await A.getAudiobook(id); if (!book) return null;
  const lay = layout(book); const speed = clampSpeed(book.speed ?? settings.get('audioSpeed') ?? 1);
  cur = { book, ...lay, ti: 0, url: null, speed }; closed = false;
  if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = book.coverBlob ? URL.createObjectURL(book.coverBlob) : null;
  let pos = book.position || 0; if (pos >= lay.total - 1) pos = 0;
  const ti = trackAt(pos); await setTrack(ti, pos - cur.offs[ti], false);
  book.lastOpened = Date.now(); emit('state'); updateSession();
  if (play) await playNow();
  return cur;
}
async function playNow() {
  if (!cur) return; try { await el.play(); } catch { /* needs a user gesture */ }
  if (cur.book.status === 'want') { const b = await A.getAudiobook(cur.book.id); if (b) { b.status = 'reading'; await A.saveAudiobook(b); cur.book.status = 'reading'; } }
}
export const play = playNow;
export const pause = () => { el.pause(); };
export const togglePlay = () => (el.paused ? playNow() : pause());
export async function seekGlobal(t, autoplay) {
  if (!cur) return; t = Math.max(0, Math.min(t, cur.total)); const ti = trackAt(Math.min(t, Math.max(0, cur.total - 0.01)));
  const wasPlaying = autoplay ?? !el.paused;
  if (ti === cur.ti) { el.currentTime = t - cur.offs[ti]; if (wasPlaying && el.paused) playNow(); chapterCheck(); emit('tick'); return; }
  await setTrack(ti, t - cur.offs[ti], wasPlaying);
}
export const skip = (s) => seekGlobal(gpos() + s);
export async function gotoChapter(i, autoplay) { if (!cur) return; const c = cur.ch[Math.max(0, Math.min(i, cur.ch.length - 1))]; await seekGlobal(c.start, autoplay); }
export const nextChapter = () => { const c = chapterAt(gpos()); return gotoChapter(c.i + 1); };
export const prevChapter = () => { const t = gpos(); const c = chapterAt(t); return gotoChapter(t - c.start > 3 ? c.i : c.i - 1); };
export const clampSpeed = (x) => Math.min(3, Math.max(0.5, Math.round((+x || 1) * 20) / 20));
export async function setSpeed(x) {
  if (!cur) return; x = clampSpeed(x); cur.speed = x; el.defaultPlaybackRate = x; el.playbackRate = x; settings.set({ audioSpeed: x });
  const b = await A.getAudiobook(cur.book.id); if (b) { b.speed = x; await A.saveAudiobook(b, false); cur.book.speed = x; } emit('state'); updateSession();
}

/* ---------- sleep timer ---------- */
export function sleepState() { if (!sleep) return null; return sleep.kind === 'chapter' ? { kind: 'chapter', label: 'End of chapter' } : { kind: 'minutes', remaining: Math.max(0, sleep.until - Date.now()), label: Math.ceil(Math.max(0, sleep.until - Date.now()) / 60000) + ' min' }; }
export function setSleep(spec) {
  clearInterval(sleepTimer); sleep = null;
  if (spec === 'chapter') sleep = { kind: 'chapter' };
  else if (spec) { sleep = { kind: 'minutes', until: Date.now() + spec * 60000 }; sleepTimer = setInterval(() => { if (!sleep || sleep.kind !== 'minutes') return clearInterval(sleepTimer); if (Date.now() >= sleep.until) fireSleep(); else emit('sleep'); }, 1000); }
  emit('sleep'); emit('state');
}
function fireSleep() { clearInterval(sleepTimer); sleep = null; el.pause(); save(true); toast('Sleep timer: playback paused'); emit('sleep'); emit('state'); }

/* ---------- persistence ---------- */
export async function save(force) {
  if (!cur) return; const now = Date.now(); if (!force && now - lastSave < 4500) return; lastSave = now;
  const b = await DB.get('audiobooks', cur.book.id); if (!b) return;   // deleted meanwhile: never recreate it
  const t = Math.min(gpos(), cur.total);
  if (cur.finished) { b.position = cur.total; b.progress = 1; } else { b.position = t; b.progress = cur.total ? t / cur.total : 0; }
  b.lastOpened = cur.book.lastOpened || now;
  if (cur.dirty) { b.tracks.forEach((tr, i) => { tr.duration = cur.book.tracks[i].duration; }); b.duration = cur.total; cur.dirty = false; }
  await DB.put('audiobooks', b); cur.book.position = b.position;
}
async function finish() {
  cur.finished = true; el.pause(); const b = await A.getAudiobook(cur.book.id); if (!b) return;
  b.status = 'finished'; b.finishedAt = Date.now(); b.position = cur.total; b.progress = 1; await A.saveAudiobook(b); cur.book.status = 'finished';
  toast('Finished “' + cur.book.title + '”'); emit('state');
}

/* ---------- audio element events ---------- */
el.addEventListener('timeupdate', () => {
  if (!cur) return; const t = gpos(); cur.finished = false; chapterCheck();
  if (sleep && sleep.kind === 'chapter') { const c = chapterAt(t); if (c && t >= c.end - 0.35 && !el.paused) { sleep = null; el.pause(); if (c.end < cur.total) seekGlobal(c.end, false); save(true); toast('Sleep timer: end of chapter'); emit('sleep'); } }
  const ms = Date.now(); if (ms - lastMs > 240) { lastMs = ms; emit('tick'); if (ms - lastSession > 1000) { lastSession = ms; positionState(); } }
  save(false);
});
let lastSession = 0;
el.addEventListener('play', () => { emit('state'); updateSession(); });
el.addEventListener('pause', () => { save(true); emit('state'); updateSession(); });
el.addEventListener('ratechange', () => emit('tick'));
el.addEventListener('ended', async () => {
  if (!cur) return;
  if (cur.ti < cur.book.tracks.length - 1) {
    if (sleep && sleep.kind === 'chapter') { sleep = null; emit('sleep'); await setTrack(cur.ti + 1, 0, false); toast('Sleep timer: end of chapter'); return; }
    await setTrack(cur.ti + 1, 0, true); return;
  }
  await finish();
});
el.addEventListener('error', () => { if (cur && el.currentSrc && el.error) { toast('Playback error. The file may be damaged or unsupported on this device.', 5000); emit('state'); } });
addEventListener('pagehide', () => { save(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });

/** Called when books are deleted: stop and forget the loaded one. */
export async function unloadIf(ids) {
  if (!cur || !ids.includes(cur.book.id)) return; await unload();
}
export async function unload() {
  loadToken++; el.pause(); el.removeAttribute('src'); el.load(); if (cur?.url) URL.revokeObjectURL(cur.url); if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = null; cur = null; closed = true; setSleep(null);
  try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch { /* no media session */ }
  emit('state'); renderMini(); closePlayer();
}
/** The mini player's ✕ / library clean-up: pause + save + unload. */
export async function stopAndClose() { await save(true); await unload(); }

/* ---------- Media Session ---------- */
const ms = () => ('mediaSession' in navigator ? navigator.mediaSession : null);
function updateSession() {
  const s = ms(); if (!s || !cur) return; const c = chapterAt(gpos());
  try {
    if (typeof MediaMetadata !== 'undefined') s.metadata = new MediaMetadata({ title: c?.title || cur.book.title, artist: cur.book.author || '', album: cur.book.title, artwork: coverUrl ? [{ src: coverUrl, sizes: '360x540', type: cur.book.coverBlob?.type || 'image/jpeg' }] : [] });
    s.playbackState = el.paused ? 'paused' : 'playing'; positionState();
  } catch { /* unsupported bits */ }
}
function positionState() {
  const s = ms(); if (!s || !cur || !s.setPositionState) return; const t = gpos(); const c = chapterAt(t); if (!c) return;
  const dur = c.end - c.start; if (!(dur > 0)) return;
  try { s.setPositionState({ duration: dur, position: Math.max(0, Math.min(dur, t - c.start)), playbackRate: cur.speed || 1 }); } catch { /* ignore */ }
}
export function initMediaSession() {
  const s = ms(); if (!s) return;
  const set = (a, fn) => { try { s.setActionHandler(a, fn); } catch { /* action unsupported */ } };
  set('play', () => playNow()); set('pause', () => pause()); set('stop', () => pause());
  set('seekbackward', (d) => skip(-(d?.seekOffset || 15))); set('seekforward', (d) => skip(d?.seekOffset || 15));
  set('previoustrack', () => prevChapter()); set('nexttrack', () => nextChapter());
  set('seekto', (d) => { if (!cur || d?.seekTime == null) return; const c = chapterAt(gpos()); seekGlobal(c.start + d.seekTime); });
}

/* ============================== UI ============================== */
export const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
export const fmtLong = (s) => { s = Math.round(s || 0); if (s < 60) return s + ' sec'; const hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60); return hh ? `${hh} h ${mm} min` : `${mm} min`; };
const ph = (b, cls = 'ap-cover') => h('div', { class: cls, style: coverUrl && cur && cur.book.id === b.id ? { backgroundImage: `url(${coverUrl})` } : { background: `linear-gradient(135deg,hsl(${hashHue(b.title)} 45% 38%),hsl(${(hashHue(b.title) + 40) % 360} 45% 28%))` } }, coverUrl && cur && cur.book.id === b.id ? null : h('span', null, b.title));

const ICON = { play: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>', pause: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>', next: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M16 5h2v14h-2zM4 5l11 7-11 7z"/></svg>' };
const setIcon = (b, n) => { if (b.dataset.icon !== n) { b.innerHTML = ICON[n]; b.dataset.icon = n; } };
let ui = null;
export function openPlayer() {
  if (!cur) return; const root = $('#audioplayer'); if (!root) return; root.hidden = false; document.body.classList.add('audio-open');
  const b = cur.book; let scrubbing = false;
  const scrub = h('input', { type: 'range', id: 'ap-scrub', min: 0, max: 1, step: 0.1, value: 0, 'aria-label': 'Position in chapter' });
  const el_ = { title: h('div', { id: 'ap-title', class: 'ap-title' }), author: h('div', { id: 'ap-author', class: 'ap-author muted' }), chapter: h('div', { id: 'ap-chapter', class: 'ap-chapter' }),
    elapsed: h('span', { id: 'ap-elapsed' }), remaining: h('span', { id: 'ap-remaining' }), prog: h('i', { id: 'ap-progress' }), progText: h('div', { id: 'ap-progress-text', class: 'muted small center' }),
    play: h('button', { id: 'ap-play', class: 'ap-play', 'aria-label': 'Play', onclick: () => togglePlay(), html: ICON.play }),
    speed: h('button', { id: 'ap-speed', class: 'btn small', onclick: speedSheet }), sleepB: h('button', { id: 'ap-sleep', class: 'btn small', onclick: sleepSheet }), coverBox: h('div', { class: 'ap-cover-box' }) };
  scrub.addEventListener('input', () => { scrubbing = true; const c = chapterAt(gpos()); el_.elapsed.textContent = fmtTime(+scrub.value); el_.remaining.textContent = '-' + fmtTime((c.end - c.start) - +scrub.value); });
  scrub.addEventListener('change', async () => { const c = chapterAt(gpos()); await seekGlobal(c.start + +scrub.value); scrubbing = false; paint(); });
  root.replaceChildren(
    h('div', { class: 'ap-top' }, h('button', { class: 'btn-text', id: 'ap-close', 'aria-label': 'Close player', onclick: closePlayer }, '⌄ Done'), h('strong', { class: 'grow center' }, 'Now playing'), h('button', { class: 'btn-icon', id: 'ap-menu', 'aria-label': 'Audiobook options', onclick: playerMenu }, '⋯')),
    h('div', { class: 'ap-body' }, el_.coverBox, el_.title, el_.author, el_.chapter,
      h('div', { class: 'ap-scrub' }, scrub, h('div', { class: 'ap-times' }, el_.elapsed, el_.remaining)),
      h('div', { class: 'ap-ctl' },
        h('button', { id: 'ap-prev', 'aria-label': 'Previous chapter', onclick: () => prevChapter(), html: ICON.prev }),
        h('button', { id: 'ap-back', class: 'ap-skip', 'aria-label': 'Back 15 seconds', onclick: () => skip(-15) }, h('b', null, '↺'), h('small', null, '15')), el_.play,
        h('button', { id: 'ap-fwd', class: 'ap-skip', 'aria-label': 'Forward 15 seconds', onclick: () => skip(15) }, h('b', null, '↻'), h('small', null, '15')),
        h('button', { id: 'ap-next', 'aria-label': 'Next chapter', onclick: () => nextChapter(), html: ICON.next })),
      h('div', { class: 'ap-row' }, el_.speed, el_.sleepB, h('button', { id: 'ap-chapters', class: 'btn small', onclick: chaptersSheet }, '☰ Chapters')),
      h('div', { class: 'bar ap-bar' }, el_.prog), el_.progText));
  function paint() {
    const s = getState(); if (!s) return; const c = s.chapter; const cd = c.end - c.start; const rel = Math.max(0, Math.min(cd, s.pos - c.start));
    if (el_.title.textContent !== s.title) { el_.title.textContent = s.title; el_.author.textContent = s.author || 'Unknown author'; el_.coverBox.replaceChildren(ph(s.book)); }
    el_.chapter.textContent = s.chapters.length > 1 ? `${c.title}  ·  ${c.i + 1} of ${s.chapters.length}` : '';
    setIcon(el_.play, s.playing ? 'pause' : 'play'); el_.play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play'); el_.play.dataset.playing = s.playing ? '1' : '0';
    if (!scrubbing) { scrub.max = Math.max(1, cd); scrub.value = rel; el_.elapsed.textContent = fmtTime(rel); el_.remaining.textContent = '-' + fmtTime(cd - rel); }
    const frac = s.total ? s.pos / s.total : 0; el_.prog.style.width = Math.round(frac * 100) + '%';
    el_.progText.textContent = `${Math.round(frac * 100)}% · ${fmtLong(Math.max(0, (s.total - s.pos) / s.speed))} left${s.speed !== 1 ? ' at ' + s.speed + '×' : ''}`;
    el_.speed.textContent = (s.speed % 1 === 0 ? s.speed.toFixed(1) : s.speed) + '×'; el_.speed.dataset.speed = s.speed;
    el_.sleepB.textContent = s.sleep ? '☾ ' + (s.sleep.kind === 'chapter' ? 'End of chapter' : s.sleep.label) : '☾ Sleep'; el_.sleepB.dataset.sleep = s.sleep ? s.sleep.kind : '';
  }
  const offs = [onPlayer('state', paint), onPlayer('tick', paint), onPlayer('sleep', paint)];
  ui = { off: () => offs.forEach((f) => f()), paint }; paint();
}
export function closePlayer() { const root = $('#audioplayer'); if (root) { root.hidden = true; root.replaceChildren(); } document.body.classList.remove('audio-open'); ui?.off(); ui = null; }
export const playerOpen = () => !!ui;

function speedSheet() {
  const s = getState(); let w;
  const label = h('div', { id: 'speed-label', class: 'sp-big' }, s.speed + '×');
  const range = h('input', { type: 'range', id: 'speed-range', min: 0.5, max: 3, step: 0.05, value: s.speed }); range.addEventListener('input', () => { label.textContent = (+range.value).toFixed(2).replace(/0$/, '') + '×'; setSpeed(+range.value); });
  w = sheet('Playback speed', () => [label, range, h('div', { class: 'sp-grid' }, SPEEDS.map((x) => h('button', { class: 'btn' + (x === s.speed ? ' primary' : ''), 'data-speed': x, onclick: () => { setSpeed(x); w.close(); } }, x + '×'))), h('p', { class: 'muted small' }, 'Voices keep their natural pitch. Your last speed is remembered for each audiobook.')]);
}
function sleepSheet() {
  const s = sleepState();
  actionSheet('Sleep timer', [{ id: 'sleep-off', label: 'Off', checked: !s, onClick: () => setSleep(null) },
    ...SLEEP_OPTIONS.map(([v, n]) => ({ id: 'sleep-' + v, label: n, checked: !!s && (v === 'chapter' ? s.kind === 'chapter' : false), onClick: () => { setSleep(v); toast(v === 'chapter' ? 'Will pause at the end of this chapter' : `Will pause in ${v} minutes`); } }))]);
}
function chaptersSheet() {
  const s = getState(); const w = sheet('Chapters', () => [h('div', { class: 'list', id: 'chapter-list' }, s.chapters.map((c) => h('button', { class: 'list-item' + (c.i === s.chapter.i ? ' now' : ''), 'data-ch': c.i, onclick: () => { gotoChapter(c.i, true); w.close(); } },
    h('span', { class: 'grow' }, h('span', { class: 'muted small' }, (c.i + 1) + '. '), c.title), h('span', { class: 'muted small' }, fmtTime(c.end - c.start)), c.i === s.chapter.i ? h('span', { class: 'check' }, '▶') : null)))], { tall: true });
  setTimeout(() => w.body.querySelector('.now')?.scrollIntoView({ block: 'center' }), 30);
}
function playerMenu() {
  const b = cur.book; const items = [];
  if (A.hasUrls(b)) items.push(A.isDownloaded(b) ? { label: 'Remove offline copy', id: 'ap-rm-dl', onClick: async () => { await A.removeDownload(b.id); const nb = await A.getAudiobook(b.id); Object.assign(cur.book, { tracks: nb.tracks }); toast('Offline copy removed'); } }
    : { label: 'Download for offline', id: 'ap-dl', onClick: () => downloadWithToast(b.id) });
  items.push({ label: 'Mark as finished', id: 'ap-finish', onClick: async () => { await A.setAudioStatus(b.id, 'finished'); cur.book.status = 'finished'; toast('Marked finished'); } });
  items.push({ label: 'Stop and close player', id: 'ap-stop', onClick: () => stopAndClose() });
  actionSheet(b.title, items);
}
export async function downloadWithToast(id) {
  toast('Downloading for offline…', 60000); const sig = { cancelled: false };
  try { await A.downloadOffline(id, (d, n, f) => toast(`Downloading ${Math.min(n, d + 1)} of ${n} (${Math.round(f * 100)}%)…`, 60000), sig); const b = await A.getAudiobook(id); if (cur && cur.book.id === id && b) cur.book.tracks = b.tracks; toast('Saved for offline listening', 3500); }
  catch (e) { toast(e.message || 'Download failed', 6000); }
}

/* ---------- mini player ---------- */
export function renderMini() {
  const m = $('#miniplayer'); if (!m) return;
  if (!cur || closed) { m.hidden = true; m.replaceChildren(); document.body.classList.remove('has-mini'); return; }
  const s = getState(); const c = s.chapter;
  m.hidden = false; document.body.classList.add('has-mini');
  m.replaceChildren(h('div', { class: 'mini-main', id: 'mini-open', role: 'button', tabindex: 0, 'aria-label': 'Open player', onclick: openPlayer, onkeydown: (e) => { if (e.key === 'Enter') openPlayer(); } },
    ph(s.book, 'mini-cover'), h('div', { class: 'mini-meta' }, h('div', { class: 't ellipsis', id: 'mini-title' }, s.title), h('div', { class: 'a muted small ellipsis', id: 'mini-chapter' }, s.chapters.length > 1 ? c.title : (s.author || '')))),
    h('button', { class: 'mini-btn', id: 'mini-play', 'aria-label': s.playing ? 'Pause' : 'Play', onclick: (e) => { e.stopPropagation(); togglePlay(); }, html: s.playing ? ICON.pause : ICON.play }),
    h('button', { class: 'mini-btn mini-x', id: 'mini-close', 'aria-label': 'Close player', onclick: (e) => { e.stopPropagation(); stopAndClose(); } }, '✕'),
    h('div', { class: 'mini-bar' }, h('i', { id: 'mini-prog', style: { width: Math.round((s.total ? s.pos / s.total : 0) * 100) + '%' } })));
}
let miniT = 0;
export function initPlayerUI() {
  initMediaSession();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui && !$('#overlay').children.length) closePlayer(); });   // Escape closes the full-screen player (sheets on top close first)
  onPlayer('state', renderMini);
  onPlayer('tick', () => { const p = $('#mini-prog'); if (p && cur) p.style.width = Math.round((cur.total ? gpos() / cur.total : 0) * 100) + '%'; });
}
// Test / debugging hook
window.__audio = { el, state: getState, loadBook, play, pause, seekGlobal, setSpeed, setSleep, skip, gotoChapter, save, SPEEDS, openPlayer };

// Audiobook ↔ ebook links ("Find my place" + automatic pairing). Records live in the IndexedDB `links` store and sync through Drive appData:
//   { id: '<bookKey> ⇄ <audioKey>', bookKey, audioKey, state: 'linked' | 'rejected', by: 'user' | 'auto', score, bookTitle, audioTitle, createdAt, updatedAt }
// Keys are the cross-device sync keys (S.bookSyncKey / audiobook syncKey), so a link made on one device resolves on the others.
// "rejected" is also what Unlink leaves behind, so automatic pairing never re-suggests a pair the user turned down.
import { DB } from './db.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import * as P from './pairing.js';
import { settings } from './settings.js';

export const bookKey = (b) => S.bookSyncKey(b);
export const audioKey = (a) => a.syncKey || a.id;
export const getLinks = () => DB.all('links');
const nowLink = (bk, ak, patch) => ({ id: P.pairId(bk, ak), bookKey: bk, audioKey: ak, createdAt: Date.now(), ...patch });
const emit = () => S.emitChange();

export const ebooksOf = (books) => books.filter((b) => b.format !== 'pdf');

/** Active link for an ebook or an audiobook, with the other side resolved (null when the other item isn't on this device). */
export async function linkFor(kind, item) {
  const links = (await getLinks()).filter((l) => l.state === 'linked');
  const l = links.find((x) => (kind === 'book' ? x.bookKey === bookKey(item) : x.audioKey === audioKey(item)));
  if (!l) return null;
  let other = null;
  if (kind === 'book') other = (await A.getAudiobooks()).find((a) => audioKey(a) === l.audioKey) || null;
  else other = (await S.getBooks()).find((b) => bookKey(b) === l.bookKey) || null;
  return { link: l, other };
}
export async function linkedPairs() {
  const [links, books, audios] = await Promise.all([getLinks(), S.getBooks(), A.getAudiobooks()]);
  const bk = new Map(books.map((b) => [bookKey(b), b])), ak = new Map(audios.map((a) => [audioKey(a), a]));
  return links.filter((l) => l.state === 'linked' && bk.has(l.bookKey) && ak.has(l.audioKey)).map((l) => ({ link: l, book: bk.get(l.bookKey), audio: ak.get(l.audioKey) }));
}

/** Link an ebook with an audiobook (one-to-one: anything either was linked to before is unlinked, and remembered as rejected). */
export async function link(book, audio, { by = 'user', score = null } = {}) {
  const bk = bookKey(book), ak = audioKey(audio); const id = P.pairId(bk, ak);
  for (const l of await getLinks()) if (l.state === 'linked' && l.id !== id && (l.bookKey === bk || l.audioKey === ak)) await DB.put('links', { ...l, state: 'rejected', by: 'user' });
  const old = await DB.get('links', id);
  await DB.put('links', nowLink(bk, ak, { ...(old || {}), state: 'linked', by, score, bookTitle: book.title, audioTitle: audio.title }));
  emit();
}
export async function unlink(book, audio) { return reject(bookKey(book), audioKey(audio), { bookTitle: book.title, audioTitle: audio.title }); }
export async function reject(bk, ak, titles = {}) {
  const id = P.pairId(bk, ak); const old = await DB.get('links', id);
  await DB.put('links', nowLink(bk, ak, { ...(old || {}), ...titles, state: 'rejected', by: 'user' })); emit();
}
/** Forget a rejection (so the pair can be suggested again). */
export async function clearRejection(bk, ak) { const id = P.pairId(bk, ak); const old = await DB.get('links', id); if (old?.state === 'rejected') { await DB.del('links', id); emit(); } }

/* ---------- automatic pairing ---------- */
export async function candidates() {
  const [books, sets, audios, links] = await Promise.all([S.getBooks(), S.getSets(), A.getAudiobooks(), getLinks()]);
  const setMap = new Map(sets.map((s) => [s.id, s]));
  const bs = ebooksOf(books).map((b) => ({ key: bookKey(b), item: b, profile: P.profile(b, { series: setMap.get(b.setId)?.name, seriesIndex: b.seriesIndex }) }));
  const as = audios.map((a) => ({ key: audioKey(a), item: a, profile: P.profile(a) }));
  const skip = new Set(links.filter((l) => l.state === 'rejected').map((l) => l.id));
  const linked = links.filter((l) => l.state === 'linked' && bs.some((b) => b.key === l.bookKey) && as.some((a) => a.key === l.audioKey));
  const res = P.findPairs(bs, as, { skip, linkedBooks: new Set(linked.map((l) => l.bookKey)), linkedAudios: new Set(linked.map((l) => l.audioKey)) });
  const bm = new Map(bs.map((b) => [b.key, b.item])), am = new Map(as.map((a) => [a.key, a.item]));
  const fill = (c) => ({ ...c, book: bm.get(c.bookKey), audio: am.get(c.audioKey) });
  return { auto: res.auto.map(fill), suggested: res.suggested.map(fill) };
}
export const suggestionsFor = async (kind, item) => { const { auto, suggested } = await candidates(); const key = kind === 'book' ? bookKey(item) : audioKey(item); return [...auto, ...suggested].filter((c) => (kind === 'book' ? c.bookKey : c.audioKey) === key); };

let running = false;
/** Link every high-confidence, unambiguous pair; returns { linked, suggested } (suggested = review list). Honors the "Pair automatically" setting unless force. */
export async function autoPair({ force = false } = {}) {
  if (running) return { linked: [], suggested: [] }; if (!force && !settings.get('autoPair')) return { linked: [], suggested: [] };
  running = true;
  try {
    const { auto, suggested } = await candidates();
    const sug = settings.get('autoPair') || force ? [...suggested] : [];
    if (!settings.get('autoPair')) return { linked: [], suggested: [...auto, ...suggested] };   // forced manual run with auto-linking off: nothing is linked without a click
    for (const c of auto) await link(c.book, c.audio, { by: 'auto', score: c.score });
    return { linked: auto, suggested: sug };
  } finally { running = false; }
}
const NKEY = 'folio.pairNotified';
let timer;
export function startAutoPair(notify = () => {}) {
  const run = async () => {
    try {
      const r = await autoPair(); if (!r.linked.length && !r.suggested.length) return;
      if (r.linked.length) notify('linked', r.linked);
      const seen = new Set(JSON.parse(localStorage.getItem(NKEY) || '[]')); const fresh = r.suggested.filter((c) => !seen.has(P.pairId(c.bookKey, c.audioKey)));
      if (fresh.length) { localStorage.setItem(NKEY, JSON.stringify([...seen, ...fresh.map((c) => P.pairId(c.bookKey, c.audioKey))].slice(-300))); notify('suggested', fresh); }
    } catch (e) { console.warn('auto-pair failed', e); }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 1500); };
  S.onLibraryChange(later); A.onAudioChange(later); settings.onChange((p) => { if ('autoPair' in p) later(); });
  setTimeout(later, 2500);
  return run;
}

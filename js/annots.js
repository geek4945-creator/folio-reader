// Highlights & notes (v0.5.8): per-book records in the synced `glossary` IndexedDB store with kind 'hl' (so they ride the same Drive file, the same
// backup and the same per-book key as the glossary — see glossary.js). One record = one highlighted range:
//   { id, kind:'hl', bookKey, bookTitle, fmt:'epub'|'pdf', cfiRange, text (the full excerpt), note, color, chapter, sec, off, progress, loc (pdf), at }
// Deleting leaves a { del:true } tombstone so the deletion syncs.
import { DB, uid } from './db.js';
import * as S from './store.js';

const GL = 'glossary';
export const COLORS = [
  { id: 'yellow', name: 'Yellow', hex: '#ffd54f' }, { id: 'green', name: 'Green', hex: '#81c784' }, { id: 'blue', name: 'Blue', hex: '#64b5f6' },
  { id: 'pink', name: 'Pink', hex: '#f48fb1' }, { id: 'purple', name: 'Purple', hex: '#ba68c8' },
];
export const colorHex = (id) => (COLORS.find((c) => c.id === id) || COLORS[0]).hex;
export const TEXT_MAX = 30000, NOTE_MAX = 4000;
const keyOf = (book) => S.bookSyncKey(book);
const clip = (s, n) => String(s || '').slice(0, n);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const live = (x) => x && x.kind === 'hl' && !x.del;
const changed = () => { try { S.emitChange(); } catch { /* ignore */ } try { window.dispatchEvent(new Event('folio-annots')); } catch { /* not in a window */ } };
export const lastColor = () => { const c = localStorage.getItem('folio.hlColor'); return COLORS.some((x) => x.id === c) ? c : 'yellow'; };

/** Reading order: spine section, then position inside it (EPUB); page then paragraph then offset (PDF). */
const order = (a, b) => ((a.sec ?? 0) - (b.sec ?? 0)) || ((a.off ?? 0) - (b.off ?? 0)) || ((a.at || 0) - (b.at || 0));
export async function forBook(book, filter = 'all') {
  const k = keyOf(book); const list = (await DB.all(GL)).filter((x) => live(x) && x.bookKey === k).sort(order);
  return filter === 'notes' ? list.filter((x) => x.note) : filter === 'hl' ? list.filter((x) => !x.note) : list;
}
export const get = async (id) => { const x = await DB.get(GL, id); return live(x) ? x : null; };
export async function countFor(book) { return (await forBook(book)).length; }
export async function add(book, a) {
  const text = clip(norm(a.text), TEXT_MAX); if (!text) throw new Error('Nothing selected');
  const rec = { id: uid(), at: Date.now(), kind: 'hl', bookKey: keyOf(book), bookTitle: book.title, fmt: a.fmt || 'epub', cfiRange: a.cfiRange || '', text, note: clip(a.note, NOTE_MAX), color: COLORS.some((c) => c.id === a.color) ? a.color : lastColor(),
    chapter: clip(a.chapter, 200), sec: a.sec ?? 0, off: a.off ?? 0, progress: a.progress ?? 0, ...(a.loc ? { loc: a.loc } : {}) };
  await DB.put(GL, rec); localStorage.setItem('folio.hlColor', rec.color); changed(); return rec;
}
export async function update(id, patch) {
  const cur = await DB.get(GL, id); if (!live(cur)) return null;
  const rec = { ...cur, ...(patch.note != null ? { note: clip(patch.note, NOTE_MAX) } : {}), ...(patch.color && COLORS.some((c) => c.id === patch.color) ? { color: patch.color } : {}),
    ...(patch.text ? { text: clip(norm(patch.text), TEXT_MAX), cfiRange: patch.cfiRange || '', chapter: clip(patch.chapter, 200), sec: patch.sec ?? cur.sec, off: patch.off ?? cur.off, progress: patch.progress ?? cur.progress, ...(patch.loc ? { loc: patch.loc } : {}) } : {}) };   // v0.5.11: extend / shrink the range
  await DB.put(GL, rec); if (patch.color) localStorage.setItem('folio.hlColor', rec.color); changed(); return rec;
}
export async function remove(id) { const cur = await DB.get(GL, id); if (!cur) return; await DB.put(GL, { id, bookKey: cur.bookKey, kind: 'hl', del: true }); changed(); }

/** Plain text / Markdown of a book's highlights and notes (copy / export). */
export function toMarkdown(list, book) {
  const out = ['# ' + (book.title || 'Book') + (book.author ? ' — ' + book.author : ''), '', '_Highlights & notes — ' + list.length + '_', ''];
  let chap = null;
  for (const a of list) {
    if ((a.chapter || '') !== chap) { chap = a.chapter || ''; if (chap) out.push('## ' + chap, ''); }
    out.push(a.text.split('\n').map((l) => '> ' + l).join('\n') + '  ', '_(' + a.color + (a.fmt === 'pdf' && a.loc ? ', page ' + (a.loc.sp ? a.loc.sp.page : '') : '') + ')_', '');
    if (a.note) out.push('**Note:** ' + a.note, '');
  }
  return out.join('\n');
}

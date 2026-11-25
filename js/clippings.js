// v0.5.26: import Kindle highlights & notes that the reader exported herself — the Kindle's "My Clippings.txt" (Kindle device → USB /
// documents folder) or a Kindle app notebook export (Notebook → Export → HTML email, or CSV). Matched to books already in Folio by title
// (and author when both have one). Folio never reads a Kindle account or a Kindle book file; DRM books stay in the Kindle app.
import * as S from './store.js';
import * as A from './annots.js';
import { matchRows, parseDelimited } from './kybook.js';
import { h, sheet, toast } from './util.js';

const COLOR = { yellow: 'yellow', blue: 'blue', pink: 'pink', orange: 'yellow', green: 'green', purple: 'purple' };
const colorOf = (s) => { const m = String(s || '').toLowerCase().match(/yellow|blue|pink|orange|green|purple/); return m ? COLOR[m[0]] : 'yellow'; };
const clean = (s) => String(s || '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();

export const looksLikeClippings = (name, text) => /my clippings/i.test(name || '') || (/^==========\s*$/m.test(text || '') && /^- (Your |La tua |Ihre |Votre |Tu )?\S*.*\|/m.test(text || ''));
export const looksLikeNotebookHtml = (text) => /class=["']?noteText/i.test(text || '') && /class=["']?bookTitle/i.test(text || '');
export const looksLikeNotebookCsv = (text) => /"?Annotation Type"?\s*[,;\t]\s*"?Location"?/i.test(text || '');

/** "My Clippings.txt" → [{ title, author, kind:'hl'|'note', text, loc, color }] (bookmarks are skipped). */
export function parseClippings(text) {
  const out = [];
  for (const block of String(text).replace(/\r/g, '').split(/^==========\s*$/m)) {
    const lines = block.split('\n').map((l) => l.replace(/^\uFEFF/, '')).filter((l, i, a) => i > 0 || l.trim());
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length < 2) continue;
    const head = lines[0].trim(), info = lines[1].trim(), body = clean(lines.slice(2).join('\n'));
    const m = head.match(/^(.*)\(([^()]*)\)\s*$/); const title = clean(m ? m[1] : head), author = clean(m ? m[2] : '');
    if (/bookmark|lesezeichen|signet|segnalibro|marcador/i.test(info) || !body) continue;
    const kind = /\bnote\b|notiz|remarque|nota\b/i.test(info) ? 'note' : 'hl';
    const lm = info.match(/(?:location|loc\.|position|posizione|posición|emplacement)\s*([\d]+)(?:-(\d+))?/i) || info.match(/(\d+)(?:-(\d+))?\s*\|/);
    out.push({ title, author, kind, text: body, loc: lm ? +lm[1] : null, color: 'yellow' });
  }
  return out;
}
/** Kindle notebook HTML export → same shape. */
export function parseNotebookHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const title = clean(doc.querySelector('.bookTitle')?.textContent), author = clean(doc.querySelector('.authors')?.textContent);
  const out = []; let heading = '';
  for (const el of doc.querySelectorAll('.noteHeading, .noteText')) {
    if (el.classList.contains('noteHeading')) { heading = el.textContent; continue; }
    const body = clean(el.childNodes[0]?.nodeType === 3 ? el.childNodes[0].nodeValue : el.textContent); if (!body) continue;
    const lm = heading.match(/(?:location|page|position)\s*(\d+)/i);
    out.push({ title, author, kind: /^\s*note/i.test(heading) ? 'note' : 'hl', text: body, loc: lm ? +lm[1] : null, color: colorOf(heading) });
  }
  return out;
}
/** Kindle notebook CSV export → same shape. */
export function parseNotebookCsv(text) {
  const { rows } = parseDelimited(text); const hi = rows.findIndex((r) => /annotation type/i.test(r[0] || ''));
  if (hi < 0) return [];
  const pre = rows.slice(0, hi).map((r) => clean(r[0])).filter((x) => x && !/^your kindle notes|^free kindle|^https?:|^-{5,}/i.test(x));
  const title = pre[0] || '', author = clean((pre[1] || '').replace(/^by\s+/i, ''));
  return rows.slice(hi + 1).map((r) => ({ title, author, kind: /^note/i.test(r[0] || '') ? 'note' : 'hl', text: clean(r[3]), loc: (String(r[1] || '').match(/\d+/) || [])[0] ? +String(r[1]).match(/\d+/)[0] : null, color: colorOf(r[0]) })).filter((x) => x.text);
}
export function parseAny(name, text) {
  if (looksLikeNotebookHtml(text)) return parseNotebookHtml(text);
  if (looksLikeNotebookCsv(text)) return parseNotebookCsv(text);
  return parseClippings(text);
}

/** Group by book, match to Folio, add new highlights (a Kindle note on the same location becomes that highlight's note). */
export async function importClippings(items) {
  const groups = new Map();
  for (const it of items) { const k = (it.title + '|' + it.author).toLowerCase(); (groups.get(k) || groups.set(k, { title: it.title, author: it.author, items: [] }).get(k)).items.push(it); }
  const list = [...groups.values()]; const matches = matchRows(list.map((g) => ({ title: g.title, author: g.author })), await S.getBooks());
  const sum = { books: 0, added: 0, skipped: 0, missing: [] };
  for (let i = 0; i < list.length; i++) {
    const g = list[i], book = matches[i].book;
    if (!book) { sum.missing.push(g.title + (g.author ? ' — ' + g.author : '')); continue; }
    sum.books++;
    const ex = await A.forBook(book); const have = new Set(ex.map((a) => clean(a.text).toLowerCase())); const haveNotes = new Set(ex.map((a) => clean(a.note).toLowerCase()).filter(Boolean));
    const hls = g.items.filter((x) => x.kind === 'hl'), notes = g.items.filter((x) => x.kind === 'note');
    const used = new Set();
    for (const hl of hls) {
      const k = hl.text.toLowerCase(); if (have.has(k)) { sum.skipped++; continue; }
      const n = notes.find((x) => !used.has(x) && x.loc != null && hl.loc != null && Math.abs(x.loc - hl.loc) <= 3); if (n) used.add(n);
      await A.add(book, { fmt: book.format === 'pdf' ? 'pdf' : 'epub', text: hl.text, note: n ? n.text : '', color: hl.color, chapter: 'Kindle' + (hl.loc != null ? ' · location ' + hl.loc : '') });
      have.add(k); if (n) haveNotes.add(n.text.toLowerCase()); sum.added++;
    }
    for (const n of notes) {
      if (used.has(n)) continue; const t = 'Kindle note' + (n.loc != null ? ' (location ' + n.loc + ')' : ''); if (haveNotes.has(n.text.toLowerCase())) { sum.skipped++; continue; }
      await A.add(book, { fmt: book.format === 'pdf' ? 'pdf' : 'epub', text: t, note: n.text, color: 'blue', chapter: 'Kindle' }); sum.added++;
    }
  }
  return sum;
}

export async function handleClippingsFile(file) {
  const text = await file.text(); const items = parseAny(file.name, text);
  if (!items.length) { toast('No Kindle highlights were found in “' + file.name + '”.', 5000); return null; }
  const sum = await importClippings(items);
  sheet('Kindle highlights imported', () => [
    h('ul', { id: 'clip-summary' }, h('li', { id: 'clip-added' }, `${sum.added} highlights and notes added to ${sum.books} book${sum.books === 1 ? '' : 's'}`),
      sum.skipped ? h('li', null, `${sum.skipped} already in Folio (skipped)`) : null,
      sum.missing.length ? h('li', { id: 'clip-missing' }, `${sum.missing.length} book${sum.missing.length === 1 ? '' : 's'} not in Folio: ${sum.missing.slice(0, 8).join('; ')}${sum.missing.length > 8 ? '…' : ''}`) : null),
    h('p', { class: 'muted small' }, 'Find them in each book under ☰ → Highlights & notes. Kindle doesn’t export exact positions, so they’re listed by Kindle location. Import a missing book’s DRM-free file and run this again — duplicates are skipped.'),
  ]);
  return sum;
}

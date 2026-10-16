// "Borrowed" items: ebooks / audiobooks that come from a public-library loan (a catalog source marked as a library, an OPDS availability
// date, or marked by hand). Fields on the item: borrowed (bool), dueAt (ms | null), loanAt (ms, last change – used for sync), loanSource (name).
// They live in their own Borrowed filter, outside the owned library and its counts. DRM-protected loans are still refused by the importers.
import { h, toast, sheet } from './util.js';
import * as S from './store.js';
import * as A from './audiostore.js';

export const DAY = 864e5, SOON_DAYS = 3;
export const isBorrowed = (it) => !!it?.borrowed;
export const owned = (items) => items.filter((b) => !b.borrowed);
export const borrowedOf = (items) => items.filter((b) => b.borrowed);

const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** { ms, expired, soon, days, label } for a borrowed item with a due date, else null. Days are calendar days (a loan due at the end of Friday is "Due today" all of Friday). */
export function dueInfo(it, now = Date.now()) {
  if (!it?.borrowed || !it.dueAt) return null;
  const ms = it.dueAt - now; const cal = Math.round((dayStart(it.dueAt) - dayStart(now)) / DAY);
  if (ms <= 0) { const d = Math.max(0, -cal); return { ms, expired: true, soon: false, days: -d, label: d === 0 ? 'Expired today' : d === 1 ? 'Expired 1 day ago' : `Expired ${d} days ago` }; }
  if (cal <= 0) return { ms, expired: false, soon: true, days: 0, label: 'Due today' };
  return { ms, expired: false, soon: cal <= SOON_DAYS, days: cal, label: `Due in ${cal} day${cal === 1 ? '' : 's'}` };
}
/** OPDS availability / loan date (ISO string, Date or ms) → ms or null. */
export const parseDue = (v) => { if (!v) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; };
export const dateInputValue = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const fromDateInput = (s) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 0).getTime(); };   // due at the end of that day

const API = { book: { get: S.getBook, save: (x) => S.saveBook(x), del: (ids) => S.deleteBooks(ids) }, audio: { get: A.getAudiobook, save: (x) => A.saveAudiobook(x), del: (ids) => A.deleteAudiobooks(ids) } };
export async function setLoan(kind, id, { borrowed, dueAt }) {
  const it = await API[kind].get(id); if (!it) return null;
  it.borrowed = !!borrowed; it.dueAt = borrowed ? (dueAt ?? it.dueAt ?? null) : null; it.loanAt = Date.now(); if (!borrowed) delete it.loanSource;
  await API[kind].save(it); return it;
}
export const setDue = (kind, id, dueAt) => setLoan(kind, id, { borrowed: true, dueAt });
export async function removeLoans(kind, ids) { if (ids.length) await API[kind].del(ids); }

/** Items needing attention: expired ones and those due within SOON_DAYS. */
export async function attention(kind) {
  const items = kind === 'book' ? await S.getBooks() : await A.getAudiobooks(); const now = Date.now();
  const rows = borrowedOf(items).map((it) => ({ it, info: dueInfo(it, now) })).filter((r) => r.info && (r.info.expired || r.info.soon));
  rows.sort((a, b) => a.info.ms - b.info.ms); return rows;
}
/** The reminder banner shown on the Library / Audiobooks tabs; null when nothing is expired or due soon. */
export async function loanBanner(kind, rerender) {
  const rows = await attention(kind); if (!rows.length) return null;
  const expired = rows.filter((r) => r.info.expired), soon = rows.length - expired.length;
  const done = (msg) => { toast(msg); rerender(); };
  return h('div', { class: 'loan-banner', id: 'loan-banner', role: 'status' },
    h('div', { class: 'loan-head' }, h('strong', null, '⏰ Borrowed ' + (kind === 'book' ? 'books' : 'audiobooks')), h('span', { class: 'muted small', id: 'loan-summary' }, [expired.length ? expired.length + ' expired' : '', soon ? soon + ' due soon' : ''].filter(Boolean).join(' · '))),
    ...rows.slice(0, 6).map(({ it, info }) => h('div', { class: 'loan-row' + (info.expired ? ' expired' : ''), dataset: { id: it.id } },
      h('span', { class: 'grow ellipsis' }, it.title), h('span', { class: 'loan-due' }, info.label),
      h('button', { class: 'btn small loan-remove', 'aria-label': 'Remove ' + it.title, onclick: async () => { await removeLoans(kind, [it.id]); done('Removed “' + it.title + '”'); } }, 'Remove'))),
    rows.length > 6 ? h('div', { class: 'muted small' }, '…and ' + (rows.length - 6) + ' more (see the Borrowed filter)') : null,
    expired.length ? h('button', { class: 'btn small danger', id: 'loan-remove-expired', onclick: async () => { await removeLoans(kind, expired.map((r) => r.it.id)); done(`Removed ${expired.length} expired ${expired.length === 1 ? 'item' : 'items'}`); } }, 'Remove all expired (' + expired.length + ')') : null);
}
export const dueBadge = (it) => { const i = dueInfo(it); return h('span', { class: 'loan-badge' + (i?.expired ? ' expired' : i?.soon ? ' soon' : ''), title: 'Borrowed' + (it.loanSource ? ' from ' + it.loanSource : '') }, i ? i.label : 'Borrowed'); };

/** Manual due-date picker (also reachable for items that got a date from OPDS). */
export function dueSheet(kind, it, onDone = () => {}) {
  const inp = h('input', { type: 'date', class: 'field', id: 'borrow-date', value: dateInputValue(it.dueAt) });
  const w = sheet('Borrowed: due date', () => [
    h('p', { class: 'muted small' }, 'When does this loan end? You’ll get a reminder here when it is close, and can remove it with one tap. Leave it empty if you don’t know.'),
    h('label', null, 'Due date', inp),
    h('div', { class: 'row-fields' }, [7, 14, 21].map((n) => h('button', { class: 'btn small loan-quick', 'data-days': n, onclick: () => { inp.value = dateInputValue(Date.now() + n * DAY); } }, '+' + n + ' days'))),
    h('button', { class: 'btn primary block', id: 'borrow-save', onclick: async () => { await setLoan(kind, it.id, { borrowed: true, dueAt: fromDateInput(inp.value) }); w.close(); toast(inp.value ? 'Due ' + inp.value : 'No due date'); onDone(); } }, 'Save'),
    h('button', { class: 'btn block', id: 'borrow-clear', onclick: async () => { await setLoan(kind, it.id, { borrowed: true, dueAt: null }); w.close(); onDone(); } }, 'No due date')]);
  return w;
}
/** Menu entries for ⋯ sheets (book or audiobook). */
export function loanMenuItems(kind, it, onDone) {
  return it.borrowed
    ? [{ label: 'Borrowed: set due date…', id: 'menu-due', onClick: () => dueSheet(kind, it, onDone) },
      { label: 'Not borrowed — keep it in my library', id: 'menu-unborrow', onClick: async () => { await setLoan(kind, it.id, { borrowed: false }); toast('Moved to your library'); onDone(); } }]
    : [{ label: 'Mark as borrowed (library loan)…', id: 'menu-borrow', onClick: async () => { const x = await setLoan(kind, it.id, { borrowed: true, dueAt: null }); onDone(); if (x) dueSheet(kind, x, onDone); } }];
}

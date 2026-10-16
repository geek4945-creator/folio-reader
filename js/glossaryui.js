// Glossary manager, entry editor, review screen and import for the open book (v0.5.6), plus the global "Saved words" list in Settings.
import { h, toast, sheet, confirmDlg } from './util.js';
import { settings } from './settings.js';
import * as G from './glossary.js';

const dl = (name, text, type = 'text/csv') => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
const safeName = (s) => String(s || 'book').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'book';

/** Add / edit one glossary entry. `entry` null → new; term / def prefill (e.g. from the word bubble). */
export function openTermEditor(book, { entry = null, term = '', def = '', note = '', onDone = () => {} } = {}) {
  const t = h('input', { type: 'text', class: 'field', id: 'gl-term', placeholder: 'Word, name or place', value: entry ? entry.term : term, maxlength: G.TERM_MAX });
  const d = h('textarea', { class: 'field', id: 'gl-def', rows: 4, placeholder: 'What it means', maxlength: G.DEF_MAX }, entry ? entry.def : def);
  const n = h('input', { type: 'text', class: 'field', id: 'gl-note', placeholder: 'Note (optional)', value: entry ? entry.note || '' : note });
  sheet(entry ? 'Edit glossary entry' : 'Add to glossary', (close) => [
    h('p', { class: 'muted small' }, 'Saved with “' + book.title + '”. This is checked first when you hold a word in this book' + (book.setId ? ' (and in the series if you share the glossary).' : '.')),
    h('label', { class: 'small muted', for: 'gl-term' }, 'Term'), t, h('label', { class: 'small muted', for: 'gl-def' }, 'Definition'), d, h('label', { class: 'small muted', for: 'gl-note' }, 'Note'), n,
    h('div', { class: 'row-actions' },
      entry ? h('button', { class: 'btn danger', id: 'gl-del', onclick: async () => { await G.removeEntry(entry.id); close(); toast('Entry deleted'); onDone(); } }, 'Delete') : null,
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', id: 'gl-save', onclick: async () => {
        if (!t.value.trim()) { toast('Enter the word or name first'); return; }
        if (entry) await G.updateTerm(entry.id, { term: t.value, def: d.value, note: n.value });
        else await G.addTerm(book, { term: t.value, def: d.value, note: n.value });
        close(); toast('Glossary entry saved'); onDone();
      } }, 'Save')),
  ], { noFooter: true });
  setTimeout(() => (entry || term ? d : t).focus(), 60);
}

/** Review candidates (auto-extracted, pasted or from a CSV) before anything is saved. */
export async function openReview(book, candidates, { title = 'Review entries', note = '', onDone = () => {} } = {}) {
  const have = new Set((await G.forBook(book)).own.map((x) => x.term.toLowerCase()));
  const rows = candidates.map((c) => ({ ...c, on: !have.has(String(c.term).toLowerCase()), dupe: have.has(String(c.term).toLowerCase()) }));
  let overwrite = false;
  const w = sheet(title, () => build(), { tall: true, noFooter: true });
  function build() {
    const count = () => rows.filter((r) => r.on && r.term.trim()).length;
    const go = h('button', { class: 'btn primary', id: 'rv-import', onclick: async () => {
      const list = rows.filter((r) => r.on && r.term.trim()); if (!list.length) { toast('Nothing selected'); return; }
      const res = await G.importTerms(book, list, { overwrite }); w.close();
      toast(`Imported ${res.added + res.updated} entr${res.added + res.updated === 1 ? 'y' : 'ies'}${res.skipped ? ` (${res.skipped} already there kept)` : ''}`, 4000); onDone();
    } }, 'Import ' + count());
    const upd = () => { go.textContent = 'Import ' + count(); };
    const list = h('div', { class: 'rv-list', id: 'rv-list' }, rows.map((r, i) => h('div', { class: 'rv-row' + (r.dupe ? ' dupe' : ''), 'data-i': i },
      h('input', { type: 'checkbox', class: 'rv-on', checked: r.on, 'aria-label': 'Include', onchange: (e) => { r.on = e.target.checked; upd(); } }),
      h('div', { class: 'rv-fields' },
        h('input', { type: 'text', class: 'field rv-term', value: r.term, oninput: (e) => { r.term = e.target.value; upd(); } }),
        h('textarea', { class: 'field rv-def', rows: 2, oninput: (e) => { r.def = e.target.value; } }, r.def),
        r.dupe ? h('small', { class: 'muted' }, 'Already in the glossary') : null))));
    return h('div', null,
      note ? h('p', { class: 'muted small' }, note) : null,
      rows.length ? null : h('p', { class: 'muted', id: 'rv-empty' }, 'No entries found.'),
      rows.length ? h('div', { class: 'row-actions' }, h('button', { class: 'btn small', id: 'rv-all', onclick: () => { rows.forEach((r) => { r.on = true; }); w.body.replaceChildren(build()); } }, 'Select all'), h('button', { class: 'btn small', id: 'rv-none', onclick: () => { rows.forEach((r) => { r.on = false; }); w.body.replaceChildren(build()); } }, 'Select none'),
        h('label', { class: 'small', style: { display: 'flex', gap: '.4rem', alignItems: 'center' } }, h('input', { type: 'checkbox', id: 'rv-over', onchange: (e) => { overwrite = e.target.checked; } }), 'Replace existing')) : null,
      list,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: () => w.close() }, 'Cancel'), go));
  }
  return w;
}

/** Paste text / pick a CSV or text file / use the current text selection → review. */
export function openImport(book, { getSelection = () => '', onDone = () => {} } = {}) {
  const ta = h('textarea', { class: 'field', id: 'imp-text', rows: 8, placeholder: 'One entry per line:\nAes Sedai – a woman who can channel\nSaidin: the male half of the One Power\nor CSV: term,definition' });
  const file = h('input', { type: 'file', id: 'imp-file', accept: '.csv,.tsv,.txt,text/csv,text/plain', hidden: true, onchange: async (e) => { const f = e.target.files[0]; if (!f) return; ta.value = await f.text(); ta.dataset.name = f.name; } });
  const w = sheet('Import glossary', (close) => [
    h('p', { class: 'muted small' }, 'Paste a list, choose a CSV / text file, or use the text you selected in the book. You’ll review the entries before they’re added.'),
    ta, file,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', id: 'imp-pick', onclick: () => file.click() }, 'Choose file…'),
      h('button', { class: 'btn small', id: 'imp-sel', onclick: () => { const t = getSelection(); if (!t) { toast('Select some text in the book first (press and drag), then open Import'); return; } ta.value = t; } }, 'Use selected text')),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', id: 'imp-go', onclick: () => { const list = G.parseAny(ta.value, ta.dataset.name || ''); if (!list.length) { toast('No “term – definition” lines found'); return; } close(); openReview(book, list, { title: 'Review import', note: list.length + ' entries found.', onDone }); } }, 'Review')),
  ], { noFooter: true });
  return w;
}

/**
 * The glossary / saved words manager for the open book. ctx: { book, epub?, toc?, getSelection(), goto(entry), refresh() }
 */
export async function openGlossary(ctx, tab = 'glossary') {
  const book = ctx.book; let q = '';
  const w = sheet('Words & glossary', () => h('div', { id: 'gl-root' }), { tall: true });
  const root = w.body.firstChild;
  const rebuild = async () => { root.replaceChildren(await build()); };
  async function build() {
    const f = await G.forBook(book); const shared = await G.isShared(book);
    const seg = h('div', { class: 'seg wide' }, [['glossary', 'Glossary (' + f.terms.length + ')'], ['words', 'Saved words (' + f.words.length + ')']].map(([k, n]) => h('button', { class: tab === k ? 'on' : '', 'data-tab': k, onclick: () => { tab = k; rebuild(); } }, n)));
    const box = h('div');
    if (tab === 'glossary') {
      const search = h('input', { type: 'search', class: 'field', id: 'gl-search', placeholder: 'Search the glossary', value: q, oninput: (e) => { q = e.target.value; fill(); } });
      const listEl = h('div', { class: 'list gl-list', id: 'gl-list' });
      const fill = () => {
        const n = q.trim().toLowerCase(); const items = f.terms.filter((t) => !n || t.term.toLowerCase().includes(n) || (t.def || '').toLowerCase().includes(n));
        listEl.replaceChildren(...(items.length ? items.map((t) => h('div', { class: 'list-item gl-item', 'data-id': t.id },
          h('div', { class: 'grow', onclick: () => openTermEditor(book, { entry: t, onDone: rebuild }) }, h('strong', null, t.term), t.src === 'auto' || t.src === 'import' ? h('small', { class: 'muted' }, ' · ' + t.src) : null, t.bookKey !== G.keyOf(book) ? h('small', { class: 'muted' }, ' · ' + (t.bookTitle || 'series')) : null, h('div', { class: 'gl-def small' }, t.def), t.note ? h('div', { class: 'muted small' }, t.note) : null),
          h('button', { class: 'btn-icon', 'aria-label': 'Edit', onclick: () => openTermEditor(book, { entry: t, onDone: rebuild }) }, '✎'))) : [h('p', { class: 'muted pad', id: 'gl-empty' }, f.terms.length ? 'No matches.' : 'No glossary yet. Hold a word and tap “＋ Glossary”, or find / import entries below.')]));
      };
      fill();
      box.append(search, listEl,
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn', id: 'gl-add', onclick: () => openTermEditor(book, { onDone: rebuild }) }, '＋ Add entry'),
          h('button', { class: 'btn', id: 'gl-find', disabled: !ctx.epub, title: ctx.epub ? '' : 'Only available for EPUB books', onclick: () => findInBook() }, 'Find in this book'),
          h('button', { class: 'btn', id: 'gl-import', onclick: () => openImport(book, { getSelection: ctx.getSelection, onDone: rebuild }) }, 'Import…'),
          h('button', { class: 'btn', id: 'gl-export', disabled: !f.own.length, onclick: () => dl(safeName(book.title) + '-glossary.csv', G.toCsv(f.own)) }, 'Export CSV')),
        h('label', { class: 'toggle-row', id: 'gl-share-row' }, h('input', { type: 'checkbox', id: 'gl-share', checked: shared, disabled: !book.setId, onchange: async (e) => { await G.setShared(book, e.target.checked); toast(e.target.checked ? 'Shared with the other books in this series' : 'Not shared'); rebuild(); } }),
          h('span', null, 'Share this glossary with the series', h('small', { class: 'muted' }, book.setId ? ' — the other books of the series see these entries' : ' — add the book to a series first'))),
        h('label', { class: 'toggle-row', id: 'gl-hl-row' }, h('input', { type: 'checkbox', id: 'gl-hl', checked: !!settings.get('glossaryHighlight'), onchange: (e) => { settings.set({ glossaryHighlight: e.target.checked }); } }),
          h('span', null, 'Underline glossary terms in the text', h('small', { class: 'muted' }, ' — needs a recent browser'))));
    } else {
      const items = f.words;
      box.append(h('div', { class: 'list gl-list', id: 'sw-list' }, items.length ? items.map((x) => h('div', { class: 'list-item gl-item', 'data-id': x.id },
        h('div', { class: 'grow', onclick: () => { if (ctx.goto && (x.cfi || x.page)) { w.close(); ctx.goto(x); } } }, h('strong', null, x.term), x.pos ? h('small', { class: 'muted' }, ' · ' + x.pos) : null, x.phonetic ? h('small', { class: 'muted' }, ' ' + x.phonetic) : null, h('div', { class: 'gl-def small' }, x.def || '(no definition saved)'), x.ctx ? h('div', { class: 'muted small gl-ctx' }, '“' + x.ctx + '”') : null),
        h('button', { class: 'btn-icon', 'aria-label': 'Delete', onclick: async () => { await G.removeEntry(x.id); rebuild(); } }, '🗑'))) : [h('p', { class: 'muted pad', id: 'sw-empty' }, 'No saved words yet. Hold a word in the book and tap “Save to book”.')]),
      items.length ? h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'sw-export', onclick: () => dl(safeName(book.title) + '-saved-words.csv', G.toCsv(items.map((x) => ({ term: x.term, def: x.def, note: x.ctx })))) }, 'Export CSV'), h('button', { class: 'btn danger', id: 'sw-clear', onclick: async () => { if (await confirmDlg('Clear saved words?', 'Removes all ' + items.length + ' saved words of this book (glossary entries stay).', 'Clear', true)) { await G.clearBookWords(book); rebuild(); } } }, 'Clear all')) : null);
    }
    return h('div', null, seg, box);
  }
  async function findInBook() {
    const pages = G.glossaryPages(ctx.epub, ctx.toc || []);
    if (!pages.length) { toast('No glossary or appendix pages found in this book. You can paste a list with Import.', 4500); return; }
    toast('Reading ' + pages.length + ' page' + (pages.length === 1 ? '' : 's') + '…', 1500);
    const all = new Map(); for (const p of pages.slice(0, 12)) { try { for (const c of await G.extractFromSection(ctx.epub, p.href)) if (!all.has(c.term.toLowerCase())) all.set(c.term.toLowerCase(), { ...c, from: p.label }); } catch (e) { console.warn('glossary page', p.href, e); } }
    openReview(book, [...all.values()], { title: 'Found in the book', note: 'From: ' + pages.slice(0, 12).map((p) => p.label).join(' · ') + '. Untick anything that isn’t a glossary entry and fix wording before importing.', onDone: rebuild });
  }
  await rebuild();
  const onCh = () => { if (document.body.contains(root)) rebuild(); };
  window.addEventListener('folio-glossary', onCh);
  return w;
}

/** Settings → Word lookup: every book with saved words / glossary entries. */
export async function openAllWords() {
  const books = await G.savedCounts();
  sheet('Saved words & glossaries', () => h('div', { id: 'aw-root' },
    books.length ? h('div', { class: 'list' }, books.map((b) => h('button', { class: 'list-item', 'data-key': b.key, onclick: () => showBook(b) }, h('span', { class: 'grow' }, b.title), h('small', { class: 'muted' }, `${b.terms} glossary · ${b.words} saved`))))
      : h('p', { class: 'muted pad', id: 'aw-empty' }, 'Nothing yet. In the reader, press and hold a word to look it up, save it, or add it to the book’s glossary.')), { tall: true });
  async function showBook(b) {
    const ents = (await G.wordsOfKey(b.key)).sort((a, c) => a.term.localeCompare(c.term));
    sheet(b.title, () => [h('div', { class: 'list' }, ents.map((x) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('strong', null, x.term), h('small', { class: 'muted' }, x.kind === 'word' ? ' · saved word' : ' · glossary'), h('div', { class: 'small' }, x.def || '')),
      h('button', { class: 'btn-icon', 'aria-label': 'Delete', onclick: async (e) => { await G.removeEntry(x.id); e.target.closest('.list-item').remove(); } }, '🗑')))),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', onclick: () => dl(safeName(b.title) + '-words.csv', G.toCsv(ents.map((x) => ({ term: x.term, def: x.def, note: x.note || x.ctx || '' })))) }, 'Export CSV'))], { tall: true });
  }
}

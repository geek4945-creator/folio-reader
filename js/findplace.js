// "Find my place": move between an audiobook and its ebook, plus the pairing UI (suggested pairs, linked pairs, settings toggle).
// Every position produced here is an ESTIMATE (percent of audio length ≈ percent of text, or chapter-aligned when chapter titles / numbers match);
// the UI says so and offers − / + nudges before anything is applied.
import { h, toast, sheet } from './util.js';
import { settings } from './settings.js';
import * as S from './store.js';
import * as A from './audiostore.js';
import * as L from './links.js';
import * as P from './pairing.js';
import * as Al from './align.js';
import { currentReader, closeReader, openReader } from './reader.js';
import { getState, seekGlobal, fmtTime, closePlayer } from './audioplayer.js';

/** Find `q` in one loaded epub.js section: case-insensitive, whitespace-collapsed, and across inline markup (epub.js's own section.search only sees a few
 *  neighbouring text nodes). Returns [{ cfi, excerpt }]. */
export function searchSection(sec, q, max = 25) {
  const doc = sec.document; const root = doc && (doc.body || doc.documentElement); if (!root) return [];
  const walker = doc.createTreeWalker(root, 4, null); const nodes = []; let n; while ((n = walker.nextNode())) { const p = n.parentNode && n.parentNode.nodeName.toLowerCase(); if (p === 'script' || p === 'style') continue; nodes.push(n); }
  let norm = ''; const at = []; let prevSpace = true;   // at[i] = [node index, offset] of normalised char i
  nodes.forEach((node, ni) => { const d = node.data; for (let i = 0; i < d.length; i++) { const sp = /\s/.test(d[i]); if (sp) { if (prevSpace) continue; norm += ' '; } else norm += d[i].toLowerCase(); at.push([ni, i]); prevSpace = sp; } });
  const needle = q.replace(/\s+/g, ' ').trim().toLowerCase(); if (!needle) return [];
  const out = []; let from = 0;
  while (out.length < max) {
    const i = norm.indexOf(needle, from); if (i < 0) break; from = i + needle.length;
    try { const [sn, so] = at[i], [en, eo] = at[i + needle.length - 1]; const r = doc.createRange(); r.setStart(nodes[sn], so); r.setEnd(nodes[en], eo + 1);
      out.push({ cfi: sec.cfiFromRange(r), excerpt: (i > 75 ? '…' : '') + norm.slice(Math.max(0, i - 75), i + needle.length + 75).trim() + '…' }); } catch { /* skip an unmappable hit */ }
  }
  return out;
}

/* ---------- headless ebook engine (epub.js) ---------- */
const engines = new Map();
async function engineFor(book) {
  let e = engines.get(book.id); if (e) return e;
  const blob = await S.getFile(book.id); if (!blob) throw new Error('The ebook file is missing on this device');
  const epub = ePub(await blob.arrayBuffer()); await epub.ready;
  const fresh = await S.getBook(book.id); let ready = false;
  if (fresh.locations) { try { epub.locations.load(fresh.locations); ready = epub.locations.total > 0; } catch { /* regenerate */ } }
  if (!ready) { await epub.locations.generate(1600); const b = await S.getBook(book.id); b.locations = epub.locations.save(); b._noTouch = true; await S.saveBook(b); }
  const locs = epub.locations._locations || []; const total = Math.max(1, locs.length);
  const nav = await epub.loaded.navigation; const flat = (items) => items.flatMap((it) => [it, ...flat(it.subitems || [])]);
  const spineLen = epub.spine.length || 1; const startOf = new Map();
  const fracOfSection = (sec) => { if (!sec) return null; if (startOf.has(sec.index)) return startOf.get(sec.index); const base = sec.cfiBase; let i = base ? locs.findIndex((c) => c.includes(base + '!') || c.includes(base + '/')) : -1; const f = i >= 0 ? i / total : sec.index / spineLen; startOf.set(sec.index, f); return f; };
  const chapters = []; for (const it of flat(nav.toc || [])) { let sec = null; try { sec = epub.spine.get(it.href); } catch { /* ignore */ } const f = fracOfSection(sec); if (f != null) chapters.push({ title: (it.label || '').trim(), frac: f, href: it.href }); }
  e = { epub, chapters, locs, total,
    fracOfCfi: (cfi) => { try { return Math.max(0, Math.min(1, epub.locations.percentageFromCfi(cfi) || 0)); } catch { return 0; } },
    cfiAt: (f) => epub.locations.cfiFromPercentage(Math.max(0, Math.min(0.9999, f))),
    chapterAt: (f) => { let c = null; for (const x of chapters) if (x.frac <= f + 1e-9) c = x; return c; },
    async search(q, { max = 25 } = {}) {
      const tries = []; const clean = q.replace(/\s+/g, ' ').trim(); if (clean.length < 3) return { hits: [], partial: false };
      tries.push([clean, false]); const w = clean.split(' '); if (w.length > 6) tries.push([w.slice(0, 6).join(' '), true]); if (w.length > 3) tries.push([w.slice(0, 3).join(' '), true]);
      for (const [t, partial] of tries) {
        const hits = [];
        for (let i = 0; i < epub.spine.length && hits.length < max; i++) {
          const sec = epub.spine.get(i); try { await sec.load(epub.load.bind(epub)); for (const r of searchSection(sec, t, max - hits.length)) hits.push({ cfi: r.cfi, excerpt: (r.excerpt || '').replace(/\s+/g, ' ').trim() }); } catch { /* unreadable section */ } finally { try { sec.unload(); } catch { /* ignore */ } }
        }
        if (hits.length) return { hits: hits.map((x) => ({ ...x, frac: e.fracOfCfi(x.cfi) })), partial };
      }
      return { hits: [], partial: false };
    },
    destroy() { try { epub.destroy(); } catch { /* ignore */ } engines.delete(book.id); } };
  engines.set(book.id, e); return e;
}
export const dropEngines = () => { for (const e of [...engines.values()]) e.destroy(); };

/* ---------- audio side ---------- */
export function audioInfo(a) {
  const offs = []; let t = 0; for (const tr of a.tracks) { offs.push(t); t += tr.duration || 0; }
  const total = t || a.duration || 0;
  const chapters = (a.chapters || []).map((c, i) => ({ title: c.title || 'Chapter ' + (i + 1), start: (offs[c.track] ?? 0) + (c.start || 0) })).sort((x, y) => x.start - y.start);
  const live = getState(); const pos = live && live.id === a.id ? live.pos : a.position || 0;
  return { total, chapters, pos };
}
const pct = (f, d = 1) => (f * 100).toFixed(d) + '%';

/** Build the position map for a pair: chapter-aligned when ≥ 2 chapters match by title / number, else overall percent. */
export function mapFor(audio, eng) {
  const ai = audioInfo(audio); const anchors = Al.matchChapters(ai.chapters, eng.chapters);
  return { map: Al.buildMap(anchors, ai.total), ai };
}
const methodText = (m) => (m.method === 'chapters' ? `chapter-aligned: ${m.matched} chapters matched by title / number` : 'overall percent: audio length vs. ebook length');

async function openEbookAt(book, cfi, frac) {
  if (currentReader()) await closeReader();
  const b = await S.getBook(book.id); b.cfi = cfi; b.progress = frac; b.lastOpened = Date.now(); if (b.status === 'want') b.status = 'reading'; await S.saveBook(b);
  try { closePlayer(); } catch { /* not open */ }
  await openReader(b.id);
}
async function setAudioTo(audio, t) {
  const total = audioInfo(audio).total; t = Math.max(0, Math.min(total, t));
  const a = await A.getAudiobook(audio.id); a.position = t; a.progress = total ? t / total : 0; a.lastOpened = Date.now(); if (a.status === 'want') a.status = 'reading'; await A.saveAudiobook(a);
  const st = getState(); if (st && st.id === audio.id) await seekGlobal(t, false);
  return t;
}

/* ---------- the Find my place sheet ---------- */
export async function openFindPlace({ bookId, audioId }) {
  let book = bookId ? await S.getBook(bookId) : null, audio = audioId ? await A.getAudiobook(audioId) : null;
  const kind = book ? 'book' : 'audio'; const me = book || audio; if (!me) return;
  const st = { changing: false, aNudge: 0, bNudge: 0, bBase: null, bSource: 'reader', hits: null, searching: false, error: '' };
  const w = sheet('Find my place', () => [h('div', { id: 'fp-root' })], { tall: true, onClose: () => { dropEngines(); } });
  const root = w.body.querySelector('#fp-root');

  async function resolve() {
    const lk = await L.linkFor(kind, me);
    if (lk?.other) { if (kind === 'book') audio = lk.other; else book = lk.other; return lk; }
    return null;
  }
  async function render() {
    root.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
    const lk = await resolve();
    if (!lk || st.changing) return renderLink(lk);
    book = await S.getBook(book.id); audio = await A.getAudiobook(audio.id);
    root.replaceChildren(h('p', { class: 'muted', id: 'fp-prep' }, 'Preparing the ebook (finding chapters and text positions)…'));
    let eng; try { eng = await engineFor(book); } catch (e) { root.replaceChildren(h('p', { class: 'plib-warn' }, 'Can’t read this ebook: ' + (e.message || e))); return; }
    renderTools(lk, eng);
  }
  async function renderLink(lk) {
    const others = kind === 'book' ? await A.getAudiobooks() : L.ebooksOf(await S.getBooks());
    const sugg = await L.suggestionsFor(kind, me);
    const doLink = async (other) => { const b = kind === 'book' ? me : other, a = kind === 'book' ? other : me; await L.link(b, a, { by: 'user' }); st.changing = false; book = b; audio = a; toast('Linked'); render(); };
    const sel = h('select', { class: 'field', id: 'fp-choose' }, h('option', { value: '' }, kind === 'book' ? 'Choose an audiobook…' : 'Choose an ebook…'), others.sort((x, y) => x.title.localeCompare(y.title)).map((o) => h('option', { value: o.id }, o.title + (o.author ? ' — ' + o.author : ''))));
    root.replaceChildren(
      lk ? h('div', { class: 'fp-linked' }, h('strong', null, 'Currently linked: '), lk.other?.title || 'item not on this device', ' ', h('button', { class: 'btn small', id: 'fp-cancel-change', onclick: () => { st.changing = false; render(); } }, 'Keep it')) : null,
      h('p', { class: 'muted small' }, kind === 'book' ? 'Link this ebook with its audiobook, then jump between them.' : 'Link this audiobook with its ebook, then jump between them.'),
      sugg.length ? h('div', { class: 'list', id: 'fp-suggestions' }, h('div', { class: 'sep' }, 'Suggested matches'), sugg.filter((c) => !lk || (kind === 'book' ? c.audioKey : c.bookKey) !== (kind === 'book' ? lk.link.audioKey : lk.link.bookKey)).map((c) => { const o = kind === 'book' ? c.audio : c.book; return h('div', { class: 'list-item fp-sugg', dataset: { id: o.id } }, h('span', { class: 'grow' }, o.title, h('small', { class: 'muted' }, ' · ' + (o.author || 'unknown author') + ' · ' + c.score + '% match')), h('button', { class: 'btn small primary fp-link', onclick: () => doLink(o) }, 'Link')); })) : h('p', { class: 'muted small', id: 'fp-nosugg' }, 'No confident match found automatically.'),
      h('label', null, 'Or pick one yourself', sel), h('button', { class: 'btn block', id: 'fp-link-chosen', onclick: () => { const o = others.find((x) => x.id === sel.value); if (o) doLink(o); else toast('Pick one first'); } }, 'Link selected'));
  }
  function renderTools(lk, eng) {
    const { map, ai } = mapFor(audio, eng);
    const ebookNow = (() => { const cr = currentReader(); if (cr && cr.book?.id === book.id && cr.progress != null) return { frac: cr.progress, cfi: cr.loc?.start?.cfi || book.cfi }; return { frac: book.progress || 0, cfi: book.cfi }; })();
    if (st.bBase == null) st.bBase = ebookNow.frac;
    const aEst = () => Math.max(0, Math.min(0.9999, Al.audioToFrac(map, ai.pos) + st.aNudge));
    const bEst = () => Math.max(0, Math.min(ai.total, Al.fracToAudio(map, st.bBase) + st.bNudge));
    const chap = (f) => eng.chapterAt(f)?.title;
    const aBox = h('div', { class: 'fp-box' }), bBox = h('div', { class: 'fp-box' }), cBox = h('div', { class: 'fp-box' });
    const nudgeBtns = (list, set) => h('div', { class: 'fp-nudge' }, list.map(([id, label, d]) => h('button', { class: 'btn small', id, onclick: () => { set(d); } }, label)));
    function paintA() {
      const f = aEst();
      aBox.replaceChildren(h('h4', null, 'Jump ebook to audio position'),
        h('p', { class: 'small' }, `Audiobook is at ${fmtTime(ai.pos)} of ${fmtTime(ai.total)} (${pct(ai.total ? ai.pos / ai.total : 0)}).`),
        h('p', { id: 'fp-a-est' }, '≈ ', h('strong', { id: 'fp-a-pct' }, pct(f)), ' of the ebook', chap(f) ? ' · near “' + chap(f) + '”' : ''),
        h('p', { class: 'muted small fp-method', id: 'fp-a-method' }, 'Estimate — ' + methodText(map) + '. Nudge if it lands a little early or late.'),
        nudgeBtns([['fp-a-m2', '−2%', -0.02], ['fp-a-m05', '−0.5%', -0.005], ['fp-a-p05', '+0.5%', 0.005], ['fp-a-p2', '+2%', 0.02]], (d) => { st.aNudge += d; paintA(); }),
        st.aNudge ? h('p', { class: 'muted small', id: 'fp-a-nudge' }, 'Nudge: ' + (st.aNudge > 0 ? '+' : '') + (st.aNudge * 100).toFixed(1) + '%') : null,
        h('button', { class: 'btn primary block', id: 'fp-open-reader', onclick: async () => { const fr = aEst(); const cfi = eng.cfiAt(fr); w.close(); await openEbookAt(book, cfi, fr); toast('Opened the ebook at ≈ ' + pct(fr) + ' (estimate)'); } }, 'Open ebook here'));
    }
    function paintB() {
      const t = bEst();
      bBox.replaceChildren(h('h4', null, 'Set audiobook from the ebook'),
        h('p', { class: 'small', id: 'fp-b-from' }, st.bSource === 'phrase' ? `From the phrase match at ${pct(st.bBase)}` : `Ebook is at ${pct(st.bBase)}`, chap(st.bBase) ? ' · ' + chap(st.bBase) : '', ' ', st.bSource === 'phrase' ? h('button', { class: 'btn-text small', id: 'fp-b-reset', onclick: () => { st.bBase = ebookNow.frac; st.bSource = 'reader'; st.bNudge = 0; paintB(); } }, 'use my reading place instead') : null),
        h('p', { id: 'fp-b-est' }, '≈ ', h('strong', { id: 'fp-b-time' }, fmtTime(t)), ' of ' + fmtTime(ai.total) + ' in the audiobook'),
        h('p', { class: 'muted small fp-method', id: 'fp-b-method' }, 'Estimate — ' + methodText(map) + '.'),
        nudgeBtns([['fp-b-m60', '−1 min', -60], ['fp-b-m10', '−10 s', -10], ['fp-b-p10', '+10 s', 10], ['fp-b-p60', '+1 min', 60]], (d) => { st.bNudge += d; paintB(); }),
        st.bNudge ? h('p', { class: 'muted small', id: 'fp-b-nudge' }, 'Nudge: ' + (st.bNudge > 0 ? '+' : '') + st.bNudge + ' s') : null,
        h('button', { class: 'btn primary block', id: 'fp-set-audio', onclick: async () => { const x = await setAudioTo(audio, bEst()); toast('Audiobook set to ' + fmtTime(x) + ' (estimate)'); ai.pos = x; paintA(); } }, 'Set audiobook here'));
    }
    function paintC() {
      const input = h('input', { class: 'field', id: 'fp-phrase', placeholder: 'Type a phrase from the page you’re on', autocomplete: 'off', value: st.phrase || '' });
      const go = async () => { st.phrase = input.value; st.searching = true; st.hits = null; paintC(); try { st.res = await eng.search(st.phrase); } catch (e) { st.res = { hits: [], partial: false, error: e.message }; } st.searching = false; paintC(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      cBox.replaceChildren(h('h4', null, 'Find by phrase'), h('div', { class: 'row-fields' }, input, h('button', { class: 'btn', id: 'fp-search', onclick: go }, 'Search')),
        st.searching ? h('p', { class: 'muted small', id: 'fp-searching' }, 'Searching the ebook…') : null,
        st.res ? (st.res.hits.length ? h('div', { class: 'list', id: 'fp-hits' }, st.res.partial ? h('p', { class: 'muted small' }, 'No exact match, showing matches for the first words only.') : null,
          st.res.hits.map((x, i) => h('div', { class: 'fp-hit', dataset: { i } }, h('div', { class: 'small fp-excerpt' }, x.excerpt), h('div', { class: 'muted small' }, `≈ ${pct(x.frac)}` + (chap(x.frac) ? ' · ' + chap(x.frac) : '')),
            h('div', { class: 'row-actions' }, h('button', { class: 'btn small fp-hit-open', onclick: async () => { w.close(); await openEbookAt(book, x.cfi, x.frac); } }, 'Open in ebook'),
              h('button', { class: 'btn small fp-hit-audio', onclick: () => { st.bBase = x.frac; st.bSource = 'phrase'; st.bNudge = 0; paintB(); bBox.scrollIntoView?.({ block: 'nearest' }); toast('Audio estimate updated from this match'); } }, 'Set audio from here'))))) : h('p', { class: 'muted small', id: 'fp-nohits' }, st.res.error || 'No match found. Try a few exact words from the text.')) : null);
    }
    root.replaceChildren(
      h('div', { class: 'fp-linked' }, h('strong', null, '📖 ' + book.title), h('span', { class: 'muted' }, ' ⇄ '), h('strong', null, '🎧 ' + audio.title), ' ',
        h('button', { class: 'btn small', id: 'fp-change', onclick: () => { st.changing = true; render(); } }, 'Change…'), ' ',
        h('button', { class: 'btn small danger', id: 'fp-unlink', onclick: async () => { await L.unlink(book, audio); toast('Unlinked'); render(); } }, 'Unlink')),
      h('p', { class: 'muted small' }, 'These positions are estimates: narration speed, front matter and cut chapters make audio and text drift. Use the nudge buttons to fine-tune.'),
      aBox, bBox, cBox);
    paintA(); paintB(); paintC();
    window.__findplace = { st, map, ai, eng, book, audio };
  }
  await render();
}

/* ---------- pairs: suggested / linked / settings ---------- */
export async function openPairs() {
  const w = sheet('Audiobook ↔ ebook pairs', () => [h('div', { id: 'pairs-root' })], { tall: true });
  const root = w.body.querySelector('#pairs-root');
  async function render() {
    const [{ auto, suggested }, linked, links] = await Promise.all([L.candidates(), L.linkedPairs(), L.getLinks()]);
    const auto_on = !!settings.get('autoPair'); const review = auto_on ? suggested : [...auto, ...suggested];
    const rejected = links.filter((x) => x.state === 'rejected');
    const row = (c) => h('div', { class: 'list-item pair-row', dataset: { book: c.book.id, audio: c.audio.id, score: c.score } },
      h('span', { class: 'grow' }, h('div', null, '📖 ' + c.book.title, h('small', { class: 'muted' }, c.book.author ? ' · ' + c.book.author : '')), h('div', null, '🎧 ' + c.audio.title, h('small', { class: 'muted' }, c.audio.author ? ' · ' + c.audio.author : '')), h('small', { class: 'muted' }, c.score + '% match · ' + c.why.join(', '))),
      h('button', { class: 'btn small primary pair-accept', onclick: async () => { await L.link(c.book, c.audio, { by: 'user', score: c.score }); toast('Linked'); render(); } }, 'Accept'),
      h('button', { class: 'btn small pair-reject', onclick: async () => { await L.reject(c.bookKey, c.audioKey, { bookTitle: c.book.title, audioTitle: c.audio.title }); toast('Won’t suggest this pair again'); render(); } }, 'Reject'));
    root.replaceChildren(
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', id: 'pairs-auto', checked: auto_on, onchange: async (e) => { settings.set({ autoPair: e.target.checked }); if (e.target.checked) await L.autoPair(); render(); } }), ' Pair automatically (link when ≥ 85% sure)'),
      h('p', { class: 'muted small' }, 'Matches use the normalised title (without “unabridged”, subtitles or series prefixes), author, series + number and ISBN. Anything less sure than 85% is only suggested here. Rejected or unlinked pairs are remembered.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn small', id: 'pairs-scan', onclick: async () => { const r = await L.autoPair({ force: true }); toast(r.linked.length ? `Linked ${r.linked.length} pair${r.linked.length === 1 ? '' : 's'}` : 'No new confident matches'); render(); } }, 'Find pairs now')),
      h('h4', null, 'Suggested pairs' + (review.length ? ' (' + review.length + ')' : '')),
      review.length ? h('div', { class: 'list', id: 'pairs-suggested' }, review.map(row)) : h('p', { class: 'muted small', id: 'pairs-none' }, 'Nothing to review.'),
      h('h4', null, 'Linked' + (linked.length ? ' (' + linked.length + ')' : '')),
      linked.length ? h('div', { class: 'list', id: 'pairs-linked' }, linked.map(({ link, book, audio }) => h('div', { class: 'list-item pair-linked', dataset: { book: book.id, audio: audio.id, by: link.by } },
        h('span', { class: 'grow' }, h('div', null, '📖 ' + book.title), h('div', null, '🎧 ' + audio.title), h('small', { class: 'muted' }, link.by === 'auto' ? 'linked automatically' + (link.score ? ' · ' + link.score + '%' : '') : 'linked by you')),
        h('button', { class: 'btn small pair-open', onclick: () => { w.close(); openFindPlace({ bookId: book.id }); } }, 'Find my place'),
        h('button', { class: 'btn small danger pair-unlink', onclick: async () => { await L.unlink(book, audio); toast('Unlinked'); render(); } }, 'Unlink')))) : h('p', { class: 'muted small', id: 'pairs-nolinks' }, 'No linked pairs yet.'),
      rejected.length ? h('div', { class: 'row-actions' }, h('span', { class: 'muted small', id: 'pairs-rejected-count' }, rejected.length + ' rejected / unlinked pair' + (rejected.length === 1 ? '' : 's') + ' remembered'), h('button', { class: 'btn small', id: 'pairs-forget', onclick: async () => { for (const x of rejected) await L.clearRejection(x.bookKey, x.audioKey); toast('Forgot rejected pairs'); render(); } }, 'Forget')) : null);
  }
  await render();
}
export function pairSettingsSection() {
  return h('section', { class: 'pad card-sec', id: 'sec-pairs' }, h('h3', null, 'Audiobook ↔ ebook pairs'),
    h('p', { class: 'muted small' }, 'Link an audiobook with the ebook of the same book to jump between your listening and reading place. Folio compares titles, authors, series and ISBN on your device only.'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', id: 'auto-pair', checked: !!settings.get('autoPair'), onchange: (e) => settings.set({ autoPair: e.target.checked }) }), ' Pair automatically (when ≥ 85% sure; otherwise suggested for review)'),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'settings-pairs', onclick: () => openPairs() }, 'Review pairs…')));
}
export function pairNotify(kind, list) {
  if (kind === 'linked') toast(`Linked ${list.length} audiobook${list.length === 1 ? '' : 's'} with ${list.length === 1 ? 'its' : 'their'} ebook${list.length === 1 ? '' : 's'} — ${list.map((c) => '“' + c.book.title + '”').slice(0, 2).join(', ')}${list.length > 2 ? '…' : ''}`, 4500, { label: 'Review', onClick: () => openPairs() });
  else if (kind === 'suggested') toast(`${list.length} suggested audiobook ↔ ebook pair${list.length === 1 ? '' : 's'}`, 6000, { label: 'Review', onClick: () => openPairs() });
}

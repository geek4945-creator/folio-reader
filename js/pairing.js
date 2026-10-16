// Audiobook ↔ ebook matching (pure functions, no DOM / IndexedDB): normalised title, author, series + index and ISBN → a 0–100 confidence.
// ≥ AUTO_MIN (and unambiguous) links automatically; SUGGEST_MIN … AUTO_MIN goes to the "Suggested pairs" review list.
export const AUTO_MIN = 85, SUGGEST_MIN = 55;

const strip = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const NOISE = /\b(unabridged|abridged|audiobook|audio book|audio edition|ebook|e-book|kindle edition|library edition|dramatized|complete|full[- ]cast|narrated by [^,:;()\-–]+|read by [^,:;()\-–]+)\b/gi;
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export const squash = (s) => strip(s).toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => squash(s).split(' ').filter(Boolean);

/** "Saga, Book 2" / "Saga #2" / "(Saga, #2)" / "Saga 2" series hints inside a title. */
export function seriesFromTitle(title) {
  const t = strip(title || '');
  let m = /\(([^()]+?)[,;:]?\s*(?:book|vol(?:ume)?\.?|no\.?|part|#)\s*(\d+(?:\.\d+)?)\)/i.exec(t) || /^(.+?)[,:]?\s*(?:book|vol(?:ume)?\.?|#)\s*(\d+(?:\.\d+)?)\s*[:\-–—]\s*.+$/i.exec(t) || /^(.+?)\s*#(\d+(?:\.\d+)?)\s*$/i.exec(t);
  return m ? { name: squash(m[1]), index: parseFloat(m[2]) } : null;
}
/** Title variants used for comparison: the full cleaned title and the "main" title (no subtitle, no series prefix, no leading article). */
export function titleForms(raw, seriesName) {
  let t = strip(raw || '').replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(NOISE, ' ');
  const sh = seriesFromTitle(raw); const sName = squash(seriesName || sh?.name || '');
  t = t.replace(/\s+/g, ' ').trim();
  const cut = (x) => x.replace(/^(the|a|an)\s+/i, '');
  const full = squash(cut(t));
  let main = t.split(/\s*[:;–—]\s+|\s+-\s+|[;,]?\s+or,\s+/i)[0] || t;   // "Frankenstein; or, the Modern Prometheus" → "Frankenstein"
  if (sName && squash(t).startsWith(sName + ' ') && !squash(main).startsWith(sName + ' ') === false) { /* keep */ }
  // "Saga, Book 2 - The Title"  →  "The Title"
  const pre = /^(.+?)[,:]?\s*(?:book|vol(?:ume)?\.?|#)\s*\d+(?:\.\d+)?\s*[:\-–—]\s*(.+)$/i.exec(t); if (pre) main = pre[2].split(/\s*[:–—]\s+/)[0];
  else if (sName && squash(main).startsWith(sName + ' ') && squash(main).length > sName.length + 3) main = main.slice(main.toLowerCase().indexOf(sName.split(' ')[0]) + sName.length).replace(/^[\s,:#\-–]+/, '') || main;
  const m = squash(cut(main.replace(/\s+/g, ' ').trim()));
  const dz = (x) => x.split(' ').map((w) => (NUMW[w] ? String(NUMW[w]) : w)).join(' ');
  return { full: dz(full), main: dz(m || full) };
}
export function authorSurnames(a) {
  const s = strip(a || '').toLowerCase(); if (!s.trim() || /^(unknown|various)/.test(s)) return [];
  return s.split(/\s*(?:;|&|\band\b|\bwith\b|\bnarrated by\b|\bread by\b)\s*|,(?=\s*[a-z]+\s+[a-z])/).map((x) => x.trim()).filter(Boolean).map((x) => {
    if (/^[^,]+,\s*[^,]+$/.test(x)) return squash(x.split(',')[0]).split(' ').pop();   // "Shelley, Mary"
    return squash(x).split(' ').filter((w) => w.length > 1 || false).pop() || '';
  }).filter(Boolean);
}
export function toIsbn13(x) {
  const d = (x || '').replace(/[^0-9Xx]/g, '').toUpperCase(); if (d.length === 13 && /^\d+$/.test(d)) return d;
  if (d.length === 10 && /^\d{9}[\dX]$/.test(d)) { const b = '978' + d.slice(0, 9); let s = 0; for (let i = 0; i < 12; i++) s += +b[i] * (i % 2 ? 3 : 1); return b + ((10 - (s % 10)) % 10); }
  return '';
}
export const isbnIn = (s) => { const m = /(?:97[89][\d\- ]{10,14}\d|\b\d{9}[\dXx]\b)/.exec(s || ''); return m ? toIsbn13(m[0]) : ''; };

/** item: { title, author, isbn?, identifier?, series?, seriesIndex? } → comparable profile. */
export function profile(item, extra = {}) {
  const sh = seriesFromTitle(item.title); const series = squash(extra.series || item.series || sh?.name || ''); const idx = extra.seriesIndex ?? item.seriesIndex ?? sh?.index ?? null;
  return { forms: titleForms(item.title, series), authors: authorSurnames(item.author), isbn: toIsbn13(item.isbn) || isbnIn(item.identifier) || isbnIn(item.title), series, idx: idx == null || idx === '' ? null : +idx };
}
/** Volume-ish numbers in a title ("Book Two", "2", "II"): a different number means a different volume. */
const numsOf = (full) => new Set(full.split(' ').map((w) => (/^\d{1,3}$/.test(w) ? +w : NUMW[w] || (w.length > 1 && ROMAN[w]) || 0)).filter(Boolean));
const jacc = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
const subset = (a, b) => { const A = new Set(a), B = new Set(b); const [s, l] = A.size <= B.size ? [A, B] : [B, A]; return s.size >= 2 && [...s].every((x) => l.has(x)); };

/** Confidence 0–100 that two profiles are the same work, plus human-readable reasons. */
export function score(p, q) {
  const why = []; let s = 0;
  if (p.isbn && q.isbn && p.isbn === q.isbn) return { score: 99, why: ['same ISBN'] };
  const fa = p.forms, fb = q.forms;
  if (!fa.main || !fb.main) return { score: 0, why: [] };
  let t = 0;
  if (fa.full === fb.full) { t = 75; why.push('same title'); }
  else if (fa.main === fb.main) { t = 72; why.push('same main title'); }
  else {
    const wa = fa.main.split(' '), wb = fb.main.split(' '); const j = jacc(wa, wb);
    if (subset(wa, wb) && Math.min(wa.length, wb.length) >= 2) { t = 58; why.push('one title contains the other'); }
    else if (j >= 0.5) { t = Math.round(60 * j); why.push('similar title'); }
  }
  s = t;
  if (t) {
    const na = numsOf(fa.full), nb = numsOf(fb.full);
    if (na.size && nb.size && ![...na].some((x) => nb.has(x))) { s -= 45; why.push('different volume number'); }
    else if (na.size !== nb.size && (!na.size || !nb.size) && (na.size + nb.size) === 1 && fa.full !== fb.full && fa.main !== fb.main) { s -= 20; why.push('volume number on one side only'); }
    if (p.authors.length && q.authors.length) {
      if (p.authors.some((x) => q.authors.includes(x))) { s += 22; why.push('same author'); } else { s -= 30; why.push('different author'); }
    }
    if (p.series && q.series && (p.series === q.series || p.series.includes(q.series) || q.series.includes(p.series))) {
      if (p.idx != null && q.idx != null) { if (p.idx === q.idx) { s += 8; why.push('same series #'); } else { s -= 45; why.push('different series #'); } }
    }
  } else if (p.series && q.series && p.series === q.series && p.idx != null && p.idx === q.idx && p.authors.some((x) => q.authors.includes(x))) { s = 70; why.push('same series, number and author'); }
  return { score: Math.max(0, Math.min(98, s)), why };
}
export const pairId = (bookKey, audioKey) => bookKey + ' ⇄ ' + audioKey;

/**
 * books / audios: [{ key, profile }]; skip: Set of pair ids that were rejected or unlinked; linkedBooks / linkedAudios: Sets of keys already paired.
 * Returns { auto: [...], suggested: [...] } of { bookKey, audioKey, score, why }.
 * "auto" needs ≥ AUTO_MIN and no rival within 10 points on either side (two audiobooks of one title → both just suggested).
 */
export function findPairs(books, audios, { skip = new Set(), linkedBooks = new Set(), linkedAudios = new Set() } = {}) {
  const cands = [];
  for (const b of books) { if (linkedBooks.has(b.key)) continue;
    for (const a of audios) { if (linkedAudios.has(a.key) || skip.has(pairId(b.key, a.key))) continue; const r = score(b.profile, a.profile); if (r.score >= SUGGEST_MIN) cands.push({ bookKey: b.key, audioKey: a.key, score: r.score, why: r.why }); } }
  cands.sort((x, y) => y.score - x.score);
  const rival = (c, side) => cands.some((o) => o !== c && o[side] === c[side] && o.score > c.score - 10);
  const auto = [], suggested = []; const usedB = new Set(), usedA = new Set();
  for (const c of cands) {
    if (usedB.has(c.bookKey) || usedA.has(c.audioKey)) continue;
    if (c.score >= AUTO_MIN && !rival(c, 'bookKey') && !rival(c, 'audioKey')) { auto.push(c); usedB.add(c.bookKey); usedA.add(c.audioKey); }
  }
  for (const c of cands) { if (auto.includes(c) || usedB.has(c.bookKey) || usedA.has(c.audioKey)) continue; suggested.push(c); }
  return { auto, suggested };
}

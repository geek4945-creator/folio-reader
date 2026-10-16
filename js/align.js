// Chapter alignment + position estimates between an audiobook (seconds) and an ebook (fraction 0–1 of its text). Pure functions.
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20, xxi: 21, xxii: 22, xxiii: 23, xxiv: 24, xxv: 25, xxvi: 26, xxvii: 27, xxviii: 28, xxix: 29, xxx: 30 };
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const sq = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** "Chapter 12: The Storm" → { num: 12, key: 'the storm' };  "12" → { num: 12, key: '' };  "Letter IV" → { num: 4 }. */
export function chapterKey(title) {
  let t = sq(title); let num = null;
  const m = /^(?:(?:chapter|chap|ch|part|book|letter|section|canto|act|scene)\s+)?(\d{1,3}|[ivxl]{1,6}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\s*(.*)$/.exec(t);
  if (m) { const n = /^\d+$/.test(m[1]) ? +m[1] : ROMAN[m[1]] || WORDS[m[1]] || null; if (n) { num = n; t = m[2]; } }
  t = t.replace(/^(?:chapter|chap|ch)\s+/, '').trim();
  if (/^(chapter|part|book|section|letter|opening credits|end credits|credits|intro|introduction|prologue|epilogue|contents|title page|copyright|cover)$/.test(t) && num == null) { /* generic */ }
  return { num, key: t };
}
const same = (a, b) => (a.key && a.key === b.key && a.key.length >= 3) || (a.num != null && a.num === b.num && (!a.key || !b.key));

/**
 * audio: [{ title, start }] (seconds from the start of the book), ebook: [{ title, frac }] (0–1).
 * Greedy in-order matching by title / chapter number; both sides must keep increasing. Returns anchors [{ t, frac, title }].
 */
export function matchChapters(audio, ebook) {
  const a = audio.map((c) => ({ ...c, ...chapterKey(c.title) })), e = ebook.map((c) => ({ ...c, ...chapterKey(c.title) }));
  const out = []; let j = 0, lastT = -1, lastF = -1;
  for (const ac of a) {
    for (let k = j; k < e.length; k++) {
      if (same(ac, e[k]) && ac.start > lastT && e[k].frac > lastF) { out.push({ t: ac.start, frac: e[k].frac, title: ac.title }); j = k + 1; lastT = ac.start; lastF = e[k].frac; break; }
    }
  }
  return out;
}
/** Anchors usable for interpolation: need ≥ 2 matched chapters, plus (0,0) and (total,1), strictly increasing on both axes. */
export function buildMap(anchors, total) {
  if (!(total > 0)) return { method: 'percent', pts: [{ t: 0, f: 0 }, { t: 1, f: 1 }], total: 1, matched: 0 };
  const pts = [{ t: 0, f: 0 }]; let n = 0;
  if (anchors.length >= 2) for (const x of anchors) { const p = pts[pts.length - 1]; if (n === 0 && x.frac <= 1e-6 && x.t > 0.5 && x.t < total - 0.5) { pts[0] = { t: x.t, f: 0 }; n++; continue; }   // chapter 1 starts the text: audio before it (intro / credits) maps to 0
      if (x.t > p.t + 0.5 && x.frac > p.f + 1e-6 && x.t < total - 0.5 && x.frac < 1 - 1e-6) { pts.push({ t: x.t, f: x.frac }); n++; } }
  if (n < 2) return { method: 'percent', pts: [{ t: 0, f: 0 }, { t: total, f: 1 }], total, matched: 0 };
  pts.push({ t: total, f: 1 });
  return { method: 'chapters', pts, total, matched: n };
}
function interp(pts, v, from, to) {
  if (v <= pts[0][from]) return pts[0][to]; const last = pts[pts.length - 1]; if (v >= last[from]) return last[to];
  for (let i = 1; i < pts.length; i++) if (v <= pts[i][from]) { const a = pts[i - 1], b = pts[i]; return a[to] + ((v - a[from]) / (b[from] - a[from])) * (b[to] - a[to]); }
  return last[to];
}
export const audioToFrac = (map, t) => Math.max(0, Math.min(1, interp(map.pts, t, 't', 'f')));
export const fracToAudio = (map, f) => Math.max(0, Math.min(map.total, interp(map.pts, f, 'f', 't')));

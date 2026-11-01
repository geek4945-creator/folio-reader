// v0.5.21: per-field user edits ("user overrides") for book info.
// A field the user typed (title, author, set, order in the set, description, year, language) is kept in book.uo[field] = {v, at, d}:
// the value, when it was edited (Drive-corrected clock) and on which device. Extraction, re-downloads and older devices' default values never
// replace it; two edits of the same field are last-writer-wins on `at` (ties: device id), field by field. `m: 1` marks an edit recovered from
// stamps written by an older version (less certain): any edit made with this version beats it.
export const UO_FIELDS = ['title', 'author', 'setId', 'seriesIndex', 'description', 'year', 'language'];
export const UO_HIST = 5;   // per field: the last values replaced on this device (Book info → earlier values)
const J = JSON.stringify;
export const norm = (f, v) => (v === undefined || v === '' && f !== 'title' ? null : v);
export function uoBeats(x, y) {   // true when edit x should replace edit y
  if (!x) return false; if (!y) return true;
  if (!x.m !== !y.m) return !x.m;
  if ((x.at || 0) !== (y.at || 0)) return (x.at || 0) > (y.at || 0);
  return String(x.d || '') > String(y.d || '');
}
export const sameV = (a, b) => J(a ?? null) === J(b ?? null);
/** Merge two uo maps field by field. */
export function mergeUo(a, b) {
  if (!a && !b) return null; const out = {};
  for (const f of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) { const x = a?.[f], y = b?.[f]; out[f] = structuredClone(uoBeats(y, x) ? y : x); }
  return out;
}
/** Put the edited values onto a book / state (an empty title never blanks a book). */
export function forceUo(rec) {
  if (!rec || !rec.uo) return rec;
  for (const [f, o] of Object.entries(rec.uo)) { if (!o) continue; if (f === 'title' && !o.v) continue; rec[f] = o.v ?? null; }
  return rec;
}
export function pushHist(rec, f, entry) {
  if (!entry) return; rec.uoHist = rec.uoHist || {}; const h = rec.uoHist[f] = rec.uoHist[f] || [];
  if (h.length && sameV(h[h.length - 1].v, entry.v)) return;
  h.push({ v: entry.v ?? null, at: entry.at || 0, d: entry.d || '' }); while (h.length > UO_HIST) h.shift();
}
/** Group of each field in the structure stamps (db.js GROUPS). */
export const UO_GROUP = { title: 'name', author: 'name', setId: 'series', seriesIndex: 'series' };

// Cross-device sync of enriched / hand-edited metadata and covers (the Drive appData parts live in google.js).
// Each synced field carries { v, at, u }: value, when it was set, and whether the *user* set it by hand. A user-set value always beats an
// automatic one; otherwise the newest wins. Covers are content-addressed (cover-<sha1>.jpg) so identical images are stored once.
// This module has no static imports so store.js / audiostore.js can use it without import cycles.
export const TEXT_FIELDS = ['author', 'description', 'year', 'language'];

const lastAtOf = (e) => Math.max(0, ...TEXT_FIELDS.map((f) => e?.[f]?.at || 0), e?.cover?.at || 0, e?.cover?.rv || 0);
export { lastAtOf };

/** The synced metadata entry of one item (only fields that were enriched or edited by hand are included). */
export function localMeta(it) {
  const e = {}; const at = it.metaAt || {};
  for (const f of TEXT_FIELDS) if (at[f]) e[f] = { v: it[f] ?? '', at: at[f], u: !!it.userSet?.[f] };
  if (at.cover || it.revertedAt) {
    const custom = (it.coverSource === 'enrich' || it.coverSource === 'user') && it.coverBlob && it.coverId;
    e.cover = { id: custom ? it.coverId : null, at: at.cover || 0, u: !!it.userSet?.cover, src: it.coverSource || 'file', rv: it.revertedAt || 0 };
  }
  if (it.userSet?.series) e.us = ['series'];
  return Object.keys(e).length ? e : null;
}
const pickText = (a, b) => (!a ? b : !b ? a : a.u !== b.u ? (a.u ? a : b) : (b.at || 0) > (a.at || 0) ? b : a);
export function pickCover(a, b) {
  if (!a) return b; if (!b) return a;
  if (!!a.u !== !!b.u) { const user = a.u ? a : b, auto = a.u ? b : a; return (auto.rv || 0) >= (user.at || 0) && (auto.rv || 0) > 0 ? auto : user; }   // a later "revert to automatic" beats an older user cover
  return (b.at || 0) > (a.at || 0) ? b : a;
}
export function mergeEntry(a, b) {
  const out = {};
  for (const f of TEXT_FIELDS) { const w = pickText(a?.[f], b?.[f]); if (w) out[f] = w; }
  const c = pickCover(a?.cover, b?.cover); if (c) out.cover = { ...c, rv: Math.max(a?.cover?.rv || 0, b?.cover?.rv || 0) };
  const us = [...new Set([...(a?.us || []), ...(b?.us || [])])]; if (us.length) out.us = us;
  return out;
}
/** Merge two key → entry maps. isDead(key, lastAt) says whether a tombstone outranks the entry. */
export function mergeMetaMaps(L = {}, R = {}, isDead = () => false) {
  const out = {};
  for (const k of new Set([...Object.keys(L), ...Object.keys(R)])) { const e = mergeEntry(L[k], R[k]); if (!isDead(k, lastAtOf(e))) out[k] = e; }
  return out;
}

/** Apply the winning remote text fields to a local item (sync). Returns true if anything changed. Cover handled by applyRemoteCover. */
export function applyTextFields(it, rm) {
  let changed = false; it.metaAt = it.metaAt || {}; it.userSet = it.userSet || {};
  for (const f of TEXT_FIELDS) {
    const r = rm?.[f]; if (!r) continue;
    const loc = it.metaAt[f] ? { v: it[f] ?? '', at: it.metaAt[f], u: !!it.userSet[f] } : null;
    if (loc && pickText(loc, r) !== r) continue; if (loc && loc.at === r.at && !!loc.u === !!r.u && String(loc.v) === String(r.v)) continue;
    it[f] = f === 'year' ? (parseInt(r.v, 10) || null) : (r.v ?? ''); it.metaAt[f] = r.at; if (r.u) it.userSet[f] = true; else delete it.userSet[f]; changed = true;
  }
  if (rm?.us?.includes('series') && !it.userSet.series) { it.userSet.series = true; changed = true; }
  return changed;
}
/** Does the remote cover entry beat the local one? (and differ from what we have) */
export function remoteCoverWins(it, rc) {
  if (!rc) return false;
  const loc = it.metaAt?.cover || it.revertedAt ? { id: (it.coverSource === 'enrich' || it.coverSource === 'user') ? it.coverId || null : null, at: it.metaAt?.cover || 0, u: !!it.userSet?.cover, rv: it.revertedAt || 0 } : null;
  if (loc && pickCover(loc, rc) !== rc) return false;
  if (loc && loc.at === rc.at && loc.id === rc.id && !!loc.u === !!rc.u) return false;
  if (!loc && rc.id && it.coverId === rc.id) return false;
  return true;
}
/** Pending (book not imported on this device yet): keep the entries locally, apply them at import time. */
const PKEY = { book: 'folio.pendingMeta', audio: 'folio.pendingAudioMeta' };
export const getPendingMeta = (kind) => { try { return JSON.parse(localStorage.getItem(PKEY[kind]) || '{}'); } catch { return {}; } };
export const setPendingMeta = (kind, p) => localStorage.setItem(PKEY[kind], JSON.stringify(p));
export function applyPendingMeta(it, kind, key) {
  const p = getPendingMeta(kind); const e = p[key]; if (!e) return false;
  applyTextFields(it, e); return true;   // the cover (if any) arrives with the next sync, which finds the item and downloads cover-<id>.jpg
}

/** Hash + remember the id of every custom (enriched / user) cover, so it can be synced as cover-<id>.jpg. */
export async function ensureCoverIds(items, put, hash) {
  for (const it of items) if ((it.coverSource === 'enrich' || it.coverSource === 'user') && it.coverBlob && !it.coverId) { it.coverId = await hash(it.coverBlob); await put(it); }
}

export const isbnFrom = (id) => { const m = /(?:isbn[:\s]*)?(97[89][0-9]{10}|[0-9]{9}[0-9Xx])\b/i.exec((id || '').replace(/[- ]/g, '')); return m ? m[1] : ''; };

/** Hand edits: any changed field is marked user-set (automatic lookups never touch it again) and stamped for sync. */
export function markEdits(it, vals) {
  it.userSet = it.userSet || {}; it.metaAt = it.metaAt || {}; const now = Date.now(); let n = 0;
  for (const [f, v] of Object.entries(vals)) {
    const nv = f === 'year' ? (parseInt(v, 10) || null) : String(v ?? '').trim();
    if (String(nv ?? '') === String(it[f] ?? '')) continue;
    it[f] = nv; it.userSet[f] = true; it.metaAt[f] = now; n++;
  }
  return n;
}

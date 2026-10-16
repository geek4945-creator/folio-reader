// Fetch with optional CORS proxy fallback.  Proxy contract: GET {proxy}?url=<encoded target>
import { settings } from './settings.js';

const BLOCKED = [/annas-archive/i, /z-?lib/i, /zlibrary/i, /libgen/i, /library\.lol/i, /sci-?hub/i, /1lib\./i, /b-ok\./i, /singlelogin/i, /oceanofpdf/i, /pdfdrive/i, /\bbookzz\b/i, /ebin\.pub/i, /\bepdf\.pub\b/i];
export function isBlockedSite(url) {
  try { const u = new URL(url); return BLOCKED.some((r) => r.test(u.hostname)); } catch { return false; }
}

export function proxied(url) {
  const p = settings.get('proxyUrl').trim();
  if (!p) return null;
  return p + (p.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
}

export class CorsError extends Error {}

export async function fetchSmart(url, init = {}) {
  if (isBlockedSite(url)) throw new Error('This site is not supported. Folio only works with legal catalogs and your own libraries.');
  const mode = settings.get('proxyMode');
  const px = proxied(url);
  const timeout = init.timeout || 25000;
  const run = async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try { return await fetch(u, { ...init, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  };
  if (mode === 'always' && px) return check(await run(px));
  try {
    const r = await run(url);
    return check(r);
  } catch (e) {
    if (e instanceof CorsError) throw e;
    if (px && mode !== 'never') return check(await run(px));
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw new CorsError('Could not reach that address directly (the server likely blocks browser cross-origin requests, or you are offline). Set a CORS proxy in Settings → Network to use it.');
  }
}
function check(r) {
  if (!r.ok) throw new Error('Server returned ' + r.status);
  return r;
}

/** Download with progress callback(0..1). Returns Blob. */
export async function download(url, onProgress) {
  const r = await fetchSmart(url, { timeout: 120000 });
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total || !onProgress) return r.blob();
  const reader = r.body.getReader(); const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; onProgress(Math.min(1, got / total));
  }
  return new Blob(chunks, { type: r.headers.get('content-type') || 'application/epub+zip' });
}

const olCache = new Map();
/** Open Library cover fallback (https://covers.openlibrary.org). Resolves to URL or null. */
export async function openLibraryCover(title, author) {
  const key = (title + '|' + author).toLowerCase();
  if (olCache.has(key)) return olCache.get(key);
  let url = null;
  try {
    const q = new URLSearchParams({ title, limit: '1', fields: 'cover_i' });
    if (author && !/unknown/i.test(author)) q.set('author', author.split(',')[0]);
    const r = await fetch('https://openlibrary.org/search.json?' + q, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (r.ok) { const d = await r.json(); const id = d.docs?.[0]?.cover_i; if (id) url = `https://covers.openlibrary.org/b/id/${id}-M.jpg`; }
  } catch { /* offline or blocked */ }
  olCache.set(key, url);
  return url;
}

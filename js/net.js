// Fetch with optional CORS proxy fallback.  Proxy contract: GET {proxy}?url=<encoded target>
import { settings } from './settings.js';

const BLOCKED = [/annas-archive/i, /z-?lib/i, /zlibrary/i, /libgen/i, /library\.lol/i, /sci-?hub/i, /1lib\./i, /b-ok\./i, /singlelogin/i, /oceanofpdf/i, /pdfdrive/i, /\bbookzz\b/i, /ebin\.pub/i, /\bepdf\.pub\b/i];
export function isBlockedSite(url) {
  try { const u = new URL(url); return BLOCKED.some((r) => r.test(u.hostname)); } catch { return false; }
}

/** Clean up a user-typed web address: trim, drop spaces, add https:// when there is no scheme, validate with new URL().
 *  Returns the normalized href; throws a friendly Error (message safe to show inline) when it can't be a web address. */
export function normalizeUrl(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
  if (!s) throw new Error('Enter a web address, for example archive.org or https://example.com/opds.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error('Only http:// and https:// addresses work here.');
  if (s.startsWith('//')) s = s.slice(2);
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { throw new Error('That doesn’t look like a web address. Try something like archive.org or https://example.com/opds.'); }
  const h = u.hostname;
  if (!h || !(h.includes('.') || h === 'localhost' || /^\[/.test(h))) throw new Error('“' + raw.trim() + '” doesn’t look like a web address. Try something like archive.org or https://example.com/opds.');
  return u.href;
}
export function proxied(url) {
  let p = settings.get('proxyUrl').trim();
  if (!p) return null;
  try { p = normalizeUrl(p); } catch { return null; }
  return p + (p.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
}

export class CorsError extends Error {}
/** A readable "the site / proxy said no" error (not a CORS problem, so no "set up a proxy" hint). */
export class SiteError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }
export const BLOCKED_MSG = 'That site blocked the request; try downloading in the browser and importing the file.';
export const UNSUPPORTED_MSG = 'This site isn’t supported.';

/** Turn a failed response into a human-friendly error. viaProxy: the response came from the Folio proxy (its own 400s carry a message). */
export async function httpError(r, viaProxy = false) {
  let body = ''; try { body = (await r.clone().text()).slice(0, 4000); } catch { /* unreadable */ }
  const challenge = r.headers.get('cf-mitigated') === 'challenge' || /Just a moment\.\.\.|cf-browser-verification|challenge-platform|cf-chl-|Attention Required! \| Cloudflare|Enable JavaScript and cookies to continue/i.test(body);
  if (viaProxy && r.status === 400 && /^Proxy error:/i.test(body.trim())) {
    const m = body.trim().replace(/^Proxy error:\s*/i, '').slice(0, 200);
    if (/site not supported/i.test(m)) return new SiteError(UNSUPPORTED_MSG, 'unsupported');
    return new SiteError('The proxy refused this address: ' + m, 'proxy');
  }
  if (r.status === 403 || challenge) return new SiteError(BLOCKED_MSG, 'blocked');
  if (viaProxy && r.status === 400) return new SiteError('The proxy refused this request' + (body.trim() ? ': ' + body.trim().slice(0, 200) : '.'), 'proxy');
  return Object.assign(new Error('Server returned ' + r.status), { http: r.status });
}

export async function fetchSmart(url, init = {}) {
  if (isBlockedSite(url)) throw new SiteError('This site is not supported. Folio only works with legal catalogs and your own libraries.');
  const mode = settings.get('proxyMode');
  const px = proxied(url);
  const timeout = init.timeout || 25000;
  const run = async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try { return await fetch(u, { ...init, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  };
  const viaProxy = async () => {
    let r;
    try { r = await run(px); } catch (e) {
      if (e.name === 'AbortError') throw new Error('Request timed out');
      throw new SiteError('Could not reach the proxy. Check your connection, or the proxy address in Settings → Network.');
    }
    return check(r, true);
  };
  if (mode === 'always' && px) return await viaProxy();
  try {
    const r = await run(url);
    return await check(r);
  } catch (e) {
    if (e instanceof CorsError || ((e instanceof SiteError || e.http) && !(px && mode !== 'never'))) throw e;
    if (px && mode !== 'never') return await viaProxy();
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw new CorsError('Could not reach that address directly (the server likely blocks browser cross-origin requests, or you are offline). Set a CORS proxy in Settings → Network to use it.');
  }
}
async function check(r, viaProxy = false) {
  if (!r.ok) throw await httpError(r, viaProxy);
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

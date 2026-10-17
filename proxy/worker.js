// Folio optional CORS proxy for Cloudflare Workers.
//   wrangler deploy   (see proxy/wrangler.toml)  ->  https://folio-proxy.<you>.workers.dev/?url=<encoded target>
// Configure via Worker vars: ALLOW_HOSTS="my-calibre.example.com,other.host"  ALLOW_ORIGIN="https://you.github.io"
const DEFAULT_ALLOW = ['gutenberg.org', 'pglaf.org', 'standardebooks.org', 'archive.org', 'openlibrary.org', 'gutendex.com'];
const DENY = [/annas-archive/i, /z-?lib/i, /zlibrary/i, /libgen/i, /library\.lol/i, /sci-?hub/i, /1lib\./i, /b-ok\./i, /singlelogin/i, /oceanofpdf/i, /pdfdrive/i, /audiobook-?bay/i, /tokybook/i, /golden-?audiobooks?/i, /audiobooks4soul/i];

// ---- "Suggest a change" inbox (v0.5.15) ------------------------------------------------------------------------------------------------
//   POST /suggest              {id, app, version, platform, text}  (browser/app only: Origin must be in ALLOW_ORIGIN) -> stored in KV (binding SUGGESTIONS)
//   GET  /suggestions?key=…    (or Authorization: Bearer …)  [&status=new|handled|all] [&app=…]  -> JSON list, newest first   (admin: secret SUGGEST_KEY)
//   POST /suggestions/ack?key=…      {ids:[…]} or {all:true}   -> marks entries handled
//   POST /suggestions/delete?key=…   {ids:[…]}                  -> removes entries
// Stored per entry: id, timestamp, app name + version, a coarse platform label, a trimmed user-agent and the text. No IP address is stored (rate-limit counters use a salted hash and expire after an hour).
const MAX_TEXT = 2000, MAX_BODY = 8192, RATE_PER_HOUR = 10, KEEP_DAYS = 365;
const J = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h } });
const safeEq = (a, b) => { a = String(a || ''); b = String(b || ''); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].slice(0, 10).map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function readJson(request) {
  const len = +(request.headers.get('content-length') || 0); if (len > MAX_BODY) return { err: J({ ok: false, error: 'too large' }, 413) };
  const t = await request.text(); if (t.length > MAX_BODY) return { err: J({ ok: false, error: 'too large' }, 413) };
  try { const v = JSON.parse(t || '{}'); return { v: v && typeof v === 'object' ? v : {} }; } catch { return { err: J({ ok: false, error: 'bad json' }, 400) }; }
}
async function handleSuggest(request, env, path, allowed, reqOrigin) {
  const originOk = !!reqOrigin && allowed.includes(reqOrigin);
  const cors = originOk ? { 'Access-Control-Allow-Origin': reqOrigin, 'Vary': 'Origin' } : { 'Vary': 'Origin' };
  const withCors = (r) => { for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; };
  if (!env.SUGGESTIONS) return withCors(J({ ok: false, error: 'not configured' }, 503));
  if (path === '/suggest') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: originOk ? { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } : cors });
    if (request.method !== 'POST') return withCors(J({ ok: false, error: 'POST only' }, 405));
    if (!originOk) return withCors(J({ ok: false, error: 'origin not allowed' }, 403));
    const body = await readJson(request); if (body.err) return withCors(body.err);
    const text = clip(body.v.text, MAX_TEXT + 1).trim();
    if (!text) return withCors(J({ ok: false, error: 'empty' }, 400));
    if (text.length > MAX_TEXT) return withCors(J({ ok: false, error: 'too long' }, 413));
    const id = clip(body.v.id, 64).replace(/[^A-Za-z0-9_-]/g, '') || crypto.randomUUID();
    if (await env.SUGGESTIONS.get('i:' + id)) return withCors(J({ ok: true, id, duplicate: true }));   // a retry of something already stored
    // simple per-IP rate limit: RATE_PER_HOUR per hour (counter keyed by a salted hash of the IP; expires on its own)
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rk = 'r:' + (await sha(ip + '|' + (env.SUGGEST_KEY || 'salt'))) + ':' + Math.floor(Date.now() / 3600000);
    const n = +(await env.SUGGESTIONS.get(rk)) || 0;
    if (n >= RATE_PER_HOUR) return withCors(J({ ok: false, error: 'rate limited' }, 429, { 'Retry-After': '3600' }));
    await env.SUGGESTIONS.put(rk, String(n + 1), { expirationTtl: 3700 });
    const at = Date.now(), app = clip(body.v.app, 40) || 'unknown';
    const entry = { id, at, iso: new Date(at).toISOString(), app, version: clip(body.v.version, 20), platform: clip(body.v.platform, 40), ua: clip(body.v.ua || request.headers.get('User-Agent'), 160), text, status: 'new' };
    await env.SUGGESTIONS.put('s:' + String(at).padStart(13, '0') + ':' + id, JSON.stringify(entry), { expirationTtl: KEEP_DAYS * 86400 });
    await env.SUGGESTIONS.put('i:' + id, '1', { expirationTtl: 7 * 86400 });
    return withCors(J({ ok: true, id }));
  }
  // admin endpoints: no CORS headers (used from curl, not from the app); secret via ?key= or Authorization: Bearer
  const auth = request.headers.get('Authorization') || ''; const url = new URL(request.url);
  const key = url.searchParams.get('key') || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!env.SUGGEST_KEY || !safeEq(key, env.SUGGEST_KEY)) return J({ ok: false, error: 'unauthorized' }, 401);
  const all = async () => { const out = []; let cursor; do { const l = await env.SUGGESTIONS.list({ prefix: 's:', cursor, limit: 1000 }); for (const k of l.keys) out.push(k.name); cursor = l.list_complete ? undefined : l.cursor; } while (cursor && out.length < 2000); return out; };
  if (path === '/suggestions') {
    if (request.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);
    const status = url.searchParams.get('status') || 'new', app = url.searchParams.get('app');
    const names = (await all()).sort().reverse().slice(0, 500), items = [];
    for (const nm of names) { const v = await env.SUGGESTIONS.get(nm, 'json'); if (!v) continue; if (status !== 'all' && v.status !== status) continue; if (app && v.app !== app) continue; items.push(v); }
    return J({ ok: true, count: items.length, suggestions: items });
  }
  if (request.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  const body = await readJson(request); if (body.err) return body.err;
  const ids = new Set(Array.isArray(body.v.ids) ? body.v.ids.map((x) => String(x)) : body.v.id ? [String(body.v.id)] : []);
  if (!ids.size && !(path === '/suggestions/ack' && body.v.all === true)) return J({ ok: false, error: 'give ids' }, 400);
  let n = 0;
  for (const nm of await all()) {
    const id = nm.slice(nm.indexOf(':', 2) + 1); const every = path === '/suggestions/ack' && body.v.all === true;
    if (!every && !ids.has(id)) continue;
    if (path === '/suggestions/delete') { await env.SUGGESTIONS.delete(nm); n++; continue; }
    const v = await env.SUGGESTIONS.get(nm, 'json'); if (!v || v.status === 'handled') continue;
    v.status = 'handled'; v.handledAt = new Date().toISOString(); await env.SUGGESTIONS.put(nm, JSON.stringify(v), { expirationTtl: KEEP_DAYS * 86400 }); n++;
  }
  return J({ ok: true, changed: n });
}

export default {
  async fetch(request, env) {
    // ALLOW_ORIGIN: comma-separated list of allowed origins (or "*"). The matching request Origin is echoed back.
    const allowed = (env.ALLOW_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const reqOrigin = request.headers.get('Origin') || '';
    const origin = allowed.includes('*') ? '*' : (allowed.includes(reqOrigin) ? reqOrigin : allowed[0]);
    const cors = (h = {}) => ({ 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Accept', 'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range', ...h });
    { const path = new URL(request.url).pathname; if (path === '/suggest' || path === '/suggestions' || path === '/suggestions/ack' || path === '/suggestions/delete') return handleSuggest(request, env, path, allowed, reqOrigin); }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('GET only', { status: 405, headers: cors() });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Folio proxy: use /?url=<encoded URL>', { headers: cors() });
    const allow = (env.ALLOW_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).concat(DEFAULT_ALLOW);
    const check = (u) => {
      if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s)');
      const h = u.hostname.toLowerCase();
      if (DENY.some((r) => r.test(h))) throw new Error('site not supported');
      if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^\[/.test(h) || /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(h) || /^\d+$/.test(h)) throw new Error('private addresses are not allowed');
      // Any public host is allowed (the DENY list above still applies). ALLOW_HOSTS is kept for compatibility; set STRICT=1 to restrict to the allow list.
      if (env.STRICT === '1' && !allow.some((a) => h === a || h.endsWith('.' + a))) throw new Error('host not allowed (set ALLOW_HOSTS)');
    };
    try {
      let u = new URL(target), r;
      for (let i = 0; i < 6; i++) {
        check(u);
        const headers = { 'User-Agent': 'FolioReaderProxy/1.0' }; const range = request.headers.get('range'); if (range) headers.Range = range;
        r = await fetch(u, { redirect: 'manual', method: request.method, headers });
        const loc = r.headers.get('location');
        if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, u); continue; }
        break;
      }
      const h = new Headers(cors());
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) h.set(k, r.headers.get(k));
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) { return new Response('Proxy error: ' + e.message, { status: 400, headers: cors() }); }
  },
};

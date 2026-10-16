// Folio optional CORS proxy for Cloudflare Workers.
//   wrangler deploy   (see proxy/wrangler.toml)  ->  https://folio-proxy.<you>.workers.dev/?url=<encoded target>
// Configure via Worker vars: ALLOW_HOSTS="my-calibre.example.com,other.host"  ALLOW_ORIGIN="https://you.github.io"
const DEFAULT_ALLOW = ['gutenberg.org', 'pglaf.org', 'standardebooks.org', 'archive.org', 'openlibrary.org', 'gutendex.com'];
const DENY = [/annas-archive/i, /z-?lib/i, /zlibrary/i, /libgen/i, /library\.lol/i, /sci-?hub/i, /1lib\./i, /b-ok\./i, /singlelogin/i, /oceanofpdf/i, /pdfdrive/i];

export default {
  async fetch(request, env) {
    // ALLOW_ORIGIN: comma-separated list of allowed origins (or "*"). The matching request Origin is echoed back.
    const allowed = (env.ALLOW_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const reqOrigin = request.headers.get('Origin') || '';
    const origin = allowed.includes('*') ? '*' : (allowed.includes(reqOrigin) ? reqOrigin : allowed[0]);
    const cors = (h = {}) => ({ 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Accept', 'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range', ...h });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('GET only', { status: 405, headers: cors() });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Folio proxy: use /?url=<encoded URL>', { headers: cors() });
    const allow = (env.ALLOW_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).concat(DEFAULT_ALLOW);
    const check = (u) => {
      if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s)');
      const h = u.hostname.toLowerCase();
      if (DENY.some((r) => r.test(h))) throw new Error('site not supported');
      if (!allow.some((a) => h === a || h.endsWith('.' + a))) throw new Error('host not allowed (set ALLOW_HOSTS)');
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

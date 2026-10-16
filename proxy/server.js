#!/usr/bin/env node
// Folio optional CORS proxy (Node 18+, no dependencies).
//   node proxy/server.js            -> http://localhost:8787/?url=<encoded target>
// Env: PORT=8787  ALLOW_HOSTS="gutenberg.org,my-calibre.example.com"  ALLOW_ORIGIN="https://you.github.io"
// By default only the catalogs Folio ships with are allowed. Add your own library host to ALLOW_HOSTS.
// Safety: GET/HEAD only, http(s) only, no private/loopback addresses (unless ALLOW_PRIVATE=1 for your home LAN
// server), redirects re-validated, 120 MB cap, piracy-site denylist.
const http = require('http'); const dns = require('dns').promises; const net = require('net');
const PORT = +process.env.PORT || 8787;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const DEFAULT_ALLOW = ['gutenberg.org', 'pglaf.org', 'standardebooks.org', 'archive.org', 'openlibrary.org', 'gutendex.com'];
const ALLOW = (process.env.ALLOW_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).concat(DEFAULT_ALLOW);
const DENY = [/annas-archive/i, /z-?lib/i, /zlibrary/i, /libgen/i, /library\.lol/i, /sci-?hub/i, /1lib\./i, /b-ok\./i, /singlelogin/i, /oceanofpdf/i, /pdfdrive/i];
const MAX = 120 * 1024 * 1024;
const hostAllowed = (h) => ALLOW.some((a) => h === a || h.endsWith('.' + a));
function isPrivate(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
async function validate(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s)');
  const host = u.hostname.toLowerCase();
  if (DENY.some((r) => r.test(host))) throw new Error('site not supported');
  if (!hostAllowed(host)) throw new Error('host not allowed (add it to ALLOW_HOSTS)');
  if (process.env.ALLOW_PRIVATE !== '1') {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivate(a.address))) throw new Error('private address blocked');
  }
}
const cors = (extra = {}) => ({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Accept', 'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range', ...extra });

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }
  const send = (code, msg) => { res.writeHead(code, cors({ 'Content-Type': 'text/plain' })); res.end(msg); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'GET only');
  const target = new URL(req.url, 'http://x').searchParams.get('url');
  if (!target) return send(200, 'Folio proxy: use /?url=<encoded URL>');
  try {
    let u = new URL(target); let r;
    for (let i = 0; i < 6; i++) {
      await validate(u);
      r = await fetch(u, { redirect: 'manual', method: req.method, headers: { 'User-Agent': 'FolioReaderProxy/1.0', ...(req.headers.range ? { Range: req.headers.range } : {}), Accept: req.headers.accept || '*/*' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u); continue; }
      break;
    }
    const len = +r.headers.get('content-length') || 0; if (len > MAX) return send(413, 'too large');
    const h = cors({ 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) if (r.headers.get(k)) h[k] = r.headers.get(k);
    res.writeHead(r.status, h);
    if (req.method === 'HEAD' || !r.body) return res.end();
    let n = 0; const reader = r.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX) { res.destroy(); return; } res.write(value); }
    res.end();
  } catch (e) { if (!res.headersSent) send(400, 'Proxy error: ' + e.message); else res.end(); }
}).listen(PORT, () => console.log('Folio proxy listening on :' + PORT + ' (allow: ' + ALLOW.join(', ') + ')'));

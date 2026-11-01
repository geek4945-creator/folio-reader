// A fake Google Drive appDataFolder for the sync tests: many named files (folio-sync.json, folio-positions.json, folio-settings.json, folio-devices.json…),
// md5 / modifiedTime so the app can tell what changed, failure + offline injection, and a call log. Covers (cover-*.jpg) stay in meta-mocks' own map.
const crypto = require('crypto');
function attach(C, prefix) {
  C.prefix = prefix; C.files = new Map(); C.fseq = 0; C.rseq = 0; C.calls = []; C.offline = false; C.fail = null; C.writesBy = {};
  const key = prefix + '-sync.json';
  Object.defineProperty(C, 'sync', { configurable: true, get() { const f = C.files.get(key); return f ? f.buf.toString('utf8') : null; }, set(v) { if (v == null) C.files.delete(key); else put(key, Buffer.from(String(v))); } });
  const put = (name, buf) => { let f = C.files.get(name); if (!f) { f = { id: 'F' + (++C.fseq), name, createdTime: new Date().toISOString() }; C.files.set(name, f); } f.buf = buf; f.modifiedTime = new Date().toISOString(); f.md5 = crypto.createHash('md5').update(buf).digest('hex'); f.revs = f.revs || []; f.revs.push({ id: 'R' + (++C.rseq), modifiedTime: f.modifiedTime, buf, keep: false }); while (f.revs.filter((r) => !r.keep).length > (C.maxRevs || 100)) f.revs.splice(f.revs.findIndex((r) => !r.keep), 1);  /* v0.5.21: Drive keeps earlier versions (revisions) */ C.writesBy[name] = (C.writesBy[name] || 0) + 1; return f; };
  C.put = put; C.json = (name) => { const f = C.files.get(name); return f ? JSON.parse(f.buf.toString('utf8')) : null; };
  C.names = () => [...C.files.keys()];
  return C;
}
const meta = (f) => ({ id: f.id, name: f.name, md5Checksum: f.md5, modifiedTime: f.modifiedTime, createdTime: f.createdTime });
/** Returns true when the request was a sync-file request and has been answered. `json(obj, status)` replies. */
async function handle(req, u, C, json, CORS) {
  const q = decodeURIComponent(u).replace(/\+/g, ' '); const m = req.method();
  const isFileApi = u.includes('/drive/v3/files') || u.includes('/upload/drive/v3/files'); if (!isFileApi) return false;
  const injected = () => {
    if (C.offline) { req.abort('internetdisconnected'); return true; }
    if (C.fail && C.fail.times > 0 && (!C.fail.match || C.fail.match.test(m + ' ' + u))) { C.fail.times--; req.respond({ status: C.fail.status, headers: { ...CORS, ...(C.fail.retryAfter ? { 'Retry-After': String(C.fail.retryAfter) } : {}) }, contentType: 'application/json', body: JSON.stringify({ error: { errors: [{ reason: C.fail.status === 403 ? 'rateLimitExceeded' : 'x' }] } }) }); return true; }
    return false;
  };
  // v0.5.21: revisions (earlier versions of a file): list, download one, keepForever
  const rv = /\/drive\/v3\/files\/(F\d+)\/revisions(?:\/(R\d+))?/.exec(u);
  if (rv) {
    const f = [...C.files.values()].find((x) => x.id === rv[1]); if (injected()) return true; if (!f) { req.respond({ status: 404, headers: CORS, body: 'nf' }); return true; }
    if (!rv[2] && m === 'GET') { C.calls.push('revisions ' + f.name); return json({ revisions: f.revs.map((r) => ({ id: r.id, modifiedTime: r.modifiedTime, size: String(r.buf.length), keepForever: r.keep })) }), true; }
    const r = f.revs.find((x) => x.id === rv[2]); if (!r) { req.respond({ status: 404, headers: CORS, body: 'nf' }); return true; }
    if (m === 'GET') { C.calls.push('revision ' + r.id); req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: r.buf }); return true; }
    if (m === 'PATCH') { try { const b = JSON.parse(req.postData() || '{}'); if ('keepForever' in b) r.keep = !!b.keepForever; } catch { /* ignore */ } C.pins = (C.pins || 0) + 1; return json({ id: r.id, keepForever: r.keep }), true; }
  }
  // list
  if (m === 'GET' && /\/drive\/v3\/files\?/.test(u) && !u.includes('/upload/') && /name='/.test(q)) {
    const names = [...q.matchAll(/name='([^']+)'/g)].map((x) => x[1]); if (injected()) return true; C.calls.push('list');
    return json({ files: names.map((n) => C.files.get(n)).filter(Boolean).map(meta).sort((a, b) => a.createdTime < b.createdTime ? -1 : 1) }), true;
  }
  const media = /\/drive\/v3\/files\/(F\d+)\?alt=media/.exec(u);
  if (m === 'GET' && media) { const f = [...C.files.values()].find((x) => x.id === media[1]); if (injected()) return true; if (!f) { req.respond({ status: 404, headers: CORS, body: 'nf' }); return true; } C.calls.push('get ' + f.name); req.respond({ status: 200, headers: CORS, contentType: 'application/json', body: f.buf }); return true; }
  if (u.includes('/upload/drive/v3/files') && (/uploadType=resumable/.test(u) || /\/files\/session\//.test(u))) {   // v0.5.20: resumable uploads (big library files)
    C.sessions = C.sessions || new Map(); C.resumable = C.resumable || 0;
    const sess = /\/files\/session\/(S\d+)/.exec(u);
    if (sess && m === 'PUT') { const ss = C.sessions.get(sess[1]); if (!ss) return false; if (injected()) return true; const buf = C.lastBody || Buffer.from(req.postData() || '');
      const name = ss.name || [...C.files.values()].find((x) => x.id === ss.id)?.name; const f = C.put(name, Buffer.from(buf.toString('latin1'), 'latin1')); C.writes++; C.resumable++; C.calls.push('resumable ' + f.name); json(meta(f)); return true; }
    if (injected()) return true;
    const body = JSON.parse((C.lastBody || Buffer.from(req.postData() || '{}')).toString('utf8') || '{}'); const id = /\/upload\/drive\/v3\/files\/(F\d+)/.exec(u);
    if (m === 'POST' && /^cover-/.test(body.name || '')) return false;
    const sid = 'S' + (C.sessions.size + 1); C.sessions.set(sid, id ? { id: id[1] } : { name: body.name });
    req.respond({ status: 200, headers: { ...CORS, 'Access-Control-Expose-Headers': 'Location', Location: 'https://www.googleapis.com/upload/drive/v3/files/session/' + sid }, contentType: 'application/json', body: '' }); return true;
  }
  if (u.includes('/upload/drive/v3/files')) {
    const buf = C.lastBody || Buffer.from(req.postData() || ''); const s = buf.toString('latin1'); if (m === 'POST' && s.includes('appDataFolder')) C.parents = true;
    if (m === 'POST') { const nm = /"name":"([^"]+)"/.exec(s); if (!nm || /^cover-/.test(nm[1])) return false; if (injected()) return true; const mark = 'Content-Type: application/json\r\n\r\n'; const rest = s.slice(s.lastIndexOf(mark) + mark.length); const f = C.put(nm[1], Buffer.from(rest.slice(0, rest.lastIndexOf('\r\n--')), 'latin1')); C.writes++; C.calls.push('post ' + f.name); json(meta(f)); return true; }
    const id = /\/upload\/drive\/v3\/files\/(F\d+)/.exec(u); if (m === 'PATCH' && id) { const f = [...C.files.values()].find((x) => x.id === id[1]); if (!f) return false; if (injected()) return true; C.put(f.name, buf); C.writes++; C.calls.push('patch ' + f.name); json(meta(f)); return true; }
  }
  return false;
}
module.exports = { attach, handle };

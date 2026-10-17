// Offline shell + runtime caching of same-origin assets. Bump VERSION to refresh.
const VERSION = 'folio-v26';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'css/app.css', 'vendor/jszip.min.js', 'vendor/epub.min.js',
  'js/app.js', 'js/covers.js', 'js/openguard.js', 'js/coversearch.js', 'js/viewport.js', 'js/hold.js', 'js/dict.js', 'js/glossary.js', 'js/glossaryui.js', 'js/wordbubble.js', 'js/readingnow.js', 'js/suggest.js', 'js/update.js', 'js/appupdate.js', 'js/annots.js', 'js/annotui.js', 'js/nav.js', 'js/pinch.js', 'js/pdftext.js', 'js/zip.js', 'js/device.js', 'js/positions.js', 'js/syncui.js', 'js/backup.js', 'js/backupui.js', 'js/drivebatch.js', 'js/pairing.js', 'js/links.js', 'js/align.js', 'js/loans.js', 'js/findplace.js', 'js/enrich.js', 'js/metasync.js', 'js/util.js', 'js/db.js', 'js/settings.js', 'js/store.js', 'js/epubmeta.js', 'js/net.js', 'js/opds.js', 'js/catalogs.js',
  'js/library.js', 'js/reader.js', 'js/dragsort.js', 'js/google.js', 'js/drive.js', 'js/kindle.js', 'js/pdf.js', 'js/pdfreader.js', 'js/publib.js', 'js/env.js', 'js/install.js', 'js/fullscreen.js', 'js/pages.js', 'js/audiotags.js', 'js/audiostore.js', 'js/audioplayer.js', 'js/audiobooks.js', 'js/audiosources.js',
  'vendor/foliate-mobi.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/icon-maskable-512.png'];

// v0.5.17 update flow (non-disruptive, version-consistent):
//  * install: download EVERY shell file fresh (cache:'reload', so GitHub Pages' HTTP cache can't hand us a stale file), check that they are all from the same build
//    (js/device.js must say BUILD) and store them in ONE cache named VERSION. If anything is missing or mixed, the install fails and the old version keeps running untouched.
//  * the new worker then WAITS. It never takes over by itself (no skipWaiting on install): the page shows "Update ready — tap to refresh" and asks it to take over
//    ({type:'SKIP_WAITING'}) when the reader is closed / the user taps — so code is never swapped under a book that is being read.
//  * fetch: cache-first from this version's cache only, so every module a page loads (including lazy import()s) comes from the same build the page started with.
const BUILD = '0.5.17';
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const base = self.registration.scope;
    const got = await Promise.all(SHELL.map(async (path) => {
      const url = new URL(path, base).href; const r = await fetch(new Request(url, { cache: 'reload' }));
      if (!r.ok) throw new Error('shell file missing: ' + path + ' (' + r.status + ')');
      return [url, r];
    }));
    const dev = got.find(([u]) => /\/js\/device\.js$/.test(u));
    if (!dev || !(await dev[1].clone().text()).includes("APP_VERSION = '" + BUILD + "'")) throw new Error('mixed build: js/device.js is not ' + BUILD);   // a deploy is half-published: try again at the next check
    await Promise.all(got.map(([u, r]) => cache.put(u, r)));
  })().catch(async (err) => { try { await caches.delete(VERSION); } catch { /* ignore */ } throw err; }));
});
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && /\/share-target$/.test(url.pathname)) { e.respondWith(receiveShare(req)); return; }   // Web Share Target: an image shared from Safari / Chrome
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // never touch cross-origin catalog / Google traffic
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    try { return await fetch(req); } catch { return Response.error(); }   // not part of the shell (e.g. the shared-cover cache keys are handled above): plain network, never stored, so versions can't mix
  })());
});

/** Web Share Target: keep the shared image (or address) in the cache, then open the app, which asks which book / audiobook it is for. */
async function receiveShare(req) {
  try {
    const fd = await req.formData(); const cache = await caches.open(VERSION); const base = self.registration.scope;
    const file = fd.get('image'); const img = file && typeof file === 'object' && file.size ? file : null;
    await cache.delete(new URL('__shared__/cover', base).href);
    if (img) await cache.put(new URL('__shared__/cover', base).href, new Response(img, { headers: { 'Content-Type': img.type || 'image/jpeg' } }));
    const link = String(fd.get('url') || fd.get('text') || '').trim();
    await cache.put(new URL('__shared__/meta', base).href, new Response(JSON.stringify({ url: /^https?:\/\/\S+$/i.test(link) ? link : '', title: String(fd.get('title') || ''), hasImage: !!img, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* nothing usable: the app just opens */ }
  return Response.redirect(new URL('index.html?share=cover', self.registration.scope).href, 303);
}

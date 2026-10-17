// Offline shell + runtime caching of same-origin assets. Bump VERSION to refresh.
const VERSION = 'folio-v20';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'css/app.css', 'vendor/jszip.min.js', 'vendor/epub.min.js',
  'js/app.js', 'js/covers.js', 'js/openguard.js', 'js/coversearch.js', 'js/viewport.js', 'js/hold.js', 'js/dict.js', 'js/glossary.js', 'js/glossaryui.js', 'js/wordbubble.js', 'js/readingnow.js', 'js/annots.js', 'js/annotui.js', 'js/nav.js', 'js/pinch.js', 'js/pdftext.js', 'js/zip.js', 'js/device.js', 'js/positions.js', 'js/syncui.js', 'js/backup.js', 'js/backupui.js', 'js/drivebatch.js', 'js/pairing.js', 'js/links.js', 'js/align.js', 'js/loans.js', 'js/findplace.js', 'js/enrich.js', 'js/metasync.js', 'js/util.js', 'js/db.js', 'js/settings.js', 'js/store.js', 'js/epubmeta.js', 'js/net.js', 'js/opds.js', 'js/catalogs.js',
  'js/library.js', 'js/reader.js', 'js/dragsort.js', 'js/google.js', 'js/drive.js', 'js/kindle.js', 'js/pdf.js', 'js/pdfreader.js', 'js/publib.js', 'js/env.js', 'js/install.js', 'js/fullscreen.js', 'js/pages.js', 'js/audiotags.js', 'js/audiostore.js', 'js/audioplayer.js', 'js/audiobooks.js', 'js/audiosources.js',
  'vendor/foliate-mobi.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && /\/share-target$/.test(url.pathname)) { e.respondWith(receiveShare(req)); return; }   // Web Share Target: an image shared from Safari / Chrome
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // never touch cross-origin catalog / Google traffic
  // Network-first (fresh code when online), falling back to the cache when offline or slow.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
      if (r.ok) cache.put(req, r.clone());
      return r;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }
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

// Offline shell + runtime caching of same-origin assets. Bump VERSION to refresh.
const VERSION = 'folio-v2';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'css/app.css', 'vendor/jszip.min.js', 'vendor/epub.min.js',
  'js/app.js', 'js/util.js', 'js/db.js', 'js/settings.js', 'js/store.js', 'js/epubmeta.js', 'js/net.js', 'js/opds.js', 'js/catalogs.js',
  'js/library.js', 'js/reader.js', 'js/dragsort.js', 'js/google.js', 'js/drive.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
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

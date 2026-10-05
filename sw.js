/* Tally service worker: offline support. Bump CACHE when you deploy a new version. */
const CACHE = 'tally-v1';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'config.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  const u = new URL(r.url);
  if(r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;   // never cache account or database calls
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => {
    const net = fetch(r).then(res => { if(res && res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; })
      .catch(() => hit || caches.match('index.html'));
    return hit || net;                                                          // instant from cache, refreshed in the background
  }));
});

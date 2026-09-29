const VERSION = 'tf-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'lib/hours.js', 'lib/rank.js', 'lib/facilities.js', 'lib/icons.js', 'manifest.json', 'icons/logo.svg', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'sample-data.json'];
const CDN = ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.all(CDN.map((u) => fetch(u, { mode: 'cors' }).then((r) => r.ok && c.put(u, r)).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Overpass and map tiles: always network (app handles its own offline cache)
  if (url.hostname.includes('overpass') || url.hostname.includes('tile.openstreetmap')) return;
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !url.hostname.endsWith('unpkg.com')) return;
  e.respondWith(caches.match(req, { ignoreSearch: sameOrigin }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net; // cache-first, refresh in background
  }));
});

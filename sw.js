/* Service worker: offline support for the Forever Winter map atlas.
   - App shell + all map JSON are precached on install (small, ~1 MB).
   - Images (tiles/icons/photos) are cached at runtime, cache-first, so any
     map you open keeps working offline afterwards.
   - "Save all offline" in the app posts SAVE_ALL to warm the whole image cache.
*/
const VERSION = 'fw-maps-v1';
const SHELL = VERSION + '-shell';
const IMG = VERSION + '-img';

const SHELL_ASSETS = [
  './', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'manifest.json',
  'assets/vendor/leaflet.js', 'assets/vendor/leaflet.css',
  'assets/vendor/images/marker-icon.png', 'assets/vendor/images/marker-shadow.png',
  'assets/vendor/images/layers.png', 'assets/vendor/images/layers-2x.png',
  'assets/icons/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // shell
    await cache.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: 'reload' })))
      .catch(() => {});
    // every map's JSON (so the map list + data work fully offline)
    try {
      const mf = await fetch('manifest.json').then(r => r.json());
      await cache.addAll(mf.maps.map(m => m.file)).catch(() => {});
    } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let wiki article links pass through

  const isImg = url.pathname.includes('/assets/img/');
  if (isImg) {
    e.respondWith(cacheFirst(IMG, req));
  } else {
    e.respondWith(staleWhileRevalidate(SHELL, req));
  }
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return hit || Response.error();
  }
}

async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fetcher = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fetcher;
}

/* Warm the entire image cache on request from the page. */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SAVE_ALL' && Array.isArray(e.data.urls)) {
    e.waitUntil((async () => {
      const cache = await caches.open(IMG);
      let done = 0;
      for (const u of e.data.urls) {
        try {
          if (!(await cache.match(u))) {
            const res = await fetch(u);
            if (res && res.ok) await cache.put(u, res.clone());
          }
        } catch (_) {}
        done++;
        if (done % 20 === 0 || done === e.data.urls.length) {
          const clients = await self.clients.matchAll();
          clients.forEach(c => c.postMessage({ type: 'SAVE_PROGRESS', done, total: e.data.urls.length }));
        }
      }
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'SAVE_DONE', total: e.data.urls.length }));
    })());
  }
});

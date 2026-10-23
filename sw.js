// Service worker for the installed app (PWA): the app files are served from the cache, so the app works
// offline, and refreshed in the background, so a new version is picked up on the next start.
// Bump CACHE when the file list changes.
const CACHE = 'step-viewer-v1';
const FILES = [
  'step-viewer.html', 'manifest.webmanifest',
  'vendor/libs.js', 'vendor/occt.js', 'vendor/sample.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];
const APP = new Set(FILES.map((f) => new URL(f, self.location).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // only the app's own files; models opened with ?model= always come from the network
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !APP.has(url.pathname)) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) c.put(url.origin + url.pathname, res.clone());
      return res;
    });
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});

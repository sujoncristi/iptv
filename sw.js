// StreamWave Pro Service Worker (simple app-shell cache)
const CACHE_NAME = "streamwave-pro-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./assets/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // For navigation requests, serve cached index.html
  if(req.mode === "navigate"){
    event.respondWith(
      caches.match("./index.html").then((cached) => cached || fetch(req))
    );
    return;
  }

  // Cache-first for app assets, network-first for everything else
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(()=>cached))
  );
});

// Tarmoq birinchi: har safar yangi versiya olinadi, internet bo'lmasa keshdan ochiladi.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(r, { cache: "no-cache" }).then(res => {
      const copy = res.clone();
      caches.open("app-v1").then(c => c.put(r, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(r))
  );
});

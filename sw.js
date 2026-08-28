const CACHE = "daily-growth-v11";
const APP_SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./cloudbase-config.js", "./cloudbase.js", "./sync.js", "./vendor/cloudbase.bundle.js", "./manifest.webmanifest", "./icons/app-icon.svg", "./icons/apple-touch-icon.png", "./icons/icon-512.png"];
const SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }
  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

// Keeps a copy of the app's files on the device, so Dotdown opens without
// waiting for the network (home screen launches above all) and works offline.
//
// Every file is answered from the copy at once. In the background the file is
// fetched again and the copy updated, so a new deploy shows up one launch
// later. No version to bump: only the list below needs care when files are
// added, renamed or removed.
//
// The countdown itself never passes through here: it lives after the "#",
// which is not part of any request.

const CACHE = 'dotdown-app';

const FILES = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'favicon.svg',
  'apple-touch-icon.png',
  'fonts/CommitMono-Variable.woff2',
  'privacy.html',
];

self.addEventListener('install', (event) => {
  // 'reload' skips the browser's HTTP cache, so the copy starts out current.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Drop caches under any other name (left over if CACHE is ever renamed).
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(respond(event));
});

async function respond(event) {
  const cache = await caches.open(CACHE);
  // ignoreSearch: a link with ?s=... (STATE_MODE 'query') is still the same page.
  const cached = await cache.match(event.request, { ignoreSearch: true });

  // 'no-cache' asks the server whether the file changed (GitHub Pages lets
  // browsers keep files for 10 minutes otherwise); unchanged files cost
  // almost nothing to check.
  const fresh = fetch(event.request.url, { cache: 'no-cache' }).then((response) => {
    // A redirected response cannot answer a page load later, so do not keep it.
    if (response.ok && !response.redirected) {
      return cache.put(event.request.url, response.clone()).then(() => response);
    }
    return response;
  });

  if (cached) {
    event.waitUntil(fresh.catch(() => {})); // offline: the copy is all there is
    return cached;
  }
  return fresh;
}

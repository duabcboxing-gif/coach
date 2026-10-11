/*
 * Minimal service worker – only so phones offer "Install app / Add to Home Screen".
 * It does NOT cache anything (there is no offline mode): every request goes to the network.
 */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (event) {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request));
});

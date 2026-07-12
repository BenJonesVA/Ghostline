'use strict';

// Installability only — deliberately does not cache or intercept anything.
// Ghostline's entire feature set (signaling, WebRTC) needs a live connection,
// so there's nothing meaningful to serve offline, and caching app.js/index.html
// here would risk serving a stale build after a deploy. This exists purely so
// the browser considers the app installable (Add to Home Screen / desktop
// install prompt).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

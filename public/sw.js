// Service Worker for "متقن" PWA
// Purpose: Satisfies PWA installability criteria for Chrome/Android
// Note: Intentionally does NOT cache any Supabase or other dynamic requests to ensure 100% live data.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch listener required by PWA installability heuristics
self.addEventListener('fetch', (event) => {
  // Direct network pass-through
  return;
});

/* Minimal service worker.
   Its job is installability plus a usable offline shell — NOT caching answers.
   Vote data is always fetched live; a stale tally would be worse than none. */
const SHELL = 'oqotd-shell-v1';
const ASSETS = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never cache the API — results move through the day.
  if (url.pathname.startsWith('/api/')) return;

  // Network first for the page so a new question is never masked by cache.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => { const c = r.clone(); caches.open(SHELL).then(x => x.put('/index.html', c)); return r; })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});

/* ── web push ──────────────────────────────────────────────────────
   The push carries no payload. We fetch the current question here instead,
   so a notification delivered late still shows today's question, and there
   is no message content stored on any push service en route. */

const API_BASE = 'https://oqotd-api.YOUR-SUBDOMAIN.workers.dev';

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let title = 'Today\u2019s question is up';
    let body = 'Tap to answer before your colleagues do.';
    try {
      const res = await fetch(API_BASE + '/api/today', { cache: 'no-store' });
      if (res.ok) {
        const d = await res.json();
        title = d.text;
        body = d.option_a + ' or ' + d.option_b + '?';
      }
    } catch { /* keep the generic copy */ }

    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'oqotd-daily',        // one notification, never a stack
      renotify: true,
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) return c.focus();
    }
    return clients.openWindow(event.notification.data?.url || '/');
  })());
});

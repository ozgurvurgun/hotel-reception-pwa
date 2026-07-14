const CACHE_NAME = 'golden-gate-v75';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/config.js',
  '/js/api.js',
  '/js/icons.js',
  '/js/shift-excel.js',
  '/js/app.js',
  '/manifest.json',
  '/easter-egg/cover-dilerim.webp',
  '/easter-egg/cover-beni-al.webp',
  '/easter-egg/cover-kisa-mesafe.webp',
  '/easter-egg/cover-dilerim-96.jpg',
  '/easter-egg/cover-dilerim-256.jpg',
  '/easter-egg/cover-dilerim-512.jpg',
  '/easter-egg/cover-beni-al-96.jpg',
  '/easter-egg/cover-beni-al-256.jpg',
  '/easter-egg/cover-beni-al-512.jpg',
  '/easter-egg/cover-kisa-mesafe-96.jpg',
  '/easter-egg/cover-kisa-mesafe-256.jpg',
  '/easter-egg/cover-kisa-mesafe-512.jpg',
  '/icons/icon-16.png',
  '/icons/icon-32.png',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-144.png',
  '/icons/icon-152.png',
  '/icons/icon-167.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-384.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
];

function isUncacheableMedia(request) {
  try {
    const url = new URL(request.url);
    if (/\.(m4a|mp3|aac|wav|ogg|opus)$/i.test(url.pathname)) return true;
    if (request.headers.has('Range')) return true;
  } catch { /* ignore */ }
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) return;

  // Audio must hit the network with Range support — Cache API breaks seek on Android Chrome.
  if (isUncacheableMedia(event.request)) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Golden Gate', body: 'New notification', data: {} };
  try {
    data = event.data ? event.data.json() : data;
  } catch {
    data.body = event.data?.text() || data.body;
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      data: data.data || {},
      tag: data.data?.shiftId || 'golden-gate',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('/');
    })
  );
});

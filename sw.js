const CACHE_NAME = 'mundial-2026-v1';

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();

  event.waitUntil(
    self.registration.showNotification(data.title || '⚽ Polla Mundial 2026', {
      body: data.body || '¡Tienes un partido próximo sin apostar!',
      icon: data.icon || 'https://mundial-2026-ten-eta.vercel.app/favicon.ico',
      badge: data.badge || 'https://mundial-2026-ten-eta.vercel.app/favicon.ico',
      tag: data.matchId || 'mundial-reminder',
      requireInteraction: true,
      data: { url: data.url || '/' }
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
      return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});

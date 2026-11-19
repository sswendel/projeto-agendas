const APP_CACHE = 'agendas-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(['/'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== APP_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) await caches.open(APP_CACHE).then((cache) => cache.put('/', response.clone()))
        return response
      } catch {
        return (await caches.match('/')) || Response.error()
      }
    })())
  }
})

self.addEventListener('push', (event) => {
  let data = { title: 'Nova solicitação', body: 'Há um novo pedido de horário na sua agenda.', url: '/' }
  try { if (event.data) data = { ...data, ...event.data.json() } } catch { /* mantém a notificação padrão */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/app-icon.svg',
    badge: '/app-icon.svg',
    tag: 'agendas-new-appointment',
    renotify: true,
    data: { url: data.url || '/' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const destination = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin)
    return existing ? existing.navigate(destination).then(() => existing.focus()) : self.clients.openWindow(destination)
  }))
})

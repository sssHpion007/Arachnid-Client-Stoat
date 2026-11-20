// Service worker как у for-web (workbox precacheAndRoute): обработчик fetch
// есть, отвечает он только на свои файлы, остальные запросы страницы уходят в
// сеть. По сообщению страницы сам запрашивает адрес — как запросы service
// worker.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname === "/app/precached.txt") {
    event.respondWith(new Response("precached"));
  }
});

self.addEventListener("message", (event) => {
  const { id, url } = event.data;
  const reply = (result) => event.source.postMessage({ id, result });
  fetch(url, { mode: "cors", cache: "no-store" })
    .then(async (response) => {
      await response.arrayBuffer();
      reply({ status: response.status, timing: response.headers.get("server-timing") });
    })
    .catch((error) => reply({ error: String(error) }));
});

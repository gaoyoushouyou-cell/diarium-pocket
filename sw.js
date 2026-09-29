/*
 * Diarium Pocket — オフラインでも開けるようにするサービスワーカー。
 * アプリ本体のファイルだけをキャッシュする(記録の中身はキャッシュしない)。
 * Microsoft のサインインや OneDrive への通信には一切手を出さない。
 */
const CACHE = "pocket-2026-09-29.2";
const SHELL = [
  "./", "index.html", "app.js", "core.js", "auth.js", "config.js", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 画面(HTML)は「まずネット、3秒で返らなければ手元のコピー」。更新がすぐ届き、
// 電波が弱くても待たされない。スクリプト等は手元のコピーを使いつつ裏で更新する。
const NAV_TIMEOUT_MS = 3000;

function networkFirstPage(req) {
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put("index.html", copy));
    }
    return res;
  });
  const fallback = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS))
    .then(() => caches.match("index.html"));
  return Promise.race([network.catch(() => caches.match("index.html")), fallback.then((r) => r || network)]);
}

function staleWhileRevalidate(req) {
  return caches.match(req, { ignoreSearch: true }).then((cached) => {
    const network = fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => cached);
    return cached || network;
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  // サインインから戻ってきた "./?code=..." も同じ画面として扱う
  event.respondWith(req.mode === "navigate" ? networkFirstPage(req) : staleWhileRevalidate(req));
});

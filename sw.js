/*
 * Diarium Pocket — オフラインでも開けるようにするサービスワーカー。
 * アプリ本体のファイルだけをキャッシュする(記録の中身はキャッシュしない)。
 * Microsoft のサインインや OneDrive への通信には一切手を出さない。
 *
 * 更新の仕組み(画面と中身の版が食い違わないように):
 *  - 版ごとに別の名前のキャッシュを作り、install のときに全ファイルをまとめて取り直す
 *    (ブラウザの HTTP キャッシュに残った古いファイルは使わない)。
 *  - 開いている間は、その版のキャッシュだけから配る(HTML と JS が必ず同じ版になる)。
 *  - 新しい版が入ると、ページ側(app.js)が一度だけ読み直して新しい版に切り替わる。
 */
const CACHE = "pocket-2026-10-06.1";
const SHELL = [
  "./", "index.html", "app.js", "core.js", "auth.js", "config.js", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // サインインから戻ってきた "./?code=..." も同じ画面として扱う
    const hit = req.mode === "navigate"
      ? await cache.match("index.html")
      : await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});

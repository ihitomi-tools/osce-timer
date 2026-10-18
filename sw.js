/* ==============================================================
   OSCE 学習会タイマー  Service Worker（オフライン用）

   ■ しくみ
   - 初めて開いたとき、下の PRECACHE にあるファイルを全部端末に保存します。
     1つでも取れなかったら全体をやり直すので、「半分だけ保存された」状態にはなりません。
   - 2回目以降は保存したファイルを先に出します（電波がなくても動きます）。
     電波があれば、裏で最新版を取りに行き、次に開いたときから反映されます。

   ■ ファイルを更新したとき
   - timer.html など中身を変えたら、下の VERSION の数字を1つ上げてください（v2 → v3 …）。
     上げないと、端末が古い版を使い続けることがあります。
   - ファイルを追加・削除したら、PRECACHE の一覧も直してください。
   ============================================================== */

const VERSION = 'v22';
const CACHE_PREFIX = 'osce-timer-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

// 必ず必要なファイル（1つでも取れなかったら、保存全体をやり直します）
const PRECACHE = [
  './timer.html',
  './manifest.json',
  './jszip.min.js',
  './pdf.min.js',
  './pdf.worker.min.js',
  './awake.mp4',
  './start.mp3',
  './10min.mp3',
  './12min.mp3',
  './end.mp3',
  './precc-start.mp3',
  './precc-2min.mp3',
  './precc-end.mp3',
  './reading_assignment.mp3',
  './MPLUS1p-Regular.woff2',
  './MPLUS1p-Bold.woff2',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// あれば保存するファイル（まだ用意できていなくても、全体の保存は失敗させません）
// PreCC用の音声。あとから追加したときは、VERSION を上げるか、電波のある所でアプリを開けば保存されます
const OPTIONAL = [
  // 例：'./new-voice.mp3',
];

const toURL = (path) => new URL(path, self.registration.scope).href;
const isOptional = (url) => OPTIONAL.some((p) => toURL(p) === url.origin + url.pathname);
// ?以降（クエリ）を外した形をキャッシュの鍵にする
const cacheKey = (url) => { const u = new URL(url); return u.origin + u.pathname; };

/* ---------- インストール：全ファイルを保存 ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(async (path) => {
      const url = toURL(path);
      // cache:'reload' … 端末やGitHubの一時保存ではなく、必ず最新を取りに行く
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${path} を取得できませんでした (${res.status})`);
      await cache.put(cacheKey(url), res);
    }));
    // 任意のファイルは、取れたものだけ保存（失敗は無視）
    await Promise.all(OPTIONAL.map(async (path) => {
      try {
        const url = toURL(path);
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(cacheKey(url), res);
      } catch (err) { /* まだ無い／圏外 */ }
    }));
    await self.skipWaiting();
  })());
});

/* ---------- 有効化：古い版の保存データを削除 ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ---------- 通信：保存したものを先に返す ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(respond(event, req, url));
});

async function respond(event, req, url) {
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(url.href);
  const cached = await cache.match(key);

  // 音声：iPhoneのSafariは「ここからここまで」と部分的に要求してくる（Range）。
  // 保存したファイルから該当部分を切り出して返さないと、再生できないことがある。
  if (req.headers.has('range')) {
    if (cached) return rangeResponse(req, cached);
    // 任意ファイルがまだ保存されていなければ、丸ごと取って保存してから該当部分を返す
    if (isOptional(url)) {
      try {
        const full = await fetch(new Request(url.href, { cache: 'reload' }));
        if (full.ok) { await cache.put(key, full.clone()); return rangeResponse(req, full); }
        return full;
      } catch (err) { /* 圏外 */ }
    }
    return fetch(req);
  }

  if (cached) {
    event.waitUntil(refresh(cache, key));   // 裏で最新版を取っておく
    return cached;
  }

  try {
    const res = await fetch(req);
    if (res.ok && isOptional(url)) await cache.put(key, res.clone());
    return res;
  } catch (err) {
    // 圏外で、保存にないページを開こうとしたときは、タイマー画面を出す
    if (req.mode === 'navigate') {
      const fallback = await cache.match(cacheKey(toURL('./timer.html')));
      if (fallback) return fallback;
    }
    throw err;
  }
}

// 電波があるときだけ、最新版を保存し直す（失敗しても何もしない）
async function refresh(cache, key) {
  try {
    const res = await fetch(new Request(key, { cache: 'no-cache' }));
    if (res.ok) await cache.put(key, res);
  } catch (err) { /* 圏外 */ }
}

// 保存したファイルから、要求された範囲だけを返す
async function rangeResponse(req, cachedRes) {
  const buffer = await cachedRes.arrayBuffer();
  const size = buffer.byteLength;
  const type = cachedRes.headers.get('Content-Type') || 'audio/mpeg';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');

  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(buffer, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size) } });
  }

  let start, end;
  if (m[1] === '') {                       // 「最後のNバイト」の指定
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }

  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  const body = buffer.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(body.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

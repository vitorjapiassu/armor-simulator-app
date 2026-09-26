/*
 * Service worker: what makes the page installable, and what lets it open without a network.
 *
 * Two rules, because the files come in two kinds. Everything under assets/ carries a content hash in
 * its name, so a given URL never changes and the cache can be trusted outright. The page itself has
 * a fixed name and does change, so it is fetched first and only falls back to the cache when there
 * is no network — otherwise an install would pin whatever version happened to be current on the day.
 */
const CACHE = 'armor-simulator-v3';

/*
 * Cross-origin isolation, added to every response this worker hands back.
 *
 * `SharedArrayBuffer` is what lets more than one thread work on the same simulation state, and the
 * browser only offers it to a page that is cross-origin isolated — which normally means the server
 * sending these two headers. GitHub Pages does not let anyone set a header, so the service worker
 * sends them instead: it sits between the page and the network, and a response it rewrites counts.
 *
 * `require-corp` is only safe because this app loads nothing from anywhere else — no font service, no
 * CDN, no analytics. Every byte comes from this origin. Adding such a dependency later would be
 * blocked by this, which is the trade: the isolation buys threads and costs the right to hotlink.
 *
 * The very first visit ever made cannot be isolated, because no worker is controlling the page yet
 * to rewrite anything. Every visit after that is served through this and arrives isolated, which is
 * why nothing forces a reload to close that one gap; see `main.tsx`.
 */
const ISOLATION = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
];

/**
 * The same response, with the isolation headers on it.
 *
 * Never throws. This runs inside `respondWith`, so a exception here would not merely lose the
 * headers — it would fail the request and leave the page blank. Threads are worth a lot less than
 * the app loading, so anything unexpected hands back the response untouched and the app runs on one
 * thread, exactly as it did before any of this.
 */
function isolate(response) {
  try {
    // An opaque response has no readable body and no headers to speak of; hand it back untouched.
    if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of ISOLATION) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return response;
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

/** Stores a copy without holding up the response. */
async function keep(request, response) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response);
  } catch {
    /* quota, or an opaque response: nothing to do about either */
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // no-store, not a plain fetch: the page has a fixed name and GitHub Pages serves it with a
          // short max-age, so a plain fetch can be answered from the browser's HTTP cache with the
          // version from ten minutes ago — which then pins the old hashed bundle. Going past the HTTP
          // cache is the whole point of fetching the page first, and it is what makes an update show up.
          const fresh = await fetch(request, { cache: 'no-store' });
          void keep(request, fresh.clone());
          return isolate(fresh);
        } catch {
          const hit = (await caches.match(request)) ?? (await caches.match('index.html'));
          return hit ? isolate(hit) : Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(request);
      if (hit) return isolate(hit);
      const fresh = await fetch(request);
      if (fresh.ok) void keep(request, fresh.clone());
      return isolate(fresh);
    })(),
  );
});

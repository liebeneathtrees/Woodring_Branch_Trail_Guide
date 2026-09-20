/* Service worker for the Woodring Branch Recreation Area Field Guide.
 *
 * Goal: the guide opens and every species card works with no signal, and map
 * tiles the visitor has looked at (or chose to save) are still there.
 *
 * Caches
 *   shell : the page, its libraries and fonts, the icons
 *   tiles : map tiles (capped so storage cannot grow without limit)
 *   api   : the last good Community Sightings response
 *
 * Bump VERSION when this file's behavior changes. The page itself always tries
 * the network first (with a short timeout), so updates to the HTML arrive on the
 * next visit that has signal.
 */
const VERSION = 'v1';
const SHELL_CACHE = 'woodring-shell-' + VERSION;
const TILE_CACHE = 'woodring-tiles-v1';
const API_CACHE = 'woodring-api-v1';
const MAX_TILES = 800;          // total tiles kept in the tile cache
const MAX_REQUEST_TILES = 260;  // most tiles one "save this view" request may ask for
const NAV_TIMEOUT_MS = 4000;    // weak signal: give up on the network after this long

const PRECACHE = [
  './',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet-locatecontrol/0.79.0/L.Control.Locate.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet-locatecontrol/0.79.0/L.Control.Locate.min.js',
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap'
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'basemap.nationalmap.gov'
];
const STATIC_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// A 1x1 transparent PNG, shown in place of a tile that is not saved and cannot be fetched.
const BLANK_TILE = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

function isTile(url) {
  return TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One failed URL (for example, no signal during install) must not block installing.
    await Promise.allSettled(PRECACHE.map(async u => {
      const isCross = /^https?:/.test(u);
      const req = new Request(u, isCross ? { mode: 'cors', credentials: 'omit' } : {});
      const res = await fetch(req);
      if (res && res.ok) await cache.put(req, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith('woodring-shell-') && n !== SHELL_CACHE)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(res => { clearTimeout(timer); resolve(res); }, err => { clearTimeout(timer); reject(err); });
  });
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetchWithTimeout(req, NAV_TIMEOUT_MS);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./'));
    if (cached) return cached;
    return new Response('You are offline and this page has not been saved yet. Open it once with a connection, then it will work offline.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function cacheFirstWithRefresh(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  if (hit) {
    // Refresh in the background so the next visit has the newest copy.
    fetch(req).then(res => { if (res && res.ok) cache.put(req, res); }).catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    return Response.error();
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_TILES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]); // oldest first
}

async function tileHandler(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    // Ask with CORS so the saved copy is readable and small in the storage budget.
    const res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
    if (res && res.ok) {
      await cache.put(req.url, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch (err) {
    try { return await fetch(req); }
    catch (err2) { return new Response(BLANK_TILE, { status: 200, headers: { 'Content-Type': 'image/png' } }); }
  }
}

async function networkFirstApi(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirstNavigation(req));
  } else if (isTile(url)) {
    event.respondWith(tileHandler(req));
  } else if (url.hostname === 'api.inaturalist.org') {
    event.respondWith(networkFirstApi(req));
  } else if (url.origin === self.location.origin || STATIC_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirstWithRefresh(req));
  }
});

// ---- Messages from the page ----
async function cacheTiles(urls, port) {
  const cache = await caches.open(TILE_CACHE);
  const list = Array.from(new Set(urls)).filter(u => {
    try { return isTile(new URL(u)); } catch (e) { return false; }
  }).slice(0, MAX_REQUEST_TILES);
  let done = 0, failed = 0, i = 0;
  const total = list.length;
  const post = m => { if (port) port.postMessage(m); };
  post({ type: 'PROGRESS', done, failed, total });
  async function worker() {
    while (i < list.length) {
      const u = list[i++];
      try {
        if (!(await cache.match(u))) {
          const res = await fetch(new Request(u, { mode: 'cors', credentials: 'omit' }));
          if (res && res.ok) await cache.put(u, res); else failed++;
        }
      } catch (err) { failed++; }
      done++;
      post({ type: 'PROGRESS', done, failed, total });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  await trimTiles(cache);
  post({ type: 'DONE', done, failed, total });
}

async function reportStatus(port, page) {
  const shell = await caches.open(SHELL_CACHE);
  const tiles = await caches.open(TILE_CACHE);
  let pageSaved = false;
  if (page) pageSaved = !!(await shell.match(page, { ignoreSearch: true }));
  if (!pageSaved) pageSaved = !!(await shell.match('./'));
  const tileCount = (await tiles.keys()).length;
  if (port) port.postMessage({ type: 'STATUS', pageSaved, tileCount, version: VERSION });
}

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  if (data.type === 'CACHE_TILES' && Array.isArray(data.urls)) {
    event.waitUntil(cacheTiles(data.urls, port));
  } else if (data.type === 'CLEAR_TILES') {
    event.waitUntil(caches.delete(TILE_CACHE).then(() => { if (port) port.postMessage({ type: 'CLEARED' }); }));
  } else if (data.type === 'STATUS') {
    event.waitUntil(reportStatus(port, data.page));
  } else if (data.type === 'CACHE_PAGE' && data.url) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        const res = await fetch(data.url, { cache: 'reload' });
        if (res && res.ok) await cache.put(data.url, res);
      } catch (err) { /* offline: nothing to save right now */ }
      if (port) port.postMessage({ type: 'PAGE_SAVED' });
    })());
  }
});

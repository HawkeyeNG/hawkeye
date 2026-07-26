// Minimal service worker: cache the app shell so the observer app opens instantly
// on flaky election-day networks. API calls always hit the network.
const CACHE = 'hawkeye-v133'; // bump on any shell change so installed clients refresh
// NOTE: vendor/tesseract (~6 MB per client) is deliberately NOT precached — it
// lazy-loads on first sheet capture and the browser's HTTP cache keeps it.
// PRECACHE ONLY THE REAL SHELL. This list is re-downloaded IN FULL by every
// installed client on every CACHE bump (i.e. every deploy), in the background,
// while people are using the app — so weight here is paid repeatedly on slow
// Nigerian mobile links and shows up as "the site hangs when I tap something".
// It was ~1.5 MB / 45 requests; the map data and Leaflet (~940 KB) are needed by
// only 5 of ~25 pages, so they moved to LAZY below. Keep this lean: HTML +
// core JS/CSS + fonts. Anything big and page-specific belongs in LAZY.
const SHELL = ['/', '/index.html', '/observe.html', '/profile.html', '/how.html', '/faq.html', '/guide.html', '/collation.html', '/integrity.html', '/incidents.html', '/osun.html', '/practice.html', '/practice.js?v=1', '/race.html', '/race.js?v=3', '/race.css?v=1', '/app.js?v=118', '/scan.js?v=3', '/scan-worker.js?v=3', '/device.js', '/menu.js?v=109', '/tg.js?v=95', '/styles.css?v=108', '/manifest.webmanifest', '/dashboard.html', '/results.html', '/about.html', '/candidates.html', '/political.html', '/privacy.html', '/logo.svg', '/fonts/inter-400.woff2', '/fonts/inter-500.woff2', '/fonts/inter-600.woff2', '/fonts/inter-700.woff2', '/fonts/lora-600.woff2', '/fonts/lora-700.woff2'];

// Heavy, page-specific assets: NEVER precached (they'd tax every install for
// every user), cached on first successful fetch so revisits are instant.
// og-image.png is here too — only crawlers fetch it, and they don't use the SW.
const LAZY = ['/opencv.js', '/nga_wards.geojson', '/states_geo.json', '/lga_geo.json',
  '/district_geo.json', '/constituency_geo.json', '/political_data.json',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/og-image.png'];

// Opened ONCE per worker lifetime. The global caches.match() searches every
// cache in the origin, and re-opening the cache on each request adds latency to
// the path that has to be fastest — the navigation a user just tapped.
const cacheP = caches.open(CACHE);

self.addEventListener('install', (e) => {
  // skipWaiting: without it a NEW worker sits waiting while the OLD one keeps
  // serving the previous cache until every tab/app instance is closed — on
  // Android that made shell updates (e.g. new app.js) invisible for days.
  self.skipWaiting();
  // Add entries individually: cache.addAll() is ATOMIC, so one 404 (a renamed
  // page, a stale ?v= pin) aborts the whole install and the client then caches
  // NOTHING — every navigation silently falls back to the network forever.
  // allSettled degrades to "one file missing" instead.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(
    SHELL.map((u) => c.add(u).catch((err) => { console.warn('[sw] precache miss', u, err); throw err; })),
  )));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return; // network only
  }
  if (LAZY.includes(url.pathname)) {
    // Opt-in heavies (opencv ~13 MB, ward polygons ~5 MB, map GeoJSON, Leaflet):
    // fetched only when a page actually asks for them, then cached so repeat
    // visits and toggles are instant.
    e.respondWith(cacheP.then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // Navigations ignore the query string, so deep links (observe.html?intent=
  // incident, ?ref=…) hit the cached page instead of going to the network.
  // Documents ONLY — versioned assets must match exactly or a ?v= bump could be
  // served from the previous build.
  const opts = e.request.mode === 'navigate' ? { ignoreSearch: true } : undefined;
  e.respondWith(cacheP.then((c) => c.match(e.request, opts)).then((hit) => hit || fetch(e.request)));
});

// Minimal service worker: cache the app shell so the observer app opens instantly
// on flaky election-day networks. API calls always hit the network.
const CACHE = 'hawkeye-v121'; // bump on any shell change so installed clients refresh
// NOTE: vendor/tesseract (~6 MB per client) is deliberately NOT precached — it
// lazy-loads on first sheet capture and the browser's HTTP cache keeps it.
const SHELL = ['/', '/index.html', '/observe.html', '/profile.html', '/how.html', '/faq.html', '/guide.html', '/collation.html', '/integrity.html', '/incidents.html', '/osun.html', '/race.html', '/race.js?v=3', '/race.css?v=1', '/political_data.json', '/app.js?v=117', '/scan.js', '/device.js', '/menu.js?v=106', '/tg.js?v=95', '/styles.css?v=104', '/manifest.webmanifest', '/dashboard.html', '/results.html', '/about.html', '/candidates.html', '/political.html', '/privacy.html', '/og-image.png', '/states_geo.json', '/lga_geo.json', '/district_geo.json', '/constituency_geo.json', '/logo.svg', '/fonts/inter-400.woff2', '/fonts/inter-500.woff2', '/fonts/inter-600.woff2', '/fonts/inter-700.woff2', '/fonts/lora-600.woff2', '/fonts/lora-700.woff2', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];

self.addEventListener('install', (e) => {
  // skipWaiting: without it a NEW worker sits waiting while the OLD one keeps
  // serving the previous cache until every tab/app instance is closed — on
  // Android that made shell updates (e.g. new app.js) invisible for days.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
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
  if (url.pathname === '/opencv.js' || url.pathname === '/nga_wards.geojson') {
    // Large opt-in assets (opencv ~13 MB, ward polygons ~5 MB) — too big to
    // precache; cache on first successful fetch so repeat toggles are instant.
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});

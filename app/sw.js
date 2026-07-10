// Minimal service worker: cache the app shell so the observer app opens instantly
// on flaky election-day networks. API calls always hit the network.
const CACHE = 'hawkeye-v89'; // bump on any shell change so installed clients refresh
const SHELL = ['/', '/index.html', '/observe.html', '/how.html', '/faq.html', '/guide.html', '/collation.html', '/integrity.html', '/incidents.html', '/app.js', '/scan.js', '/device.js', '/menu.js?v=88', '/tg.js?v=88', '/styles.css?v=88', '/manifest.webmanifest', '/dashboard.html', '/results.html', '/about.html', '/candidates.html', '/political.html', '/privacy.html', '/og-image.png', '/states_geo.json', '/lga_geo.json', '/district_geo.json', '/constituency_geo.json', '/logo.svg', '/fonts/inter-400.woff2', '/fonts/inter-500.woff2', '/fonts/inter-600.woff2', '/fonts/inter-700.woff2', '/fonts/lora-600.woff2', '/fonts/lora-700.woff2', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
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

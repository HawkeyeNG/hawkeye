/**
 * Hawkeye basemap — the streets-and-rivers layer under every Leaflet map.
 *
 * WHY NOT tile.openstreetmap.org. OSM's tile policy forbids heavy use, and an
 * election night can bring ~1M visitors; getting blocked mid-count would blank
 * the map for everyone. So:
 *
 *   PRIMARY   our own Protomaps extract of Nigeria, one PMTiles file on
 *             Cloudflare R2 behind Cloudflare's cache (tiles.hawkeye.com.ng).
 *             Built and uploaded by .github/workflows/basemap-tiles.yml.
 *   FALLBACK  OpenFreeMap (openfreemap.org): free, no key. Used ONLY when ours
 *             fails — the header probe fails or times out, or three tiles in a
 *             row fail later on.
 *
 * Both are VECTOR tiles drawn by protomaps-leaflet (vendor/, self-hosted, no
 * CDN), so Leaflet stays the map library and every overlay keeps working.
 *
 * NETWORK. Tile requests are fetch()es, so they need the page's connect-src
 * (backend/src/services/security.js) AND must bypass the service worker, whose
 * own CSP is connect-src 'self' — see the tile-host early return in sw.js.
 * Nothing here is precached; the browser's HTTP cache is the only cache.
 *
 * HAWKEYE LITE. Capacitor's CapacitorHttp patches window.fetch to proxy through
 * native HTTP; range requests and binary bodies are not something to trust to
 * that proxy, so tile fetches use the WebView's own fetch
 * (window.CapacitorWebFetch) when it exists. CORS then applies exactly as on the
 * web, which the tile host answers with `Access-Control-Allow-Origin: *`.
 *
 * Usage:  HawkeyeBasemap.add(leafletMap)  → Promise<'primary'|'fallback'|'none'>
 */
(function () {
  'use strict';

  const PRIMARY_URL = 'https://tiles.hawkeye.com.ng/nigeria.pmtiles';
  const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
  const OFM_TILE_PREFIX = 'https://tiles.openfreemap.org/';
  // A dead host fails fast on its own; this bounds the one that hangs. Generous,
  // because the first 16 KB on a congested election-night link can be slow.
  const PROBE_MS = 10000;
  const FAILS_BEFORE_FALLBACK = 3;
  const MAX_ZOOM = 19; // what the old OSM raster layer allowed

  const T = (k, en) => (window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en);
  const netFetch = (...a) => (window.CapacitorWebFetch || window.fetch).apply(window, a);

  const osmCredit = () => `&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">${T('map.osm-contributors', 'OpenStreetMap contributors')}</a>`;
  const ATTRIBUTION = {
    primary: () => `<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> ${osmCredit()}`,
    // OpenFreeMap asks for "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
    fallback: () => `<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ${osmCredit()}`,
  };

  const withTimeout = (p, ms, what) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)),
  ]);

  /** The PMTiles class, reached through the one constructor the bundle exports. */
  function pmtilesFor(url) {
    const probe = new window.protomapsL.PmtilesSource(url, true).p;
    if (!window.CapacitorWebFetch) return probe; // web: the library's own FetchSource
    const PMTiles = probe.constructor;
    return new PMTiles({
      getKey: () => url,
      async getBytes(offset, length, signal) {
        const res = await netFetch(url, { signal, headers: { range: `bytes=${offset}-${offset + length - 1}` } });
        // A 200 here is the WHOLE ~400 MB file, not the slice asked for.
        if (res.status !== 206) throw new Error(`tiles: HTTP ${res.status} for a range request`);
        return {
          data: await res.arrayBuffer(),
          etag: res.headers.get('etag') || undefined,
          cacheControl: res.headers.get('cache-control') || undefined,
          expires: res.headers.get('expires') || undefined,
        };
      },
    });
  }

  /** Counts consecutive tile failures and calls onDead once past the limit. */
  function watchFailures(p, onDead) {
    const getZxy = p.getZxy.bind(p);
    let fails = 0; let dead = false;
    p.getZxy = async (...a) => {
      try {
        const r = await getZxy(...a);
        fails = 0;
        return r;
      } catch (e) {
        if (e && e.name !== 'AbortError' && ++fails >= FAILS_BEFORE_FALLBACK && !dead) { dead = true; onDead(e); }
        throw e;
      }
    };
    return p;
  }

  async function primaryLayer(onDead) {
    const p = pmtilesFor(PRIMARY_URL);
    const h = await withTimeout(p.getHeader(), PROBE_MS, 'basemap header');
    if (!h || h.specVersion < 3 || !(h.maxZoom >= 0)) throw new Error('basemap header unreadable');
    return window.protomapsL.leafletLayer({
      url: watchFailures(p, onDead),
      flavor: 'light',
      lang: 'en',
      maxDataZoom: h.maxZoom,
      maxZoom: MAX_ZOOM,
      attribution: ATTRIBUTION.primary(),
    });
  }

  /* ---------- fallback: OpenFreeMap (OpenMapTiles schema) ---------- */

  // Colours are protomaps-leaflet's own "light" flavour, so a fallback looks like
  // the same map with less detail rather than a different product.
  const C = {
    earth: '#e2dfda', water: '#80deea', park: '#cfddd5', wood: '#d0ded0', sand: '#e2e0d7',
    buildings: '#cccccc', casing: '#e0e0e0', road: '#ffffff', minor: '#ebebeb', rail: '#a7b1b3',
    boundary: '#adadad', label: '#5c5c5c', sublabel: '#8f8f8f', halo: '#ffffff',
  };

  function omtRules() {
    const P = window.protomapsL;
    const cls = (...c) => (z, f) => c.includes(f.props.class);
    const MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];
    const MINOR = ['tertiary', 'minor', 'service', 'track', 'path'];
    const paintRules = [
      { dataLayer: 'water', symbolizer: new P.PolygonSymbolizer({ fill: C.water }) },
      { dataLayer: 'landcover', filter: cls('wood', 'forest'), symbolizer: new P.PolygonSymbolizer({ fill: C.wood }) },
      { dataLayer: 'landcover', filter: cls('grass', 'farmland', 'scrub', 'wetland'), symbolizer: new P.PolygonSymbolizer({ fill: C.park, opacity: 0.6 }) },
      { dataLayer: 'landcover', filter: cls('sand'), symbolizer: new P.PolygonSymbolizer({ fill: C.sand }) },
      { dataLayer: 'park', symbolizer: new P.PolygonSymbolizer({ fill: C.park }) },
      { dataLayer: 'waterway', symbolizer: new P.LineSymbolizer({ color: C.water, width: P.exp(1.4, [[8, 0.5], [16, 4]]) }) },
      { dataLayer: 'building', minzoom: 13, symbolizer: new P.PolygonSymbolizer({ fill: C.buildings, opacity: 0.7 }) },
      { dataLayer: 'transportation', minzoom: 12, filter: cls(...MINOR), symbolizer: new P.LineSymbolizer({ color: C.casing, width: P.exp(1.6, [[12, 1.5], [18, 12]]) }) },
      { dataLayer: 'transportation', minzoom: 12, filter: cls(...MINOR), symbolizer: new P.LineSymbolizer({ color: C.minor, width: P.exp(1.6, [[12, 0.8], [18, 10]]) }) },
      { dataLayer: 'transportation', filter: cls('rail'), symbolizer: new P.LineSymbolizer({ color: C.rail, width: 1, dash: [3, 3] }) },
      { dataLayer: 'transportation', filter: cls(...MAJOR), symbolizer: new P.LineSymbolizer({ color: C.casing, width: P.exp(1.6, [[5, 1], [18, 18]]) }) },
      { dataLayer: 'transportation', filter: cls(...MAJOR), symbolizer: new P.LineSymbolizer({ color: C.road, width: P.exp(1.6, [[5, 0.5], [18, 15]]) }) },
      { dataLayer: 'boundary', filter: (z, f) => f.props.admin_level === 4 && !f.props.maritime, minzoom: 5, symbolizer: new P.LineSymbolizer({ color: C.boundary, width: 1, dash: [4, 3] }) },
      { dataLayer: 'boundary', filter: (z, f) => f.props.admin_level === 2 && !f.props.maritime, symbolizer: new P.LineSymbolizer({ color: C.boundary, width: 1.6, dash: [6, 3] }) },
    ];
    const names = ['name:en', 'name:latin', 'name'];
    const text = (size, fill) => new P.CenteredTextSymbolizer({
      labelProps: names, fill, stroke: C.halo, width: 2, fontFamily: 'sans-serif', fontSize: size, fontWeight: 600,
    });
    const labelRules = [
      { dataLayer: 'place', filter: cls('city'), symbolizer: text(14, C.label) },
      { dataLayer: 'place', filter: cls('town'), minzoom: 8, symbolizer: text(12, C.label) },
      { dataLayer: 'place', filter: cls('village', 'suburb', 'neighbourhood'), minzoom: 11, symbolizer: text(11, C.sublabel) },
      { dataLayer: 'place', filter: cls('state'), maxzoom: 7, symbolizer: text(12, C.sublabel) },
    ];
    return { paintRules, labelRules };
  }

  async function fallbackLayer() {
    const tj = await withTimeout(netFetch(OFM_TILEJSON).then((r) => {
      if (!r.ok) throw new Error(`OpenFreeMap TileJSON HTTP ${r.status}`);
      return r.json();
    }), PROBE_MS, 'OpenFreeMap TileJSON');
    const tpl = tj && Array.isArray(tj.tiles) && tj.tiles[0];
    // Only ever fetch tiles from OpenFreeMap's own host, whatever the JSON says.
    if (typeof tpl !== 'string' || !tpl.startsWith(OFM_TILE_PREFIX)) throw new Error('OpenFreeMap TileJSON has no usable tile URL');
    // A ZXY source shaped like PMTiles (getZxy), so it takes the same WebView fetch
    // in Lite as the primary does.
    const source = {
      async getZxy(z, x, y, signal) {
        const res = await netFetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal });
        if (res.status === 204 || res.status === 404) return undefined; // empty sea / out of range
        if (!res.ok) throw new Error(`OpenFreeMap tile HTTP ${res.status}`);
        return { data: await res.arrayBuffer() };
      },
    };
    const { paintRules, labelRules } = omtRules();
    return window.protomapsL.leafletLayer({
      url: source,
      paintRules,
      labelRules,
      backgroundColor: C.earth,
      maxDataZoom: Number.isInteger(tj.maxzoom) ? tj.maxzoom : 14,
      maxZoom: MAX_ZOOM,
      attribution: ATTRIBUTION.fallback(),
    });
  }

  /* ---------- wiring ---------- */

  function add(map) {
    if (!map || typeof L === 'undefined') return Promise.resolve('none');
    if (!window.protomapsL) {
      console.warn('[basemap] protomaps-leaflet did not load; map has no basemap');
      return Promise.resolve('none');
    }
    let current = null; let kind = 'none';
    const put = (layer, k) => {
      if (current) map.removeLayer(current);
      current = layer; kind = k;
      layer.addTo(map);
      map.getContainer().dataset.basemap = k; // for tests and support: which one drew
      return k;
    };
    // The attribution is built from translated text, and the page's language
    // bundle can land after the layer does — rebuild it on every language load.
    document.addEventListener('hawkeye-lang', () => {
      const ac = map.attributionControl;
      if (!current || !ac || !ATTRIBUTION[kind]) return;
      ac.removeAttribution(current.options.attribution);
      current.options.attribution = ATTRIBUTION[kind]();
      ac.addAttribution(current.options.attribution);
    });

    const toFallback = (why) => {
      console.warn('[basemap] Hawkeye tiles unavailable, using OpenFreeMap:', why && why.message ? why.message : why);
      return fallbackLayer().then((l) => put(l, 'fallback')).catch((e) => {
        console.warn('[basemap] OpenFreeMap unavailable too:', e && e.message ? e.message : e);
        // Ours stopped answering mid-session but still drew what it had: keep
        // it rather than blank the map — the next tiles may come back.
        if (kind === 'primary') return 'primary';
        kind = 'none';
        map.getContainer().dataset.basemap = 'none';
        return 'none';
      });
    };
    let switched = false;
    const onDead = (e) => { if (!switched && kind === 'primary') { switched = true; toFallback(e); } };
    return primaryLayer(onDead).then((l) => put(l, 'primary'), toFallback);
  }

  window.HawkeyeBasemap = { add, PRIMARY_URL, OFM_TILEJSON };
})();

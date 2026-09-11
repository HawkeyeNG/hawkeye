/* Ward-level maps for the situation room: geometry only, no DOM.
 *
 * The shipped state/LGA layers are pre-projected SVG; wards exist only as raw
 * lat/lng (app/nga_wards.geojson, served per LGA by /groups/:id/wards-geo), and
 * polling units have no polygon at all. So this projects a ward layer itself and
 * places units as POINTS.
 *
 * MOST UNITS HAVE NO TRUSTWORTHY POSITION. A unit is drawn where it is only when
 * it has one (verified or crowd-located) AND that point falls inside its ward —
 * the geocoded register is often wrong, and a point outside its own ward is
 * exactly that. Every other unit is SCATTERED inside the ward polygon: these are
 * visuals to show a manager what is going on, not a gazetteer. The scatter is
 * DETERMINISTIC — seeded from the unit code — so a point never jumps on refresh
 * and reads as activity; and every scattered point is flagged `approx` so the
 * page can say "position approximate" rather than assert a location.
 */
(function (G) {
  const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Words naming a direction or a kind of place, not a ward: sharing one
  // ("Epetedo East" / "Epetedo West") proves nothing.
  const STOP = new Set(['ward', 'east', 'west', 'north', 'south', 'central', 'upper', 'lower', 'new', 'old', 'town', 'road', 'area', 'village', 'the']);
  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

  /**
   * The layer's ward for a register ward name, or null.
   *
   * The layer and the INEC register draw and name wards differently — only about
   * half of the register's wards match a layer name exactly. So: an exact folded
   * match, else the ONE layer ward sharing a distinctive word with it
   * ("Olowogbowo/Elegbata" -> "Oke-Olowogbowo"). Two candidates is ambiguous and
   * stays unmatched: a ward drawn in the wrong place is worse than one not drawn.
   */
  function match(name, wards) {
    const f = fold(name);
    const exact = wards.find((w) => fold(w.ward) === f);
    if (exact) return exact;
    const t = words(name);
    const cands = wards.filter((w) => words(w.ward).some((x) => t.includes(x)));
    return cands.length === 1 ? cands[0] : null;
  }
  // Polygon | MultiPolygon -> [polygon[ring[[lng, lat]]]]
  const polys = (g) => (g && g.type === 'Polygon' ? [g.coordinates] : g && g.type === 'MultiPolygon' ? g.coordinates : []);

  function bbox(geoms) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const g of geoms) for (const poly of polys(g)) for (const ring of poly) for (const [x, y] of ring) {
      if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y;
    }
    return [a, b, c, d];
  }

  // Equirectangular with the longitude squeezed by cos(latitude): at ward and
  // LGA scale near the equator that is indistinguishable from anything fancier.
  function projector(geoms, W = 800) {
    const [a, b, c, d] = bbox(geoms);
    const k = Math.cos(((b + d) / 2) * Math.PI / 180);
    const s = W / Math.max((c - a) * k, 1e-9);
    return { W, H: Math.max(1, (d - b) * s), p: ([x, y]) => [(x - a) * k * s, (d - y) * s] };
  }

  const pathOf = (g, p) => polys(g).map((poly) => poly.map((ring) =>
    'M' + ring.map((pt) => p(pt).map((v) => v.toFixed(1)).join(' ')).join('L') + 'Z').join('')).join('');

  // Even-odd ray cast over every ring, so holes count as outside.
  function inside(g, [x, y]) {
    let hit = false;
    for (const poly of polys(g)) for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
    }
    return hit;
  }

  // mulberry32 seeded by FNV-1a of the unit code.
  function rng(key) {
    let h = 2166136261;
    for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    let t = h >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function place(node, g) {
    if (node.lat != null && node.lng != null && inside(g, [node.lng, node.lat])) {
      return { pt: [node.lng, node.lat], approx: false };
    }
    const [a, b, c, d] = bbox([g]);
    const r = rng(node.key);
    for (let i = 0; i < 400; i++) {
      const pt = [a + r() * (c - a), b + r() * (d - b)];
      if (inside(g, pt)) return { pt, approx: true };
    }
    return { pt: [(a + c) / 2, (b + d) / 2], approx: true };
  }

  const api = {
    fold,
    inside,
    match,
    /**
     * LGA view: every ward of the LGA, each matched to at most ONE coverage row.
     * Exact names claim shapes first; a word match may only take a shape nothing
     * claimed exactly, and a shape two rows reach by word is given to neither.
     */
    wardShapes(wards, nodes) {
      const { W, H, p } = projector(wards.map((w) => w.geometry));
      const claims = new Map();
      const exact = new Set();
      for (const n of nodes) {
        const w = wards.find((x) => fold(x.ward) === fold(n.name));
        if (w && !claims.has(w)) { claims.set(w, n); exact.add(n); }
      }
      const free = wards.filter((w) => !claims.has(w));
      const loose = new Map();
      for (const n of nodes) {
        if (exact.has(n)) continue;
        const w = match(n.name, free);
        if (w) loose.set(w, loose.has(w) ? null : n);
      }
      for (const [w, n] of loose) if (n) claims.set(w, n);
      return { W, H, shapes: wards.map((w) => ({ name: w.ward, node: claims.get(w) || null, d: pathOf(w.geometry, p) })) };
    },
    /** Ward view: the ward outline, and one point per unit row. */
    unitPoints(geometry, nodes) {
      const { W, H, p } = projector([geometry]);
      return {
        W, H, outline: pathOf(geometry, p),
        points: nodes.map((node) => {
          const { pt, approx } = place(node, geometry);
          const [x, y] = p(pt);
          return { x, y, pt, approx, node };
        }),
      };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else G.HawkeyeWardMap = api;
})(typeof self !== 'undefined' ? self : globalThis);

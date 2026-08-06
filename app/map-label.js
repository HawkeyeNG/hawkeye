/**
 * Where to put a label inside an irregular map shape.
 *
 * THE BUG THIS FIXES. Both maps placed the party flag at a point that is not
 * guaranteed to be inside the state at all: preview.html used the precomputed
 * vertex-average centroid, results.html used the bounding-box centre. Both are
 * correct only for roughly convex blobs. Nigeria has plenty of states that are
 * not — long tails, crescents, shapes that wrap around a neighbour — and for
 * those the "centre" lands off the shape or jammed against an edge, which is
 * what reads as janky when 37 of them are on screen at once.
 *
 * THE FIX is the pole of inaccessibility: the interior point furthest from the
 * boundary. It is the standard answer for map labelling because it is always
 * inside the shape and always has the most room around it.
 *
 * No dependency and no polygon parsing: the SVG path itself is the source of
 * truth. `getPointAtLength` samples the outline, `isPointInFill` tests the
 * inside. That also means it works unchanged for states, senatorial districts,
 * federal constituencies and LGAs, which are four different geometries.
 */
(function () {
  const CACHE = new WeakMap();

  /**
   * @param {SVGPathElement} path
   * @param {{samples?:number, grid?:number, passes?:number}} [opts]
   * @returns {{x:number, y:number, r:number}} centre + clearance to the edge
   */
  function labelPoint(path, opts) {
    const hit = CACHE.get(path);
    if (hit) return hit;
    const { samples = 96, grid = 12, passes = 4 } = opts || {};
    const b = path.getBBox();
    const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2, r: 0 };

    // Outline sample set — distance to the nearest of these approximates
    // distance to the boundary closely enough at label scale.
    let len = 0;
    try { len = path.getTotalLength(); } catch { return centre; }
    if (!len || !path.isPointInFill) return centre;
    const edge = [];
    for (let i = 0; i < samples; i++) {
      const p = path.getPointAtLength((len * i) / samples);
      edge.push(p.x, p.y);
    }

    const svg = path.ownerSVGElement;
    if (!svg) return centre;
    const pt = svg.createSVGPoint();
    const clearance = (x, y) => {
      pt.x = x; pt.y = y;
      let inside;
      try { inside = path.isPointInFill(pt); } catch { inside = false; }
      if (!inside) return -1;
      let min = Infinity;
      for (let i = 0; i < edge.length; i += 2) {
        const dx = x - edge[i];
        const dy = y - edge[i + 1];
        const d = dx * dx + dy * dy;
        if (d < min) min = d;
      }
      return Math.sqrt(min);
    };

    // Coarse grid, then zoom in around the winner. Cheap and good enough:
    // we need "comfortably inside", not the mathematical optimum.
    let best = { x: centre.x, y: centre.y, r: clearance(centre.x, centre.y) };
    let x0 = b.x, y0 = b.y, w = b.width, h = b.height;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i <= grid; i++) {
        for (let j = 0; j <= grid; j++) {
          const x = x0 + (w * i) / grid;
          const y = y0 + (h * j) / grid;
          const r = clearance(x, y);
          if (r > best.r) best = { x, y, r };
        }
      }
      w /= grid / 2; h /= grid / 2;          // shrink the search window
      x0 = best.x - w / 2; y0 = best.y - h / 2;
    }
    // Degenerate slivers can have no sampled interior point; fall back rather
    // than drop the flag, since a slightly-off flag beats a missing one.
    const out = best.r > 0 ? best : centre;
    CACHE.set(path, out);
    return out;
  }

  /**
   * Half-width, in USER units, for a badge that should be `targetPx` wide on
   * screen — whatever the viewBox is.
   *
   * SVG lengths are user units, so a badge sized in them changes physical size
   * whenever the viewBox does. The national map is 800 units wide; a cropped
   * state map is ~75. The same 20-unit badge is 7px on one and 79px on the
   * other, which is how the Osun LGA map ended up completely buried under its
   * own flags. Sizing by viewBox fraction instead just inverts the problem —
   * the Osun flags shrink to 7px and stop being readable.
   *
   * Pinning it to a constant PIXEL size is the other wrong answer, and it is
   * worth writing down because it looks right on a desktop: the map shrinks
   * with the viewport but the flags do not, so on a phone they collide into an
   * unreadable pile in the dense south. Flags have to scale WITH the map.
   *
   * So: a constant fraction of the viewBox. Identical relative size on the
   * national map and on any cropped state map, and it grows and shrinks with
   * the viewport exactly like the rest of the SVG. /80 reproduces the r=10 that
   * was signed off on the 800-wide national viewBox.
   */
  function badgeScale(svg, divisor) {
    const vbW = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 0;
    return vbW > 0 ? vbW / (divisor || 80) : 10;
  }

  window.HAWKEYE_MAP = { labelPoint, badgeScale };
})();

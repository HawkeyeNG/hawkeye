/**
 * SEVERAL PHOTOS OF ONE SHEET, JOINED ON THE PHONE.
 *
 * The public photographs the EC60(E) result poster INEC pastes up at the unit,
 * and a poster can be too big for one readable photo or printed across sheets
 * (docs/private/EC60E-RESULT-POSTER.md). The observer shoots it in parts, top
 * first; this joins them TOP TO BOTTOM into one JPEG, BEFORE anything is
 * hashed or signed. The ledger therefore still holds exactly one sheet photo,
 * and the report says how many parts it was (`sheetParts`, unsigned: it only
 * changes how the server reads the photo).
 *
 * THE BOX IS THE GPU READER'S BUDGET. The reader scales a sheet to 1500 px wide
 * and has an 8,192-token context; a joined image taller than 1500 x 2250 would
 * crowd out the answer. So parts are scaled to a common width (at most 1500)
 * and the whole join is shrunk, never cropped, to fit 2250 px of height.
 *
 * THE BAND IS ON PURPOSE. A plain dark strip between parts says "joined here"
 * to a human reviewer and to the vision check (which is told about it), so a
 * join is never mistaken for a hidden edit.
 *
 * Shared by observe.html (app.js) and practice.html (practice.js). Twin of
 * native/src/lib/sheet-parts.ts.
 */
(function () {
  const MAX = 3;          // backend MAX_SHEET_PARTS
  const MAX_W = 1500;
  const MAX_H = 2250;
  const BAND = 16;
  const BAND_COLOUR = '#111111';
  const QUALITY = 0.76;   // the sheet's tuned upload quality (app.js compressCapture)

  /** The joined layout for parts of these natural sizes: [{w,h}] -> { width, height, rows:[{y,h}] }. */
  function layout(sizes) {
    if (!sizes.length) throw new Error('no parts');
    const w = Math.min(MAX_W, Math.max(...sizes.map((s) => s.w)));
    const hs = sizes.map((s) => (s.h * w) / s.w);
    const room = MAX_H - BAND * (sizes.length - 1);
    const k = Math.min(1, room / hs.reduce((a, b) => a + b, 0));
    const width = Math.max(1, Math.round(w * k));
    let y = 0;
    const rows = hs.map((h) => {
      const r = { y, h: Math.max(1, Math.round(h * k)) };
      y += r.h + BAND;
      return r;
    });
    return { width, height: y - BAND, rows };
  }

  /** A data: URL or a Blob, as a Blob. */
  async function asBlob(x) {
    if (x instanceof Blob) return x;
    return (await fetch(x)).blob();
  }

  /** Join the parts (Blobs or data: URLs), top first, into one JPEG Blob. */
  async function join(parts) {
    if (!Array.isArray(parts) || parts.length < 2 || parts.length > MAX) throw new Error(`join needs 2..${MAX} parts`);
    const bmps = [];
    try {
      for (const p of parts) bmps.push(await createImageBitmap(await asBlob(p)));
      const L = layout(bmps.map((b) => ({ w: b.width, h: b.height })));
      const c = document.createElement('canvas');
      c.width = L.width; c.height = L.height;
      const g = c.getContext('2d');
      g.fillStyle = BAND_COLOUR;
      g.fillRect(0, 0, L.width, L.height);
      bmps.forEach((b, i) => g.drawImage(b, 0, L.rows[i].y, L.width, L.rows[i].h));
      const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', QUALITY));
      if (!out) throw new Error('could not encode the joined photo');
      return out;
    } finally {
      for (const b of bmps) b.close?.();
    }
  }

  window.HAWKEYE_SHEETPARTS = { MAX, MAX_W, MAX_H, BAND, layout, join };
})();

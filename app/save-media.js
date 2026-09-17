/* A copy of what the observer just reported, kept on their own device.
 *
 * ONE helper, four callers: the result report (app.js), collation, incidents
 * and practice. Each calls it ONCE per report, at hand-off — after the server
 * accepted it (201) or after it went into the offline outbox — and never from
 * outbox.js, so a later flush or a retry cannot save the same photos twice.
 *
 *   HAWKEYE_SAVE_MEDIA(items, label)
 *     items  [{ blob, kind: 'photo'|'video', picked? }]
 *            blob is the PROCESSED Blob that was uploaded or queued (the canvas
 *            re-encode, never the camera original), or a data: URL string.
 *            picked: true marks a file chosen off the device — never saved,
 *            it is already there.
 *     label  'result' | 'collation' | 'incident' | 'practice' (goes in the name)
 *
 * FIRE AND FORGET. It returns at once and swallows every error: a report must
 * never wait on, or fail because of, a copy of itself.
 *
 * Lite: @capacitor-community/media into a "Hawkeye" album, in the plugin's
 * default (non-gallery) Android mode, which needs no storage permission — see
 * MediaPlugin.java: it writes under getExternalMediaDirs(), i.e.
 * Android/media/ng.com.hawkeye.lite/Hawkeye/, and broadcasts a media scan so
 * gallery apps list it. iOS asks for add-only Photos access.
 * Browser: a best-effort download per file. A page cannot reach the gallery.
 *
 * OFF SWITCH: My Profile writes hawkeye_save_media = '0' for "don't keep copies
 * on this phone" — an observer whose phone may be searched. Read first, before
 * any plugin, permission prompt or download.
 */
(function () {
  const PREF = 'hawkeye_save_media';
  // Videos cross the bridge as base64: ~1.33x the file, plus the copies the
  // WebView and the plugin each hold. Lite targets low-end phones, so anything
  // over 25 MB is skipped rather than risk the app being killed mid-report.
  const VIDEO_MAX = 25 * 1024 * 1024;
  const ALBUM = 'Hawkeye';
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp' };

  const enabled = () => { try { return localStorage.getItem(PREF) !== '0'; } catch { return true; } };
  const inTelegram = () => /tgWebApp/i.test(location.hash) || /tgWebApp/i.test(location.search)
    || window.TelegramWebviewProxy !== undefined; // tg.js's own test; its WebView drops downloads

  const typeOf = (blob, kind) => blob.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg');

  function fromDataUrl(s) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(s);
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] || '' });
  }

  /**
   * Does this JPEG carry a location? The pages' compression hands back the
   * ORIGINAL when re-encoding fails or comes out larger, and an original can
   * hold an Exif GPS block or XMP GPS fields. A canvas re-encode never has
   * either, so this only ever fires on that fallback — and then the copy is
   * skipped rather than written into a gallery that may be shared later.
   */
  async function locates(blob) {
    const b = new Uint8Array(await blob.slice(0, 262144).arrayBuffer());
    if (b[0] !== 0xFF || b[1] !== 0xD8) return false; // not a JPEG
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) return true; // unparseable: assume the worst
      const m = b[i + 1];
      if (m === 0xDA || m === 0xD9) return false; // image data begins: no more metadata
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m === 0xE1) {
        const seg = b.subarray(i + 4, Math.min(b.length, i + 2 + len));
        const head = String.fromCharCode.apply(null, seg.subarray(0, 29));
        if (head.startsWith('Exif\0\0') && gpsIfd(seg.subarray(6))) return true;
        if (head.startsWith('http://ns.adobe.com/xap/') && /GPS(Latitude|Longitude)/.test(new TextDecoder().decode(seg))) return true;
      }
      i += 2 + len;
    }
    return true; // metadata ran past what was read
  }
  // TIFF header -> IFD0 -> is tag 0x8825 (GPSInfo) present?
  function gpsIfd(t) {
    const le = t[0] === 0x49;
    const u16 = (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
    const u32 = (o) => (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3])) >>> 0;
    const ifd = u32(4);
    if (ifd + 2 > t.length) return true;
    for (let k = 0, n = u16(ifd); k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 2 > t.length) return true;
      if (u16(e) === 0x8825) return true;
    }
    return false;
  }

  const asDataUrl = (blob, type) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^;,]*/, 'data:' + type)); // the plugin names the file from this type
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  // The album's identifier, looked up once per session. Android requires one;
  // iOS goes without, because listing albums there needs full Photos READ
  // access where saving alone needs only add-only.
  let albumP = null;
  function album(M) {
    try { const id = sessionStorage.getItem('hawkeye_media_album'); if (id) return Promise.resolve(id); } catch { /* look it up */ }
    if (!albumP) {
      const find = async () => (((await M.getAlbums()) || {}).albums || []).find((a) => a.name === ALBUM);
      albumP = (async () => {
        let a = await find();
        if (!a) { await M.createAlbum({ name: ALBUM }).catch(() => {}); a = await find(); } // rejects if it already exists
        if (!a || !a.identifier) throw new Error('no album');
        try { sessionStorage.setItem('hawkeye_media_album', a.identifier); } catch { /* memory only */ }
        return a.identifier;
      })();
      albumP.catch(() => { albumP = null; });
    }
    return albumP;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Not revoked at once: some browsers are still reading the blob after click().
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function run(items, label) {
    const Cap = window.Capacitor;
    const lite = !!(window.HAWKEYE && window.HAWKEYE.native);
    const M = lite && Cap && Cap.Plugins && Cap.Plugins.Media;
    if (lite && !M) return; // Lite without the plugin: nothing to save with
    if (!lite && inTelegram()) return;
    const android = lite && Cap.getPlatform && Cap.getPlatform() === 'android';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    let n = 0;
    for (const it of items || []) {
      try {
        if (!it || !it.blob || it.picked) continue;
        const kind = it.kind === 'video' ? 'video' : 'photo';
        const blob = typeof it.blob === 'string' ? fromDataUrl(it.blob) : it.blob;
        if (kind === 'video' && lite && blob.size > VIDEO_MAX) continue;
        const type = typeOf(blob, kind);
        if (kind === 'photo' && await locates(blob)) continue;
        const name = `hawkeye-${label || 'report'}-${stamp}-${++n}`;
        if (!lite) { download(blob, `${name}.${EXT[type] || (kind === 'video' ? 'mp4' : 'jpg')}`); continue; }
        const opts = { path: await asDataUrl(blob, type), fileName: name };
        if (android) opts.albumIdentifier = await album(M);
        try {
          await (kind === 'video' ? M.saveVideo(opts) : M.savePhoto(opts));
        } catch (e) {
          // A stale cached album (deleted mid-session) fails every save after it.
          try { sessionStorage.removeItem('hawkeye_media_album'); } catch { /* ignore */ }
          if (/denied|not allowed/i.test(String((e && e.message) || e))) return; // no permission: stop asking
        }
      } catch { /* one file failing never stops the next */ }
    }
  }

  window.HAWKEYE_SAVE_MEDIA = function (items, label) {
    if (!enabled()) return;
    // Deferred, so the caller paints its outcome before any of this work starts.
    setTimeout(() => { run(items, label).catch(() => {}); }, 0);
  };
}());

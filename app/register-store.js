/**
 * The polling-unit register on the device — see docs/PU-SEARCH-2027.md.
 *
 * ONE owner for fetch → verify → inflate → index → search, shared by the web,
 * Capacitor (Hawkeye Lite) and eventually React Native. Today app.js and
 * pu-search.js each fetch and parse register-osun.json independently, so the
 * phone holds two copies of one state; at 176,846 units that stops being merely
 * wasteful.
 *
 * WHAT IT LOADS
 *   index pack   every state/LGA/ward + unit counts, ~56 KB, precached. Makes
 *                the browse cascade work offline nationwide from install.
 *   state pack   the unit names for one state, median ~32 KB, fetched on demand
 *                and kept COMPRESSED at rest (see below).
 *
 * COMPRESSED AT REST. Packs are served as application/octet-stream with no
 * Content-Encoding, because fetch() transparently inflates anything it can and
 * we would be storing ~5 MB instead of 1.4 MB. We hold the raw gzip bytes in
 * IndexedDB and inflate on load with DecompressionStream — which is also why the
 * generator emits gzip and not brotli: DecompressionStream has no brotli.
 *
 * REJECT, NEVER RENDER. Every pack carries a 32-byte header with a CRC32 over
 * its body. A truncated or mismatched pack is deleted and re-fetched, never
 * shown: a half-written pack does not fail loudly, it quietly lists the WRONG
 * units, and an observer standing at their polling unit has no way to tell.
 *
 * NO COORDINATES. Nothing here knows where a unit is. 8 rows in the register
 * have a real coordinate and 117,159 come from a corpus that is ~33% wrong, so
 * GPS is used only to guess which STATE to prefetch.
 */
(function () {
  'use strict';

  var MAGIC = 0x4b504b48; // 'HKPK'
  var FORMAT_VERSION = 1;
  var KIND_INDEX = 0;
  var KIND_STATE = 1;
  var HEADER_BYTES = 32;
  var DB_NAME = 'hawkeye-reg';
  var DB_STORE = 'packs';
  /**
   * ABSOLUTE, NOT RELATIVE — this matters inside the Capacitor shell (Hawkeye
   * Lite), which has no same-origin server.
   *
   * native.js rewrites LEADING-SLASH urls to hawkeye.com.ng and leaves relative
   * ones alone, so 'reg/manifest.json' resolved against the app's own asset
   * server: the shell read the manifest BUNDLED INTO THE APK and never asked the
   * site. A register correction would then reach every platform except the one
   * that cannot be updated without a store review — and the packs 404'd locally
   * rather than falling back, because Android's asset packer renames
   * `index.<sha>.pack.gz` to `.pack` and inflates it on the way in.
   *
   * apiBase is '' on the web (so this stays a same-origin absolute path, which
   * is what the service worker's SHELL entry matches) and the site's origin in
   * the shell.
   */
  var ORIGIN = (typeof window !== 'undefined' && window.HAWKEYE && window.HAWKEYE.apiBase) || '';
  var MANIFEST_URL = ORIGIN + '/reg/manifest.json';
  var MANIFEST_SIG_URL = ORIGIN + '/reg/manifest.sig';

  /**
   * The register signing key, PINNED — never fetched. A key collected from the
   * same host it is meant to authenticate would prove nothing.
   *
   * ECDSA P-256 over SHA-256, raw IEEE P1363: the primitive this codebase
   * already uses for observer signatures and the anchor, so there is one
   * algorithm here rather than two. Private half lives in ~/hawkeye-secrets and
   * signs via backend/scripts/sign_register_manifest.mjs.
   */
  var REGISTER_PUBLIC_KEY = 'BPEt4J9qwyTe0JI1ykyg7swuUMTsXp0orbcLV9pHr4m7liHXDtr4pzdUaMkfZWX61C+cpdKe+hg4eGnpW3Q3cLU=';

  /* ------------------------------------------------------------ crc32 */

  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  /* ------------------------------------------------------------- fold */

  /**
   * MUST match the server's name_fold/ward_fold exactly, or the same query
   * returns different answers online and offline at the same polling unit.
   */
  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^0-9A-Z]+/g, ' ')
      .trim();
  }

  /* ------------------------------------------------------------ reader */

  function Reader(buf) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.u8 = buf;
    this.pos = 0;
  }
  Reader.prototype.readU32 = function () { var v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; };
  Reader.prototype.readBlobBytes = function () {
    var n = this.readU32();
    var b = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  };
  Reader.prototype.readTable = function (dec) {
    var count = this.readU32();
    var s = dec.decode(this.readBlobBytes());
    var list = count === 0 ? [] : s.split('\n');
    if (list.length !== count) throw new Error('string table count mismatch');
    return list;
  };
  Reader.prototype.readColU8 = function (n) {
    var a = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return a;
  };
  Reader.prototype.readColU16 = function (n) {
    var a = new Uint16Array(n);
    for (var i = 0; i < n; i++) a[i] = this.dv.getUint16(this.pos + i * 2, true);
    this.pos += n * 2;
    return a;
  };
  /** Delta-coded ids: signed steps, so a repeated name can go backwards. */
  Reader.prototype.readColDelta = function (n) {
    var a = new Uint16Array(n), prev = 0;
    for (var i = 0; i < n; i++) { prev += this.dv.getInt16(this.pos + i * 2, true); a[i] = prev; }
    this.pos += n * 2;
    return a;
  };

  function readHeader(pack) {
    if (pack.length < HEADER_BYTES) throw new Error('pack shorter than its header');
    var dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad magic');
    var formatVersion = dv.getUint16(4, true);
    if (formatVersion !== FORMAT_VERSION) throw new Error('unsupported pack format v' + formatVersion);
    var meta = {
      formatVersion: formatVersion,
      kind: dv.getUint8(6),
      stateCode: dv.getUint8(7),
      registerVersion: dv.getUint32(8, true),
      groupCount: dv.getUint32(12, true),
      unitCount: dv.getUint32(16, true),
      bodyLength: dv.getUint32(20, true),
      crc32: dv.getUint32(24, true),
    };
    var body = pack.subarray(HEADER_BYTES);
    if (body.length !== meta.bodyLength) throw new Error('body length mismatch (truncated?)');
    if (crc32(body) !== meta.crc32) throw new Error('CRC mismatch (corrupt)');
    return { meta: meta, body: body };
  }

  /* ------------------------------------------------------------ decode */

  var pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
  var pad3 = function (n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; };

  /**
   * Decode a state pack into a SEARCHABLE form — deliberately not into 13,000
   * row objects. Two big strings plus typed arrays: the browser's own indexOf
   * does the scanning, and objects are built only for the handful displayed.
   */
  function decodeState(pack) {
    var t0 = now();
    var h = readHeader(pack);
    if (h.meta.kind !== KIND_STATE) throw new Error('not a state pack');
    var dec = new TextDecoder('utf-8');
    var r = new Reader(h.body);

    var wards = r.readTable(dec), lgas = r.readTable(dec), sens = r.readTable(dec), feds = r.readTable(dec);
    var G = h.meta.groupCount, N = h.meta.unitCount;
    var lgaCodes = r.readColU8(G), wardCodes = r.readColU8(G);
    var wardIds = r.readColDelta(G), lgaIds = r.readColDelta(G), senIds = r.readColDelta(G), fedIds = r.readColDelta(G);
    var counts = r.readColU16(G);
    var serials = r.readColU16(N);
    var tStruct = now();

    var names = dec.decode(r.readBlobBytes());
    var tDecode = now();

    // Line offsets into the display blob, and the group each unit belongs to.
    var offs = new Uint32Array(N + 1);
    var gOf = new Uint16Array(N);
    var i = 0, at = 0;
    for (var g = 0; g < G; g++) {
      for (var k = 0; k < counts[g]; k++, i++) gOf[i] = g;
    }
    offs[0] = 0;
    var line = 0;
    for (var p = 0; p < names.length; p++) {
      if (names.charCodeAt(p) === 10) offs[++line] = p + 1;
    }
    offs[N] = names.length + 1;
    if (line !== N - 1) throw new Error('name count ' + (line + 1) + ' != unitCount ' + N);
    var tOffsets = now();

    // NOTE: the FOLD IS NOT DONE HERE. Folding 13,325 names costs ~46 ms on a
    // laptop — the single most expensive step, and several hundred ms on the Go
    // phone this is for. Precomputing it in the pack was measured and rejected:
    // it nearly doubles the download (Lagos 113 KB -> 214 KB), which defeats the
    // point. So it is deferred off the load path — see buildSearchIndex().
    return {
      kind: 'state',
      meta: h.meta,
      stateCode: h.meta.stateCode,
      unitCount: N,
      names: names, offs: offs, folded: null, fOffs: null,
      serials: serials, gOf: gOf,
      groups: { lgaCodes: lgaCodes, wardCodes: wardCodes, wardIds: wardIds, lgaIds: lgaIds, senIds: senIds, fedIds: fedIds, counts: counts },
      tables: { wards: wards, lgas: lgas, sens: sens, feds: feds },
      timings: {
        header_struct: tStruct - t0,
        utf8_decode: tDecode - tStruct,
        offsets: tOffsets - tDecode,
        fold: null,               // filled in by buildSearchIndex()
        total: tOffsets - t0,
      },
    };
  }

  function decodeIndex(pack) {
    var h = readHeader(pack);
    if (h.meta.kind !== KIND_INDEX) throw new Error('not an index pack');
    var dec = new TextDecoder('utf-8');
    var r = new Reader(h.body);
    var states = r.readTable(dec), lgas = r.readTable(dec), wards = r.readTable(dec);
    var G = h.meta.groupCount;
    var stateCodes = r.readColU8(G), lgaCodes = r.readColU8(G), wardCodes = r.readColU8(G);
    var stateIds = r.readColDelta(G), lgaIds = r.readColDelta(G), wardIds = r.readColDelta(G);
    var counts = r.readColU16(G);
    return {
      kind: 'index', meta: h.meta, groupCount: G,
      stateCodes: stateCodes, lgaCodes: lgaCodes, wardCodes: wardCodes,
      stateIds: stateIds, lgaIds: lgaIds, wardIds: wardIds, counts: counts,
      tables: { states: states, lgas: lgas, wards: wards },
    };
  }

  /* ------------------------------------------------- searchable index */

  /**
   * Build the parallel FOLDED blob a search scans. Folding changes lengths
   * (NFKD, punctuation), so it carries its own offsets rather than reusing the
   * display ones.
   *
   * Deliberately NOT part of loading. It is the most expensive step by far, and
   * nothing needs it until the user actually types — by which point they have
   * spent a second reaching for the keyboard. Whole-blob folding was measured
   * and is SLOWER than per-name (one regex over 400 K chars beats 13 K small
   * ones only in theory), so this is the per-name loop, scheduled off the
   * critical path.
   */
  function buildSearchIndex(pack) {
    if (pack.folded) return pack;
    var t0 = now();
    var N = pack.unitCount, G = pack.groups.counts.length;

    // 1. folded NAME blob + its own offsets (folding changes lengths, so it
    //    cannot share the display offsets).
    var parts = new Array(N);
    var fOffs = new Uint32Array(N + 1);
    var acc = 0;
    for (var j = 0; j < N; j++) {
      var f = fold(pack.names.slice(pack.offs[j], pack.offs[j + 1] - 1));
      parts[j] = f;
      fOffs[j] = acc;
      acc += f.length + 1;
    }
    fOffs[N] = acc;
    pack.folded = parts.join('\n');
    pack.fOffs = fOffs;

    // 2. CODE blob. Every code is exactly 12 characters (DD-DD-DD-DDD), so a
    //    fixed stride replaces an offsets array entirely: code i starts at
    //    i * CODE_STRIDE. The server matches codes raw, so these are not folded.
    var codes = new Array(N);
    for (var i2 = 0; i2 < N; i2++) {
      var g2 = pack.gOf[i2];
      codes[i2] = pad2(pack.stateCode) + '-' + pad2(pack.groups.lgaCodes[g2]) + '-' +
                  pad2(pack.groups.wardCodes[g2]) + '-' + pad3(pack.serials[i2]);
    }
    pack.codes = codes.join('\n');

    // 3. folded WARD per group — a few hundred strings, not one per unit.
    var wf = new Array(G);
    for (var g3 = 0; g3 < G; g3++) wf[g3] = fold(pack.tables.wards[pack.groups.wardIds[g3]]);
    pack.wardFold = wf;

    pack.timings.fold = now() - t0;
    return pack;
  }

  var CODE_STRIDE = 13; // 12 characters + the newline

  var idle = (typeof requestIdleCallback === 'function')
    ? function (fn) { requestIdleCallback(fn, { timeout: 2000 }); }
    : function (fn) { setTimeout(fn, 0); };

  /** Resolves when the pack can be searched; starts the work if it has not run. */
  function ready(pack) {
    if (pack.folded) return Promise.resolve(pack);
    if (!pack._readyP) {
      pack._readyP = new Promise(function (resolve) {
        idle(function () { resolve(buildSearchIndex(pack)); });
      });
    }
    return pack._readyP;
  }

  /* ------------------------------------------------------------ search */

  /** Which unit does a character position in the folded blob belong to? */
  function unitAt(pack, pos) {
    var lo = 0, hi = pack.unitCount - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (pack.fOffs[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function displayName(pack, i) {
    return pack.names.slice(pack.offs[i], pack.offs[i + 1] - 1);
  }

  /** Rebuild a full row. pu_code comes back from group prefix + serial. */
  function materialise(pack, i, stateName) {
    var g = pack.gOf[i];
    return {
      pu_code: pad2(pack.stateCode) + '-' + pad2(pack.groups.lgaCodes[g]) + '-' +
               pad2(pack.groups.wardCodes[g]) + '-' + pad3(pack.serials[i]),
      name: displayName(pack, i),
      ward: pack.tables.wards[pack.groups.wardIds[g]],
      lga: pack.tables.lgas[pack.groups.lgaIds[g]],
      state: stateName || '',
      senatorial: pack.tables.sens[pack.groups.senIds[g]],
      federal_constituency: pack.tables.feds[pack.groups.fedIds[g]],
      locationTier: 'unmapped',
    };
  }

  /**
   * A FAITHFUL MIRROR of GET /api/register/search (backend/src/routes/pollingUnits.js).
   *
   * Not "similar to" — the same matched columns, the same two passes and the
   * same ordering, because an observer who loses signal mid-search must not see
   * the list reshuffle underneath them. Step 3 of docs/PU-SEARCH-2027.md diffs
   * the two implementations over a 500-query corpus and fails on any difference.
   *
   * The server:
   *   1. matches name / pu_code / ward,
   *   2. tries PREFIX first, and when that does not fill the page, appends the
   *      CONTAINS page after it (a leading wildcard cannot use an index, so it
   *      full-scans — but only when the cheap seek left room),
   *   3. orders each page by exact-code, then name-prefix, then code-prefix,
   *      then the rest, and alphabetically by name inside each tier.
   *
   * THE APPEND IS THE FIX FOR "17, Oziegbe St." (flow walkthrough REP-UNIT-01).
   * Contains used to run only when prefix found NOTHING, so "Oziegbe" answered
   * "1 match" (Oziegbe/Akinbola Junction) and hid every "NN, Oziegbe St." unit
   * — the usual Lagos house-number-first form. A count line that reads as
   * complete told the observer their unit was missing. Same change in the
   * server route and in native/src/lib/register-pack.ts; the three must agree.
   *
   * Names and wards are compared FOLDED on both sides (the server has
   * name_fold/ward_fold columns for exactly this); codes are compared raw,
   * since digits and hyphens have no case or punctuation to normalise.
   */
  function search(pack, term, opts) {
    opts = opts || {};
    var limit = opts.limit || 25;
    // The server's minimum is on the RAW query, before folding.
    var qRaw = String(term == null ? '' : term).trim();
    if (qRaw.length < 3) return { units: [], truncated: false, tookMs: 0 };
    if (!pack.folded) buildSearchIndex(pack);
    var t0 = now();

    var qf = fold(term);
    var N = pack.unitCount;
    var hit, found;

    function addUnit(i) { if (!hit[i]) { hit[i] = 1; found.push(i); } }
    function addGroup(g) {
      // units are stored grouped, so a ward match is a contiguous run
      var startIx = 0;
      for (var k = 0; k < g; k++) startIx += pack.groups.counts[k];
      for (var n = 0; n < pack.groups.counts[g]; n++) addUnit(startIx + n);
    }

    function collect(prefixOnly) {
      // --- names, over the folded blob
      if (qf) {
        if (prefixOnly) {
          if (pack.folded.lastIndexOf(qf, 0) === 0) addUnit(0);
          var needle = '\n' + qf;
          var at = pack.folded.indexOf(needle);
          while (at !== -1) { addUnit(unitAt(pack, at + 1)); at = pack.folded.indexOf(needle, at + 1); }
        } else {
          var at2 = pack.folded.indexOf(qf);
          while (at2 !== -1) { addUnit(unitAt(pack, at2)); at2 = pack.folded.indexOf(qf, at2 + 1); }
        }
      }
      // --- codes, raw, fixed stride
      for (var i = 0; i < N; i++) {
        var base = i * CODE_STRIDE;
        var ok = prefixOnly
          ? pack.codes.startsWith(qRaw, base)
          : pack.codes.indexOf(qRaw, base) !== -1 && pack.codes.indexOf(qRaw, base) < base + 12;
        if (ok) addUnit(i);
      }
      // --- wards, folded, per group
      if (qf) {
        for (var g = 0; g < pack.wardFold.length; g++) {
          var w = pack.wardFold[g];
          if (prefixOnly ? w.lastIndexOf(qf, 0) === 0 : w.indexOf(qf) !== -1) addGroup(g);
        }
      }
    }

    var codeAt = function (i) { return pack.codes.substr(i * CODE_STRIDE, 12); };
    var nameAt = function (i) { return displayName(pack, i); };
    var foldedAt = function (i) { return pack.folded.slice(pack.fOffs[i], pack.fOffs[i + 1] - 1); };

    /** One server query: match, ORDER BY, LIMIT — as unit indices. */
    function page(prefixOnly) {
      hit = new Uint8Array(N);
      found = [];
      collect(prefixOnly);
      var ranked = found.map(function (i) {
        var code = codeAt(i);
        var rank = 3;
        if (code === qRaw) rank = 0;
        else if (qf && foldedAt(i).lastIndexOf(qf, 0) === 0) rank = 1;
        else if (code.lastIndexOf(qRaw, 0) === 0) rank = 2;
        return { i: i, rank: rank, name: nameAt(i) };
      });
      // rank, then name — the server's ORDER BY, and SQLite's BINARY collation is
      // JavaScript's default string comparison, so the tie-break agrees too.
      ranked.sort(function (a, b) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        // Units do share names, and the server breaks that tie on pu_code so the
        // two implementations return the same page rather than the same set.
        var ca = codeAt(a.i), cb = codeAt(b.i);
        return ca < cb ? -1 : ca > cb ? 1 : 0;
      });
      return ranked.slice(0, limit).map(function (r) { return r.i; });
    }

    // Prefix page first; the contains page fills whatever room it left, in its
    // own order, without repeating a unit the prefix page already listed.
    var picked = page(true);
    if (picked.length < limit) {
      var seen = {};
      picked.forEach(function (i) { seen[i] = 1; });
      var more = page(false);
      for (var m = 0; m < more.length && picked.length < limit; m++) {
        if (!seen[more[m]]) picked.push(more[m]);
      }
    }

    var out = [];
    for (var n2 = 0; n2 < picked.length; n2++) {
      out.push(materialise(pack, picked[n2], opts.stateName));
    }
    // The server reports truncation as "we filled the page", not "more exist".
    return { units: out, truncated: out.length === limit, tookMs: now() - t0 };
  }

  /* ------------------------------------------------------ authenticity */

  /**
   * WHY THE PACKS ARE SIGNED AT ALL.
   *
   * On a phone with no signal the packs ARE the register — there is no server
   * left to contradict them. The CRC32 in each pack header catches a truncated
   * download; it is not a security check, since anyone able to serve bytes can
   * recompute it. HTTPS covers the wire. What remains is a compromised host, or
   * a network terminating TLS, handing an observer a unit list with units
   * quietly renamed or missing — and they would have no way to tell.
   *
   * So: the manifest is signed, and it carries a sha256 for every pack. Verify
   * the signature once, then every pack is bound to it by hash.
   *
   * FAILS CLOSED, AND THAT IS SAFE HERE. If the signature is missing or wrong we
   * refuse to use packs at all and the caller falls back to the API. Stripping
   * the signature therefore buys an attacker nothing except degraded offline
   * search — never a false unit list.
   */
  function b64ToBytes(b64) {
    var bin = atob(String(b64).trim());
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var pubKeyP = null;
  function signingKey() {
    if (!pubKeyP) {
      var pt = b64ToBytes(REGISTER_PUBLIC_KEY); // 0x04 || X || Y
      var b64u = function (u8) {
        var s2 = btoa(String.fromCharCode.apply(null, u8));
        return s2.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      pubKeyP = crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: b64u(pt.subarray(1, 33)), y: b64u(pt.subarray(33, 65)), ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    }
    return pubKeyP;
  }

  function verifyManifest(bytes, sigB64) {
    return signingKey().then(function (key) {
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64ToBytes(sigB64), bytes);
    });
  }

  function sha256Hex(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var v = new Uint8Array(buf), out = '';
      for (var i = 0; i < v.length; i++) out += (v[i] < 16 ? '0' : '') + v[i].toString(16);
      return out;
    });
  }

  /* --------------------------------------------------------- transport */

  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  function hasInflate() { return typeof DecompressionStream === 'function'; }

  function inflateGzip(bytes) {
    if (!hasInflate()) return Promise.reject(new Error('DecompressionStream unavailable'));
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var rq = tx.objectStore(DB_STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    }).catch(function () { return null; });
  }

  function idbPut(key, val) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { return false; });
  }

  function idbDel(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  /**
   * A DEADLINE ON EVERY NETWORK LEG. Nothing here had one.
   *
   * app.js has a house convention — every API call goes through apiTry(), which
   * wraps it in an AbortController with a 20s timeout (app/app.js:116). The
   * register bypassed it entirely: app.js:1055 `refApi()` awaits
   * loadRegisterIndex() BEFORE it can reach that guard, and the three fetches
   * below had no signal at all.
   *
   * A REJECTION was always handled; a STALL was not, and they are different
   * failures. Every catch here falls back to the API or to IndexedDB, so a 404
   * or a refused connection degrades fine. A connection that opens and then
   * never answers — a captive portal, a dying mobile cell, a proxy holding the
   * socket — leaves the await pending for the life of the page, and the state
   * cascade that awaits it never fills. That is the "Select your state is
   * broken" report, and it is Lite-shaped: strip_web_assets.sh removes reg/ from
   * the bundle, so on Android this is ALWAYS a network call, where on the
   * website it is a service-worker SHELL hit that resolves instantly.
   *
   * 12s, not app.js's 20: this is a prefetch with a working fallback behind it,
   * so failing over early costs a reader nothing and waiting costs them the
   * whole control.
   */
  var REG_TIMEOUT_MS = 12000;
  function fetchT(url, init) {
    var opts = init || {};
    if (typeof AbortController !== 'function') return fetch(url, opts);
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, REG_TIMEOUT_MS);
    opts.signal = ctl.signal;
    return fetch(url, opts).then(
      function (r) { clearTimeout(timer); return r; },
      function (e) {
        clearTimeout(timer);
        // Name it, so a timeout is distinguishable from a refusal in a log.
        throw (e && e.name === 'AbortError')
          ? new Error('register fetch timed out after ' + REG_TIMEOUT_MS + 'ms: ' + url)
          : e;
      }
    );
  }

  var manifestP = null;
  function manifest(force) {
    if (manifestP && !force) return manifestP;
    // Network-first so a register correction does not wait on a cache bump, with
    // the stored copy as the offline answer.
    manifestP = Promise.all([
      fetchT(MANIFEST_URL, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('manifest ' + r.status);
        return r.arrayBuffer();
      }),
      fetchT(MANIFEST_SIG_URL, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('manifest.sig ' + r.status);
        return r.text();
      }),
    ]).then(function (both) {
      var bytes = new Uint8Array(both[0]);
      return verifyManifest(bytes, both[1]).then(function (ok) {
        if (!ok) throw new Error('manifest signature invalid');
        var m = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        // Cache only what verified, so the offline path cannot be poisoned by a
        // bad manifest that happened to arrive once.
        idbPut('manifest', m);
        return m;
      });
    }).catch(function (err) {
      return idbGet('manifest').then(function (m) {
        if (!m) throw new Error('no verified manifest available (' + err.message + ')');
        return m;
      });
    });
    return manifestP;
  }

  var loaded = {};   // stateCode -> decoded pack
  var pending = {};  // stateCode -> in-flight load, so two callers share one fetch
  var indexPack = null;

  /**
   * Load one pack. Cached bytes are used only if they still verify AND match the
   * manifest's registerVersion — a stale unit list is a wrong unit list.
   */
  function loadPack(key, entry, decode, opts) {
    opts = opts || {};
    var timings = {};
    var tStart = now();

    function fromBytes(gzBytes, source) {
      var tInflate0 = now();
      // The signed manifest names each pack's sha256. A pack that does not hash
      // to it is not the pack we published, whatever else is true of it.
      var bound = entry.sha256
        ? sha256Hex(gzBytes).then(function (h) {
            if (h !== entry.sha256) throw new Error('pack hash does not match the signed manifest');
          })
        : Promise.reject(new Error('manifest entry has no sha256 — refusing to trust this pack'));
      return bound.then(function () { return inflateGzip(gzBytes); }).then(function (pack) {
        timings.inflate = now() - tInflate0;
        var decoded = decode(pack);
        timings.decode = decoded.timings ? decoded.timings.total : null;
        decoded.bytes = { gz: gzBytes.length, raw: pack.length };
        decoded.source = source;
        decoded.timings = Object.assign({}, decoded.timings, timings, { total: now() - tStart });
        return decoded;
      });
    }

    return idbGet(key).then(function (cached) {
      if (cached && cached.sha === entry.sha && !opts.forceNetwork) {
        return fromBytes(cached.bytes, 'idb').catch(function (err) {
          // Corrupt on disk: drop it and go to the network rather than render it.
          console.warn('[reg] cached pack rejected (' + err.message + '), re-fetching');
          return idbDel(key).then(function () { return null; });
        });
      }
      return null;
    }).then(function (hit) {
      if (hit) return hit;
      var tNet0 = now();
      return fetchT(ORIGIN + '/reg/' + entry.file, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('pack ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        timings.network = now() - tNet0;
        var bytes = new Uint8Array(ab);
        return fromBytes(bytes, 'network').then(function (decoded) {
          idbPut(key, { sha: entry.sha, bytes: bytes });
          return decoded;
        });
      });
    });
  }

  /* ----------------------------------------------------------------- coords */

  /**
   * OFFLINE NEAR-ME. The per-state coordinates file, and the two server answers
   * (/api/polling-units, /api/mapping/nearby) rebuilt from it. The twin of
   * native/src/lib/register-coords.ts — same format, same arithmetic — and both
   * follow backend/scripts/build_register_packs.mjs (buildCoords): unit i here is
   * unit i of the state pack named in the header, and which point may be trusted
   * was decided on the server when the file was built. Nothing here re-judges a pin.
   */
  var COORDS_MAGIC = 0x4f434b48; // 'HKCO'
  var COORDS_VERSION = 1;
  var F_PIN = 1, F_PIN_CROWD_MAPPED = 2, F_CROWD = 4, F_ENV = 64;
  var TIERS = ['verified', 'crowd', 'geocoded', 'unverified', 'unmapped'];
  var REGISTER_RADIUS_M = 500, REGISTER_MAX_ROWS = 40, MAPPING_MAX_ROWS = 200;

  function decodeCoords(bytes) {
    if (bytes.length < HEADER_BYTES) throw new Error('coords file is truncated');
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== COORDS_MAGIC) throw new Error('not a coords file');
    if (dv.getUint16(4, true) !== COORDS_VERSION) throw new Error('unsupported coords format v' + dv.getUint16(4, true));
    var n = dv.getUint32(8, true), nPin = dv.getUint32(12, true), nCrowd = dv.getUint32(16, true), nEnv = dv.getUint32(20, true);
    if (HEADER_BYTES + n + 8 * nPin + 8 * nCrowd + 10 * nEnv !== bytes.length) throw new Error('coords length mismatch');
    var pack = '';
    for (var b = 24; b < 32; b++) pack += String.fromCharCode(bytes[b]);
    var o = HEADER_BYTES;
    var flags = bytes.subarray(o, o + n); o += n;
    function col(count) {
      var a = new Float64Array(count);
      for (var i = 0; i < count; i++, o += 4) a[i] = dv.getInt32(o, true) / 1e6;
      return a;
    }
    var pLat = col(nPin), pLng = col(nPin), cLat = col(nCrowd), cLng = col(nCrowd), eLat = col(nEnv), eLng = col(nEnv);
    var eR = new Uint16Array(nEnv);
    for (var e = 0; e < nEnv; e++, o += 2) eR[e] = dv.getUint16(o, true);
    var nan = function () { var a = new Float64Array(n); a.fill(NaN); return a; };
    var out = { stateCode: dv.getUint8(6), pack: pack, unitCount: n, flags: flags,
      pinLat: nan(), pinLng: nan(), crowdLat: nan(), crowdLng: nan(), envLat: nan(), envLng: nan(), envRadius: new Uint16Array(n) };
    var ip = 0, ic = 0, ie = 0;
    for (var i = 0; i < n; i++) {
      var f = flags[i];
      if (f & F_PIN) { out.pinLat[i] = pLat[ip]; out.pinLng[i] = pLng[ip]; ip++; }
      if (f & F_CROWD) { out.crowdLat[i] = cLat[ic]; out.crowdLng[i] = cLng[ic]; ic++; }
      if (f & F_ENV) { out.envLat[i] = eLat[ie]; out.envLng[i] = eLng[ie]; out.envRadius[i] = eR[ie]; ie++; }
    }
    if (ip !== nPin || ic !== nCrowd || ie !== nEnv) throw new Error('coords columns do not match the flags');
    return out;
  }

  var RAD = Math.PI / 180;
  function haversineM(aLat, aLng, bLat, bLng) {
    var dLat = (bLat - aLat) * RAD, dLng = (bLng - aLng) * RAD;
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  /** The full API row for unit i: the pack's names plus this file's location. */
  function unitWithLocation(p, c, i, distanceM) {
    var f = c.flags[i];
    var tier = TIERS[(f >> 3) & 7] || 'unmapped';
    var num = function (v) { return v !== v ? null : v; }; // NaN -> null
    var hasPin = !!(f & F_PIN);
    var u = materialise(p, i, p.stateName);
    u.lat = num(c.pinLat[i]); u.lng = num(c.pinLng[i]);
    u.crowd_lat = num(c.crowdLat[i]); u.crowd_lng = num(c.crowdLng[i]);
    u.coords_source = hasPin ? ((f & F_PIN_CROWD_MAPPED) ? 'crowd_mapped' : 'inec_locator') : (tier === 'geocoded' ? 'geocoded' : null);
    u.approx_lat = num(c.envLat[i]); u.approx_lng = num(c.envLng[i]);
    u.approx_radius_m = (f & F_ENV) ? c.envRadius[i] : null;
    if (tier === 'unverified') u.pin_unverified = true;
    u.locationTier = tier;
    if (distanceM != null) u.distanceM = distanceM;
    return u;
  }

  /**
   * Both near-me answers for one fix, from the packs held on the phone. Sorts
   * every candidate before cutting, and its box is 2% wider than the radius
   * (111,320 m per degree is not what the haversine's sphere uses).
   */
  function nearbyFromPacks(held, lat, lng, mappingRadiusM) {
    var radius = Math.min(Number(mappingRadiusM) || 5000, 20000);
    var reach = Math.max(radius, REGISTER_RADIUS_M);
    var dLat = (reach * 1.02) / 111320;
    var dLng = (reach * 1.02) / (111320 * Math.max(Math.cos(lat * RAD), 0.2));
    var inBox = function (la, ln) { return Math.abs(la - lat) <= dLat && Math.abs(ln - lng) <= dLng; }; // false for NaN
    var reg = [], map = [];
    held.forEach(function (h) {
      var p = h.state, c = h.coords;
      if (c.unitCount !== p.unitCount) return; // not this pack's file: positions would lie
      for (var i = 0; i < c.unitCount; i++) {
        var f = c.flags[i];
        if (!(f & (F_PIN | F_CROWD | F_ENV))) continue;
        var hasPin = !!(f & F_PIN);
        var rLat = hasPin ? c.pinLat[i] : c.crowdLat[i], rLng = hasPin ? c.pinLng[i] : c.crowdLng[i];
        var mLat = hasPin ? c.pinLat[i] : c.envLat[i], mLng = hasPin ? c.pinLng[i] : c.envLng[i];
        var rIn = inBox(rLat, rLng), mIn = inBox(mLat, mLng);
        if (!rIn && !mIn) continue;
        if (rIn) {
          var d = Math.round(haversineM(lat, lng, rLat, rLng));
          if (d <= REGISTER_RADIUS_M) reg.push(unitWithLocation(p, c, i, d));
        }
        if (mIn) {
          var dm = Math.round(haversineM(lat, lng, mLat, mLng));
          if (dm <= radius) {
            var row = materialise(p, i, p.stateName);
            map.push({
              puCode: row.pu_code, name: row.name, ward: row.ward || '', lat: mLat, lng: mLng, distanceM: dm,
              status: hasPin ? ((f & F_PIN_CROWD_MAPPED) ? 'crowd' : 'verified') : 'approx',
              approxRadiusM: hasPin ? null : c.envRadius[i],
              fixes: 0, // live count of observer fixes: not known offline
              // More than the server sends: a mapping-only row otherwise needs
              // /api/register/unit to learn these, which is the request that
              // cannot be made with no signal.
              lga: row.lga || '', state: row.state || '',
            });
          }
        }
      }
    });
    reg.sort(function (a, b) { return a.distanceM - b.distanceM; });
    map.sort(function (a, b) { return a.distanceM - b.distanceM; });
    var units = reg.slice(0, REGISTER_MAX_ROWS);
    return {
      register: { radiusM: REGISTER_RADIUS_M, maxRows: REGISTER_MAX_ROWS, capped: units.length >= REGISTER_MAX_ROWS, units: units },
      mapping: { units: map.slice(0, MAPPING_MAX_ROWS) },
    };
  }

  var loadedCoords = {};  // stateCode -> decoded coords
  var pendingCoords = {};

  function idbKeys() {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAllKeys();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { resolve([]); };
        } catch (e) { resolve([]); }
      });
    }).catch(function () { return []; });
  }

  /**
   * The manifest WITHOUT waiting on the network: the last verified copy if there
   * is one. The offline path must not sit out a 12 s fetch on a stalled link, and
   * the cached packs are, by construction, the ones that cached manifest names.
   */
  function heldManifest() {
    return idbGet('manifest').then(function (m) { return m || manifest(); }).catch(function () { return manifest(); });
  }

  function loadCoordsWith(m, state) {
    if (loadedCoords[state]) return Promise.resolve(loadedCoords[state]);
    if (pendingCoords[state]) return pendingCoords[state];
    var entry = m && m.coords && m.coords.states && m.coords.states[state];
    var st = m && m.states && m.states[state];
    if (!entry || !st || entry.pack !== st.sha) return Promise.resolve(null);
    pendingCoords[state] = loadPack('coords:' + state, entry, decodeCoords).then(function (c) {
      if (c.pack !== st.sha) throw new Error('coords are for a different state pack');
      loadedCoords[state] = c;
      return c;
    }).catch(function (err) {
      console.warn('[reg] coords for ' + state + ' not usable: ' + err.message);
      return null;
    });
    var done = function () { delete pendingCoords[state]; };
    pendingCoords[state].then(done, done);
    return pendingCoords[state];
  }

  /** Every state whose pack AND coordinates are already in IndexedDB, decoded. No downloads. */
  function heldStates() {
    return Promise.all([heldManifest(), idbKeys()]).then(function (r) {
      var m = r[0], keys = r[1].map(String);
      var codes = keys.filter(function (k) { return /^state:\d\d$/.test(k) && keys.indexOf('coords:' + k.slice(6)) !== -1; })
        .map(function (k) { return k.slice(6); });
      Object.keys(loaded).forEach(function (c) { if (codes.indexOf(c) === -1 && loadedCoords[c]) codes.push(c); });
      return Promise.all(codes.slice(0, 4).map(function (code) {
        var entry = m.states && m.states[code];
        if (!entry) return null;
        var sp = loaded[code] ? Promise.resolve(loaded[code])
          : idbGet('state:' + code).then(function (cached) {
              if (!cached || cached.sha !== entry.sha) return null; // would be a download
              return loadPack('state:' + code, entry, decodeState).then(function (p) { p.stateName = entry.name; loaded[code] = p; return p; });
            });
        return sp.then(function (p) {
          if (!p) return null;
          return loadCoordsWith(m, code).then(function (c) { return c && c.unitCount === p.unitCount ? { state: p, coords: c } : null; });
        }).catch(function () { return null; });
      }));
    }).then(function (list) { return list.filter(Boolean); }).catch(function () { return []; });
  }

  function nearbyOffline(lat, lng, mappingRadiusM) {
    return heldStates().then(function (held) {
      return held.length ? nearbyFromPacks(held, lat, lng, mappingRadiusM) : null;
    }).catch(function (err) {
      console.warn('[reg] offline near-me failed: ' + (err && err.message));
      return null;
    });
  }

  /**
   * The near-me screens' two requests, answered from the phone when the server
   * does not. `online` is the page's own Promise.all of the pair; `good(a, b)`
   * says whether what came back is usable; `wrap(body)` turns an offline answer
   * into whatever shape the page's own fetch helper returns. Resolves
   * [a, b, offline]. The twin of native/src/lib/nearby-offline.ts.
   */
  function nearbyOrOffline(lat, lng, mappingRadiusM, online, opts) {
    opts = opts || {};
    var good = opts.good || function (a, b) { return !!(a || b); };
    var wrap = opts.wrap || function (body) { return body; };
    var graceMs = opts.graceMs || 8000, capMs = opts.capMs || 45000;
    var box = null;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var tracked = Promise.resolve(online).then(function (r) { box = r; return r; }, function () { box = [null, null]; return box; });
    var ok = function () { return !!(box && good(box[0], box[1])); };
    return Promise.race([tracked, sleep(graceMs)]).then(function () {
      if (ok()) return [box[0], box[1], false];
      return nearbyOffline(lat, lng, mappingRadiusM).then(function (off) {
        if (ok()) return [box[0], box[1], false];
        // An EMPTY offline answer is not trusted over a server that has not
        // spoken: the phone may simply hold another state's files.
        if (off && (off.register.units.length || off.mapping.units.length)) return [wrap(off.register), wrap(off.mapping), true];
        if (box) return [box[0], box[1], false];
        return Promise.race([tracked, sleep(Math.max(0, capMs - graceMs))]).then(function () {
          return box ? [box[0], box[1], false] : [null, null, false];
        });
      });
    });
  }

  var api = {
    fold: fold,
    manifest: manifest,
    available: function () { return typeof indexedDB !== 'undefined' && hasInflate(); },

    /** The tier-0 index: every state/LGA/ward, so browse works offline. */
    loadIndex: function (opts) {
      if (indexPack && !(opts && opts.forceNetwork)) return Promise.resolve(indexPack);
      return manifest().then(function (m) {
        return loadPack('index', m.index, decodeIndex, opts).then(function (p) {
          indexPack = p;
          return p;
        });
      });
    },

    /**
     * State NAME -> the 2-digit code the packs are keyed by. Callers work in
     * names ("Lagos") because that is what the register and the UI use; packs
     * are keyed by code because that is what a pu_code contains.
     */
    stateCode: function (name) {
      if (!indexPack || !name) return null;
      var want = String(name).trim().toLowerCase();
      for (var i = 0; i < indexPack.groupCount; i++) {
        var st = indexPack.tables.states[indexPack.stateIds[i]];
        if (st && st.trim().toLowerCase() === want) return pad2(indexPack.stateCodes[i]);
      }
      return null;
    },

    /**
     * THE BROWSE CASCADE, OFFLINE AND NATIONWIDE.
     *
     * states -> LGAs -> wards all come from the ~56 KB tier-0 index, which is
     * precached, so the cascade works from install with no network anywhere in
     * the country. Only the last step (the units inside a ward) needs that
     * state's pack, because the index deliberately carries counts and not names.
     */
    states: function () {
      if (!indexPack) return null;
      var seen = {}, out = [];
      for (var i = 0; i < indexPack.groupCount; i++) {
        var v = indexPack.tables.states[indexPack.stateIds[i]];
        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
      }
      return out.sort();
    },

    lgas: function (stateName) {
      if (!indexPack || !stateName) return null;
      var seen = {}, out = [];
      for (var i = 0; i < indexPack.groupCount; i++) {
        if (indexPack.tables.states[indexPack.stateIds[i]] !== stateName) continue;
        var v = indexPack.tables.lgas[indexPack.lgaIds[i]];
        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
      }
      return out.length ? out.sort() : null;
    },

    wards: function (stateName, lgaName) {
      if (!indexPack || !stateName || !lgaName) return null;
      var seen = {}, out = [];
      for (var i = 0; i < indexPack.groupCount; i++) {
        if (indexPack.tables.states[indexPack.stateIds[i]] !== stateName) continue;
        if (indexPack.tables.lgas[indexPack.lgaIds[i]] !== lgaName) continue;
        var v = indexPack.tables.wards[indexPack.wardIds[i]];
        if (v && !seen[v]) { seen[v] = 1; out.push(v); }
      }
      return out.length ? out.sort() : null;
    },

    /** The units in one ward, from that state's pack. null if it is not held. */
    units: function (stateName, lgaName, wardName) {
      var code = api.stateCode(stateName);
      var p = code && loaded[code];
      if (!p) return null;
      var out = [];
      var startIx = 0;
      for (var g = 0; g < p.groups.counts.length; g++) {
        var n = p.groups.counts[g];
        if (p.tables.lgas[p.groups.lgaIds[g]] === lgaName &&
            p.tables.wards[p.groups.wardIds[g]] === wardName) {
          for (var k = 0; k < n; k++) out.push(materialise(p, startIx + k, p.stateName));
        }
        startIx += n;
      }
      return out.length ? out : null;
    },

    /**
     * One unit by its code, from its state's pack — null if that pack is not
     * in memory. A pu_code IS its address (state-lga-ward-serial), so this is
     * a walk over one state's groups, not a search. The report flow uses it to
     * offer the observer's saved unit with no signal, when the server's full
     * row is not to hand.
     */
    unit: function (puCode) {
      var m = /^(\d\d)-(\d\d)-(\d\d)-(\d\d\d)$/.exec(String(puCode || '').trim());
      if (!m) return null;
      var p = loaded[m[1]];
      if (!p) return null;
      var lga = +m[2], ward = +m[3], serial = +m[4];
      var startIx = 0;
      for (var g = 0; g < p.groups.counts.length; g++) {
        var n = p.groups.counts[g];
        if (p.groups.lgaCodes[g] === lga && p.groups.wardCodes[g] === ward) {
          for (var k = 0; k < n; k++) {
            if (p.serials[startIx + k] === serial) {
              // With the state's coordinates held, the row carries its location
              // too, as GET /api/register/unit would.
              var c = loadedCoords[m[1]];
              return c && c.unitCount === p.unitCount ? unitWithLocation(p, c, startIx + k, null) : materialise(p, startIx + k, p.stateName);
            }
          }
        }
        startIx += n;
      }
      return null;
    },

    /** What the UI needs to say: ready / downloading / absent, and how big. */
    stateStatus: function (code) {
      if (!code) return Promise.resolve({ state: 'unknown' });
      if (loaded[code]) return Promise.resolve({ state: 'ready', name: loaded[code].stateName });
      if (pending[code]) return Promise.resolve({ state: 'downloading' });
      return manifest().then(function (m) {
        var e = m.states[code];
        return e ? { state: 'absent', bytes: e.bytes, name: e.name, units: e.units } : { state: 'unknown' };
      }).catch(function () { return { state: 'unknown' }; });
    },

    /** One state's units. `state` is the 2-digit code, e.g. '25'. */
    loadState: function (state, opts) {
      var key = 'state:' + state;
      if (loaded[state] && !(opts && opts.forceNetwork)) return Promise.resolve(loaded[state]);
      // Two callers (the search box mounting, and the cascade picking a state)
      // must not start two downloads of the same 32 KB.
      if (pending[state] && !(opts && opts.forceNetwork)) return pending[state];
      pending[state] = manifest().then(function (m) {
        var entry = m.states[state];
        if (!entry) throw new Error('no pack for state ' + state);
        return loadPack(key, entry, decodeState, opts).then(function (p) {
          p.stateName = entry.name;
          loaded[state] = p;
          ready(p); // warm the search index while the user is still reading
          // The coordinates follow the pack: whoever holds a state's unit list
          // for offline search should hold its near-me list too.
          idle(function () { loadCoordsWith(m, state); });
          return p;
        });
      });
      // then(done, done), not finally(): finally() returns a NEW promise that
      // re-rejects, and nobody holds it — every offline miss on a state not on
      // the phone surfaced as an unhandled "Failed to fetch". Callers still get
      // the rejection from the promise returned below.
      var done = function () { delete pending[state]; };
      pending[state].then(done, done);
      return pending[state];
    },

    isLoaded: function (state) { return !!loaded[state]; },

    /* Offline near-me (see the coords section above). */
    loadCoords: function (state) { return manifest().then(function (m) { return loadCoordsWith(m, state); }); },
    coordsHeld: function (state) { return idbGet('coords:' + state).then(function (c) { return !!c; }).catch(function () { return false; }); },
    nearbyOffline: nearbyOffline,
    nearbyOrOffline: nearbyOrOffline,
    _coords: { decode: decodeCoords, nearbyFromPacks: nearbyFromPacks, decodeState: decodeState }, // for the Node gate

    /** Resolves once `state` can answer searches (the fold has been built). */
    searchReady: function (state) {
      var p = loaded[state];
      return p ? ready(p) : Promise.reject(new Error('state ' + state + ' not loaded'));
    },

    search: function (state, term, opts) {
      var p = loaded[state];
      if (!p) return null; // caller decides: download, or ask the server
      opts = opts || {};
      opts.stateName = p.stateName;
      return search(p, term, opts);
    },

    /** Exposed for the bench page and tests. */
    _internal: { decodeState: decodeState, decodeIndex: decodeIndex, search: search, crc32: crc32, readHeader: readHeader, buildSearchIndex: buildSearchIndex },
  };

  if (typeof window !== 'undefined') window.registerStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

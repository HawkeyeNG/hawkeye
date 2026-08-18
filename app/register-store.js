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
  var MANIFEST_URL = 'reg/manifest.json';

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
   *   2. tries PREFIX first and only falls back to CONTAINS when that finds
   *      nothing (a leading wildcard cannot use an index, so it full-scans),
   *   3. orders by exact-code, then name-prefix, then code-prefix, then the
   *      rest, and alphabetically by name inside each tier.
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
    var hit = new Uint8Array(N);
    var found = [];

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

    collect(true);
    if (!found.length) collect(false);

    var codeAt = function (i) { return pack.codes.substr(i * CODE_STRIDE, 12); };
    var nameAt = function (i) { return displayName(pack, i); };
    var foldedAt = function (i) { return pack.folded.slice(pack.fOffs[i], pack.fOffs[i + 1] - 1); };

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

    var out = [];
    for (var n2 = 0; n2 < ranked.length && out.length < limit; n2++) {
      out.push(materialise(pack, ranked[n2].i, opts.stateName));
    }
    // The server reports truncation as "we filled the page", not "more exist".
    return { units: out, truncated: out.length === limit, tookMs: now() - t0 };
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

  var manifestP = null;
  function manifest(force) {
    if (manifestP && !force) return manifestP;
    // Network-first so a register correction does not wait on a cache bump, with
    // the stored copy as the offline answer.
    manifestP = fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
      .then(function (m) { idbPut('manifest', m); return m; })
      .catch(function () {
        return idbGet('manifest').then(function (m) {
          if (!m) throw new Error('no manifest, and offline');
          return m;
        });
      });
    return manifestP;
  }

  var loaded = {}; // stateCode -> decoded pack

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
      return inflateGzip(gzBytes).then(function (pack) {
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
      return fetch('reg/' + entry.file, { cache: 'no-store' }).then(function (r) {
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

  var api = {
    fold: fold,
    manifest: manifest,
    available: function () { return typeof indexedDB !== 'undefined' && hasInflate(); },

    /** The tier-0 index: every state/LGA/ward, so browse works offline. */
    loadIndex: function (opts) {
      return manifest().then(function (m) {
        return loadPack('index', m.index, decodeIndex, opts);
      });
    },

    /** One state's units. `state` is the 2-digit code, e.g. '25'. */
    loadState: function (state, opts) {
      var key = 'state:' + state;
      if (loaded[state] && !(opts && opts.forceNetwork)) return Promise.resolve(loaded[state]);
      return manifest().then(function (m) {
        var entry = m.states[state];
        if (!entry) throw new Error('no pack for state ' + state);
        return loadPack(key, entry, decodeState, opts).then(function (p) {
          p.stateName = entry.name;
          loaded[state] = p;
          ready(p); // warm the search index while the user is still reading
          return p;
        });
      });
    },

    isLoaded: function (state) { return !!loaded[state]; },

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

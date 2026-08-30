/**
 * PICK ONE RACE OUT OF A COMBINED CONTEST.
 *
 * SEN is 109 seats, REP 366, SHA 1,005, LGA 774. On those the map is the wrong
 * instrument — you cannot reliably hit your own federal constituency on a phone
 * screen showing 366 of them — and "Follow" is the wrong control, because
 * follow.js defines a subscription as (contest, region) where an EMPTY region
 * means every seat in the contest. Pressing it on a combined board signs you up
 * for 109 races and, at scale, asks the push path to fan every one of them out.
 *
 * So the combined boards get this instead: state, then seat. Deliberately the
 * same two-step shape as the register cascade in the reporting flow
 * (map-unit.html's state → LGA → ward), because an observer has already learned
 * that gesture and this is the same question asked about a different list.
 *
 * ONE CARD THAT OPENS ON CLICK. Closed it is a single line of furniture; open
 * it is two selects and nothing else. A permanently-expanded picker on a board
 * whose job is showing results would compete with the results.
 *
 * DATA, and why no new endpoint:
 *   SEN / REP / SHA   app/seat_lgas.json — every seat with its state, LGAs,
 *                     ward and polling-unit counts. 172 KB, already shipped in
 *                     the Lite bundle and already in the service worker's LAZY
 *                     list.
 *   LGA               backend/src/data/district_index.json is keyed
 *                     "state|lga", so the 774 enumerate from its keys.
 *
 * Fetched through window.fetchData where it exists (native.js) rather than a
 * relative fetch. In Lite a relative path reads the copy baked into the APK at
 * release time, so a seat corrected after a release would stay wrong until the
 * next store update — the same trap that moved the geo layers and the candidate
 * list off relative fetches.
 */
(function () {
  'use strict';

  // The four contests this exists for. GOV is 36 races but the map works there
  // (one shape per state, and everyone knows their own state's outline), and
  // PRES is a single national race with nothing to pick.
  var COMBINED = {
    SEN: { label: 'senatorial district', source: 'seats', plural: 'senatorial districts' },
    REP: { label: 'federal constituency', source: 'seats', plural: 'federal constituencies' },
    SHA: { label: 'state constituency', source: 'seats', plural: 'state constituencies' },
    LGA: { label: 'local government area', source: 'lgas', plural: 'local government areas' }
  };

  function isCombined(code) { return Object.prototype.hasOwnProperty.call(COMBINED, code); }

  /**
   * fetchData RETURNS A RESPONSE, NOT JSON — and it is defined on the web too.
   *
   * Both assumptions bit on the first run: the card opened, the state list came
   * back empty and nothing said why, because `data.SEN` on a Response is simply
   * undefined and every downstream loop found nothing to iterate. A failure
   * that renders as an empty dropdown reads exactly like "this state has no
   * seats", which is the wrong thing to go looking for.
   *
   * So: always parse, and assert the shape before handing it on.
   */
  function getJSON(path) {
    var p = typeof window.fetchData === 'function' ? window.fetchData(path) : fetch(path);
    return p.then(function (r) {
      // fetchData may already have resolved to parsed JSON in some future
      // version; accept either rather than depending on which.
      if (!r || typeof r.json !== 'function') return r;
      if (r.ok === false) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || typeof d !== 'object') throw new Error('not an object');
      return d;
    });
  }

  var cache = {};
  function load(name) {
    if (!cache[name]) {
      cache[name] = getJSON(name).catch(function (e) {
        // Let the next open try again rather than caching the failure — a
        // picker that stays broken for the session after one flaky request is
        // worse than one that retries.
        cache[name] = null;
        throw e;
      });
    }
    return cache[name];
  }

  /**
   * SHA IS KEYED DIFFERENTLY, and assuming otherwise half-works.
   *
   * SEN and REP keys are bare seat names ("Abia Central"). SHA keys are
   * "State|Seat" ("Benue|Konshisha III (Shangev-Tiev)") and carry their own
   * `seat` field. A picker that read the key as the name would show every SHA
   * row prefixed with its state, and would then send that whole string as the
   * ?seat= parameter, which matches nothing.
   */
  function seatName(code, key, row) {
    if (row && row.seat) return row.seat;
    var cut = key.indexOf('|');
    return cut === -1 ? key : key.slice(cut + 1);
  }

  // state -> [{ name, sub }] for one contest, sorted for scanning.
  function optionsFor(code, data, state) {
    var out = [];
    if (COMBINED[code].source === 'lgas') {
      // district_index.json: keys are "state|lga", lowercase.
      Object.keys(data).forEach(function (k) {
        var bits = k.split('|');
        if (bits.length !== 2) return;
        if (bits[0].toLowerCase() !== String(state).toLowerCase()) return;
        // Title-case the lga back for display; the key is lowercased.
        out.push({ name: bits[1].replace(/\b\w/g, function (c) { return c.toUpperCase(); }), sub: '' });
      });
    } else {
      var seats = data[code] || {};
      Object.keys(seats).forEach(function (k) {
        var row = seats[k];
        if (!row || String(row.state).toLowerCase() !== String(state).toLowerCase()) return;
        var bits = [];
        if (row.wards) bits.push(row.wards + (row.wards === 1 ? ' ward' : ' wards'));
        if (row.pollingUnits) bits.push(row.pollingUnits.toLocaleString() + ' polling units');
        out.push({ name: seatName(code, k, row), sub: bits.join(' · ') });
      });
    }
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function statesFor(code, data) {
    var set = {};
    if (COMBINED[code].source === 'lgas') {
      Object.keys(data).forEach(function (k) {
        var s = k.split('|')[0];
        if (s) set[s.replace(/\b\w/g, function (c) { return c.toUpperCase(); })] = 1;
      });
    } else {
      var seats = data[code] || {};
      Object.keys(seats).forEach(function (k) { if (seats[k] && seats[k].state) set[seats[k].state] = 1; });
    }
    return Object.keys(set).sort();
  }

  // Where a pick lands. race.html reads contest/state/seat/lga (race.html:83-134).
  function targetUrl(code, state, pick) {
    var q = 'contest=' + encodeURIComponent(code);
    if (COMBINED[code].source === 'lgas') {
      return 'race.html?' + q + '&state=' + encodeURIComponent(state) + '&lga=' + encodeURIComponent(pick);
    }
    // SHA needs its state too: seat names repeat across states in the assembly
    // catalogue, so seat alone is ambiguous there.
    return 'race.html?' + q + (code === 'SHA' ? '&state=' + encodeURIComponent(state) : '')
      + '&seat=' + encodeURIComponent(pick);
  }

  /**
   * Mount the card into `host` for `code`. Returns true if it mounted, false if
   * this contest is not one of the combined four — so a caller can fall back to
   * whatever it showed before without knowing the list.
   */
  function mount(host, code) {
    if (!host || !isCombined(code)) return false;
    var meta = COMBINED[code];

    host.innerHTML =
      '<div class="rp-card" data-open="0">'
      + '<button type="button" class="rp-head" aria-expanded="false">'
      + '<span class="rp-title">Find your ' + meta.label + '</span>'
      + '<span class="rp-hint">Pick a state, then your ' + meta.label + '</span>'
      + '<span class="rp-chev" aria-hidden="true">›</span>'
      + '</button>'
      + '<div class="rp-body" hidden>'
      + '<label class="rp-lab" for="rp-state">State</label>'
      + '<select id="rp-state"><option value="">— select state —</option></select>'
      + '<label class="rp-lab" for="rp-seat">' + meta.label.replace(/^\w/, function (c) { return c.toUpperCase(); }) + '</label>'
      + '<select id="rp-seat" disabled><option value="">— select state first —</option></select>'
      + '<p class="rp-msg" role="status" aria-live="polite"></p>'
      + '</div></div>';

    var card = host.querySelector('.rp-card');
    var head = host.querySelector('.rp-head');
    var body = host.querySelector('.rp-body');
    var selState = host.querySelector('#rp-state');
    var selSeat = host.querySelector('#rp-seat');
    var msg = host.querySelector('.rp-msg');
    var data = null;

    function fill(sel, rows, placeholder) {
      sel.innerHTML = '<option value="">' + placeholder + '</option>'
        + rows.map(function (r) {
          var label = typeof r === 'string' ? r : r.name + (r.sub ? '  —  ' + r.sub : '');
          var val = typeof r === 'string' ? r : r.name;
          return '<option value="' + val.replace(/"/g, '&quot;') + '">'
            + label.replace(/</g, '&lt;') + '</option>';
        }).join('');
    }

    function open() {
      var isOpen = card.getAttribute('data-open') === '1';
      card.setAttribute('data-open', isOpen ? '0' : '1');
      head.setAttribute('aria-expanded', String(!isOpen));
      body.hidden = isOpen;
      if (isOpen || data) return;
      // Load on FIRST open, not on page load: 172 KB that most readers of a
      // results board never need.
      msg.textContent = 'Loading ' + meta.plural + '…';
      load(meta.source === 'lgas' ? 'district_index.json' : 'seat_lgas.json')
        .then(function (d) {
          var states = statesFor(code, d);
          // AN EMPTY LIST IS A FAILURE, NOT A RESULT. Nigeria has 36 states and
          // the FCT; zero means the file loaded but was not the shape expected,
          // which is what a Response object looked like on the first run.
          if (!states.length) throw new Error('no states in ' + (meta.source === 'lgas' ? 'district_index.json' : 'seat_lgas.json'));
          data = d;
          fill(selState, states, '— select state —');
          msg.textContent = '';
        })
        .catch(function (e) {
          // Say it, and leave the card usable so a retry is one tap.
          msg.textContent = 'Could not load the list of ' + meta.plural + '. Tap again to retry. (' + ((e && e.message) || e) + ')';
          data = null;
        });
    }

    head.addEventListener('click', open);

    selState.addEventListener('change', function () {
      var s = selState.value;
      if (!s || !data) {
        selSeat.disabled = true;
        fill(selSeat, [], '— select state first —');
        return;
      }
      var rows = optionsFor(code, data, s);
      selSeat.disabled = rows.length === 0;
      fill(selSeat, rows, rows.length ? '— select ' + meta.label + ' —' : '— none listed for ' + s + ' —');
      msg.textContent = rows.length
        ? rows.length + ' ' + (rows.length === 1 ? meta.label : meta.plural) + ' in ' + s
        : 'No ' + meta.plural + ' listed for ' + s + '.';
    });

    selSeat.addEventListener('change', function () {
      if (!selSeat.value || !selState.value) return;
      location.href = targetUrl(code, selState.value, selSeat.value);
    });

    return true;
  }

  window.racePicker = { mount: mount, isCombined: isCombined, COMBINED: COMBINED };
}());

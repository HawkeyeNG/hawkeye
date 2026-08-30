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
 * GOVERNORSHIP IS THE ONE-STEP EXCEPTION and renders one select, not two — the
 * state is itself the race. See `oneStep` in mount().
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

  // The contests decided across many separate races. PRES is the only one left
  // out: it is a single national race with nothing to pick.
  // `title` is a fallback for a heading: /api/contests names SEN/REP/SHA, but
  // there is no LGA row in the catalogue, so a page keyed on the contest name
  // rendered a bare "LGA" as its headline.
  var COMBINED = {
    SEN: { title: 'Senate', label: 'senatorial district', source: 'seats', plural: 'senatorial districts' },
    REP: { title: 'House of Representatives', label: 'federal constituency', source: 'seats', plural: 'federal constituencies' },
    SHA: { title: 'State Houses of Assembly', label: 'state constituency', source: 'seats', plural: 'state constituencies' },
    LGA: { title: 'Local Government Chairmanship', label: 'local government area', source: 'lgas', plural: 'local government areas' },
    /**
     * GOVERNORSHIP IS ONE STEP, NOT TWO: the state IS the race, so the first
     * list is also the last and picking from it navigates.
     *
     * Its states come from the CONTEST, never from the register or a hardcoded
     * 36 — governorships are staggered, and the 2027 row lists 28. Offering the
     * other nine would send a reader to a race that is not being held.
     */
    GOV: { title: 'Governorship', label: 'state', source: 'contest', plural: 'states', statesAreRaces: true }
  };

  function isCombined(code) { return Object.prototype.hasOwnProperty.call(COMBINED, code); }

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  /**
   * EVERY STATE THAT HAS A GOVERNOR, with the eight out-of-cycle ones marked.
   *
   * The picker used to offer only the contest's 28, on the reasoning that
   * sending a reader to a race which is not being held is worse than not
   * offering it. That reasoning was half right: the destination is fine — a
   * governorship page for an off-cycle state already says so in its own words
   * ("Osun votes for governor off the general-election cycle…", race.js:1010),
   * and Osun's page is better than fine, because political_data.json carries
   * `raceOsun2026` with INEC's declaration and findRace prefers a real page to a
   * generated one. What was wrong was the SILENCE: a reader in Ekiti searched a
   * list of 28, did not find their state, and learned nothing about why.
   *
   * So all 36 are listed and the 8 carry a tag. Derived, never hardcoded: the
   * universe is the register's own state list and "off-cycle" is simply
   * "not named by the contest", so the day a governorship moves cycle this
   * follows the data instead of a list someone has to remember to edit.
   *
   * FCT is dropped. It is in every state-shaped dataset because it is a federal
   * capital territory administered by a minister, and it has no governor to
   * elect — the same exclusion race.js:993 makes at the other end.
   *
   * @param {string[]} inCycle   the contest's own states
   * @param {string[]|null} universe  every state in the register, or null
   */
  function govRows(inCycle, universe) {
    var on = {};
    (inCycle || []).forEach(function (s) { on[norm(s)] = true; });
    var names = (universe && universe.length) ? universe : (inCycle || []);
    return names
      .filter(function (s) { return norm(s) !== 'fct'; })
      .slice()
      .sort()
      .map(function (s) { return on[norm(s)] ? s : { name: s, sub: 'off-cycle' }; });
  }

  /**
   * THE CARD BRINGS ITS OWN STYLE, injected once on first mount.
   *
   * It started as a block in results.html, which meant the second page to want
   * a picker had to copy it — and the copy would drift the first time either
   * was touched. styles.css is the other home, but that file is in the service
   * worker's SHELL: putting a two-page component there costs a ?v= bump across
   * forty pages and a CACHE version for everyone. So the component carries it.
   */
  var styled = false;
  function ensureStyle() {
    if (styled || document.getElementById('rp-style')) { styled = true; return; }
    var el = document.createElement('style');
    el.id = 'rp-style';
    el.textContent = [
      '.rp-card{border:1px solid var(--border);border-radius:12px;background:var(--card);margin:0 0 12px;overflow:hidden}',
      '.rp-head{display:grid;grid-template-columns:1fr auto;align-items:center;gap:2px 10px;width:100%;',
      'text-align:left;background:none;border:0;margin:0;padding:13px 15px;font:inherit;color:inherit;cursor:pointer}',
      '.rp-title{grid-column:1;font-weight:700;font-size:0.98rem;color:var(--ink)}',
      '.rp-hint{grid-column:1;grid-row:2;font-size:0.8rem;color:var(--muted)}',
      '.rp-chev{grid-column:2;grid-row:1/span 2;color:var(--muted);font-size:1.3rem;transition:transform .18s ease}',
      '.rp-card[data-open="1"] .rp-chev{transform:rotate(90deg)}',
      '@media (prefers-reduced-motion:reduce){.rp-chev{transition:none}}',
      '.rp-body{padding:0 15px 14px;border-top:1px solid var(--border)}',
      '.rp-lab{display:block;margin:12px 0 5px;font-size:0.78rem;font-weight:700;',
      'letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}',
      // Full width and a real tap target: this IS the control on a phone, and
      // the state-constituency list runs to 1,005 rows.
      '.rp-body select{width:100%;margin:0;padding:11px 12px;font-size:0.95rem}',
      '.rp-msg{margin:10px 0 0;font-size:0.8rem;color:var(--muted);min-height:1em}'
    ].join('');
    document.head.appendChild(el);
    styled = true;
  }

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
    // GOV: the state IS the race, so there is no seat to name.
    if (COMBINED[code].statesAreRaces) {
      return 'race.html?' + q + '&state=' + encodeURIComponent(state);
    }
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
  function mount(host, code, opts) {
    if (!host || !isCombined(code)) return false;
    var given = (opts && opts.states) || null;
    ensureStyle();
    var meta = COMBINED[code];

    /**
     * ONE STEP MEANS ONE CONTROL.
     *
     * The card used to build both selects for every contest and rely on the GOV
     * branches further down to skip the second one. Skipping the LOGIC is not
     * the same as not RENDERING it: governorship showed a second select,
     * labelled "State" (meta.label capitalised) and disabled forever on
     * "— select state first —", under a hint that read "Pick a state, then your
     * state". Two dead controls describing a step that does not exist.
     *
     * The state IS the governorship race, so it gets a single select and a hint
     * that says what tapping does.
     */
    var oneStep = !!meta.statesAreRaces;

    host.innerHTML =
      '<div class="rp-card" data-open="0">'
      + '<button type="button" class="rp-head" aria-expanded="false">'
      + '<span class="rp-title">Find your ' + meta.label + '</span>'
      + '<span class="rp-hint">'
      + (oneStep ? 'Pick a state to open its race' : 'Pick a state, then your ' + meta.label)
      + '</span>'
      + '<span class="rp-chev" aria-hidden="true">›</span>'
      + '</button>'
      + '<div class="rp-body" hidden>'
      + '<label class="rp-lab" for="rp-state">State</label>'
      + '<select id="rp-state"><option value="">— select state —</option></select>'
      + (oneStep ? ''
        : '<label class="rp-lab" for="rp-seat">'
          + meta.label.replace(/^\w/, function (c) { return c.toUpperCase(); }) + '</label>'
          + '<select id="rp-seat" disabled><option value="">— select state first —</option></select>')
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
      // GOVERNORSHIP: the states came with the contest, so there is nothing to
      // fetch and nothing to wait for.
      if (meta.statesAreRaces) {
        if (!given || !given.length) {
          msg.textContent = 'No governorship races are listed for this election.';
          return;
        }
        data = given;
        // Usable IMMEDIATELY with the 28 the contest names, then widened to all
        // 36 once the register arrives. The off-cycle states are a courtesy, so
        // they must never be something the reader waits on: political_data.json
        // is 16 KB and already cached by the board, but a slow or failed fetch
        // leaves a working picker rather than a spinner.
        fill(selState, govRows(given, null), '— select state —');
        msg.textContent = given.length + ' states vote for governor in 2027';
        load('political_data.json').then(function (pd) {
          var all = Object.keys((pd && pd.stateStats) || {});
          var rows = govRows(given, all);
          var off = rows.filter(function (r) { return typeof r !== 'string'; }).length;
          if (!off) return;   // nothing gained; leave the working list alone
          fill(selState, rows, '— select state —');
          msg.textContent = given.length + ' states vote for governor in 2027 · '
            + off + ' others are off-cycle';
        }).catch(function () { /* the 28 already render; say nothing */ });
        return;
      }
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
      // One step for GOV: no seat to choose, so the state navigates.
      if (meta.statesAreRaces) {
        if (s) location.href = targetUrl(code, s, '');
        return;
      }
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

    // Absent on a one-step contest, because the markup above no longer writes
    // it. Guarding rather than asserting: mount() must not throw and leave the
    // board with a half-built card.
    if (selSeat) {
      selSeat.addEventListener('change', function () {
        if (!selSeat.value || !selState.value) return;
        location.href = targetUrl(code, selState.value, selSeat.value);
      });
    }

    return true;
  }

  window.racePicker = { mount: mount, isCombined: isCombined, COMBINED: COMBINED };
}());

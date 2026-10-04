// Free-text polling-unit search, shared by every PU picker on the web (and so
// by Capacitor, which bundles this same app/ directory).
//
// Before this, a unit could only be reached by GPS ("near me") or by walking the
// state → LGA → ward cascade — which fails the very common case of knowing your
// unit's NAME but not which ward the register files it under. This searches
// name, unit code and ward, on partial input: "aso dr" finds "Aso Drive".
//
// Usage:
//   window.puSearch.mount(containerEl, { onSelect(unit) {...}, state, lga });
// `state`/`lga` are optional narrowing, for a picker that already drilled that
// far. The rows are the same shape /api/register/units returns, so a caller's
// existing selectUnit() works unchanged.
(function () {
  /* Same shape as race.js's helper: the English stays inline as the fallback,
     so the widget still reads correctly with i18n.js absent or still loading. */
  const T = (k, en) => (window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en);
  /* Keys, resolved where they are drawn (a map of T() results would freeze in
     English before the dictionary lands). Same keys as app.js. */
  const TIER_LABEL = {
    verified: ['common.tier-verified', '📍 location verified'],
    crowd: ['common.tier-crowd', '◌ crowd-confirmed location'],
    geocoded: ['common.tier-geocoded', '◌ located from map data (unconfirmed)'],
    unmapped: ['common.tier-unmapped', '⚠ location not yet verified'],
    unverified: ['common.tier-unverified', '⚠ location unverified — its map position could not be confirmed'],
  };
  const tierLabel = (tier) => T(...(TIER_LABEL[tier] || TIER_LABEL.unmapped));
  /* A pin more than 25 km from the unit's own envelope is not a position (the
     state-shifted INEC locator load — see app.js pinContradictsEnvelope and
     backend/src/services/pin-trust.js, same rule). */
  const pinContradictsEnvelope = (u) => {
    if (u.lat == null || u.lng == null || u.approx_lat == null || u.approx_lng == null) return false;
    const rad = (d) => (d * Math.PI) / 180;
    const a = Math.sin(rad(u.approx_lat - u.lat) / 2) ** 2
      + Math.cos(rad(u.lat)) * Math.cos(rad(u.approx_lat)) * Math.sin(rad(u.approx_lng - u.lng) / 2) ** 2;
    const m = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
    return m > Math.max(25000, (Number(u.approx_radius_m) || 0) * 1.5 + 2000);
  };
  const tierOf = (u) =>
    u.pin_unverified || pinContradictsEnvelope(u)
      ? 'unverified'
      : u.coords_source === 'crowd_mapped'
        ? 'crowd'
        : u.locationTier || (u.lat != null ? 'verified' : u.crowd_lat != null ? 'crowd' : 'unmapped');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * OFFLINE SEARCH COMES FROM THE PACKS NOW (docs/PU-SEARCH-2027.md).
   *
   * This used to fetch register-osun.json — the same 1.7 MB file app.js already
   * had in memory — and flatten it into a SECOND copy, then scan it with a third
   * matching rule of its own. That was affordable for one state's 3,763 units.
   * For 2027's 176,846 it is not, and the third rule is worse than the cost: the
   * pack search and the API now return byte-identical pages (proved over 7,291
   * queries in backend/scripts/diff_register_search.mjs), and a local filter
   * that agrees with neither would quietly undo that.
   *
   * So: one owner (register-store.js), one state pack at a time, and the server
   * for anything we do not hold.
   */
  const store = () => (typeof window !== 'undefined' ? window.registerStore : null);

  // The state whose units we hold. Set when the cascade picks one, remembered
  // across sessions so a returning observer searches offline immediately.
  //
  // NOBODY CALLED rememberState() (flow walkthrough REP-UNIT-02), and no page
  // passed `state`, so stateName was always "" and every search went to the
  // server — with no signal, "Could not search just now" every time, at the
  // unit, which is the one place search has to work. Now a chosen unit
  // remembers its state here (any picker), and the report flow seeds it from
  // the observer's saved unit (app.js), so that state's pack answers offline.
  const STATE_KEY = 'hk_reg_state';
  function rememberedState() {
    try { return localStorage.getItem(STATE_KEY) || ''; } catch { return ''; }
  }
  function rememberState(name) {
    try { if (name) localStorage.setItem(STATE_KEY, name); } catch { /* private mode */ }
  }
  /** The state's pack, loaded into memory if it is on this phone (or fetchable). */
  function warmState(name) {
    const st = store();
    if (!st || !st.available() || !name) return Promise.resolve(null);
    return st.loadIndex()
      .then(() => { const code = st.stateCode(name); return code ? st.loadState(code) : null; })
      .catch(() => null);
  }

  function mount(host, opts) {
    if (!host || host.dataset.puSearchMounted) return;
    host.dataset.puSearchMounted = '1';
    const o = opts || {};
    host.innerHTML =
      '<label for="pus-q" data-i18n="pu.search-for-your-polling-unit">' + esc(T('pu.search-for-your-polling-unit', 'Search for your polling unit')) + '</label>'
      + '<input id="pus-q" type="search" autocomplete="off" data-i18n-attr="placeholder:pu.name-ward-or-unit-number-placeholder" placeholder="' + esc(T('pu.name-ward-or-unit-number-placeholder', 'Name, ward or unit number — e.g. Aso Drive')) + '" />'
      + '<p class="hint" id="pus-status" role="status" aria-live="polite" style="margin:6px 0 0"></p>'
      + '<div id="pus-results" style="margin-top:8px"></div>';
    const q = host.querySelector('#pus-q');
    const status = host.querySelector('#pus-status');
    const list = host.querySelector('#pus-results');

    // Warm what we can the moment the box exists, not on the first keystroke:
    // someone who reaches this pane is about to type, and there are usually a
    // few seconds of reading first. The index is ~56 KB and precached; the state
    // pack is ~32 KB and only fetched when we know which state to get.
    // Read on every search, not once at mount: the report flow learns the
    // observer's saved unit a moment AFTER this box exists.
    const stateNow = () => o.state || rememberedState();
    // Offline with nothing stored: the server path still works.
    warmState(stateNow());
    // The pack for the state we search, loaded if this phone has it. Waits for
    // IndexedDB (milliseconds); on the network it is the ~32 KB pack.
    const packFor = async () => {
      const sx = store();
      const name = stateNow();
      if (!sx || !name) return null;
      await warmState(name);
      const code = sx.stateCode(name);
      return code && sx.isLoaded(code) ? code : null;
    };

    let timer = null;
    let seq = 0;
    // Per-session, keyed by the full query string so a state/LGA-scoped search
    // never answers an unscoped one. The register does not change mid-session.
    const cache = new Map();
    async function run() {
      const term = q.value.trim();
      list.innerHTML = '';
      if (term.length < 3) {
        status.textContent = term ? T('pu.keep-typing-at-least-3', 'Keep typing — at least 3 characters.') : '';
        return;
      }
      const mine = ++seq;
      const p = new URLSearchParams({ q: term });
      if (o.state) p.set('state', o.state);
      if (o.lga) p.set('lga', o.lga);
      const key = p.toString();
      try {
        /**
         * MOST KEYSTROKES SHOULD COST NOTHING.
         *
         * The request itself is the expense, not the query: measured against
         * production a search round-trips in ~1.2s, and an early-return that
         * touches no data at all takes the same — so it is latency, not SQL.
         * Typing "osogbo" is six of those in a row, each superseding the last.
         *
         * Two ways out, both here. A term already searched is answered from
         * memory. And a term that EXTENDS an earlier one whose results were not
         * truncated is narrowed locally — every match for "osogb" is contained
         * in the matches for "osog", so the server has nothing to add.
         */
        /**
         * The old prefix-narrowing shortcut is gone on purpose. It filtered an
         * earlier untruncated result with its own matching rule, which was a
         * THIRD definition of "matches" next to the pack and the API — and those
         * two are now proved identical. With a pack loaded a search costs about
         * half a millisecond, so the shortcut bought nothing and risked showing
         * a page neither path would have returned.
         */
        let r = cache.get(key);
        const sx = store();
        const fromPack = (code) => {
          const local = code && sx && sx.isLoaded(code) ? sx.search(code, term, { limit: 25 }) : null;
          if (local) cache.set(key, { units: local.units, truncated: local.truncated });
          return local;
        };

        // The pack, when we hold the right state. Instant and offline. With no
        // signal, read it off the phone first (IndexedDB, milliseconds) rather
        // than ask a network that is not there.
        if (!r) {
          const code = sx && sx.stateCode(stateNow());
          r = fromPack(code) || (!navigator.onLine ? fromPack(await packFor()) : null);
        }

        if (!r) {
          status.textContent = navigator.onLine ? T('pu.searching', 'Searching…') : T('pu.looking-on-this-device', 'Looking on this device…');
          try {
            r = await fetch(`/api/register/search?${p}`).then((x) => x.json());
            if (r && !r.error) cache.set(key, { units: r.units || [], truncated: !!r.truncated });
          } catch (netErr) {
            // navigator.onLine lies (a dead cell still says "online"), so a
            // failed request is the real offline signal: try the pack then.
            r = fromPack(await packFor());
            if (!r) throw netErr;
          }
        }
        // A slower earlier request must never overwrite a newer answer.
        if (mine !== seq) return;
        const units = r.units || [];
        if (!units.length) {
          status.textContent = T('pu.no-unit-matches', 'No unit matches “{v0}”. Try fewer letters, or browse the register below.').replace('{v0}', term);
          return;
        }
        status.textContent = r.truncated
          ? T('pu.first-matches-keep-typing', 'First {v0} matches — keep typing to narrow it.').replace('{v0}', units.length)
          : (units.length === 1 ? T('pu.one-match', '1 match.') : T('pu.n-matches', '{v0} matches.').replace('{v0}', units.length));
        list.innerHTML = units.map((u, i) =>
          `<button type="button" class="pu-option" data-i="${i}"><strong>${esc(u.name)}</strong><br />`
          + `<small>${esc(u.pu_code)} · ${esc(u.ward)}, ${esc(u.lga)}, ${esc(u.state)} · ${tierLabel(tierOf(u))}</small></button>`).join('');
        list.querySelectorAll('.pu-option').forEach((b) => {
          b.onclick = () => {
            const u = units[+b.dataset.i];
            if (u && u.state) { rememberState(u.state); warmState(u.state); }
            if (o.onSelect) o.onSelect(u);
          };
        });
      } catch {
        if (mine !== seq) return;
        // Say which of the two things went wrong, and what fixes it. An
        // indefinite "could not search" on a phone with no signal is the failure
        // mode docs/PU-SEARCH-2027.md calls a regression rather than degradation.
        const sx = store();
        const code = sx && sx.stateCode(stateNow());
        // No state to search offline at all: point at the register, which
        // walks state -> LGA -> ward from the index every install carries.
        const fallback = () => (navigator.onLine
          ? T('pu.could-not-search', 'Could not search just now — check your connection.')
          : T('pu.offline-browse-below', 'No connection. Browse the register below instead.'));
        if (sx && code && !sx.isLoaded(code)) {
          sx.stateStatus(code).then((info) => {
            if (mine !== seq) return;
            status.textContent = info.state === 'absent'
              ? T('pu.unit-list-not-on-device', 'The unit list for {v0} is not on this device yet ({v1} KB). Connect once to download it, then search works offline.').replace('{v0}', info.name).replace('{v1}', Math.round(info.bytes / 1024))
              : fallback();
          });
        } else {
          status.textContent = fallback();
        }
      }
    }
    // Debounced: each keystroke would otherwise be a full-table LIKE scan.
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
  }

  // rememberState/warmState are exported for the report flow (app.js), which
  // knows the observer's saved unit before anyone has typed.
  window.puSearch = { mount, rememberState, rememberedState, warmState };
})();

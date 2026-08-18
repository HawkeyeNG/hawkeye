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
  const TIER_LABEL = {
    verified: '📍 location verified',
    crowd: '◌ crowd-confirmed location',
    geocoded: '◌ located from map data (unconfirmed)',
    unmapped: '⚠ location not yet verified',
  };
  const tierOf = (u) =>
    u.coords_source === 'crowd_mapped'
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
  const STATE_KEY = 'hk_reg_state';
  function rememberedState() {
    try { return localStorage.getItem(STATE_KEY) || ''; } catch { return ''; }
  }
  function rememberState(name) {
    try { if (name) localStorage.setItem(STATE_KEY, name); } catch { /* private mode */ }
  }

  function mount(host, opts) {
    if (!host || host.dataset.puSearchMounted) return;
    host.dataset.puSearchMounted = '1';
    const o = opts || {};
    host.innerHTML =
      '<label for="pus-q">Search for your polling unit</label>'
      + '<input id="pus-q" type="search" autocomplete="off" placeholder="Name, ward or unit number — e.g. Aso Drive" />'
      + '<p class="hint" id="pus-status" role="status" aria-live="polite" style="margin:6px 0 0"></p>'
      + '<div id="pus-results" style="margin-top:8px"></div>';
    const q = host.querySelector('#pus-q');
    const status = host.querySelector('#pus-status');
    const list = host.querySelector('#pus-results');

    // Warm what we can the moment the box exists, not on the first keystroke:
    // someone who reaches this pane is about to type, and there are usually a
    // few seconds of reading first. The index is ~56 KB and precached; the state
    // pack is ~32 KB and only fetched when we know which state to get.
    const st = store();
    let stateName = o.state || rememberedState();
    let stateCode = null;
    if (st && st.available()) {
      st.loadIndex()
        .then(() => {
          stateCode = st.stateCode(stateName);
          if (stateCode) return st.loadState(stateCode);
        })
        .catch(() => { /* offline with nothing stored: the server path still works */ });
    }

    let timer = null;
    let seq = 0;
    // Per-session, keyed by the full query string so a state/LGA-scoped search
    // never answers an unscoped one. The register does not change mid-session.
    const cache = new Map();
    async function run() {
      const term = q.value.trim();
      list.innerHTML = '';
      if (term.length < 3) {
        status.textContent = term ? 'Keep typing — at least 3 characters.' : '';
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

        // The pack, when we hold the right state. Instant and offline.
        if (!r) {
          const sx = store();
          const code = stateCode || (sx && sx.stateCode(stateName));
          if (sx && code && sx.isLoaded(code)) {
            const local = sx.search(code, term, { limit: 25 });
            if (local) {
              r = local;
              cache.set(key, { units: local.units, truncated: local.truncated });
            }
          }
        }

        if (!r) {
          status.textContent = navigator.onLine ? 'Searching…' : 'Looking on this device…';
          r = await fetch(`/api/register/search?${p}`).then((x) => x.json());
          if (r && !r.error) cache.set(key, { units: r.units || [], truncated: !!r.truncated });
        }
        // A slower earlier request must never overwrite a newer answer.
        if (mine !== seq) return;
        const units = r.units || [];
        if (!units.length) {
          status.textContent = `No polling unit matches “${term}”. Try fewer letters, or browse by state below.`;
          return;
        }
        status.textContent = r.truncated
          ? `Showing the first ${units.length} matches — keep typing to narrow it.`
          : `${units.length} match${units.length === 1 ? '' : 'es'}.`;
        list.innerHTML = units.map((u, i) =>
          `<button type="button" class="pu-option" data-i="${i}"><strong>${esc(u.name)}</strong><br />`
          + `<small>${esc(u.pu_code)} · ${esc(u.ward)}, ${esc(u.lga)}, ${esc(u.state)} · ${TIER_LABEL[tierOf(u)]}</small></button>`).join('');
        list.querySelectorAll('.pu-option').forEach((b) => {
          b.onclick = () => o.onSelect && o.onSelect(units[+b.dataset.i]);
        });
      } catch {
        if (mine !== seq) return;
        // Say which of the two things went wrong, and what fixes it. An
        // indefinite "could not search" on a phone with no signal is the failure
        // mode docs/PU-SEARCH-2027.md calls a regression rather than degradation.
        const sx = store();
        const code = stateCode || (sx && sx.stateCode(stateName));
        if (sx && code && !sx.isLoaded(code)) {
          sx.stateStatus(code).then((info) => {
            if (mine !== seq) return;
            status.textContent = info.state === 'absent'
              ? `The unit list for ${info.name} is not on this device yet (${Math.round(info.bytes / 1024)} KB). Connect once to download it, then search works offline.`
              : 'Could not search just now — browse by state below.';
          });
        } else {
          status.textContent = 'Could not search just now — browse by state below.';
        }
      }
    }
    // Debounced: each keystroke would otherwise be a full-table LIKE scan.
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
  }

  window.puSearch = { mount };
})();

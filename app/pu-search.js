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
   * SEARCH THE SHIPPED REGISTER BEFORE THE NETWORK.
   *
   * Every Osun polling unit is already on the device: the browse cascade ships
   * app/register-osun.json, and its rows are the same shape /api/register/search
   * returns. Searching still went to the server for all of them — so typing a
   * PU code like "29-" (every Osun code starts with 29-) spent ~1.2s per query
   * asking about rows sitting in local storage, on exactly the mobile links
   * where that hurts most.
   *
   * Same URL and query string app.js uses, so this shares one HTTP/service
   * worker cache entry with the cascade instead of pulling a second copy.
   */
  let flatRows = null, flatPending = null;
  function loadFlatRegister() {
    if (flatRows) return Promise.resolve(flatRows);
    if (!flatPending) {
      flatPending = fetch('register-osun.json?v=1')
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => {
          const rows = [];
          if (b) {
            for (const st of Object.keys(b)) {
              if (st === 'states' || st === 'generated' || !b[st] || typeof b[st] !== 'object') continue;
              for (const lga of Object.keys(b[st])) {
                for (const ward of Object.keys(b[st][lga])) {
                  const units = b[st][lga][ward];
                  if (Array.isArray(units)) rows.push(...units);
                }
              }
            }
          }
          flatRows = rows;
          return rows;
        })
        .catch(() => { flatRows = []; return flatRows; }); // tried and failed; never retry-loop
    }
    return flatPending;
  }

  const LOCAL_MAX = 50;
  /** Returns {units,truncated} from the shipped register, or null if it can't answer. */
  async function localSearch(term, o) {
    // Scoped searches are the caller narrowing to a state/LGA we may not ship.
    if (o.state && o.state !== 'Osun') return null;
    const rows = await loadFlatRegister();
    if (!rows.length) return null;
    const t = term.toLowerCase();
    const hits = [];
    for (const u of rows) {
      if (o.lga && u.lga !== o.lga) continue;
      if (`${u.name} ${u.pu_code} ${u.ward}`.toLowerCase().includes(t)) {
        hits.push(u);
        if (hits.length > LOCAL_MAX) break;
      }
    }
    return { units: hits.slice(0, LOCAL_MAX), truncated: hits.length > LOCAL_MAX };
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
        let r = cache.get(key);
        if (!r) {
          for (const [k, v] of cache) {
            if (v.truncated || !k.startsWith('q=')) continue;
            const prev = decodeURIComponent(k.slice(2).split('&')[0]).toLowerCase();
            if (prev.length >= 3 && term.toLowerCase().startsWith(prev)
                && k.slice(k.indexOf('&') + 1) === key.slice(key.indexOf('&') + 1)) {
              const t = term.toLowerCase();
              r = {
                units: (v.units || []).filter((u) => `${u.name} ${u.pu_code} ${u.ward}`.toLowerCase().includes(t)),
                truncated: false,
              };
              break;
            }
          }
        }
        // Then the shipped register: instant, offline, and it covers the whole
        // election state. Only fall through to the network when it finds
        // nothing — another state, or a field the bundle does not carry.
        if (!r) {
          const local = await localSearch(term, o);
          if (local && local.units.length) {
            r = local;
            cache.set(key, { units: local.units, truncated: local.truncated });
          }
        }
        if (!r) {
          status.textContent = 'Searching…';
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
        if (mine === seq) status.textContent = 'Could not search just now — check your connection, or browse by state below.';
      }
    }
    // Debounced: each keystroke would otherwise be a full-table LIKE scan.
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } });
  }

  window.puSearch = { mount };
})();

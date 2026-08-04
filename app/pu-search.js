// Free-text polling-unit search, shared by every PU picker on the web (and so
// by Capacitor, which bundles this same app/ directory).
//
// Before this, a unit could only be reached by GPS ("near me") or by walking the
// state → LGA → ward cascade — which fails the very common case of knowing your
// unit's NAME but not which ward the register files it under. This searches
// name, unit code and ward, on partial input: "wonde" finds "Wonderland Estate".
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

  function mount(host, opts) {
    if (!host || host.dataset.puSearchMounted) return;
    host.dataset.puSearchMounted = '1';
    const o = opts || {};
    host.innerHTML =
      '<label for="pus-q">Search for your polling unit</label>'
      + '<input id="pus-q" type="search" autocomplete="off" placeholder="Name, ward or unit number — e.g. Wonderland" />'
      + '<p class="hint" id="pus-status" role="status" aria-live="polite" style="margin:6px 0 0"></p>'
      + '<div id="pus-results" style="margin-top:8px"></div>';
    const q = host.querySelector('#pus-q');
    const status = host.querySelector('#pus-status');
    const list = host.querySelector('#pus-results');

    let timer = null;
    let seq = 0;
    async function run() {
      const term = q.value.trim();
      list.innerHTML = '';
      if (term.length < 3) {
        status.textContent = term ? 'Keep typing — at least 3 characters.' : '';
        return;
      }
      status.textContent = 'Searching…';
      const mine = ++seq;
      const p = new URLSearchParams({ q: term });
      if (o.state) p.set('state', o.state);
      if (o.lga) p.set('lga', o.lga);
      try {
        const r = await fetch(`/api/register/search?${p}`).then((x) => x.json());
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

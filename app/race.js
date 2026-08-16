// Shared race-page renderer. One race object -> the whole <main> body. Tolerant
// of both data shapes in political_data.json:
//   race2027   : { election, note, asOf, candidates[], minors[], photoCredit }   (compare table)
//   raceOsun2026: { office, date, note, asOf, stats, incumbentNote, candidates[],
//                   others[], notableAbsence }                                   (statbar + ballot)
// Usage: window.mountRace(mainEl, race, LOGOS, { compare: true|false });
(function () {
  // Party colours — every code that can appear on a Nigerian ballot we render.
  const PC = {
    A: '#00838f', APC: '#2e7d32', ADC: '#00897b', AA: '#3e2723', AAC: '#6d4c41',
    ADP: '#455a64', APGA: '#f9a825', APM: '#283593', APP: '#ef6c00', BP: '#37474f',
    NNPP: '#1565c0', PRP: '#827717', YPP: '#c2185b', ZLP: '#5e35b1', PDP: '#c62828',
    LP: '#8bc34a', SDP: '#5e35b1', NRM: '#827717', NDC: '#2e3192', YP: '#00695c',
    DLA: '#6a1b9a', Accord: '#00838f', BOOT: '#37474f',
  };
  const color = (p) => PC[p] || '#9aa7a0';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * The seat's own map, cut from the national layers already on the site.
   *
   * Same shape as the Osun board: crop to the seat and subdivide it, rather than
   * draw one flat outline. Every senatorial district and federal constituency is
   * a union of WHOLE LGAs (measured: zero LGAs shared between seats at either
   * level), and app/lga_geo.json already holds all 774 at full precision — so
   * the map is a filter over a file the site ships anyway. No new geometry.
   *
   * FALLS BACK TO THE SEAT'S OUTLINE where LGA cannot represent it. Some federal
   * constituencies split one LGA between them — Lagos Island I/II, Mushin I/II,
   * Surulere I/II — and the ward-dissolved outline in constituency_geo.json is
   * the only honest source for those. A single-LGA seat has nothing to subdivide
   * and takes the same path.
   *
   * Colours use currentColor so the map follows the page's light/dark theme
   * without a stylesheet change.
   */
  const geoCache = {};
  const getGeo = (f) => (geoCache[f] = geoCache[f] || fetch(f).then((r) => r.json()).catch(() => null));

  const bboxOf = (paths) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of paths) {
      const n = d.match(/-?\d+(?:\.\d+)?/g) || [];
      // Paths are M/L/Z only (see build_reps_from_wards.js), so numbers pair up
      // as coordinates with nothing else interleaved.
      for (let i = 0; i + 1 < n.length; i += 2) {
        const x = +n[i], y = +n[i + 1];
        if (x < x0) x0 = x; if (y < y0) y0 = y;
        if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
    }
    return { x0, y0, x1, y1 };
  };

  const svgFor = (shapes, label) => {
    const b = bboxOf(shapes.map((s) => s.path));
    if (!isFinite(b.x0)) return '';
    let w = b.x1 - b.x0, h = b.y1 - b.y0;
    let cx = b.x0 + w / 2, cy = b.y0 + h / 2;
    // Keep every card the same shape: a long thin constituency fitted tightly
    // would otherwise sit beside a compact one at a wildly different aspect.
    const AR = 1.35;
    if (w / h < AR) w = h * AR; else h = w / AR;
    const pad = Math.max(w, h) * 0.08 || 1;
    w += pad * 2; h += pad * 2;
    const vb = `${(cx - w / 2).toFixed(1)} ${(cy - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
    // The internal borders ARE the information — a seat drawn as one silhouette
    // says nothing the title did not. At 0.45 opacity over a 0.14 fill the LGA
    // divisions inside Kano Central read as a single blob, so the stroke carries
    // more weight than the fill.
    //
    // A FIXED PIXEL WIDTH, because vector-effect below takes the stroke out of
    // the coordinate system. Scaling it with the viewBox (as the fill and
    // padding are) made it a hairline here and a slab on a small seat — the
    // bounding boxes differ by orders of magnitude between Kano Central and a
    // single-LGA constituency.
    return `<svg class="race-map" viewBox="${vb}" role="img" aria-label="${esc(label)}"
      style="width:100%;height:auto;max-height:280px;display:block;margin:14px 0">
      ${shapes.map((s) => `<path d="${s.path}" fill="currentColor" fill-opacity="0.10"
        stroke="currentColor" stroke-opacity="0.7" stroke-width="1.1"
        stroke-linejoin="round" vector-effect="non-scaling-stroke"
        ><title>${esc(s.name || '')}</title></path>`).join('')}
    </svg>`;
  };

  async function raceMapHtml(race) {
    const j = race.join;
    if (!j || !j.value) return '';
    if (j.lgas && j.lgas.length > 1 && j.state) {
      const geo = await getGeo('lga_geo.json');
      if (geo && geo.lgas) {
        const want = new Set(j.lgas.map((l) => `${j.state}|${l}`.toLowerCase()));
        const parts = geo.lgas.filter((x) => want.has(String(x.key).toLowerCase()))
          .map((x) => ({ path: x.path, name: String(x.key).split('|')[1] || '' }));
        // Only use the cut if it actually found the members; a partial cut would
        // draw a seat missing pieces of itself, which is worse than an outline.
        if (parts.length === j.lgas.length) return svgFor(parts, `Map of ${j.value}, by LGA`);
      }
    }
    const file = j.level === 'senatorial' ? 'district_geo.json' : 'constituency_geo.json';
    const geo = await getGeo(file);
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const hit = geo && geo.regions && geo.regions.find((r) => norm(r.name) === norm(j.value));
    return hit ? svgFor([{ path: hit.path, name: hit.name }], `Map of ${j.value}`) : '';
  }

  function mountRace(main, race, LOGOS, opts) {
    opts = opts || {};
    LOGOS = LOGOS || {};
    if (!race) { main.innerHTML = '<p class="race-absence">Race data unavailable.</p>'; return; }

    const flagIcon = (p) => LOGOS[p]
      ? `<img class="flag" src="${LOGOS[p]}" alt="${esc(p)} logo" loading="lazy" onerror="this.outerHTML='<span class=&quot;fallback&quot;>${esc(p)}</span>'">`
      : `<span class="fallback">${esc(p)}</span>`;
    const flagInline = (p, sz = 14) => LOGOS[p]
      ? `<img src="${LOGOS[p]}" alt="" style="width:${sz}px;height:${sz}px;border-radius:50%;object-fit:contain;background:#fff;vertical-align:-2px;margin-right:4px">` : '';
    const avatar = (c) => c.photo
      ? `<span class="av"><img src="${esc(c.photo)}" alt="${esc(c.name)}" loading="lazy" onerror="this.parentNode.textContent='${esc(c.initials || '')}'"></span>`
      : `<span class="av">${esc(c.initials || '')}</span>`;

    // THE YEAR COMES FROM THE DATA. It was the literal "2026", which was true
    // for the only two races this template had ever rendered and wrong for every
    // one after them — a 2027 Senate page would have announced itself as 2026.
    // Prefer the polling date, fall back to a year inside dateText (races whose
    // date INEC has not fixed carry "2027" there), and print no year rather than
    // a guessed one.
    const yearOf = (r) => (r.date ? String(new Date(`${r.date}T00:00:00`).getFullYear())
      : (String(r.dateText || r.election || '').match(/\b(20\d{2})\b/) || [])[1] || '');
    const yr = yearOf(race);
    const title = race.office ? `${esc(race.office)}${yr ? ` — ${esc(yr)}` : ''}` : esc(race.election || 'Race');
    const dateStr = race.date ? new Date(race.date + 'T00:00:00').toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
    document.title = `Hawkeye — ${race.office || race.election || 'Race'}`;

    const parts = [];
    parts.push(`<h1>${title}</h1>`);
    // No office/date lede: the header already names the race and the date is a
    // stat-bar cell below, so this line only ever repeated them.

    // Stat bar. The candidate count is derived from the cards on THIS page
    // (front-runners + the full ballot / minor list) so it always matches what's
    // shown; LGA and polling-unit totals are geographic facts from the data. Date
    // is a fixed day where INEC has set one (Osun), else a verbatim label (the 2027
    // presidential date is not yet fixed). Rendered on every race page.
    const st = race.stats || {};
    const candTotal = race.candidates.length + ((race.others || race.minors || []).length);
    const cells = [];
    if (race.date) cells.push([new Date(race.date + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }), 'Election day']);
    else if (race.dateText) cells.push([race.dateText, race.dateLabel || 'Date']);
    cells.push([candTotal, 'Candidates']);
    if (st.lgas != null) cells.push([st.lgas, 'LGAs']);
    if (st.pollingUnits != null) cells.push(['~' + Number(st.pollingUnits).toLocaleString(), 'Polling units']);
    if (cells.length) parts.push(`<div class="race-statbar">${cells.map(([n, l]) => `<div class="s"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`);

    // A placeholder, filled once the geometry arrives. mountRace stays
    // SYNCHRONOUS — every caller (osun.html, candidates.html, race.html) treats
    // it as such, and awaiting a 800 KB map file before painting the candidates
    // would trade a fast page for a decorative one.
    parts.push('<div id="race-map-slot"></div>');

    // Context / incumbent note (optional)
    if (race.incumbentNote) parts.push(`<div class="race-ctx">${esc(race.incumbentNote)}</div>`);

    // Primary candidate cards
    // SKIP THE SECTION ENTIRELY WHEN THERE ARE NO CARDS TO PUT IN IT. A
    // down-ballot race carries no per-candidate prose — every name lives in
    // others[] and the full ballot below says everything there is to say — so
    // with candidates[] empty this printed a "Front-runners" heading, a
    // nonpartisan disclaimer and then nothing at all. 470 Senate and House pages
    // would each have opened on that.
    if (race.candidates.length) {
    const heading = opts.frontLabel || (race.others ? 'Front-runners' : 'Declared candidates');
    parts.push(`<h2 style="margin-top:26px">${esc(heading)}</h2>`);
    parts.push('<p class="hint">Listed alphabetically by party. Not an endorsement or a prediction — Hawkeye is nonpartisan.</p>');
    parts.push(`<div class="cand-grid">${race.candidates.map((c) => `
      <div class="cand" style="--pc:${color(c.party)}">
        <div class="row1">${avatar(c)}
          <div><span class="pill">${flagInline(c.party, 13)}${esc(c.party)}</span>
            <h3>${esc(c.name)}${c.incumbent ? '<span class="inc">Incumbent</span>' : ''}</h3></div></div>
        <p>${esc(c.line || '')}</p>
        <dl><dt>Home base</dt><dd>${esc(c.home || '—')}</dd>
            <dt>Bid</dt><dd>${esc(c.bids || '—')}</dd>
            <dt>Status</dt><dd>${esc(c.status || '—')}</dd></dl>
      </div>`).join('')}</div>`);
    }

    // Full ballot (osun `others`) or minor candidates (presidential `minors`)
    const secondary = race.others || race.minors;
    if (secondary && secondary.length) {
      if (race.others) {
        const all = [...race.candidates, ...race.others].sort((a, b) => a.party.localeCompare(b.party));
        parts.push(`<h2 style="margin-top:26px">Full ballot — ${all.length} candidates</h2>`);
        parts.push(`<div class="ballot">${all.map((c) => `
          <div class="b" style="--pc:${color(c.party)}">${flagIcon(c.party)}
            <div><strong>${esc(c.name)}</strong><span>${esc(c.party)}${c.incumbent ? ' · incumbent' : ''}</span></div></div>`).join('')}</div>`);
      } else {
        parts.push('<h2 style="margin-top:26px">Other declared candidates</h2>');
        parts.push(`<div class="ballot">${race.minors.map((m) => `
          <div class="b" style="--pc:${color(m.party)}">${flagIcon(m.party)}
            <div><strong>${esc(m.name)}</strong><span>${esc(m.meta || m.party)}</span></div></div>`).join('')}</div>`);
      }
    }

    if (race.notableAbsence) parts.push(`<p class="race-absence">${esc(race.notableAbsence)}</p>`);

    // Quick compare — a compact side-by-side of the front-runner cards (Candidate,
    // Party, Home base, Bid, Status). Shown on every race page that HAS such
    // cards: presidency and governorship alike.
    //
    // Guarded for the same reason as the front-runner grid above. Its rows map
    // over race.candidates, so a down-ballot race — every name in others[], no
    // per-candidate prose to compare — rendered the heading and a table with
    // column headers and not one row beneath them.
    if (race.candidates.length) {
    parts.push('<h2 style="margin-top:26px">Quick compare</h2>');
    parts.push(`<div class="race-compare"><table><thead>
      <tr><th>Candidate</th><th>Party</th><th>Home base</th><th>Bid</th><th>Status</th></tr></thead><tbody>${
      race.candidates.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td>
        <td>${flagInline(c.party)}<span style="font-weight:700;color:${color(c.party)}">${esc(c.party)}</span></td>
        <td>${esc(c.home || '—')}</td><td>${esc(c.bids || '—')}</td><td>${esc(c.status || '—')}</td></tr>`).join('')}</tbody></table></div>`);
    }

    // Calls to action. resultsHref lets a race page deep-link its own board
    // (e.g. Osun -> results.html?contest=GOV&scope=Osun preselects the race).
    parts.push(`<div class="race-cta">
      <a class="btn-accent" href="observe.html?intent=observe">Become an Observer</a>
      <a class="btn-quiet" href="${esc(opts.resultsHref || 'results.html')}">See Live Results</a></div>`);

    const credit = [race.note ? `${race.note}` : '', race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit || ''].filter(Boolean).join(' ');
    if (credit) parts.push(`<p class="hint">${esc(credit)}</p>`);

    main.innerHTML = parts.join('\n');

    // Fill the map slot behind the paint. A failure here must cost nothing: the
    // page is about candidates, the map is context, and a race with no matching
    // geometry (or a network that never answers) simply keeps an empty slot
    // rather than showing a broken frame or an error the reader cannot act on.
    const slot = main.querySelector('#race-map-slot');
    if (slot) {
      raceMapHtml(race)
        .then((html) => { if (html) slot.innerHTML = html; else slot.remove(); })
        .catch(() => slot.remove());
    }
  }

  window.mountRace = mountRace;
})();

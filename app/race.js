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
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const titleCase = (s) => String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());

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

  // A CAPTION, because the alt text is not visible and the map has no other
  // label. On a race with candidates the shape is read in the context of the
  // names beside it; on a seat page with no ballot yet it is the whole content,
  // and an uncaptioned outline asks the reader to recognise a state by sight.
  const svgFor = (shapes, label, caption) => {
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
    // `data-region` is what makes the map INSPECTABLE: it carries the register
    // name of the area, so a click can be matched against the tally without
    // re-deriving anything from the tooltip text.
    const svg = `<svg class="race-map" viewBox="${vb}" role="img" aria-label="${esc(label)}"
      style="width:100%;height:auto;max-height:420px;display:block;margin:14px 0">
      ${shapes.map((s) => `<path d="${s.path}" data-region="${esc(s.name || '')}"
        fill="currentColor" fill-opacity="0.10"
        stroke="currentColor" stroke-opacity="0.7" stroke-width="1.1"
        stroke-linejoin="round" vector-effect="non-scaling-stroke"
        ><title>${esc(s.name || '')}</title></path>`).join('')}
    </svg>`;
    return caption
      ? `${svg}<p class="hint" style="margin:-6px 0 0;text-align:center">${esc(caption)}</p>`
      : svg;
  };

  async function raceMapHtml(race) {
    const j = race.join;
    if (!j || !j.value) return '';

    // A GOVERNORSHIP's seat is the whole state, and the state's LGAs are its
    // subdivision — the same treatment every other level gets, and the one the
    // Osun board already used.
    //
    // The members are read from lga_geo's OWN KEYS rather than listed on the race
    // object. All 774 are in the file keyed "<state>|<lga>", so every one of the
    // 36 states draws from the same two lines with nothing written down per
    // state: a hand-listed membership could only go stale or disagree with the
    // map it is supposed to describe.
    if (j.level === 'state') {
      const geo = await getGeo('lga_geo.json');
      const want = norm(j.value);
      const parts = ((geo && geo.lgas) || [])
        .filter((x) => norm(String(x.key).split('|')[0]) === want)
        .map((x) => ({ path: x.path, name: titleCase(String(x.key).split('|')[1] || '') }));
      if (parts.length > 1) {
        return svgFor(parts, `Map of ${j.value} State, by local government area`,
          `${j.value} State — ${parts.length} local government areas`);
      }
      // No LGAs for this state means the key did not match, not that the state
      // has one LGA — fall back to its outline rather than draw a lone shape.
      const sgeo = await getGeo('states_geo.json');
      const hit = ((sgeo && sgeo.states) || []).find((s) => norm(s.key) === want || norm(s.name) === want);
      return hit ? svgFor([{ path: hit.path, name: hit.name }], `Map of ${j.value} State`) : '';
    }

    if (j.lgas && j.lgas.length > 1 && j.state) {
      const geo = await getGeo('lga_geo.json');
      if (geo && geo.lgas) {
        const want = new Set(j.lgas.map((l) => `${j.state}|${l}`.toLowerCase()));
        const parts = geo.lgas.filter((x) => want.has(String(x.key).toLowerCase()))
          .map((x) => ({ path: x.path, name: titleCase(String(x.key).split('|')[1] || '') }));
        // Only use the cut if it actually found the members; a partial cut would
        // draw a seat missing pieces of itself, which is worse than an outline.
        if (parts.length === j.lgas.length) {
          return svgFor(parts, `Map of ${j.value}, by LGA`,
            `${j.value} — ${parts.length} local government area${parts.length === 1 ? '' : 's'}`);
        }
      }
    }
    const file = j.level === 'senatorial' ? 'district_geo.json' : 'constituency_geo.json';
    const geo = await getGeo(file);
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
    // NO "0 Candidates" CELL. A race whose field INEC has not published yet is
    // the normal state of every seat page until about a month out, and a zero in
    // a stat bar reads as a claim about the ballot rather than about our data.
    // The note below the map says what is actually true.
    if (candTotal) cells.push([candTotal, 'Candidates']);
    if (st.heldBy) cells.push([st.heldBy, 'Currently held by']);
    if (st.lgas != null) cells.push([st.lgas, 'LGAs']);
    if (st.pollingUnits != null) cells.push(['~' + Number(st.pollingUnits).toLocaleString(), 'Polling units']);
    if (cells.length) parts.push(`<div class="race-statbar">${cells.map(([n, l]) => `<div class="s"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`);

    // A placeholder, filled once the geometry arrives. mountRace stays
    // SYNCHRONOUS — every caller (osun.html, candidates.html, race.html) treats
    // it as such, and awaiting a 800 KB map file before painting the candidates
    // would trade a fast page for a decorative one.
    parts.push('<div id="race-map-slot"></div>');

    // WHERE THE NOTE GOES DEPENDS ON WHAT ELSE IS ON THE PAGE. On a race with
    // candidates it is a source credit and belongs at the foot with `asOf`. On a
    // race with none it is the only thing explaining why the page has no ballot
    // on it — and printing that under two call-to-action buttons, as the foot
    // position does, buries the answer to the reader's first question.
    const noteLeads = !candTotal && !!race.note;
    if (noteLeads) parts.push(`<div class="race-ctx">${esc(race.note)}</div>`);

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

    // Calls to action.
    //
    // "See Live Results" GOES TO THIS RACE'S BOARD, not to the leaderboard's
    // default — which is the presidency, so every governorship page used to send
    // its readers to a nationwide presidential map. The link is DERIVED from the
    // race's own `join` rather than passed in by each caller: osun.html
    // remembered to pass one, race.html never did, and 36 generated state pages
    // were never going to.
    //
    //   state= crops the board to the seat's state and subdivides it
    //   scope= preselects the same region in the follow picker
    //
    // A FINISHED RACE ASKS FOR NOTHING. "Become an Observer" on an election that
    // is over recruits people for a thing they cannot do — and "See Live
    // Results" promises a count that stopped moving. A completed race offers its
    // record instead, and the standing rule is: no recruitment CTA once polling
    // day has passed, and the results link says what it now is.
    const done = statusOf(race) === 'completed';
    /**
     * FOLLOWING ONE SEAT — the size of subscription most people actually want,
     * and until now the one there was no way to ask for. The leaderboard could
     * only offer the whole election; wanting every governorship in the
     * federation is a newsroom's interest, not a voter's.
     *
     * `join.value` is the seat's own region key — the state, senatorial district
     * or federal constituency the backend buckets its reports by — so this
     * follows exactly this race and nothing else. Not offered on a finished
     * race, by the same rule as the CTAs: there will be no further reports.
     */
    const j = race.join || {};
    const canFollow = !done && !!j.contest && !!j.value;
    // `data-cta` names each button's JOB, so styling can change without a test
    // or a caller having to guess which anchor is which.
    parts.push(`<div class="race-cta">
      ${canFollow ? '<button type="button" class="btn-quiet" data-cta="follow" id="race-follow-btn">🔔 Follow this race</button>' : ''}
      ${done ? '' : '<a class="btn-accent" data-cta="observe" href="observe.html?intent=observe">Become an Observer</a>'}
      <a class="${done ? 'btn-accent' : 'btn-quiet'}" data-cta="results" href="${esc(opts.resultsHref || resultsHrefFor(race))}">${
        done ? 'Review the Results' : 'See Live Results'}</a>
      ${done ? '<a class="btn-quiet" data-cta="verify" href="ledger.html">Verify the Record</a>' : ''}</div>
      ${canFollow ? '<p class="hint" id="race-follow-msg" hidden></p>' : ''}`);

    const credit = [noteLeads ? '' : (race.note || ''), race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit || ''].filter(Boolean).join(' ');
    if (credit) parts.push(`<p class="hint">${esc(credit)}</p>`);

    main.innerHTML = parts.join('\n');

    // The Follow toggle, wired once the markup exists. follow.js owns the
    // wording and the request so this page and the leaderboard cannot describe
    // the same subscription differently; a page that has not loaded it simply
    // keeps a button that does nothing rather than throwing during mount.
    if (canFollow && typeof window.mountFollow === 'function') {
      window.mountFollow({
        button: main.querySelector('#race-follow-btn'),
        message: main.querySelector('#race-follow-msg'),
        contest: j.contest,
        scope: j.value,
      });
    }

    // Fill the map slot behind the paint. A failure here must cost nothing: the
    // page is about candidates, the map is context, and a race with no matching
    // geometry (or a network that never answers) simply keeps an empty slot
    // rather than showing a broken frame or an error the reader cannot act on.
    const slot = main.querySelector('#race-map-slot');
    if (slot) {
      raceMapHtml(race)
        .then((html) => {
          if (!html) { slot.remove(); return; }
          slot.innerHTML = html;
          // The map paints IMMEDIATELY and the reporting arrives after: the
          // geometry is a static file and the tally is a live query, so waiting
          // for the second would hold back the first for no reason.
          if (slot.querySelectorAll('path[data-region]').length > 1) {
            slot.insertAdjacentHTML('beforeend',
              `<label class="race-map-pickwrap"><span class="sr-only">Jump to an area</span>
                 <select class="race-map-pick"></select></label>
               <p class="race-map-info" aria-live="polite"><span class="race-mi-sub">Tap an area of the map for what has been reported from it.</span></p>`);
            boardFor(race)
              .then((board) => wireRaceMap(slot, race, board))
              .catch(() => wireRaceMap(slot, race, null));
          }
        })
        .catch(() => slot.remove());
    }
  }

  /* ------------------------------------------------------------------------
   * Making the map INSPECTABLE.
   *
   * The map is a picture of a seat; these turn it into a picture of the seat's
   * REPORTING. Tap an LGA and it says what has come in from there — or, when
   * nothing has, why: an election still ahead says when polls open, one under
   * way says no reports yet, and the two are not the same thing. A single "no
   * data" for both would read as a failure on polling day and as a silence
   * months early.
   * --------------------------------------------------------------------- */

  const PARTY_TINT = 0.55;

  /**
   * The leaderboard, showing THIS race — the destination of "See Live Results".
   *
   * A governorship's board is its state's, cropped and broken down by LGA. A
   * senatorial or federal seat has no crop of its own (the API scopes by state),
   * so it gets its state's board — which shows that state's districts — with the
   * seat preselected in the follow picker. Both are the closest thing to "this
   * race's board" the data model can express, and both beat the federation-wide
   * presidential default a reader got before.
   */
  function resultsHrefFor(race) {
    const j = race && race.join;
    if (!j || !j.contest || !j.value) return 'results.html';
    const q = new URLSearchParams({ contest: j.contest });
    const state = j.state || (j.level === 'state' ? j.value : '');
    if (state) q.set('state', state);
    // `scope` ONLY when it is finer than the crop. Cropping to Osun already
    // makes the follow choices Osun's own LGAs, so scope=Osun would name a
    // region that is no longer in the list — the picker would silently fall back
    // to its first option. A senatorial seat is genuinely finer than its state
    // crop, and there it does the job it exists for.
    if (j.value !== state) q.set('scope', j.value);
    return `results.html?${q}`;
  }

  /**
   * Register spellings and geo-file spellings disagree for a handful of LGAs per
   * state ("Atakumosa" vs "atakunmosa", "Ilesa" vs "ilesha"), so an exact match
   * silently drops them and the map shows blanks where reports exist. Same
   * two-tier fallback results.html uses: exact normalised, then a
   * first-four-letters-per-word stem, with ambiguous stems dropped rather than
   * guessed at.
   */
  function regionLookup(regions) {
    const stemOf = (s) => norm(s).replace(/([a-z0-9]{4})[a-z0-9]*/g, '$1');
    const exact = new Map(), stem = new Map();
    for (const r of regions || []) {
      exact.set(norm(r.region), r);
      const k = stemOf(r.region);
      stem.set(k, stem.has(k) ? null : r);
    }
    return (name) => exact.get(norm(name)) || stem.get(stemOf(name)) || null;
  }

  /**
   * Where a race sits in time: completed / ongoing / upcoming. Same rule
   * races.html groups by, and deliberately NOT the contest's `open` flag —
   * reportingOpen() is true from poll-open onwards and never goes false again,
   * so every finished election would read as live forever.
   */
  function statusOf(race) {
    const d = race && race.date;
    if (!d) return 'upcoming';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = dayStart(d);
    if (day < today) return 'completed';
    if (day > today) return 'upcoming';
    return 'ongoing';
  }

  const dayStart = (d) => { const x = new Date(`${d}T00:00:00`); x.setHours(0, 0, 0, 0); return x; };
  const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });

  /**
   * Why an area has no numbers. Three genuinely different states, and saying the
   * wrong one is worse than saying nothing.
   */
  function silenceReason(race) {
    if (!race.date) return 'No date has been set for this election yet.';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = dayStart(race.date);
    if (day > today) return `Polls open on ${fmtDay(race.date)}.`;
    if (day.getTime() === today.getTime()) return 'Polls are open — no reports from here yet.';
    return 'No reports were filed from here.';
  }

  /**
   * The tally for this seat, broken down by LGA, or null.
   *
   * `level=lga` is asked for explicitly: a senatorial contest's own breakdown is
   * by district, and this map draws LGAs. Failure is silent by design — the map
   * is still a map without it, and a race page must not turn into an error
   * message because a board could not be reached.
   */
  async function boardFor(race) {
    const j = race.join;
    if (!j || !j.contest || !(j.state || j.value)) return null;
    const state = j.state || j.value;
    const url = `/api/national/${encodeURIComponent(j.contest)}`
      + `?state=${encodeURIComponent(state)}&level=lga`;
    return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  /** One line per fact, most important first. */
  function inspectLines(race, name, row) {
    if (!row || !row.unitsReporting) return [`${name}`, silenceReason(race)];
    const L = row.leaders && row.leaders.length ? row.leaders : (row.leader ? [row.leader] : []);
    const lead = L.length > 2 ? `${L.length}-way tie`
      : L.length === 2 ? `${L[0]} and ${L[1]} tied`
      : L.length === 1 ? `${L[0]} leads` : 'No votes counted yet';
    const top = Object.entries(row.votes || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([p, v]) => `${p} ${Number(v).toLocaleString()}`).join(' · ');
    return [
      `${name} — ${lead}`,
      `${row.unitsReporting} unit${row.unitsReporting === 1 ? '' : 's'} reporting, ${row.unitsVerified || 0} verified`,
      top,
    ].filter(Boolean);
  }

  /**
   * Wire an already-rendered map: tint what has reported, and let a tap on any
   * area explain itself.
   */
  function wireRaceMap(root, race, board) {
    const svg = root.querySelector('.race-map');
    if (!svg) return;
    const paths = [...svg.querySelectorAll('path[data-region]')];
    if (paths.length < 2) return;   // an outline has nothing to break down

    const find = regionLookup(board && board.regions);
    for (const p of paths) {
      const row = find(p.dataset.region);
      // Tint by the LEADING PARTY, the one thing a results map exists to show.
      // As INLINE STYLE, not an attribute, so the :hover rule cannot lighten a
      // region that is already carrying a colour with meaning.
      if (row && row.unitsReporting && row.leader && (row.leaders || []).length === 1) {
        p.style.fill = color(row.leader);
        p.style.fillOpacity = String(PARTY_TINT);
      }
      p.style.cursor = 'pointer';
    }

    const panel = root.querySelector('.race-map-info');
    if (!panel) return;
    const paint = (p) => {
      // A THICKER STROKE ALONE IS NOT ENOUGH. Kano's reporting LGAs are the four
      // small metropolitan ones; at 44-to-a-frame a 2.4px outline in the same
      // colour as every other border is invisible. So the selection changes
      // COLOUR as well as weight, and the shape is moved to the end of the SVG —
      // there is no z-index in SVG, and a neighbour drawn later was painting
      // over half the outline meant to pick it out.
      for (const q of paths) {
        q.style.stroke = '';
        q.style.strokeWidth = '';
        q.style.strokeOpacity = '';
      }
      p.style.stroke = 'var(--link, #00693e)';
      p.style.strokeWidth = '3';
      p.style.strokeOpacity = '1';
      p.parentNode.appendChild(p);
      const name = p.dataset.region;
      panel.innerHTML = inspectLines(race, name, find(name))
        .map((l, i) => `<span class="${i ? 'race-mi-sub' : 'race-mi-lead'}">${esc(l)}</span>`).join('');
    };
    svg.addEventListener('click', (e) => {
      const p = e.target.closest('path[data-region]');
      if (p) paint(p);
    });
    // Keyboard and screen-reader parity: the SVG alone is one image, so the
    // areas are reachable through a plain list rather than by faking focus on
    // the paths.
    const picker = root.querySelector('.race-map-pick');
    if (picker) {
      picker.innerHTML = `<option value="">Jump to an area…</option>`
        + paths.map((p) => `<option value="${esc(p.dataset.region)}">${esc(p.dataset.region)}</option>`).join('');
      picker.addEventListener('change', () => {
        const p = paths.find((x) => x.dataset.region === picker.value);
        if (p) paint(p);
      });
    }
  }

  /**
   * The hand-written race object for a (contest, region) pair, or null.
   *
   * Races declare where they sit via `join`, so this index is DERIVED from
   * political_data.json rather than kept beside it. Adding a race with a join
   * makes it linkable from the leaderboard automatically — the alternative, a
   * second list of "races that have pages", is the kind of thing that is correct
   * on the day it is written and wrong a month later. Same reasoning as
   * contests.json being the one source for every picker.
   */
  function findRace(data, contest, region) {
    if (!data || !contest || !region) return null;
    const want = norm(region);
    for (const key of Object.keys(data)) {
      const r = data[key];
      const j = r && r.join;
      if (!j || j.contest !== contest) continue;
      if (norm(j.value) === want) return { key, race: r };
    }
    return null;
  }

  /**
   * A governorship page for a state Hawkeye has no candidate list for — which is
   * every state until INEC publishes one, roughly a month out.
   *
   * The page is still worth having: it is the seat's map, its size, who holds it
   * now, and when it is next voted on. What it must NEVER do is invent the part
   * it does not have, so `date` is taken from the contest catalogue and is
   * absent — not guessed — for the eight off-cycle states whose next governorship
   * is not in the 2027 general election.
   */
  function stateRace(data, state, contest) {
    const pd = data || {};
    const known = findRace(pd, 'GOV', state);
    if (known) return known.race; // Osun's real page beats a generated one.
    // THE STATE MUST BE A REAL ONE. `state` arrives from the query string, and a
    // page will happily render "Governor of <anything> State" from it. Resolving
    // against the register's own state list means an unknown value produces no
    // page at all rather than an official-looking one about a place that is not
    // there.
    const canon = Object.keys(pd.stateStats || {}).find((s) => norm(s) === norm(state));
    if (!canon) return null;
    // THE FCT HAS NO GOVERNOR. It is in every state-shaped map and dataset
    // because it is a federal capital territory, administered by a minister, and
    // a "Governor of FCT" page would be a page about an office that does not
    // exist. app.js already excludes it from GOV and SHA when picking a unit's
    // race; this is the same rule at the other end.
    if (norm(canon) === 'fct') return null;
    state = canon;
    const stats = pd.stateStats[canon] || {};
    const inCycle = contest && Array.isArray(contest.states) && contest.states.some((s) => norm(s) === norm(state));
    const held = (pd.governors || {})[state];
    return {
      office: `Governor of ${state}${/^fct$/i.test(state) ? '' : ' State'}`,
      election: `${state} State Governorship Election`,
      date: inCycle && contest.date ? contest.date : undefined,
      stats: { ...stats, heldBy: held || undefined },
      note: inCycle
        ? 'INEC has not published the candidate list for this race yet. Candidates appear here as soon as the official list is out. The map and seat facts on this page come from the electoral register and are current.'
        : `${state} votes for governor off the general-election cycle, so this race is not part of the 2027 general election and Hawkeye has no date for it yet. The map and seat facts on this page come from the electoral register and are current.`,
      candidates: [],
      others: [],
      join: { contest: 'GOV', level: 'state', value: state, state },
    };
  }

  /**
   * A page for ONE senatorial district or federal constituency.
   *
   * The board links here: a national map of 109 districts is only useful if a
   * district goes somewhere. Built from the register the same way the state
   * pages are — the seat's LGAs, its size, and the date from the contest
   * catalogue — with the candidate list the one thing missing, for a reason the
   * page states.
   *
   * `seats` is app/seat_lgas.json, fetched only by this page: 471 seats with
   * their LGA membership is ~46 KB no other page needs.
   */
  function seatRace(seats, code, seatName, contest) {
    const table = (seats || {})[code];
    if (!table || !seatName) return null;
    // Map spellings and register spellings differ on a handful of seats, so the
    // name is RESOLVED rather than trusted — and an unknown one builds no page
    // rather than an official-looking one about a seat that is not there.
    const canon = Object.keys(table).find((s) => norm(s) === norm(seatName));
    if (!canon) return null;
    const s = table[canon];
    const senate = code === 'SEN';
    return {
      office: `${senate ? 'Senator' : 'House of Representatives'} — ${canon}`,
      election: `${s.state} State · ${senate ? 'Senate' : 'House of Representatives'}`,
      date: contest && contest.date ? contest.date : undefined,
      stats: { lgas: s.lgas.length, pollingUnits: s.pollingUnits },
      note: 'INEC has not published the candidate list for this race yet. Candidates appear here as soon as the official list is out. The map and seat facts on this page come from the electoral register and are current.',
      candidates: [],
      others: [],
      join: {
        contest: code,
        level: senate ? 'senatorial' : 'federal_constituency',
        value: canon,
        state: s.state,
        lgas: s.lgas,
      },
    };
  }

  window.mountRace = mountRace;
  window.findRace = findRace;
  window.stateRace = stateRace;
  window.seatRace = seatRace;
})();

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
  // fetchData, not fetch: Lite does not bundle lga/constituency/district_geo
  // (1.7 MB of its download). native.js's helper fetches them from the live site
  // off-origin and is a no-op on hawkeye.com.ng, so the website is unchanged.
  // Already tolerant of failure — the `.catch(() => null)` here is why an
  // offline seat page loses only its outline and still renders everything else.
  const getGeo = (f) => (geoCache[f] = geoCache[f]
    || (typeof window !== 'undefined' && window.fetchData ? window.fetchData(f) : fetch(f))
      .then((r) => r.json()).catch(() => null));
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  /**
   * Each word clipped to its first four letters, deduplicated and sorted.
   *
   * The register and lga_geo.json disagree by a letter or two on names that are
   * plainly the same LGA — "Dawaki Kudu" vs "Dawakin Kudu", "Ayedaade" vs
   * "Ayedade", "Somolu" vs "Shomolu", "Danbata" vs "Dambatta". `norm()` strips
   * punctuation and case and still sees two strangers, so ~50 of the 774 never
   * matched and the seats containing them fell back to a featureless outline.
   *
   * Same key the native board uses (components/results-map.tsx stemKey), for the
   * same reason and with the same guard: a stem match is accepted only when it
   * is UNIQUE among the candidates. A map would rather draw nothing than draw
   * the neighbouring LGA, and {Burutu, Buruku} / {Kaura, Kauru} are exactly the
   * pairs that would otherwise be guessed between.
   */
  const stemKey = (s) => [...new Set(String(s || '').toLowerCase().split(/[^a-z]+/)
    .filter(Boolean).map((w) => w.slice(0, 4)))].sort().join(' ');

  /** Exact key first, then a UNIQUE stem match, then nothing. */
  const matchOne = (wanted, candidates, nameOf) => {
    if (!wanted) return null;
    const key = norm(wanted);
    if (!key) return null;
    const exact = candidates.find((c) => norm(nameOf(c)) === key);
    if (exact) return exact;
    const want = stemKey(wanted);
    if (!want) return null;
    const hits = candidates.filter((c) => stemKey(nameOf(c)) === want);
    return hits.length === 1 ? hits[0] : null;
  };
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

    // A SEAT, cut into its member LGAs.
    //
    // `> 1` used to guard this: a single-LGA seat had nothing to subdivide and
    // took the outline path instead. That is right for SEN and REP, whose
    // outlines exist — and wrong for a state-assembly seat, which has no outline
    // file at all, so the guard left it with no map whatsoever. A one-LGA cut is
    // now allowed when nothing else could be drawn.
    //
    // The members are RESOLVED through matchOne rather than compared raw. The
    // old `.toLowerCase()` comparison missed every LGA the two sources spell
    // differently, and a seat containing one silently lost its cut.
    const minParts = j.level === 'lga' ? 1 : 2;
    if (j.lgas && j.lgas.length >= minParts && j.state) {
      const geo = await getGeo('lga_geo.json');
      if (geo && geo.lgas) {
        const pool = geo.lgas.filter((x) => norm(String(x.key).split('|')[0]) === norm(j.state));
        const parts = [];
        for (const l of j.lgas) {
          const hit = matchOne(l, pool, (x) => String(x.key).split('|')[1] || '');
          if (!hit) break;
          parts.push({ path: hit.path, name: titleCase(String(hit.key).split('|')[1] || '') });
        }
        // Only use the cut if it found EVERY member; a partial cut would draw a
        // seat missing pieces of itself, which is worse than an outline.
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

  /**
   * The presidency, and only it.
   *
   * A join names the region a race is fought in; the presidency is fought in
   * all of them and carries none. Named because the CTA row and the field rule
   * below both branch on it, and `!race.join` at a call site reads as a
   * missing-data check rather than a statement about which election this is.
   *
   * It is also WHY the presidency keeps a second button: the map block renders
   * nothing without a join, so it is the one race page with no live map of its
   * own. Twin: political.ts:isPresidency.
   */
  const isPresidency = (race) => !!race && !race.join;

  /**
   * THE PRESIDENCY PROFILES ITS FIELD; EVERY OTHER RACE LISTS IT.
   *
   * The presidency is the one race read as a contest between named individuals
   * — nineteen people with running mates, home bases and national profiles — so
   * it keeps the front-runner cards, the full ballot and the quick-compare
   * table.
   *
   * A GOVERNORSHIP USED TO BE TREATED THE SAME WAY AND IS NOT ANY MORE. In
   * practice its cards and compare table were the presidential furniture with
   * nothing to put in it: no running mate, no home base, no prose, so five
   * columns of "—" and two card sizes for what is, like every other race, a list
   * of names. Osun is the clearest case — a completed race whose actual result
   * is in the declared card above, with front-runner cards below re-arguing a
   * contest that is over.
   *
   * So everything but the presidency gets ONE section, "Declared candidates", in
   * the compact row format the presidential page already uses for "Other
   * declared candidates" — which is what that format is good at: many names, one
   * line each, party-marked, and now with each candidate's running total beside
   * them once reports start arriving.
   *
   * Expressed as "not the presidency" rather than a list of levels. It was a
   * list, and adding the governorship left it stating the same fact twice —
   * worse, a level added later would have defaulted to the profiled treatment,
   * which is exactly the wrong way round.
   *
   * A FUNCTION, not an expression inside the renderer, because the native twin
   * needs the identical answer and a rule buried in JSX cannot be compared to
   * one buried in template strings. Twin: political.ts:seatFieldOf.
   */
  const seatFieldOf = (race) => !isPresidency(race) && !!(race && race.join && race.join.level);

  /**
   * Every declared name on a seat's page, in one list.
   *
   * `candidates`/`others`/`minors` are three shapes of the same fact and a seat
   * has no reason to separate them — merging is what lets one heading be honest
   * about being the whole field. Sorted by party like every other list here, so
   * the order is not a ranking.
   */
  const wholeFieldOf = (race) => [
    ...((race && race.candidates) || []),
    ...((race && race.others) || []),
    ...((race && race.minors) || []),
  ].sort((a, b) => String(a.party).localeCompare(String(b.party)));

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
    const seatField = seatFieldOf(race);
    const wholeField = seatField ? wholeFieldOf(race) : null;
    // COUNTED FROM THE LIST THAT IS ACTUALLY PRINTED. The old expression added
    // `others || minors`, which silently dropped one of them if a race ever
    // carried both — and on a seat page the merged list is the only list, so
    // deriving the number from anything else could disagree with what is on
    // screen directly beneath it.
    const candTotal = seatField
      ? wholeField.length
      : race.candidates.length + ((race.others || race.minors || []).length);
    const cells = [];
    /**
     * THE YEAR IS A FALLBACK, NOT A FIFTH CELL.
     *
     * A full election day already contains it — "16 Jan 2027" — and the written
     * races carry their own dated label, one of which is literally "Election
     * year". Adding a year cell unconditionally printed that label TWICE on
     * those pages. So the year fills in only when neither a date nor a dated
     * label exists, which keeps the promise (every card shows a year) without
     * saying the same thing in two boxes.
     */
    if (race.date) cells.push([new Date(race.date + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }), 'Election day']);
    else if (race.dateText) cells.push([race.dateText, race.dateLabel || 'Date']);
    else if (yr) cells.push([yr, 'Election year']);
    /**
     * TBD, NOT A SUPPRESSED CELL.
     *
     * This used to omit the cell entirely when the count was zero, on the
     * grounds that "a zero in a stat bar reads as a claim about the ballot
     * rather than about our data". That reasoning was right about `0` and wrong
     * about the fix: dropping the cell made the card SHORTER on exactly the
     * pages that have least, so a seat with no published field looked like a
     * page that had been half-built.
     *
     * `TBD` says the thing the zero could not: the number is missing from
     * Hawkeye, not from the election. Every race now carries the same four
     * facts, and three of them are known for every seat in the country.
     */
    cells.push([candTotal || 'TBD', 'Candidates']);
    if (st.heldBy) cells.push([st.heldBy, 'Currently held by']);
    /**
     * THE COUNT SHOULD DESCRIBE WHAT THE MAP DRAWS — except where it cannot.
     *
     * The map above is cut from LGAs at every level, so the LGA count and the
     * shapes on screen are the same fact twice: a governorship's whole state, a
     * senatorial district's 3-8, a federal constituency's 2-4. Naming a
     * different unit than the one being drawn makes a reader reconcile two
     * numbers for no gain.
     *
     * A STATE CONSTITUENCY IS THE EXCEPTION, and the only one. It sits inside a
     * single LGA — "1 LGAs", on 765 of the 1,005 seats — which is not a fact
     * about the seat so much as a fact about the register not separating them.
     * Wards are the grain that seat is actually built from and the only figure
     * that varies: 8 to 20 per state constituency.
     *
     * REP was briefly measured in wards too and is back on LGAs, because its
     * map really does draw 2-4 shapes and the count now names them. Twin:
     * native components/race.tsx.
     *
     * Chosen off `join.level`, which is the same field the board and the map key
     * on, so a page cannot describe itself as one kind of race and draw another.
     */
    const seatLevel = race.join && race.join.level === 'lga';
    // A count of one is still a count of one. "1 LGAs" appears on 80 of the 366
    // federal constituencies and 986 of the 1,005 state seats — not a rare edge.
    const plural = (n, word) => (Number(n) === 1 ? word : word + 's');
    if (seatLevel && st.wards != null) cells.push([st.wards, plural(st.wards, 'Ward')]);
    else if (st.lgas != null) cells.push([st.lgas, plural(st.lgas, 'LGA')]);
    if (st.pollingUnits != null) cells.push(['~' + Number(st.pollingUnits).toLocaleString(), plural(st.pollingUnits, 'Polling unit')]);
    if (cells.length) parts.push(`<div class="race-statbar">${cells.map(([n, l]) => `<div class="s"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`);

    // WHO INEC DECLARED — on a finished race, the first thing a reader wants.
    //
    // DELIBERATELY NOT AN INEC-LOOKING BADGE. No crest, no emblem, nothing that
    // could pass for a mark INEC issued: this product says "Not government or
    // INEC affiliated" on every board, and a page wearing INEC's insignia would
    // contradict that on sight — quite apart from being someone else's mark to
    // use. It is Hawkeye's own badge, in Hawkeye's own colours, CITING INEC in
    // words, with the sources it was taken from.
    //
    // And it only claims what it can support: `declared` is written by hand from
    // the returning officer's announcement, and the page renders nothing at all
    // without it. IReV publishes sheet IMAGES, never numbers — there is no
    // endpoint that would let this be derived, so an absent block means nobody
    // has recorded the declaration yet, not that the race was undecided.
    if (race.declared && race.declared.winner) {
      const D = race.declared;
      const rows = Array.isArray(D.results) ? D.results : [];
      const top = rows.length ? Math.max(...rows.map((r) => Number(r.votes) || 0)) : 0;
      parts.push(`<section class="declared" aria-labelledby="declared-h">
        <div class="declared-head">
          <!-- THE HEADING NAMES THE SECTION, NOT THE PERSON. As an <h2> the
               winner's name alone put "Ademola Adeleke A" in the page outline,
               which tells someone navigating by heading nothing about what the
               section is — and read as Hawkeye announcing a person rather than
               recording a declaration. The pill IS the heading now; the name is
               the content under it. -->
          <h2 class="declared-tag" id="declared-h">Declared result</h2>
          <p class="declared-winner">${esc(D.winner)}${D.party ? ` <span class="declared-party">${flagInline(D.party, 18)}${esc(D.party)}</span>` : ''}</p>
          <p class="declared-by">Declared by ${esc(D.by || 'INEC')}${
            D.date ? ` on ${esc(new Date(D.date + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }))}` : ''
          }${D.place ? `, ${esc(D.place)}` : ''}${D.returningOfficer ? ` · Returning Officer ${esc(D.returningOfficer)}` : ''}.</p>
        </div>
        ${rows.length ? `<ol class="declared-rows">${rows.map((r) => {
          const v = Number(r.votes) || 0;
          const pct = top ? Math.max(3, Math.round((v / top) * 100)) : 0;
          return `<li${r.party === D.party ? ' class="won"' : ''}>
            <span class="dp">${flagInline(r.party, 16)}${esc(r.party)}</span>
            <span class="dn">${esc(r.name || '')}</span>
            <span class="dbar"><i style="width:${pct}%"></i></span>
            <span class="dv">${v.toLocaleString()}</span></li>`;
        }).join('')}</ol>` : ''}
        <p class="declared-note">${esc(D.note || '')}</p>
        ${Array.isArray(D.sources) && D.sources.length ? `<p class="declared-src">Recorded from: ${
          D.sources.map((u, i) => `<a href="${esc(u)}" rel="noopener noreferrer" target="_blank">source ${i + 1}</a>`).join(' · ')
        }</p>` : ''}
      </section>`);
    }

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

    // THE SEAT'S WHOLE FIELD, one heading, one row each. `wholeField` and the
    // rule behind it are derived up with the stat bar, so the count in the card
    // and the list beneath it come from the same array.
    if (seatField && wholeField.length) {
      parts.push('<h2 style="margin-top:26px">Declared candidates</h2>');
      parts.push('<p class="hint" id="field-hint">Listed alphabetically by party. Not an endorsement or a prediction — Hawkeye is nonpartisan.</p>');
      /**
       * `data-party` is the join key for the running totals filled in later —
       * see fillFieldTotals. The slot is rendered EMPTY rather than omitted, so
       * arriving numbers do not reflow a list the reader is already looking at.
       */
      parts.push(`<div class="ballot" id="field-list">${wholeField.map((c) => `
        <div class="b" style="--pc:${color(c.party)}" data-party="${esc(c.party)}">${flagIcon(c.party)}
          <div><strong>${esc(c.name)}</strong><span>${esc(c.meta || c.party)}${!c.meta && c.incumbent ? ' · incumbent' : ''}</span></div>
          <b class="b-votes" hidden></b></div>`).join('')}</div>`);
    }

    // Primary candidate cards
    // SKIP THE SECTION ENTIRELY WHEN THERE ARE NO CARDS TO PUT IN IT. A
    // down-ballot race carries no per-candidate prose — every name lives in
    // others[] and the full ballot below says everything there is to say — so
    // with candidates[] empty this printed a "Front-runners" heading, a
    // nonpartisan disclaimer and then nothing at all. 470 Senate and House pages
    // would each have opened on that.
    if (!seatField && race.candidates.length) {
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

    // Full ballot (osun `others`) or minor candidates (presidential `minors`).
    // Not on a seat page: `wholeField` above already printed every one of these
    // names, and reprinting them under a second heading would double the field.
    const secondary = seatField ? null : (race.others || race.minors);
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
    // Party, Home base, Bid, Status). The presidency and a governorship, which
    // are the races read as a contest between named people.
    //
    // Guarded for the same reason as the front-runner grid above, plus the seat
    // rule: its columns are Home base / Bid / Status, three facts a seat's field
    // does not carry, so on a seat page every cell would be an em dash.
    if (!seatField && race.candidates.length) {
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
    /**
     * "REPORT FROM YOUR UNIT", not "Become an Observer".
     *
     * The two clients said the same words and meant different things: native
     * routed straight to the report flow while this went to sign-up. Both now
     * ask for the report — observe.html?intent=observe already handles either
     * state, taking a signed-in observer to filing and a stranger through
     * sign-up first, so the destination is unchanged and only the promise is
     * honest now. Someone reading a race page who is ready to act is being
     * asked to file from where they are standing.
     *
     * `race-cta` is STICKY (see race.css) — the same rule the app follows: a
     * race page runs to a stat bar, a map, a declared result and up to nineteen
     * candidates, and the one thing it asks for must not be under all of that.
     */
    /**
     * NO RESULTS BUTTON, BECAUSE THIS PAGE IS THE RESULTS.
     *
     * The map above is this race's own regions coloured from /api/national —
     * the board's data, cropped to the race being read. "See Live Results" sat
     * directly beneath a live result and led somewhere less specific than where
     * the reader already was.
     *
     * THE PRESIDENCY IS THE EXCEPTION and says why in one place: it carries no
     * join, so the map block above renders nothing for it. It is the single
     * race page with no live map of its own, and until it has one the button is
     * the only route to a presidential board — now that board directly, rather
     * than the picker (resultsHrefFor below). Twin: native RaceActions.
     */
    const boardOnly = isPresidency(race);
    parts.push(`<div class="race-cta${done ? '' : ' race-cta-pinned'}">
      ${canFollow ? '<button type="button" class="btn-quiet" data-cta="follow" id="race-follow-btn">🔔 Follow this race</button>' : ''}
      ${done ? '' : '<a class="btn-accent" data-cta="observe" href="observe.html?intent=observe">Report from your unit</a>'}
      ${boardOnly ? `<a class="${done ? 'btn-accent' : 'btn-quiet'}" data-cta="results" href="${esc(opts.resultsHref || resultsHrefFor(race))}">${
        done ? 'Review the results' : 'Live results'}</a>` : ''}
      ${done ? '<a class="btn-quiet" data-cta="verify" href="ledger.html">Verify the record</a>' : ''}</div>
      ${canFollow ? '<p class="hint" id="race-follow-msg" hidden></p>' : ''}`);

    const credit = [noteLeads ? '' : (race.note || ''), race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit || ''].filter(Boolean).join(' ');
    if (credit) parts.push(`<p class="hint">${esc(credit)}</p>`);

    /**
     * KEEP THE NOT-AFFILIATED NOTICE. menu.js prepends the `.gov-disclaimer`
     * bar INSIDE <main> (`main.insertBefore(bar, main.firstChild)`), and this
     * line replaces main's entire contents — so the bar was created, then
     * silently destroyed, on every race page.
     *
     * That is the worst possible page to lose it on. Race pages are the ones
     * carrying INEC-declared results, they are generated in the hundreds (36
     * governorships, 109 senatorial, 362 federal), and Google Play rejected
     * this app twice under Misleading Claims for showing government
     * information without a visible statement of non-affiliation and a link to
     * the source. The bar is that statement. The web app is also what Hawkeye
     * Lite wraps, so a missing notice here is a missing notice in a shipped
     * Play app.
     *
     * Carried across rather than re-injected: menu.js has already run, and its
     * guard is `if (document.querySelector('.gov-disclaimer')) return` — so
     * asking it to run again would do nothing while the node still existed, and
     * nothing again once it did not.
     */
    const disclaimer = main.querySelector('.gov-disclaimer');
    main.innerHTML = parts.join('\n');
    if (disclaimer) main.insertBefore(disclaimer, main.firstChild);

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

    /**
     * The running totals, fetched ONCE and used by both things that want them.
     *
     * The board was previously fetched only when the map had more than one
     * region to wire up — the candidate list needs the same response's
     * `national` array whether or not there is a map to tap, so the request
     * moves out here and both readers share it. Failing to a null board is
     * fine: the list simply keeps the names it already rendered.
     */
    const board = boardFor(race).catch(() => null);
    board.then((b) => fillFieldTotals(main, race, b)).catch(() => {});

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
            // The same promise the totals used — one request, two readers.
            board
              .then((b) => wireRaceMap(slot, race, b))
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
    // The presidency has no join and still has a board. A bare results.html
    // seeds itself from the picker, so the one button on the presidential page
    // opened "choose an election" and asked the reader to find the race they
    // were already reading. Name the contest and land on it. Twin: native
    // lib/political.ts:resultsHrefFor.
    if (!j || !j.contest || !j.value) return 'results.html?contest=PRES';
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

  /**
   * WHAT OBSERVERS HAVE REPORTED FOR EACH CANDIDATE, BESIDE THEIR NAME.
   *
   * The board's `national` array is the same running total the leaderboard
   * ranks, scoped to this race — so the list stops being a static roll of names
   * once polling starts and becomes the thing a reader actually opened the page
   * for. Joined on PARTY, which is the only key both sides share: the board
   * counts votes by party because that is what a result sheet records.
   *
   * THIS IS NOT THE DECLARED RESULT and must never be mistaken for it. The
   * declared card above carries INEC's figures and is unchanged; this is what
   * Hawkeye's observers have sent in so far, which is why the hint says so and
   * says how many units it is drawn from. On a completed race the two sit on the
   * same page and a reader has to be able to tell which is which.
   *
   * NOTHING IS SHOWN UNTIL SOMETHING IS REPORTED. A column of zeroes before
   * polls open reads as "no votes for anyone", not as "no reports yet" — and
   * those are opposite claims. Same rule the map's tap-through already follows.
   */
  function fillFieldTotals(main, race, board) {
    const list = main.querySelector('#field-list');
    if (!list || !board || !board.unitsReporting || !Array.isArray(board.national)) return;
    const totals = new Map(board.national.map((n) => [String(n.party), Number(n.votes) || 0]));
    let any = false;
    list.querySelectorAll('.b[data-party]').forEach((row) => {
      const v = totals.get(row.dataset.party);
      if (!v) return;                       // no reports for this party yet
      const slot = row.querySelector('.b-votes');
      if (!slot) return;
      slot.textContent = v.toLocaleString();
      slot.hidden = false;
      any = true;
    });
    if (!any) return;
    const units = board.unitsReporting;
    const hint = main.querySelector('#field-hint');
    if (hint) {
      hint.innerHTML = 'Listed alphabetically by party. Not an endorsement or a prediction — Hawkeye is nonpartisan. '
        + `<strong>Totals are what observers have reported so far</strong> — from ${units.toLocaleString()} `
        + `polling unit${units === 1 ? '' : 's'}, not an official count.`;
    }
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

  /**
   * Resolve a seat name against a table of seats: exact first, then by the SET
   * of LGAs the name lists. Shared by race.js and native's political.ts — keep
   * the two in step, they are the only two implementations of this rule.
   */
  function matchSeatName(table, name) {
    if (!table || !name) return null;
    const keys = Object.keys(table);
    const exact = keys.find((s) => norm(s) === norm(name));
    if (exact) return exact;
    // Components, sorted, so order stops mattering. Hyphens and stray spaces are
    // already gone: norm strips every non-alphanumeric.
    const parts = (s) => String(s || '').split('/').map(norm).filter(Boolean).sort().join('|');
    const want = parts(name);
    if (!want) return null;
    const index = new Map();
    for (const k of keys) {
      const p = parts(k);
      index.set(p, index.has(p) ? null : k);   // a repeat poisons the key
    }
    if (index.get(want)) return index.get(want);

    // THIRD TIER: THE SEAT'S OWN LGA LIST, not its label.
    //
    // Some names are not a list of LGAs at all. The register calls one Delta
    // seat "Warri"; the boundary file spells the same seat out as
    // "Warri North/Warri South/Warri South West" — which are exactly that
    // seat's three LGAs. Likewise the register's "Donga/Ussa/Takum/Special
    // Area" carries a fourth component the map does not, and its "Katsina
    // Central" is the map's plain "Katsina". Comparing the request against
    // each seat's `lgas` array resolves all of them, because that array is the
    // fact both names are trying to express.
    const wantSet = new Set(String(name).split('/').map(norm).filter(Boolean));
    let hit = null, hits = 0;
    for (const k of keys) {
      const lgas = (table[k] && table[k].lgas) || [];
      if (!lgas.length) continue;
      // An LGA NAME CAN ITSELF CONTAIN A SLASH — Ogun's "Obafemi/Owode" is one
      // LGA, not two — so the seat's own components are indexed both whole and
      // split. Without this the map's "Owode/Odeda" matches nothing, because
      // "owode" never equals "obafemiowode".
      const have = new Set();
      for (const l of lgas) {
        have.add(norm(l));
        for (const piece of String(l).split('/')) if (norm(piece)) have.add(norm(piece));
      }
      // Every component the caller named is one of this seat's LGAs. Subset,
      // not equality: the map may name fewer than the register records.
      const covered = [...wantSet].every((w) => have.has(w));
      if (covered) { hits++; hit = k; }
    }
    // Exactly one seat, or none. Two candidates means the name does not
    // identify a seat and a guess would send the reader to the wrong one.
    return hits === 1 ? hit : null;
  }

  /**
   * @param code  the CONTEST code — identity, and what /api/national is keyed by
   * @param tier  the CATEGORY — which seat table to look the name up in.
   *              Defaults to `code`, so the five general contests are unchanged.
   *              A by-election passes REP_BYE_GOMBE_2026 + 'REP': the seat facts
   *              live under REP, the board lives under the by-election's own code,
   *              and merging the two would file a 2026 by-election into the 2027
   *              general election's race.
   */
  function seatRace(seats, code, seatName, contest, tier) {
    const table = (seats || {})[tier || code];
    if (!table || !seatName) return null;
    // Map spellings and register spellings differ on a handful of seats, so the
    // name is RESOLVED rather than trusted — and an unknown one builds no page
    // rather than an official-looking one about a seat that is not there.
    // MATCH ON COMPONENTS, NOT THE EXACT STRING.
    //
    // A federal constituency is named by listing its LGAs, and the register and
    // the boundary file list them in DIFFERENT ORDERS: the map says
    // "Abaji/Gwagwalada/Kwali/Kuje", seat_lgas.json says
    // "Kuje/Abaji/Gwagwalada/Kwali". Both name the same seat. Exact matching saw
    // two strangers, so tapping that region on the national map reached a page
    // that said "Hawkeye has no page for this race yet" — about a seat we have
    // every fact for. 29 of 360 constituencies were dead ends this way.
    //
    // Same rule the register normalisation settled on for the same reason
    // (sorted-component matching found 15 authorities where exact found 6), and
    // the same tiering matchRegion uses on the board.
    //
    // AMBIGUOUS KEYS ARE DROPPED, NOT GUESSED. If two seats ever share an LGA
    // set, sending a reader to whichever sorted first would be worse than the
    // absence message — so such a key resolves to nothing.
    const canon = matchSeatName(table, seatName);
    if (!canon) return null;
    const s = table[canon];
    const senate = (tier || code) === 'SEN';
    return {
      office: `${senate ? 'Senator' : 'House of Representatives'} — ${canon}`,
      election: `${s.state} State · ${senate ? 'Senate' : 'House of Representatives'}`,
      date: contest && contest.date ? contest.date : undefined,
      stats: { lgas: s.lgas.length, wards: s.wards, pollingUnits: s.pollingUnits },
      // A seat the register cannot tell from its neighbour says so, rather than
      // presenting a shared figure as its own. Four Lagos LGAs elect two members
      // each and polling_units records only the LGA.
      note: (s.sharedRegister
        ? "INEC's register does not separate this seat from the other constituency in the same LGA, so the LGA and polling-unit figures on this page cover both. "
        : '') + 'INEC has not published the candidate list for this race yet. Candidates appear here as soon as the official list is out. The map and seat facts on this page come from the electoral register and are current.',
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

  /**
   * A BY-ELECTION'S PAGE.
   *
   * A by-election is a race in the same category as the general election for
   * that seat — a House by-election is a House race — so it reuses the same page
   * builders. What it must never do is share the general election's CONTEST
   * CODE: `join.contest` is what /api/national is keyed by and what the ledger
   * partitions a race's subchain on, so filing a 2026 by-election under `REP`
   * would merge it with the 2027 general election for the same seat, inside a
   * published anchor, permanently.
   *
   * The seat's name comes from the contest itself. `constituencies` is the
   * allowlist the backend gates reports with (services/scope.js contestApplies),
   * so the page and the gate cannot describe different places.
   *
   * SHA has no seat table and no outline file: state-assembly constituencies are
   * absent from the register, so the backend buckets them by LGA and the
   * contest's `constituencies` ARE LGA names. That is enough for a map — one LGA
   * polygon — and it is the only map that exists for such a seat.
   */
  /**
   * A state constituency's figures out of seat_lgas.json.
   *
   * Keyed "State|Seat" there, unlike SEN and REP which key on the bare name:
   * state-constituency names repeat across states ("Central", the numbered
   * seats), so the state is part of the identity.
   *
   * `sharedRegister` travels with them. Nearly half of the 1,005 state seats sit
   * on an LGA that elects more than one member, and the register cannot say
   * which of them a unit votes in — so those figures describe the LGA, not the
   * race, and the page has to say so rather than print a number that looks
   * specific.
   */
  function shaStats(seats, state, seat) {
    const t = (seats || {}).SHA || {};
    let hit = t[`${state}|${seat}`] || t[matchSeatName(t, `${state}|${seat}`)];
    /**
     * A BY-ELECTION NAMES ITS LGA, NOT ITS SEAT.
     *
     * `constituencies` is the allowlist the backend gates reports with, and for
     * a state-assembly contest the backend buckets by LGA — so what arrives here
     * is an LGA name. Kano's is "Dawaki Kudu"; the seat is called "Dawakin
     * Kudu". A seat-name lookup cannot bridge that, so it missed and the card
     * fell back to `{ lgas: 1 }` — the exact "1 LGAs" this function exists to
     * remove, on the one page most likely to be read.
     *
     * Resolving through the LGA instead is not a looser spelling rule, it is the
     * right question. Where the LGA elects several members every one of those
     * rows carries the LGA's own figures (checked: identical across all 240
     * shared groups), so the first is as good as any and `sharedRegister` is
     * already set on it — the caveat the page prints.
     */
    if (!hit) {
      const on = assemblySeatsInLga(seats, state, seat);
      if (on.length) hit = on[0];
    }
    if (!hit) return { lgas: 1 };
    return {
      lgas: (hit.lgas || []).length,
      wards: hit.wards,
      pollingUnits: hit.pollingUnits,
      sharedRegister: !!hit.sharedRegister,
    };
  }

  function byElectionRace(contest, seats, political) {
    if (!contest) return null;
    const tier = contest.tier || contest.code;
    const seat = (contest.constituencies || [])[0];
    const state = (contest.states || [])[0];
    if (!seat) return null;

    if (tier === 'SEN' || tier === 'REP') {
      const r = seatRace(seats, contest.code, seat, contest, tier);
      if (r) r.election = `${state} State · ${contest.name}`;
      return r;
    }
    if (tier === 'GOV') return stateRace(political, state, contest);
    if (tier !== 'SHA') return null;

    /**
     * THE SEAT'S NAME AND THE GATE'S NAME ARE DIFFERENT THINGS.
     *
     * `constituencies` is the register value reports are gated on, and for a
     * state-assembly contest that is an LGA. Usually the LGA and the seat are
     * the same place — Udu is Udu — so the title read fine off the gate.
     *
     * Bauchi 2026 is where that breaks. Its two by-elections are for Shira I
     * (Disina) and Sakwa (Zaki I), sitting in the LGAs "Shira" and "Zaki" — and
     * each of those LGAs elects a SECOND member who is not up for election
     * (Shira II, Azare). Titling off the gate would produce "Shira State
     * Constituency", which is the name of the sibling seat: a page announcing
     * the wrong race. Only the contest knows which of the two is voting.
     *
     * Falls back to the gate value, so contests written before this field
     * existed are unchanged. Twin: political.ts:byElectionRace.
     */
    const seatName = contest.seat || seat;

    return {
      office: `${seatName} State Constituency — ${state} State`,
      election: `${state} State · ${contest.name}`,
      date: contest.date || undefined,
      /**
       * REAL FIGURES, from the register, instead of the number 1.
       *
       * This was `lgas: contest.constituencies.length` — which is always 1 for a
       * by-election, so the card read "1 LGAs" and said nothing. The seat table
       * now carries state constituencies (keyed "State|Seat", because those
       * names repeat across states), so the same wards/units the other tiers
       * show are available here too.
       */
      stats: shaStats(seats, state, seat),
      note: (shaStats(seats, state, seat).sharedRegister
        ? "This LGA elects more than one state member, and INEC's register does "
          + 'not separate them, so the ward and polling-unit figures on this page '
          + 'cover every seat in the LGA rather than this one alone. '
        : '')
        + 'INEC has not published the candidate list for this by-election yet. '
        + 'Candidates appear here as soon as the official list is out. The seat '
        + 'and map on this page come from the electoral register and are current.',
      candidates: [],
      others: [],
      join: {
        contest: contest.code,
        // 'lga' because that is the level the backend buckets a state-assembly
        // contest by — state-assembly constituencies are not in the register.
        level: 'lga',
        value: seat,
        state,
        lgas: contest.constituencies || [],
      },
    };
  }

  /**
   * A STATE CONSTITUENCY'S PAGE.
   *
   * State-assembly seats are not a column in the register — that is why the
   * backend buckets SHA reports by LGA — so everything here comes from the SHA
   * block of seat_lgas.json, built from the seat catalogue. Keyed "State|Seat",
   * because those names repeat across states.
   *
   * There are 1,005 of them, which is why they are reached by URL and from the
   * board rather than listed anywhere: the same treatment the 109 senatorial
   * districts and 362 federal constituencies already get.
   */
  function assemblyRace(seats, state, seat, contest) {
    const table = (seats || {}).SHA || {};
    const key = `${state}|${seat}`;
    const canon = table[key] ? key : matchSeatName(table, key);
    if (!canon) return null;
    const s = table[canon];
    return {
      office: `${s.seat} State Constituency`,
      election: `${s.state} State · House of Assembly`,
      date: contest && contest.date ? contest.date : undefined,
      stats: { lgas: (s.lgas || []).length, wards: s.wards, pollingUnits: s.pollingUnits },
      note: (s.sharedRegister
        ? `${s.lgas.join(', ')} elects more than one state member, and INEC's register `
          + 'does not separate them, so the ward and polling-unit figures on this page cover '
          + 'every seat in that LGA rather than this one alone. '
        : '')
        + 'INEC has not published the candidate list for this race yet. Candidates appear '
        + 'here as soon as the official list is out. The seat and map on this page come from '
        + 'the electoral register and are current.',
      candidates: [],
      others: [],
      join: {
        contest: (contest && contest.code) || 'SHA',
        // 'lga' because that is the level the backend buckets a state-assembly
        // contest by — the constituencies themselves are not in the register.
        level: 'lga',
        value: (s.lgas || [])[0] || s.seat,
        state: s.state,
        lgas: s.lgas || [],
      },
    };
  }

  /**
   * Every state constituency in one state, for the picker.
   *
   * Sorted by name so the list is stable; a state has 24-40 of them, which is a
   * readable page and not a scroll.
   */
  function assemblySeats(seats, state) {
    const table = (seats || {}).SHA || {};
    return Object.keys(table)
      .filter((k) => norm(k.split('|')[0]) === norm(state))
      .map((k) => table[k])
      .sort((a, b) => String(a.seat).localeCompare(String(b.seat)));
  }

  /**
   * The seats sitting on one LGA.
   *
   * The SHA board buckets by LGA, so a link from it names an LGA and not a seat
   * — and 240 of the 768 LGAs elect two, three or four members. Returning the
   * list rather than the first one is what stops the board sending a reader to
   * a race they did not click on.
   */
  function assemblySeatsInLga(seats, state, lga) {
    return assemblySeats(seats, state).filter((s) => (s.lgas || []).some((l) => norm(l) === norm(lga)));
  }

  window.mountRace = mountRace;
  window.findRace = findRace;
  window.stateRace = stateRace;
  window.seatRace = seatRace;
  window.byElectionRace = byElectionRace;
  window.assemblyRace = assemblyRace;
  window.assemblySeats = assemblySeats;
  window.assemblySeatsInLga = assemblySeatsInLga;
  window.shaStats = shaStats;
  // Exposed so tests/native_race_parity_test.mjs can hold this rule against the
  // native twin. The renderers are not comparable; these two functions are.
  window.seatFieldOf = seatFieldOf;
  window.wholeFieldOf = wholeFieldOf;
  window.isPresidency = isPresidency;
  window.resultsHrefFor = resultsHrefFor;
})();

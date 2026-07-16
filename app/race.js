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
    LP: '#388e3c', SDP: '#5e35b1', NRM: '#827717', NDC: '#2e3192', YP: '#00695c',
    DLA: '#6a1b9a', Accord: '#00838f', BOOT: '#37474f',
  };
  const color = (p) => PC[p] || '#9aa7a0';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

    const title = race.office ? `${esc(race.office)} — 2026` : esc(race.election || 'Race');
    const dateStr = race.date ? new Date(race.date + 'T00:00:00').toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
    document.title = `Hawkeye — ${race.office || race.election || 'Race'}`;

    const parts = [];
    parts.push(`<h1>${title}</h1>`);
    if (race.office || dateStr) parts.push(`<p class="lede">${esc(race.office || race.election)}${dateStr ? ' · ' + dateStr : ''}.</p>`);

    // Stat bar (optional)
    if (race.stats) {
      const cells = [];
      if (race.date) cells.push([new Date(race.date + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }), 'Election day']);
      if (race.stats.candidates != null) cells.push([race.stats.candidates, 'Candidates on the ballot']);
      if (race.stats.lgas != null) cells.push([race.stats.lgas, 'Local Government Areas']);
      if (race.stats.pollingUnits != null) cells.push(['~' + Number(race.stats.pollingUnits).toLocaleString(), 'Polling units']);
      parts.push(`<div class="race-statbar">${cells.map(([n, l]) => `<div class="s"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`);
    }

    // Context / incumbent note (optional)
    if (race.incumbentNote) parts.push(`<div class="race-ctx">${esc(race.incumbentNote)}</div>`);

    // Primary candidate cards
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

    // Optional side-by-side compare table (presidential page keeps this)
    if (opts.compare) {
      parts.push('<h2 style="margin-top:26px">Quick compare</h2>');
      parts.push(`<div class="race-compare"><table><thead>
        <tr><th>Candidate</th><th>Party</th><th>Home base</th><th>Bid</th><th>Status</th></tr></thead><tbody>${
        race.candidates.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td>
          <td>${flagInline(c.party)}<span style="font-weight:700;color:${color(c.party)}">${esc(c.party)}</span></td>
          <td>${esc(c.home || '—')}</td><td>${esc(c.bids || '—')}</td><td>${esc(c.status || '—')}</td></tr>`).join('')}</tbody></table></div>`);
    }

    // Full ballot (osun `others`) or minor candidates (presidential `minors`)
    const secondary = race.others || race.minors;
    if (secondary && secondary.length) {
      if (race.others) {
        const all = [...race.candidates, ...race.others].sort((a, b) => a.party.localeCompare(b.party));
        parts.push(`<h2 style="margin-top:26px">Full ballot — all ${all.length} candidates</h2>`);
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

    // Calls to action
    parts.push(`<div class="race-cta">
      <a class="btn-accent" href="observe.html?intent=observe">Become an Observer</a>
      <a class="btn-ghost" style="border-color:var(--green);color:var(--green)" href="results.html">Live Results</a></div>`);

    const credit = [race.note ? `${race.note}` : '', race.asOf ? `(as of ${race.asOf})` : '', race.photoCredit || ''].filter(Boolean).join(' ');
    if (credit) parts.push(`<p class="hint">${esc(credit)}</p>`);

    main.innerHTML = parts.join('\n');
  }

  window.mountRace = mountRace;
})();

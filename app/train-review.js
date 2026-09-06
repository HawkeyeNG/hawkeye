/**
 * Flagged-sheet review — the second job on the training pages.
 *
 * Labelling (the rest of train.html) builds a calibration set from unseen
 * sheets. This re-reads the 495 tier-A sheets the Osun audit's own checks failed
 * on, to establish what each one actually says.
 *
 * TWO STEPS, AND THE ORDER IS THE POINT.
 *   1. READ    — the sheet and nothing else. No machine reading anywhere on the
 *                page, and none in the network tab either: the server refuses to
 *                release it (409) until step 1 is committed.
 *   2. COMPARE — both readings side by side. The form stays pre-filled with the
 *                REVIEWER's numbers, never the machine's, so agreeing with the
 *                machine is a decision they have to actually make.
 *
 * Why the ceremony: the 20 sheets in hand_labels.json were "labelled" by a model
 * that had been shown its own earlier output. 16 of 20 came back identical, and
 * the 97.7% figure derived from them is an agreement rate wearing an accuracy's
 * clothes. A person shown a plausible number agrees with it too. That is what
 * anchoring is, and it leaves no trace in the data.
 *
 * One shared module rather than four copies: train.html, train2.html,
 * trainderek.html and traindavina.html are byte-identical apart from four lines,
 * and four copies of this would drift apart within a month.
 */
(function () {
  'use strict';

  const mount = document.getElementById('review-mount');
  if (!mount) return;

  const token = localStorage.getItem('hawkeye_token');
  const SET = Number(window.TRAIN_SET || 1);
  const api = (p, opt) => fetch(p, {
    ...opt,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opt && opt.headers) },
  });

  let ballot = [];
  let queue = [];
  let cur = null;
  let blind = null;      // this reviewer's committed reading, once made
  let startedAt = 0;

  const BOXES = [
    ['registered', 'Registered voters'],
    ['accredited', 'Accredited voters'],
    ['ballotsIssued', 'Ballots issued'],
    ['unusedBallots', 'Unused ballots'],
    ['spoiled', 'Spoiled ballots'],
    ['rejected', 'Rejected ballots'],
    ['totalValid', 'Total valid votes'],
    ['usedBallots', 'Used ballots'],
  ];

  const style = document.createElement('style');
  style.textContent = `
    #review-mount .rv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    #review-mount .rv-row { display: flex; align-items: center; gap: 8px; }
    #review-mount .rv-row label { width: 62px; font-weight: 700; font-size: 0.9rem; }
    #review-mount .rv-row input { margin: 0; width: 100%; }
    #review-mount .rv-box label { display: block; font-size: 0.78rem; opacity: 0.8; margin-bottom: 2px; }
    /* THE BAND MUST NOT COVER THE FIELDS IT EXISTS TO HELP WITH.
       Both bands are position:sticky at top:0, which is right for the party
       rows — a thin strip that follows you down the ballot. The boxes band is
       the whole #1-#8 block, which is far taller: measured at 365px of a 704px
       screen, 52% of the viewport, and it hid the first two fields (Registered
       and Accredited voters) by 36px each while they were focused. Those are
       the two you type first.
       Two parts, and both are needed: cap the image so the band cannot dominate
       a phone screen, and give the fields a scroll-margin so focusing one
       scrolls it clear of the sticky band instead of underneath it. */
    #review-mount #rv-boxband { max-height: 30vh; object-fit: contain; object-position: top; }
    #review-mount #rv-boxes .rv-box { scroll-margin-top: calc(30vh + 52px); }
    #review-mount #rv-parties .rv-row { scroll-margin-top: calc(13vh + 52px); }
    #review-mount .rv-sheet { width: 100%; border: 1px solid var(--line, #dde4de); border-radius: 8px; }
    #review-mount .rv-zoom { cursor: zoom-in; }
    #review-mount table.rv-cmp { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    #review-mount table.rv-cmp th, #review-mount table.rv-cmp td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--line, #dde4de); }
    #review-mount table.rv-cmp td.num { font-variant-numeric: tabular-nums; text-align: right; }
    #review-mount tr.rv-differ { background: rgba(200, 120, 0, 0.14); }
    #review-mount tr.rv-added { background: rgba(0, 120, 70, 0.12); }
    #review-mount .rv-tag { font-size: 0.75rem; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
    #review-mount .rv-meta { font-size: 0.86rem; opacity: 0.85; }
  `;
  document.head.appendChild(style);

  mount.innerHTML = `
    <section class="card">
      <h2>Review a flagged sheet</h2>
      <p class="hint" id="rv-progress">Loading…</p>
      <p class="hint">These are sheets our automated checks could not settle. Read the sheet
      yourself first — the machine's reading is released only after you commit yours.</p>
    </section>
    <section id="rv-work" hidden></section>
    <p id="rv-msg" class="status"></p>
  `;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  // The sheet route is behind observer auth, and an <img src> cannot carry a
  // bearer token — so fetch it and hand the element a blob instead. The images
  // are public IReV documents; what the auth protects is the QUEUE, which is a
  // list of where we suspect a problem before anyone has confirmed one.
  let sheetUrl = null;
  async function loadSheet(key) {
    const el = $('rv-img');
    if (!el) return;
    if (sheetUrl) { URL.revokeObjectURL(sheetUrl); sheetUrl = null; }
    try {
      const r = await api('/api/training/review/sheet/' + encodeURIComponent(key));
      if (!r.ok) throw new Error('status ' + r.status);
      sheetUrl = URL.createObjectURL(await r.blob());
      el.src = sheetUrl;
      el.onclick = () => window.open(sheetUrl, '_blank', 'noopener');
    } catch (e) {
      // The sheet is fetched from INEC on hosts that hold no local copy, and
      // that can fail. Say so and offer a way past it — telling someone to skip
      // a sheet while giving them no control to do it leaves them stuck on it,
      // and the queue does not release a sheet until it has a final.
      const box = document.createElement('div');
      box.innerHTML = '<p class="status">This sheet could not be loaded from INEC. '
        + 'Nothing has been recorded for it.</p>';
      const retry = document.createElement('button');
      retry.textContent = 'Try again';
      retry.onclick = () => renderRead(cur);
      const skip = document.createElement('button');
      skip.className = 'secondary';
      skip.textContent = 'Skip to the next sheet';
      skip.onclick = () => next();
      box.append(retry, skip);
      el.replaceWith(box);
    }
  }

  /**
   * Running total of the party rows, next to the rows themselves.
   *
   * The EC8A states the same number four times — the party column, the TOTAL
   * VALID VOTES row, box #7, and the words beside each figure — and the audit
   * exists because those four do not always agree. Sheet 29-01-03-003 needed a
   * human to notice its party column said 348, its TOTAL row 347 and box #7
   * 349. Adding up fifteen handwritten numbers is exactly the tedious step
   * where a reviewer's attention is worth least, so the page does it.
   *
   * IT REPORTS, IT DOES NOT CORRECT. Nothing here writes to a field, and a
   * disagreement is stated as a fact rather than an error: a sheet whose own
   * arithmetic does not add up is a FINDING, and quietly nudging the reviewer
   * towards internal consistency would erase the very thing being measured.
   * Box #7 is never auto-filled — the reviewer's independent reading of it is
   * the second opinion that makes the comparison mean anything.
   */
  function updatePartySum() {
    const el = document.getElementById('rv-partysum');
    if (!el) return;
    let sum = 0;
    let filled = 0;
    document.querySelectorAll('#rv-parties input').forEach((i) => {
      const v = i.value.trim();
      if (v === '') return;
      const n = Number(v);
      if (Number.isFinite(n)) { sum += n; filled += 1; }
    });
    const total = document.getElementById('rv-b-totalValid');
    const tv = total && total.value.trim() !== '' ? Number(total.value) : null;

    if (!filled) { el.textContent = ''; return; }
    const rows = `${filled} of ${ballot.length} rows entered — they add up to ${sum}`;
    if (tv == null || !Number.isFinite(tv)) {
      el.textContent = `${rows}.`;
      return;
    }
    if (tv === sum) {
      el.textContent = `${rows}, which matches total valid votes (${tv}).`;
      return;
    }
    const diff = Math.abs(tv - sum);
    const short = filled < ballot.length ? ' Some rows are still blank.' : '';
    el.textContent = `${rows}. Total valid votes says ${tv} — a difference of ${diff}.`
      + `${short} If that is what the sheet says, leave it: a sheet that does not add up is a finding.`;
  }

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (!el || !el.closest) return;
    if (el.closest('#rv-parties') || el.id === 'rv-b-totalValid') updatePartySum();
  });

  function readInputs() {
    const parties = {};
    document.querySelectorAll('#rv-parties input').forEach((el) => {
      const v = el.value.trim();
      if (v !== '') parties[el.dataset.party] = Number(v);
    });
    const boxes = {};
    document.querySelectorAll('#rv-boxes input').forEach((el) => {
      const v = el.value.trim();
      if (v !== '') boxes[el.dataset.box] = Number(v);
    });
    return { parties, boxes };
  }

  const partyRows = (values) => ballot.map((p) => `
    <div class="rv-row">
      <label for="rv-p-${esc(p)}">${esc(p)}</label>
      <input id="rv-p-${esc(p)}" data-party="${esc(p)}" type="number" min="0" max="99999"
             inputmode="numeric" placeholder="—" value="${values && values[p] != null ? values[p] : ''}" />
    </div>`).join('');

  const boxRows = (values) => BOXES.map(([f, label]) => `
    <div class="rv-box">
      <label for="rv-b-${f}">${label}</label>
      <input id="rv-b-${f}" data-box="${f}" type="number" min="0" max="9999"
             inputmode="numeric" placeholder="—" value="${values && values[f] != null ? values[f] : ''}" />
    </div>`).join('');

  // ── step 1: read the sheet, with nothing else on the page ────────────────
  function renderRead(item) {
    blind = null;
    startedAt = Date.now();
    $('rv-work').hidden = false;
    $('rv-work').innerHTML = `
      <div class="card">
        <h3>${esc(item.name || item.key)}</h3>
        <p class="rv-meta">${esc(item.key)} &middot; ${esc(item.ward)} ward &middot; ${esc(item.lga)} LGA</p>
        <img class="rv-sheet rv-zoom" id="rv-img" alt="EC8A sheet for ${esc(item.key)}" />
        <p class="hint">Tap the sheet to open it full size in a new tab.</p>
      </div>
      <div class="card">
        <h3>What does the sheet say?</h3>
        <p class="hint">Enter every party row you can read, including zeros. Leave a row blank
        only if it genuinely cannot be read — blank means "unreadable", not "zero".</p>
        <div class="rv-grid" id="rv-parties">${partyRows(null)}</div>
        <p class="hint" id="rv-partysum" aria-live="polite"></p>
        <h3 style="margin-top:18px">Summary boxes</h3>
        <div class="rv-grid" id="rv-boxes">${boxRows(null)}</div>
        <p style="margin-top:14px">
          <label><input type="checkbox" id="rv-complete" /> I read every row on this sheet</label>
        </p>
        <button id="rv-submit">Submit my reading</button>
        <button id="rv-unreadable" class="secondary">This sheet cannot be read</button>
        <p class="hint">Your reading is locked once submitted — that is what makes the
        comparison meaningful. Take the time you need.</p>
      </div>`;

    loadSheet(item.key);
    updatePartySum();
    $('rv-submit').onclick = () => commitBlind(false);
    $('rv-unreadable').onclick = () => {
      if (window.confirm('Record this sheet as impossible to read? This is a finding in its own right.')) {
        commitBlind(true);
      }
    };
  }

  async function commitBlind(unreadable) {
    const { parties, boxes } = readInputs();
    if (!unreadable && !Object.keys(parties).length && !Object.keys(boxes).length) {
      $('rv-msg').textContent = 'Enter at least one figure, or mark the sheet unreadable.';
      return;
    }
    $('rv-submit').disabled = true;
    $('rv-msg').textContent = 'Locking your reading…';
    const r = await api('/api/training/review/blind', {
      method: 'POST',
      body: JSON.stringify({
        key: cur.key,
        parties,
        boxes,
        complete: $('rv-complete').checked,
        unreadable,
        ms: Date.now() - startedAt,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      $('rv-submit').disabled = false;
      if (j.error === 'blind_already_committed') {
        // A reading was locked in an earlier session that ended before the final
        // — a reload, a locked phone, a failed reveal. Without this the sheet is
        // served as a fresh READ card forever, every resubmit 409s, and because
        // the queue only drops a sheet once it has a FINAL, the reviewer's whole
        // set is wedged behind it. Resuming releases nothing new: the reading is
        // already frozen and the server hands it back to us.
        $('rv-msg').textContent = 'You already locked a reading for this sheet — picking up where you left off.';
        await revealAndCompare();
        return;
      }
      if (j.error === 'out_of_range') {
        $('rv-msg').textContent = `Check these figures: ${(j.fields || []).join(', ')}. `
          + 'Nothing has been saved yet.';
        return;
      }
      $('rv-msg').textContent = 'Could not save — are you still signed in?';
      return;
    }
    blind = { parties, boxes, unreadable, complete: $('rv-complete').checked };
    $('rv-msg').textContent = '';
    await revealAndCompare();
  }

  // ── step 2: now, and only now, the machine's reading ────────────────────
  async function revealAndCompare() {
    const r = await api('/api/training/review/pred/' + encodeURIComponent(cur.key));
    if (!r.ok) { $('rv-msg').textContent = 'Could not load the comparison.'; return; }
    const d = await r.json();
    // Take the STORED reading as the source of truth, not our local copy. It is
    // what the agreement will actually be computed against, it survives a
    // reload, and it reflects exactly what the server accepted — so what the
    // reviewer sees at the compare step cannot drift from what was recorded.
    if (d.blind) blind = d.blind;
    if (!blind) { $('rv-msg').textContent = 'Could not load your locked reading for this sheet.'; return; }
    renderCompare(d.prediction, d.triage);
  }

  function renderCompare(pred, triage) {
    const machine = {};
    const unreadByMachine = new Set();
    (pred.parties || []).forEach((row) => {
      if (!row.party) return;
      if (row.value == null) unreadByMachine.add(row.party);
      else machine[row.party] = row.value;
    });

    const rows = ballot.map((p) => {
      const m = machine[p];
      const h = blind.parties[p];
      let cls = ''; let tag = '';
      if (m != null && h != null && m !== h) { cls = 'rv-differ'; tag = 'differs'; }
      else if (m == null && h != null) {
        cls = 'rv-added';
        tag = unreadByMachine.has(p) ? 'you read what it could not' : 'not read by machine';
      } else if (m != null && h == null) { cls = 'rv-differ'; tag = 'you left blank'; }
      return `<tr class="${cls}">
          <td><strong>${esc(p)}</strong></td>
          <td class="num">${h == null ? '—' : h}</td>
          <td class="num">${m == null ? '—' : m}</td>
          <td>${tag ? `<span class="rv-tag">${tag}</span>` : ''}</td>
        </tr>`;
    }).join('');

    // Counted the same three ways the server stores them. Calling a row you
    // simply left blank a "disagreement" would push you to resolve it by
    // copying the machine's number, which is the one thing this flow exists to
    // stop.
    let nDiffer = 0; let nBlank = 0; let nRecovered = 0;
    ballot.forEach((p) => {
      const m = machine[p]; const h = blind.parties[p];
      if (m != null && h != null) { if (m !== h) nDiffer += 1; } else if (m != null) nBlank += 1;
      else if (h != null) nRecovered += 1;
    });
    const say = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const parts = [];
    if (nDiffer) parts.push(`${say(nDiffer, 'row', 'rows')} where you and the machine both read a number and they differ`);
    if (nRecovered) parts.push(`${say(nRecovered, 'row', 'rows')} you read that the machine could not`);
    if (nBlank) parts.push(`${say(nBlank, 'row', 'rows')} you left blank`);
    const summary = parts.length
      ? `${parts.join(', ')}. Nothing here has to change — a blank you meant is as valid as a number.`
      : 'You agree on every row you both read.';

    $('rv-work').innerHTML = `
      <div class="card">
        <h3>${esc(cur.name || cur.key)}</h3>
        <p class="rv-meta">${esc(cur.key)} &middot; ${esc(cur.ward)} ward &middot; ${esc(cur.lga)} LGA</p>
        <img class="rv-sheet rv-zoom" id="rv-img" alt="EC8A sheet for ${esc(cur.key)}" />
      </div>
      <div class="card">
        <h3>Your reading against the machine's</h3>
        <p class="hint">${summary}</p>
        <table class="rv-cmp">
          <thead><tr><th>Party</th><th class="num">You</th><th class="num">Machine</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="hint" style="margin-top:10px">Why this sheet was flagged:
          <strong>${esc(triage && triage.why ? triage.why : 'unspecified')}</strong></p>
      </div>
      <div class="card">
        <h3>Your final answer</h3>
        <p class="hint">Pre-filled with <em>your</em> reading. Change a figure only if the
        comparison has genuinely convinced you that you misread it.</p>
        <div class="rv-grid" id="rv-parties">${partyRows(blind.parties)}</div>
        <p class="hint" id="rv-partysum" aria-live="polite"></p>
        <h3 style="margin-top:18px">Summary boxes</h3>
        <div class="rv-grid" id="rv-boxes">${boxRows(blind.boxes)}</div>
        <p style="margin-top:14px">
          <label><input type="checkbox" id="rv-complete" ${blind.complete ? 'checked' : ''} /> I read every row on this sheet</label>
        </p>
        <p><input id="rv-note" placeholder="Anything the numbers do not capture (optional)" style="width:100%" /></p>
        <button id="rv-final">Confirm and go to next sheet</button>
        <p id="rv-msg2" class="status"></p>
      </div>`;

    loadSheet(cur.key);
    updatePartySum();
    $('rv-final').onclick = submitFinal;
  }

  async function submitFinal() {
    const { parties, boxes } = readInputs();
    $('rv-final').disabled = true;
    $('rv-msg2').textContent = 'Saving…';
    const r = await api('/api/training/review/final', {
      method: 'POST',
      body: JSON.stringify({
        key: cur.key,
        parties,
        boxes,
        complete: $('rv-complete').checked,
        unreadable: Boolean(blind.unreadable),
        note: $('rv-note').value,
      }),
    });
    if (!r.ok) {
      $('rv-final').disabled = false;
      $('rv-msg2').textContent = 'Could not save — are you still signed in?';
      return;
    }
    await loadQueue();
    next();
  }

  // ── queue ───────────────────────────────────────────────────────────────
  async function loadQueue() {
    const r = await api('/api/training/review/queue?set=' + SET + '&limit=25');
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.you) {
        // Reviewing is restricted to named people. Say who you are and exactly
        // what unlocks it — a bare 403 leaves no way to discover the id you
        // would need to be added under.
        $('rv-progress').innerHTML = `You are observer <strong>${Number(j.you)}</strong>, `
          + 'who is not on the reviewer list for the flagged-sheet audit.'
          + `<br><span class="hint">An admin adds you with: <code>node backend/scripts/reviewers.mjs add ${Number(j.you)}</code></span>`
          + '<br><span class="hint">Then re-open this tab — no reload needed.</span>';
        return false;
      }
      $('rv-progress').textContent = 'Sign in as a verified observer to review sheets.';
      return false;
    }
    const d = await r.json();
    ballot = d.ballot || [];
    queue = d.items || [];
    $('rv-progress').textContent =
      `${d.mineDone} of ${d.mineTotal} in your set reviewed · ${d.doneAll} of ${d.total} flagged sheets done overall`;
    return true;
  }

  function next() {
    cur = queue.shift();
    if (!cur) {
      $('rv-work').hidden = true;
      $('rv-msg').textContent = 'Nothing left in your set. Thank you — that is the whole queue.';
      return;
    }
    $('rv-msg').textContent = '';
    if (cur.resume) {
      // A reading was locked here in an earlier session. Go straight to the
      // comparison rather than asking them to read the sheet a second time —
      // their answer is already frozen, so nothing is at risk.
      blind = null;
      $('rv-work').hidden = false;
      $('rv-work').innerHTML = '<div class="card"><p class="hint">Picking up your locked reading…</p></div>';
      revealAndCompare();
      return;
    }
    renderRead(cur);
  }

  // Started on first switch to the review tab, not on page load: most visits to
  // these pages are for labelling, and the queue fetch would be wasted.
  let started = false;
  let starting = false;
  window.HawkeyeReview = {
    async start() {
      // `started` is set only once the queue actually loads. A refusal — not yet
      // on the reviewer list, signed out — must stay retryable: the reviewer is
      // told exactly what unlocks it, and once someone does, re-opening the tab
      // should work without a page reload. `starting` guards a double-click.
      if (started || starting) return;
      starting = true;
      try {
        if (!token) {
          $('rv-progress').textContent = 'Sign in as a verified observer to review sheets.';
          return;
        }
        if (!await loadQueue()) return;
        started = true;
        next();
      } finally {
        starting = false;
      }
    },
  };

  // ── row mode: show the row you are typing, not the whole sheet ───────────
  //
  // The tier-A pile scales to ~73,000 sheets for 2027 against a pipeline that
  // has processed 490 — about 2,400 hours at two minutes a sheet. Those 490
  // carry only 751 actually-disputed cells, so a reviewer is scanning a whole
  // form to answer one question about one number. This puts the row beside the
  // box they are typing into: a band is ~13% of the image.
  //
  // AN ADDITION, NOT A REPLACEMENT. The full sheet stays exactly where it was.
  // Everything here is driven by focus, so the existing keyboard flow is already
  // the interaction — Tab moves down the ballot and the band follows. Nothing
  // about reading, committing or the blind/compare ceremony changes, and if the
  // band fails to load the page is precisely what it was before.
  //
  // THE BAND CARRIES THE PARTY NAME, by construction on the server. These are
  // photographs of paper on a desk and the framing moves; a reviewer confidently
  // reading the wrong row produces a correction that is trusted and never
  // checked again. Seeing the party name in the crop is how they catch it.
  // TWO BANDS, ONE MECHANISM. The party rows get a per-row crop; the summary
  // boxes get the whole #1-#8 block. The asymmetry is on the server and is
  // deliberate — services/ec8a_cell_crop.js explains it — but from here they are
  // the same thing: focus a field, see the part of the sheet it came from.
  //
  // ONLY ONE IS EVER VISIBLE. Both grids sit inside the SAME `.card`, so two
  // `position:sticky` wraps would share a containing block and pin on top of
  // each other at the top of the viewport. Showing a band hides the other.
  //
  // THE BOXES BAND IS MUCH TALLER than the parties band — one is the whole
  // #1-#8 block, the other a ~13% strip — so it is capped in CSS and the fields
  // carry a matching scroll-margin. Without both it sat over the first two
  // inputs while they were focused.
  const BANDS = {
    parties: { grid: 'rv-parties', wrap: 'rv-band-wrap', img: 'rv-band', label: 'rv-band-label' },
    boxes: { grid: 'rv-boxes', wrap: 'rv-boxband-wrap', img: 'rv-boxband', label: 'rv-boxband-label' },
  };
  const bandState = { parties: { url: null, at: null }, boxes: { url: null, at: null } };

  function bandEl(slot) {
    const ids = BANDS[slot];
    let el = document.getElementById(ids.img);
    if (el) return el;
    const grid = document.getElementById(ids.grid);
    if (!grid) return null;
    const wrap = document.createElement('div');
    wrap.id = ids.wrap;
    wrap.style.cssText = 'margin:0 0 10px;position:sticky;top:0;z-index:2;background:var(--card,#fff)';
    wrap.innerHTML = '<p class="status" id="' + ids.label + '" style="margin:0 0 4px"></p>'
      + '<img id="' + ids.img + '" alt="" style="width:100%;display:block;border-radius:6px" />';
    grid.parentNode.insertBefore(wrap, grid);
    return document.getElementById(ids.img);
  }

  function hideBand(slot) {
    const wrap = document.getElementById(BANDS[slot].wrap);
    if (wrap) wrap.hidden = true;
  }

  /**
   * `at` is whatever identifies the crop currently shown in this slot, so a
   * refocus does not refetch: the row index for parties, the sheet key fo
   * boxes (there is one block per sheet, not one per field).
   */
  async function showBand(slot, key, at, url, label) {
    const el = bandEl(slot);
    const st = bandState[slot];
    if (!el) return;
    // Hide the other band FIRST, so a slow fetch cannot leave both on screen.
    Object.keys(BANDS).forEach((s) => { if (s !== slot) hideBand(s); });
    if (st.at === key + ':' + at) {
      const wrap = document.getElementById(BANDS[slot].wrap);
      if (wrap) wrap.hidden = false;
      return;
    }
    st.at = key + ':' + at;
    try {
      const r = await api(url);
      if (!r.ok) throw new Error('status ' + r.status);
      if (st.url) URL.revokeObjectURL(st.url);
      st.url = URL.createObjectURL(await r.blob());
      el.src = st.url;
      const lab = document.getElementById(BANDS[slot].label);
      if (lab) lab.textContent = label;
      const wrap = document.getElementById(BANDS[slot].wrap);
      if (wrap) wrap.hidden = false;
    } catch (e) {
      // A band is an accelerator. If it cannot load — the sheet is not cached on
      // this host yet, or the crop failed — hide it and leave the reviewer the
      // full sheet they have always had. Never block the reading on it.
      st.at = null;
      hideBand(slot);
    }
  }

  document.addEventListener('focusin', (ev) => {
    const el = ev.target;
    if (!el || !el.dataset || !el.closest) return;
    // cur and ballot are declared at the top of this IIFE; no sheet is loaded
    // until the reviewer starts one, so both are legitimately null before then.
    const key = cur && cur.key;
    if (!key) return;

    if (el.dataset.party && el.closest('#rv-parties')) {
      const idx = ballot.indexOf(el.dataset.party);
      if (idx >= 0) {
        showBand('parties', key, idx,
          '/api/training/review/row/' + encodeURIComponent(key) + '/' + idx,
          el.dataset.party + ' — row ' + (idx + 1) + '. Check the name in the crop matches.');
      }
      return;
    }

    if (el.dataset.box && el.closest('#rv-boxes')) {
      // One crop for the whole block, keyed on the sheet: every box field shows
      // the same image, so moving between them costs nothing after the first.
      // The printed labels are inside the crop — that is how the reviewer knows
      // which box they are on, the same self-check the party name provides.
      showBand('boxes', key, 'block',
        '/api/training/review/boxes/' + encodeURIComponent(key),
        'Summary boxes, as the machine read them. Match the printed label beside each number.');
    }
  });

  // Enter walks down the fields instead of submitting, so the whole reading is
  // one uninterrupted keyboard pass and the band follows without a mouse. It
  // walks WITHIN a grid: running off the end of the parties into the boxes would
  // move the reviewer to a different part of the sheet without them asking.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const el = ev.target;
    if (!el || !el.dataset || !el.closest) return;
    const grid = (el.dataset.party && el.closest('#rv-parties'))
      || (el.dataset.box && el.closest('#rv-boxes'));
    if (!grid) return;
    const inputs = [].slice.call(grid.querySelectorAll('input'));
    const at = inputs.indexOf(el);
    if (at > -1 && at + 1 < inputs.length) { ev.preventDefault(); inputs[at + 1].focus(); }
  });

}());

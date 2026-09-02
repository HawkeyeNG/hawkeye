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
      el.replaceWith(Object.assign(document.createElement('p'), {
        className: 'status',
        textContent: 'The sheet image could not be loaded. Skip this one and tell the team.',
      }));
    }
  }

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
}());

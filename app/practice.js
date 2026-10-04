// Practice / mock-election sandbox — a self-contained teaching flow. It never
// calls the real /api/submissions, never signs, never touches the ledger. The
// only write is POST /api/practice/submit (the practice chain); the reads are
// GET /api/practice (config) and, for step 2, the same read-only unit lookups
// the real report uses (near me, search). No sign-in required.
//
// THE SAME FIVE STEPS AS observe.html (flow walkthrough REP-PRAC-01): capture,
// which polling unit, which election, counts + Verify counts, sign. The fold
// and lock rules are app.js's (stepLock / setStepDone), ported rather than
// shared — app.js is the whole observer app, sign-in included.
(function () {
  /* Same helper as app.js: the English literal stays in the source, so this
     file still reads as English and still renders with no bundle loaded. */
  function T(key, english, params) {
    const s = String(window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english);
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
  }
  /* Text written into an element that carries its own data-i18n: the key moves
     with it, because menu.js re-runs apply() on every language change and
     would otherwise put the markup's original words back. The ENGLISH goes in
     and apply() translates it: apply() remembers the first text it sees under a
     key as that key's English, so writing the translation directly would make
     it the "English" that a switch back to English restores. */
  function keyed(el, key, english) {
    if (!el) return;
    el.setAttribute('data-i18n', key);
    el.textContent = english;
    if (window.HawkeyeI18n && el.parentNode) window.HawkeyeI18n.apply(el.parentNode);
  }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* THE SAMPLE SPEAKS THE READER'S LANGUAGE (first-time walkthrough #6).
     backend/src/data/practice.json names its stand-in election, office, unit,
     ward, LGA, state and parties in English, and they reached a Hausa reader
     as sent. They are the SAMPLE's own words, not register data, so each known
     value has a key — resolved when painted, and repainted on 'hawkeye-lang'.
     Anything else (a future config, a real unit) is shown exactly as sent. The
     server and the practice chain keep the English: only the screen changes. */
  const SAMPLE = {
    '2027 Practice Election': ['practice.sample-election', '2027 Practice Election'],
    '2027 Presidential': ['practice.sample-office', '2027 Presidential'],
    'Practice Polling Unit': ['practice.practice-polling-unit', 'Practice Polling Unit'],
    'Demo Ward': ['practice.sample-ward', 'Demo Ward'],
    'Demo LGA': ['practice.sample-lga', 'Demo LGA'],
    Practice: ['practice.sample-state', 'Practice'],
  };
  const sample = (v) => (Object.prototype.hasOwnProperty.call(SAMPLE, v) ? T(SAMPLE[v][0], SAMPLE[v][1]) : v);
  /* "Party A" … "Party F": the letter is the name, the word is translated. The
     submitted vote keeps the code ("Party A") — that is what the chain stores. */
  const partyLabel = (code) => {
    const m = /^Party ([A-Z])$/.exec(String(code || ''));
    return m ? T('practice.party-letter', 'Party {v0}', { v0: m[1] }) : String(code || '');
  };
  const shots = { sheet: false, venue: false };
  // The photo behind each slot — a Blob from the app's scanner/camera or the
  // in-page camera's data URL. A skipped slot has none, and saves nothing.
  const photos = { sheet: null, venue: null };
  let PARTIES = [];
  let UNIT_CODE = null;
  let UNIT_NAME = null;
  // The finished run, kept so the done screen can repaint in another language.
  let lastVotes = null;
  let lastEntryHash = '';
  let receiptAt = 0;

  /* The practice card, drawn in the CURRENT language. Called once when the run
     is recorded and again on every language change (the image is pixels — no
     data-i18n reaches it). Returns the canvas, or null with no renderer. */
  async function paintReceipt() {
    const R = window.HAWKEYE_RECEIPT;
    if (!R || !lastVotes) return null;
    const canvas = R.render({
      puName: $('prac-unit-name').textContent,
      puCode: UNIT_CODE,
      contest: T('practice.practice-run', 'Practice run'),
      votes: lastVotes.map((v) => ({ ...v, party: partyLabel(v.party) })),
      entryHash: lastEntryHash,
      practice: true,
      at: receiptAt || Date.now(),
    }, await R.loadLogo(), T);
    $('receipt-img').src = canvas.toDataURL('image/png');
    $('receipt-wrap').hidden = false;
    return canvas;
  }

  // ---- the step cards: same lock and fold as app.js ----
  const STEP_FOLDS = ['photo-fold', 'unit-fold', 'race-fold', 'counts-fold'];
  const stepDone = [false, false, false, false];
  STEP_FOLDS.forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('toggle', () => { if (el.open && el.classList.contains('locked')) el.open = false; });
  });
  function stepLock() {
    STEP_FOLDS.forEach((id, i) => {
      const el = $(id);
      if (!el) return;
      const reachable = i === 0 || stepDone[i - 1];
      el.classList.toggle('locked', !reachable);
      el.classList.toggle('done', stepDone[i]);
      if (!reachable && el.open) el.open = false;
    });
  }
  /** Mark a step confirmed (or not), fold it, and open the next unlocked one. */
  function setStepDone(i, done, label) {
    const was = stepDone[i];
    stepDone[i] = done;
    if (!done) for (let j = i + 1; j < stepDone.length; j++) stepDone[j] = false;
    const state = $(`${STEP_FOLDS[i]}-state`);
    if (state) state.textContent = done ? (label || '✔') : '';
    const el = $(STEP_FOLDS[i]);
    if (done && !was && el) {
      el.open = false;
      const next = $(STEP_FOLDS[i + 1]);
      if (next) {
        next.open = true;
        requestAnimationFrame(() => next.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    }
    stepLock();
    refreshSubmit();
  }

  function refreshSubmit() {
    $('btn-submit').disabled = !(shots.sheet && shots.venue && stepDone.every(Boolean));
  }
  function markSlot(slot) {
    shots[slot] = true;
    const badge = $(`status-${slot}`);
    keyed(badge, 'common.captured', 'Captured ✔');
    badge.classList.add('done');
    // Step 1's confirmer is the second photo, as in the real report.
    if (shots.sheet && shots.venue && !stepDone[0]) setStepDone(0, true, '✔ ' + T('report.both-captured', 'Both captured'));
    refreshSubmit();
  }

  // ---- step 2: which polling unit ----
  /* The chosen unit: a real register row (practice accepts a real code as a
     plain string — it is never joined to the register), or the sample unit.
     null until the observer picks one, exactly like the real step. */
  let CHOSEN = null;
  let CFG_UNIT = {};
  function paintFacts() {
    const box = $('submit-facts');
    if (!box) return;
    if (!CHOSEN) { box.hidden = true; return; }
    if (CHOSEN.practice) {
      if (UNIT_NAME && !Object.prototype.hasOwnProperty.call(SAMPLE, UNIT_NAME)) {
        $('prac-unit-name').removeAttribute('data-i18n');
        $('prac-unit-name').textContent = UNIT_NAME;
      } else keyed($('prac-unit-name'), 'practice.practice-polling-unit', 'Practice Polling Unit');
      $('prac-unit-scope').textContent = [CFG_UNIT.ward, CFG_UNIT.lga, CFG_UNIT.state].filter(Boolean).map(sample).join(', ');
    } else {
      // Register data, not UI: the unit's own name, never a key.
      $('prac-unit-name').removeAttribute('data-i18n');
      $('prac-unit-name').textContent = CHOSEN.name || CHOSEN.code;
      $('prac-unit-scope').textContent = [CHOSEN.ward, CHOSEN.lga, CHOSEN.state].filter(Boolean).join(', ');
    }
    const sel = $('sel-contest');
    $('prac-race').textContent = sel && sel.value ? (sel.options[sel.selectedIndex] || {}).textContent || '' : '';
    box.hidden = false;
  }
  function chooseUnit(u, isPractice) {
    const next = isPractice
      ? { practice: true, code: CFG_UNIT.code || null, name: CFG_UNIT.name || null, state: CFG_UNIT.state || '' }
      : { practice: false, code: u.pu_code || u.puCode || u.code, name: u.name, ward: u.ward || '', lga: u.lga || '', state: u.state || '' };
    const changed = !CHOSEN || CHOSEN.code !== next.code || CHOSEN.practice !== next.practice;
    CHOSEN = next;
    UNIT_CODE = next.code;
    if (!isPractice) UNIT_NAME = next.name;
    else UNIT_NAME = CFG_UNIT.name || null;
    // A different unit can hold different races, and counts belong to a race.
    if (changed) { stepDone[2] = false; stepDone[3] = false; $('race-fold-state').textContent = ''; $('counts-fold-state').textContent = ''; }
    fillRaces();
    paintFacts();
    stepDone[1] = false; // force the fold/advance, as app.js does
    setStepDone(1, true, `✔ ${isPractice ? $('prac-unit-name').textContent : next.name || next.code}`);
  }
  $('btn-prac-unit').onclick = () => chooseUnit(null, true);

  /* Near me: the real step's two lookups, read-only. Every failure ends on a
     line and the other two ways in, never a status that just stops. */
  $('btn-locate').onclick = async () => {
    const say = (m) => { $('locate-status').textContent = m; };
    $('pu-list').innerHTML = '';
    if (!navigator.geolocation) { say(T('observe.could-not-check-nearby-units-search-by', 'Could not check nearby units. Search by name below.')); return; }
    say(T('observe.getting-your-location', 'Getting your location…'));
    let pos;
    try {
      pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }));
    } catch (err) {
      say(window.HAWKEYE_GEO && window.HAWKEYE_GEO.line ? window.HAWKEYE_GEO.line(err) : T('observe.could-not-check-nearby-units-search-by', 'Could not check nearby units. Search by name below.'));
      return;
    }
    const { latitude: lat, longitude: lng } = pos.coords;
    const get = (p) => fetch(p).then((r) => r.json()).catch(() => null);
    const [reg, near] = await Promise.all([
      get(`/api/polling-units?lat=${lat}&lng=${lng}`),
      get(`/api/mapping/nearby?lat=${lat}&lng=${lng}&radiusM=800`),
    ]);
    if (!reg && !near) {
      say(navigator.onLine
        ? T('observe.could-not-check-nearby-units-search-by', 'Could not check nearby units. Search by name below.')
        : T('observe.near-me-offline', 'No connection for near me. Search or browse the register below.'));
      return;
    }
    const rows = [];
    const seen = new Set();
    for (const u of [...((reg && reg.units) || []), ...((near && near.units) || [])]) {
      const code = u.pu_code || u.puCode || u.code;
      if (!code || seen.has(code)) continue;
      seen.add(code);
      rows.push({ ...u, pu_code: code, ward: u.ward || '', lga: u.lga || '', state: u.state || '' });
    }
    rows.sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
    if (!rows.length) { say(T('practice.no-units-near', 'No units found near you. Search below, or use the practice unit.')); return; }
    say(T('observe.select-the-unit-you-are-standing-at', 'Select the unit you are standing at:'));
    for (const u of rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pu-option';
      const name = document.createElement('strong');
      name.textContent = u.name || u.pu_code;
      const sub = document.createElement('small');
      sub.textContent = [u.pu_code, [u.ward, u.lga].filter(Boolean).join(', '),
        u.distanceM != null ? T('common.m-away', '{v0} m away', { v0: u.distanceM }) : ''].filter(Boolean).join(' · ');
      b.append(name, document.createElement('br'), sub);
      b.onclick = () => chooseUnit(u, false);
      $('pu-list').appendChild(b);
    }
    keyed($('btn-locate'), 'observe.search-near-me-again', 'Search Near Me Again');
  };

  // ---- step 3: which election ----
  /* Every race is open in practice (the chain takes any code), so the list is
     the real five, scoped to the unit the way the server scopes it — the FCT
     has no governorship and no state assembly. */
  const RACES_FALLBACK = [
    { code: 'PRES', name: 'Presidency', key: 'race.presidency' },
    { code: 'GOV', name: 'Governorship', key: 'race.governorship' },
    { code: 'SEN', name: 'Senate', key: 'race.senate' },
    { code: 'REP', name: 'House of Reps', key: 'race.house-of-reps' },
    { code: 'SHA', name: 'State Assembly', key: 'race.state-assembly' },
  ];
  function fillRaces() {
    const sel = $('sel-contest');
    if (!sel) return;
    const prev = sel.value;
    const order = (window.HAWKEYE_RACES && window.HAWKEYE_RACES.ORDER) || RACES_FALLBACK;
    const fct = CHOSEN && !CHOSEN.practice && CHOSEN.state === 'FCT';
    const list = order.filter((r) => !(fct && (r.code === 'GOV' || r.code === 'SHA')));
    sel.innerHTML = `<option value="">${esc(T('race.select-election', '— select election —'))}</option>`
      + list.map((r) => `<option value="${esc(r.code)}">${esc(T(r.key, r.name))}</option>`).join('');
    if (prev && list.some((r) => r.code === prev)) sel.value = prev;
  }
  $('sel-contest').onchange = () => {
    const sel = $('sel-contest');
    const label = sel.value ? (sel.options[sel.selectedIndex] || {}).textContent || '' : '';
    setStepDone(2, Boolean(sel.value), `✔ ${label}`);
    paintFacts();
  };

  // ---- step 4: counts — "Verify counts" is the confirmer, as in the real flow ----
  $('btn-verify-counts').onclick = () => {
    const n = [...document.querySelectorAll('#vote-inputs input')]
      .filter((i) => i.value !== '' && Number(i.value) >= 0).length;
    if (!n) {
      if (window.HAWKEYE_ALERT) {
        window.HAWKEYE_ALERT(T('observe.no-counts-entered', 'No counts entered'),
          T('observe.no-counts-entered-body', 'Type the votes each party was announced to have, then tap Verify counts again.'));
      } else $('submit-status').textContent = T('observe.enter-at-least-one-party-count', 'Enter at least one party count.');
      return;
    }
    $('submit-status').textContent = '';
    setStepDone(3, true, n === 1
      ? T('observe.one-party-entered', '✔ 1 party entered')
      : T('collation.parties-entered', '✔ {v0} parties entered', { v0: n }));
  };

  // ---- lightweight camera (practice only; no GPS, no upload) ----
  let stream = null; let target = null;
  async function openCamera(which) {
    target = which;
    // App shell: capture natively — the SHEET runs through the ML Kit document
    // scanner (live edge detection, auto-capture, perspective correction and
    // on-device OCR), the same scan the real report flow uses; the VENUE uses the
    // OS camera. This is the "scan" practice was missing in the APK. On the web
    // (no capturePhoto) it falls through to the in-page getUserMedia camera below.
    if (window.HAWKEYE && typeof window.HAWKEYE.capturePhoto === 'function') {
      try {
        const blob = await window.HAWKEYE.capturePhoto(which);
        const img = $(`preview-${which}`);
        img.src = URL.createObjectURL(blob);
        img.hidden = false;
        photos[which] = blob;
        markSlot(which);
      } catch (e) {
        /* user backed out of the scanner/camera — leave the slot unchanged */
      }
      return;
    }
    if (which === 'sheet') keyed($('camera-title'), 'observe.results-sheet-ec8a', 'Results sheet (EC8A)');
    else keyed($('camera-title'), 'observe.polling-venue', 'Polling venue');
    const guide = $('camera-guide');
    if (guide) {
      guide.textContent = which === 'venue'
        ? T('observe.venue-guide', '📸 VENUE PHOTO — aim at the polling unit itself: the building, booth, banner or the crowd around it. This is NOT the results sheet.')
        : '';
      guide.hidden = which !== 'venue';
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      // No camera / denied — in practice that's fine, just mark it done.
      hkAlert(T('practice.no-camera-sample-photo', 'No camera available — using a sample photo for practice.'));
      markSlot(which);
      return;
    }
    $('camera-overlay').hidden = false;
    const v = $('video'); v.srcObject = stream; await v.play();
  }
  function closeCamera() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    $('camera-overlay').hidden = true;
  }
  function capture() {
    const v = $('video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 640; c.height = v.videoHeight || 480;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const img = $(`preview-${target}`);
    img.src = c.toDataURL('image/jpeg', 0.6); img.hidden = false;
    photos[target] = img.src;
    markSlot(target);
    closeCamera();
  }
  $('btn-cam-sheet').onclick = () => openCamera('sheet');
  $('btn-cam-venue').onclick = () => openCamera('venue');
  $('btn-skip-sheet').onclick = (e) => { e.preventDefault(); markSlot('sheet'); };
  $('btn-skip-venue').onclick = (e) => { e.preventDefault(); markSlot('venue'); };
  $('btn-capture').onclick = capture;
  $('btn-cancel-camera').onclick = closeCamera;

  // ---- submit ----
  $('btn-submit').onclick = async () => {
    const votes = [...document.querySelectorAll('#vote-inputs input')]
      .map((i) => ({ party: i.dataset.party, count: Number(i.value || 0) }))
      .filter((v) => Number.isInteger(v.count) && v.count >= 0);
    $('btn-submit').disabled = true;
    $('submit-status').textContent = T('practice.recording-your-practice-run', 'Recording your practice run…');
    try {
      const r = await fetch('/api/practice/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': await getDeviceId() },
        // The server's own name, never the translated label on screen. The
        // race goes too, as the real report sends it: a plain string on the
        // practice chain, never joined to anything.
        body: JSON.stringify({
          votes,
          puName: UNIT_NAME || $('prac-unit-name').textContent,
          puCode: UNIT_CODE,
          ...($('sel-contest').value ? { contest: $('sel-contest').value } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        $('submit-status').textContent = d.error === 'practice_closed'
          ? T('practice.just-closed-refresh', 'Practice has just closed — refresh the page.')
          : T('assistant.error', 'Something went wrong — try again.');
        $('btn-submit').disabled = false;
        return;
      }
      $('entry-hash').textContent = d.entryHash || '';
      lastVotes = votes;
      lastEntryHash = d.entryHash || '';
      // Device copies of the practice photos (save-media.js), once the run is recorded.
      if (window.HAWKEYE_SAVE_MEDIA) {
        window.HAWKEYE_SAVE_MEDIA(['sheet', 'venue'].filter((s) => photos[s]).map((s) => ({ blob: photos[s], kind: 'photo' })), 'practice');
      }
      /* THE CARD, in its practice state. Same renderer as the real flow — a
         separate "practice-looking" card would teach the wrong picture. */
      receiptAt = Date.now();
      (async () => {
        try {
          const canvas = await paintReceipt();
          if (!canvas) return;
          /* IT SAVES WITH THE PHOTOS, like a real report's card and under the
             same switch. The practice photos above already copy themselves, so
             leaving the card out made it the one artefact that behaved
             differently on the run whose whole job is to behave the same.
             The card says PRACTICE twice, so the copy cannot pass for a
             result. */
          /* })(), not }()). An arrow function cannot be invoked from inside
             its own wrapping parens the way a function expression can, and the
             SyntaxError kills the entire file — the practice screen rendered
             blank on the website and in Lite until this was spotted. */
          const on = (() => {
            try { return localStorage.getItem('hawkeye_save_media') !== '0'; } catch { return true; }
          })();
          if (on && window.HAWKEYE_SAVE_MEDIA) {
            const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
            if (blob) window.HAWKEYE_SAVE_MEDIA([{ blob: blob, kind: 'photo' }], 'practice-card');
          }
          // keyed(), not textContent: the note carries its key, so a language
          // switch on this screen moves it with everything else.
          if (on) {
            keyed($('receipt-note'), 'practice.card-note-saved',
              'Saved to your phone with your practice photos. On a real report this is yours to keep and send on \u2014 nothing here is counted.');
          } else {
            keyed($('receipt-note'), 'practice.card-note',
              'On a real report this is yours to keep and send on. Nothing here is counted.');
          }
        } catch { /* the practice run is not worth failing over a picture */ }
      })();
      renderPreview(votes);
      $('flow').hidden = true;
      $('done').hidden = false;
      window.scrollTo(0, 0);
    } catch {
      $('submit-status').textContent = T('observe.network-problem-check-your-connection-and-try', 'Network problem — check your connection and try again.');
      $('btn-submit').disabled = false;
    }
  };
  $('btn-again').onclick = () => location.reload();

  /**
   * Fill the public-card preview from what is already on this page. The sheet
   * image is the one in #preview-sheet — an object URL from the app's scanner
   * or a data URL from the in-page camera — so nothing is fetched and nothing
   * is sent. No link to open it full size: a new tab refuses a data: URL, and a
   * Capacitor WebView has no tab to open, so a link would work nowhere.
   */
  function renderPreview(votes) {
    const img = $('preview-sheet');
    const src = img && !img.hidden ? (img.getAttribute('src') || '') : '';
    $('pv-name').textContent = $('prac-unit-name').textContent;
    // Exactly the real card's shape: "[CONTEST] code · ward, lga, state".
    const scope = $('prac-unit-scope').textContent;
    $('pv-meta').textContent = `[${T('practice.practice-2', 'PRACTICE')}]${UNIT_CODE ? ` ${UNIT_CODE}` : ''}${scope ? ` · ${scope}` : ''}`;
    $('pv-votes').textContent = votes.filter((v) => v.count > 0).map((v) => `${partyLabel(v.party)} ${v.count}`).join(' · ') || T('practice.all-zero', 'all zero');
    const strip = $('pv-sheets');
    strip.textContent = '';
    if (src) {
      const thumb = document.createElement('img');
      thumb.src = src;
      thumb.alt = $('pv-sheets-wrap').querySelector('.sheet-cap').textContent;
      strip.appendChild(thumb);
    }
    $('pv-sheets-wrap').hidden = !src;
    $('pv-no-photo').hidden = Boolean(src);
  }

  // ---- boot ----
  (async () => {
    let cfg;
    // UNREACHABLE IS NOT CLOSED (2026-09-29: a venue network showed "closed" mid-demo).
    // One silent retry; then a retry screen. Only the server's own active:false is "closed".
    const getCfg = () => fetch('/api/practice').then((r) => {
      if (!r.ok) throw new Error('practice ' + r.status);
      return r.json();
    }).then((j) => { if (typeof (j && j.active) !== 'boolean') throw new Error('bad shape'); return j; });
    try { cfg = await getCfg(); }
    catch {
      try { await new Promise((ok) => setTimeout(ok, 1500)); cfg = await getCfg(); }
      catch {
        $('unreachable').hidden = false;
        $('cfg-retry').addEventListener('click', () => location.reload());
        return;
      }
    }
    if (!cfg.active) { $('closed').hidden = false; return; }

    PARTIES = cfg.parties || [];
    // cfg.note is deliberately dropped: it restated "nothing is published" a
    // third time, after the phase banner and the receipt already say it.
    const u = cfg.unit || {};
    CFG_UNIT = u;
    // Nothing is chosen until step 2 is answered — the sample unit is one of
    // the answers now, not a given.
    UNIT_CODE = null;
    UNIT_NAME = null;
    $('vote-inputs').innerHTML = PARTIES.map((p) => `
      <div class="vote-row">
        <label><span class="swatch" style="background:${esc(p.color || '#888')}"></span><span class="party-name" data-code="${esc(p.code)}">${esc(p.code)}</span></label>
        <input type="number" min="0" inputmode="numeric" placeholder="0" data-party="${esc(p.code)}" />
      </div>`).join('');
    /* Painted at boot, which can land before the language bundle has — so it
       repaints on 'hawkeye-lang'. A unit the server NAMES is a name, not a
       sentence: its data-i18n comes off, or apply() would swap it back to the
       markup's "Practice Polling Unit" — unless the name IS the sample's, which
       keeps its key. The done screen (preview + card) repaints with it. */
    const paintCfg = () => {
      $('prac-title').firstChild.textContent = `${sample(cfg.name)} `;
      $('prac-sub').textContent = T('practice.office-practice-contest', '{v0} — a practice contest.', { v0: sample(cfg.office) });
      // The practice unit, as an answer to step 2.
      const pb = $('btn-prac-unit').querySelector('strong');
      if (u.name && !Object.prototype.hasOwnProperty.call(SAMPLE, u.name)) {
        pb.removeAttribute('data-i18n');
        pb.textContent = u.name;
      } else keyed(pb, 'practice.practice-polling-unit', 'Practice Polling Unit');
      $('prac-unit-sub').textContent = [u.ward, u.lga, u.state].filter(Boolean).map(sample).join(', ');
      // Race names are painted text: repaint them in the new language.
      if (CHOSEN) fillRaces();
      paintFacts();
      document.querySelectorAll('#vote-inputs .party-name').forEach((el) => { el.textContent = partyLabel(el.dataset.code); });
      if (lastVotes && !$('done').hidden) {
        renderPreview(lastVotes);
        paintReceipt().catch(() => {});
      }
    };
    paintCfg();
    document.addEventListener('hawkeye-lang', paintCfg);
    stepLock();
    $('flow').hidden = false; // paint now; the saved unit below arrives when it does
    // The real step 2's search box (pu-search.js), choosing into this run.
    if (window.puSearch && $('pu-search-host')) window.puSearch.mount($('pu-search-host'), { onSelect: (row) => chooseUnit(row, false) });
    // Signed in with a saved unit? Offer it first, as the real step 2 does.
    try {
      const IU = window.HawkeyeInviteUnit;
      const mine = IU && IU.myUnit ? await Promise.race([IU.myUnit(), new Promise((r) => setTimeout(() => r(undefined), 5000))]) : undefined;
      if (mine && mine.pu_code) {
        const head = document.createElement('p');
        head.className = 'hint';
        head.style.margin = '0 0 6px';
        head.textContent = T('observe.your-saved-unit', 'Your polling unit');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pu-option';
        const name = document.createElement('strong');
        name.textContent = `⭐ ${mine.name || mine.pu_code}`;
        const sub = document.createElement('small');
        sub.textContent = [mine.pu_code, [mine.ward, mine.lga].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
        b.append(name, document.createElement('br'), sub);
        b.onclick = () => chooseUnit(mine, false);
        $('pu-saved').append(head, b);
        $('pu-saved').style.margin = '0 0 12px';
      }
    } catch { /* signed out or offline: near me, search and the practice unit remain */ }
  })();
})();

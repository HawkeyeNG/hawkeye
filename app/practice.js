// Practice / mock-election sandbox — a self-contained teaching flow. It never
// calls the real /api/submissions, never signs, never touches the ledger. The
// only network calls are GET /api/practice (config) and POST /api/practice/submit
// (writes to the disposable practice_submissions table). No sign-in required.
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
  const shots = { sheet: false, venue: false };
  // The photo behind each slot — a Blob from the app's scanner/camera or the
  // in-page camera's data URL. A skipped slot has none, and saves nothing.
  const photos = { sheet: null, venue: null };
  let PARTIES = [];
  let UNIT_CODE = null;

  function refreshSubmit() {
    $('btn-submit').disabled = !(shots.sheet && shots.venue);
  }
  function markSlot(slot) {
    shots[slot] = true;
    const badge = $(`status-${slot}`);
    keyed(badge, 'common.captured', 'Captured ✔');
    badge.classList.add('done');
    refreshSubmit();
  }

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
        body: JSON.stringify({ votes, puName: $('prac-unit-name').textContent, puCode: UNIT_CODE }),
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
      // Device copies of the practice photos (save-media.js), once the run is recorded.
      if (window.HAWKEYE_SAVE_MEDIA) {
        window.HAWKEYE_SAVE_MEDIA(['sheet', 'venue'].filter((s) => photos[s]).map((s) => ({ blob: photos[s], kind: 'photo' })), 'practice');
      }
      /* THE CARD, in its practice state. Same renderer as the real flow — a
         separate "practice-looking" card would teach the wrong picture. */
      (async () => {
        try {
          const R = window.HAWKEYE_RECEIPT;
          if (!R) return;
          const canvas = R.render({
            puName: $('prac-unit-name').textContent,
            puCode: UNIT_CODE,
            contest: T('practice.practice-run', 'Practice run'),
            votes: votes,
            entryHash: d.entryHash || '',
            practice: true,
            at: Date.now(),
          }, await R.loadLogo(), T);
          $('receipt-img').src = canvas.toDataURL('image/png');
          $('receipt-wrap').hidden = false;
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
          $('receipt-note').textContent = on
            ? T('practice.card-note-saved',
                'Saved to your phone with your practice photos. On a real report this is yours to keep and send on \u2014 nothing here is counted.')
            : T('practice.card-note',
                'On a real report this is yours to keep and send on. Nothing here is counted.');
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
    $('pv-meta').textContent = `[PRACTICE]${UNIT_CODE ? ` ${UNIT_CODE}` : ''}${scope ? ` · ${scope}` : ''}`;
    $('pv-votes').textContent = votes.filter((v) => v.count > 0).map((v) => `${v.party} ${v.count}`).join(' · ') || T('practice.all-zero', 'all zero');
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
    $('prac-title').firstChild.textContent = `${cfg.name} `;
    // cfg.note is deliberately dropped: it restated "nothing is published" a
    // third time, after the phase banner and the receipt already say it.
    const u = cfg.unit || {};
    UNIT_CODE = u.code || null;
    /* Painted at boot, which can land before the language bundle has — so it
       repaints on 'hawkeye-lang'. A unit the server NAMES is a name, not a
       sentence: its data-i18n comes off, or apply() would swap it back to the
       markup's "Practice Polling Unit". */
    const paintCfg = () => {
      $('prac-sub').textContent = T('practice.office-practice-contest', '{v0} — a practice contest.', { v0: cfg.office });
      if (u.name) {
        $('prac-unit-name').removeAttribute('data-i18n');
        $('prac-unit-name').textContent = u.name;
      } else keyed($('prac-unit-name'), 'practice.practice-polling-unit', 'Practice Polling Unit');
    };
    paintCfg();
    document.addEventListener('hawkeye-lang', paintCfg);
    $('prac-unit-scope').textContent = [u.ward, u.lga, u.state].filter(Boolean).join(', ');
    $('vote-inputs').innerHTML = PARTIES.map((p) => `
      <div class="vote-row">
        <label><span class="swatch" style="background:${esc(p.color || '#888')}"></span>${esc(p.code)}</label>
        <input type="number" min="0" inputmode="numeric" placeholder="0" data-party="${esc(p.code)}" />
      </div>`).join('');
    $('flow').hidden = false;
  })();
})();

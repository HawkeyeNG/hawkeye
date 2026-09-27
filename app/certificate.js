/*
 * certificate.js — the "Hawkeye Observer" certificate: the quiz, and the
 * certificate it earns (backend services/certificates.js).
 *
 * THE NAME NEVER LEAVES THIS DEVICE. The server stores no name; the one printed
 * on a certificate is typed here, kept in this browser's localStorage and drawn
 * onto a canvas here. It is in no request body, header or URL this page sends.
 * The only requests are GET /api/cert/mine and POST /api/cert/issue (answers
 * and the quiz version), both signed in, and GET /api/cert/verify?code= (the
 * public code). tests/certificate_ui_test.mjs records every request the page
 * makes and fails if the name is in any of them.
 *
 * TWO WAYS IN.
 *   1. Signed in (web, Lite): /api/cert/mine says certified, not practised yet,
 *      or ready for the quiz.
 *   2. certificate.html#code=ABCD-EFGH&name=…&lang=ha — how the native app
 *      opens this page in the in-app browser to print or save it. A #fragment
 *      is never sent to any server, and it is wiped from the address bar the
 *      moment it is read, before anything else on the page runs. The code is
 *      checked against the public verify endpoint, so a made-up code shows
 *      "not valid" rather than a certificate.
 *
 * THE QUIZ IS A LESSON. Every fact comes from the app's own guides (guide.html,
 * how.html, faq.html, captain-guide.html). After each answer the explanation
 * shows; a wrong answer is explained and the question tried again, so reaching
 * the end means every answer is right. The server grades the whole set again.
 *
 * Every string is resolved when it is PAINTED (T below), never at load, and
 * everything repaints on `hawkeye-lang`.
 */
(function () {
  'use strict';

  var ORIGIN = 'https://hawkeye.com.ng';   // never location.origin: in the app shell that is the phone itself
  var NAME_KEY = 'hawkeye_cert_name';
  var QUIZ_VERSION = 1;
  var CODE_RE = /^[2-9A-HJKMNP-TV-Z]{4}-?[2-9A-HJKMNP-TV-Z]{4}$/;

  /* THE ANSWER KEY IS A TWIN of backend services/certificates.js QUIZ_ANSWERS
     and native lib/certificate.ts; backend/tests/certificates_test.mjs reads
     all three. Keys with their English, so the page reads in English with no
     bundle loaded (en.json is never fetched). */
  var QUIZ = [
    { q: ['cert.q1', 'When do you photograph the result sheet (EC8A)?'],
      o: [['cert.q1-a', 'As soon as you arrive at the polling unit'],
          ['cert.q1-b', 'When the result is announced and posted after the count'],
          ['cert.q1-c', 'Later, from a picture someone sends you']],
      a: 1,
      why: ['cert.q1-why', 'Stay for the count. The presiding officer counts the ballots in public and fills in the EC8A; the announcement is the moment that matters. Photograph only what is posted or handed out.'] },
    { q: ['cert.q2', 'Can you report with a photo from your gallery, or a screenshot?'],
      o: [['cert.q2-a', 'No. Photos are taken live in the app, at the unit'],
          ['cert.q2-b', 'Yes, if the photo is clear'],
          ['cert.q2-c', 'Yes, if a friend at the unit sent it']],
      a: 0,
      why: ['cert.q2-why', 'Live photos only: no gallery uploads, no screenshots. Each photo is GPS-stamped when it is taken, which makes a report hard to fake from somewhere else.'] },
    { q: ['cert.q3', 'What do you type into your report?'],
      o: [['cert.q3-a', 'Your own estimate of the votes'],
          ['cert.q3-b', 'The figures someone at the unit tells you'],
          ['cert.q3-c', 'Each party’s figure exactly as announced']],
      a: 2,
      why: ['cert.q3-why', 'Type each party’s announced figure exactly, then sign and submit while you are still at the unit. Reports are permanent: nothing can be edited or deleted after signing.'] },
    { q: ['cert.q4', 'How should you treat election officials, voters and materials?'],
      o: [['cert.q4-a', 'Never interfere, and follow officials’ instructions'],
          ['cert.q4-b', 'Step in if you think an official made a mistake'],
          ['cert.q4-c', 'Check the ballot papers yourself']],
      a: 0,
      why: ['cert.q4-why', 'Never interfere with election officials, voters or materials. Follow officials’ instructions, and follow the Electoral Act and INEC’s rules.'] },
    { q: ['cert.q5', 'Trouble breaks out at your polling unit. What do you do?'],
      o: [['cert.q5-a', 'Stay and keep photographing, whatever happens'],
          ['cert.q5-b', 'Leave, and report it later from somewhere safe'],
          ['cert.q5-c', 'Try to stop it yourself']],
      a: 1,
      why: ['cert.q5-why', 'No result is worth your life. If there is trouble, leave, and report it later from somewhere safe.'] },
    { q: ['cert.q6', 'When is a count marked “verified”?'],
      o: [['cert.q6-a', 'As soon as one observer reports it'],
          ['cert.q6-b', 'When it is shared widely online'],
          ['cert.q6-c', 'When independent observers at the same unit report matching numbers']],
      a: 2,
      why: ['cert.q6-why', 'No single report is trusted on its own. A count is verified when independent observers at the same unit report matching numbers, backed by GPS, matching venue photos and the digits read from the sheet. Hawkeye does not declare results: official results are INEC’s.'] },
    { q: ['cert.q7', 'What does Hawkeye never share?'],
      o: [['cert.q7-a', 'The count reported at a polling unit'],
          ['cert.q7-b', 'Your phone number, or who watches which polling unit'],
          ['cert.q7-c', 'The public ledger']],
      a: 1,
      why: ['cert.q7-why', 'Your phone number is hashed and never published or shared. Hawkeye never shares who watches which polling unit: not with a captain, not with a party, not with anyone.'] },
  ];

  var $ = function (id) { return document.getElementById(id); };
  function T(k, en) { return window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en; }
  function P(pair) { return T(pair[0], pair[1]); }
  function fill(s, params) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return params[k] != null ? String(params[k]) : m; });
  }
  function token() { try { return localStorage.getItem('hawkeye_token'); } catch (e) { return null; } }

  /* ---------------------------------------------------------------------- */
  /* 1. The fragment, read and wiped FIRST.                                 */
  /* ---------------------------------------------------------------------- */
  var frag = (function () {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var p;
    try { p = new URLSearchParams(h); } catch (e) { return null; }
    var code = String(p.get('code') || '').toUpperCase().trim();
    if (!code) return null;
    // Out of the address bar before any script, error report or share sheet
    // can read it. replaceState sends nothing anywhere.
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    return { code: code, name: String(p.get('name') || '').slice(0, 60), lang: String(p.get('lang') || '') };
  })();
  if (frag && frag.name) { try { localStorage.setItem(NAME_KEY, frag.name); } catch (e) { /* memory only */ } }

  /* ---------------------------------------------------------------------- */
  /* 2. The network. Answers and the quiz version; nothing else, ever.      */
  /* ---------------------------------------------------------------------- */
  async function api(method, path, body, anon) {
    var headers = { accept: 'application/json' };
    var t = anon ? null : token();
    if (t) headers.authorization = 'Bearer ' + t;
    // The public check goes without credentials, so the edge may answer it.
    if (!anon) { try { if (window.getDeviceId) headers['x-device-id'] = await window.getDeviceId(); } catch (e) { /* optional */ } }
    if (body) headers['content-type'] = 'application/json';
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 12000);
    try {
      var r = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal, cache: 'no-store' });
      var j = await r.json().catch(function () { return null; });
      return { status: r.status, body: j };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Which section shows.                                                */
  /* ---------------------------------------------------------------------- */
  var SECTIONS = ['c-loading', 'c-error', 'c-signin', 'c-practice', 'c-quiz', 'c-invalid', 'c-done'];
  var view = 'c-loading';
  function show(id) {
    view = id;
    SECTIONS.forEach(function (s) { $(s).hidden = s !== id; });
    // The "how to earn it" line is for the way in, not the certificate.
    $('c-lede').hidden = id === 'c-done' || id === 'c-invalid';
  }

  var cert = null;      // { code, issuedOn, verifyUrl }

  async function load() {
    show('c-loading');
    if (!token()) { show('c-signin'); return; }
    var r = await api('GET', '/api/cert/mine');
    if (!r) { show('c-error'); return; }
    if (r.status === 401) { show('c-signin'); return; }
    if (r.status !== 200 || !r.body) { show('c-error'); return; }
    if (r.body.certified && r.body.code) { done(r.body); return; }
    if (!r.body.practised) { show('c-practice'); return; }
    startQuiz();
  }

  async function loadFragment() {
    show('c-loading');
    if (!CODE_RE.test(frag.code)) { show('c-invalid'); return; }
    var r = await api('GET', '/api/cert/verify?code=' + encodeURIComponent(frag.code), null, true);
    if (!r || r.status >= 500) { show('c-error'); return; }
    if (r.status !== 200 || !r.body || !r.body.valid) { show('c-invalid'); return; }
    done({ code: r.body.code, issuedOn: r.body.issuedOn, verifyUrl: ORIGIN + '/verify-cert?code=' + r.body.code });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. The quiz.                                                           */
  /* ---------------------------------------------------------------------- */
  var qi = 0;            // question index
  var answers = [];      // the RIGHT option per question, recorded as each is got right
  var wrong = {};        // options already tried and wrong on this question
  var state = 'ask';     // ask | right | wrong

  function startQuiz() {
    qi = 0; answers = []; wrong = {}; state = 'ask';
    $('cq-status').textContent = '';
    show('c-quiz');
    paintQuiz();
  }

  function paintQuiz() {
    var q = QUIZ[qi];
    $('cq-progress').textContent = fill(T('cert.progress', 'Question {n} of {total}'), { n: qi + 1, total: QUIZ.length });
    $('cq-question').textContent = P(q.q);
    var box = $('cq-options');
    box.innerHTML = '';
    q.o.forEach(function (opt, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cq-opt' + (state === 'right' && i === q.a ? ' ok' : '') + (wrong[i] ? ' bad' : '');
      b.textContent = P(opt);
      b.disabled = state !== 'ask' || !!wrong[i];
      b.addEventListener('click', function () { pick(i); });
      box.appendChild(b);
    });
    var fb = $('cq-feedback');
    fb.hidden = state === 'ask';
    fb.className = 'cq-feedback ' + (state === 'right' ? 'ok' : 'bad');
    $('cq-verdict').textContent = state === 'right' ? T('cert.correct', 'Correct.') : T('cert.wrong', 'Not quite.');
    $('cq-why').textContent = P(q.why);
    $('cq-retry').hidden = state !== 'wrong';
    var last = qi === QUIZ.length - 1;
    $('cq-next').hidden = state !== 'right';
    $('cq-next').textContent = last ? T('cert.finish', 'Get my certificate') : T('cert.next', 'Next');
  }

  function pick(i) {
    if (state !== 'ask') return;
    if (i === QUIZ[qi].a) { answers[qi] = i; state = 'right'; } else { wrong[i] = true; state = 'wrong'; }
    paintQuiz();
    $('cq-feedback').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('cq-retry').addEventListener('click', function () { state = 'ask'; paintQuiz(); });

  var issuing = false;
  $('cq-next').addEventListener('click', async function () {
    if (qi < QUIZ.length - 1) { qi++; wrong = {}; state = 'ask'; paintQuiz(); window.scrollTo(0, 0); return; }
    if (issuing) return;
    issuing = true;
    $('cq-next').disabled = true;
    status = ['cert.issuing', 'Issuing your certificate…'];
    paintStatus();
    var r = await api('POST', '/api/cert/issue', { answers: answers.slice(), version: QUIZ_VERSION });
    issuing = false;
    $('cq-next').disabled = false;
    if (r && r.status === 200 && r.body && r.body.code) { status = null; paintStatus(); done(r.body); return; }
    if (r && r.status === 401) { show('c-signin'); return; }
    if (r && r.status === 403) { show('c-practice'); return; }
    if (r && (r.status === 400 || r.status === 409)) { startQuiz(); return; }
    status = ['cert.issue-failed', 'Could not issue your certificate. Check your connection and try again.'];
    paintStatus();
  });

  var status = null;   // a [key, english] pair, so a language switch repaints it
  function paintStatus() { $('cq-status').textContent = status ? P(status) : ''; }

  $('c-retry').addEventListener('click', function () { if (frag) loadFragment(); else load(); });
  $('c-recheck').addEventListener('click', load);

  /* ---------------------------------------------------------------------- */
  /* 5. The certificate: drawn on a canvas, on this device.                 */
  /* ---------------------------------------------------------------------- */
  var W = 1600, H = 1131;   // A4 landscape proportions
  var GREEN = '#004225', GOLD = '#f5b301', CREAM = '#fbf7ea', INK = '#1d2a24', MUTED = '#5b6b62';
  var SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var SERIF = 'Georgia, "Times New Roman", serif';
  var MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  function dateWords(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return '';
    var months = T('practiceday.months', 'January,February,March,April,May,June,July,August,September,October,November,December').split(',');
    return Number(m[3]) + ' ' + (months[Number(m[2]) - 1] || '') + ' ' + m[1];
  }

  /** Every string on the card, decided here — the drawing below only places them. */
  function lines(c, name) {
    var shortUrl = String(c.verifyUrl || '').replace(/^https?:\/\//, '');
    return {
      title: T('cert.card-title', 'Hawkeye Observer'),
      name: String(name || '').trim().slice(0, 60),
      line: T('cert.card-line', 'Completed a practice run and the observer quiz'),
      issued: fill(T('cert.card-issued', 'Issued {date}'), { date: dateWords(c.issuedOn) }),
      code: fill(T('cert.card-code', 'Verification code {code}'), { code: c.code }),
      check: fill(T('cert.card-check', 'Check it at {url}'), { url: shortUrl }),
      foot: T('cert.card-foot', 'Hawkeye is independent and nonpartisan. This certificate is not INEC accreditation.'),
    };
  }

  /** Largest size <= `size` at which `text` fits `maxW`, never below 60% of it. */
  function fitFont(x, text, weight, size, family, maxW) {
    var s = size;
    for (; s > size * 0.6; s -= 2) {
      x.font = weight + ' ' + s + 'px ' + family;
      if (x.measureText(text).width <= maxW) break;
    }
    return s;
  }
  function wrap(x, text, maxW) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var out = [];
    var line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (line && x.measureText(t).width > maxW) { out.push(line); line = w; } else { line = t; }
    });
    if (line) out.push(line);
    return out;
  }

  function paint(x, L, logo) {
    x.fillStyle = GREEN; x.fillRect(0, 0, W, H);
    x.fillStyle = CREAM; x.fillRect(34, 34, W - 68, H - 68);
    x.strokeStyle = GOLD; x.lineWidth = 5; x.strokeRect(58, 58, W - 116, H - 116);
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';

    var y = 96;
    if (logo) { try { x.drawImage(logo, W / 2 - 70, y, 140, 140); } catch (e) { /* no crest, no problem */ } }
    y += 140 + 52;
    x.fillStyle = GREEN;
    x.font = '700 30px ' + SANS;
    if ('letterSpacing' in x) x.letterSpacing = '10px';
    x.fillText('HAWKEYE', W / 2 + 5, y);
    if ('letterSpacing' in x) x.letterSpacing = '0px';

    y += 108;
    var ts = fitFont(x, L.title, '700', 104, SANS, W - 320);
    x.font = '700 ' + ts + 'px ' + SANS;
    x.fillText(L.title, W / 2, y);

    y += 44;
    x.fillStyle = GOLD; x.fillRect(W / 2 - 180, y, 360, 6);

    y += 96;
    if (L.name) {
      var ns = fitFont(x, L.name, 'italic 400', 76, SERIF, W - 360);
      x.fillStyle = INK; x.font = 'italic 400 ' + ns + 'px ' + SERIF;
      x.fillText(L.name, W / 2, y);
      y += 80;
    } else {
      y += 10;
    }

    x.fillStyle = INK; x.font = '400 42px ' + SANS;
    wrap(x, L.line, W - 400).slice(0, 2).forEach(function (ln) { x.fillText(ln, W / 2, y); y += 56; });
    x.fillStyle = MUTED; x.font = '400 34px ' + SANS;
    x.fillText(L.issued, W / 2, y + 6);

    // The seal, bottom right: gold, with a check.
    var cx = W - 250, cy = H - 262;
    x.fillStyle = GOLD; x.beginPath(); x.arc(cx, cy, 92, 0, Math.PI * 2); x.fill();
    x.strokeStyle = CREAM; x.lineWidth = 4; x.beginPath(); x.arc(cx, cy, 76, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = GREEN; x.lineWidth = 14; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(cx - 36, cy + 2); x.lineTo(cx - 10, cy + 30); x.lineTo(cx + 40, cy - 28); x.stroke();

    // The code and where to check it, bottom left.
    x.textAlign = 'left';
    x.fillStyle = GREEN;
    var cs = fitFont(x, L.code, '700', 34, MONO, W - 620);
    x.font = '700 ' + cs + 'px ' + MONO;
    x.fillText(L.code, 130, H - 268);
    x.fillStyle = MUTED; x.font = '400 26px ' + SANS;
    wrap(x, L.check, W - 620).slice(0, 2).forEach(function (ln, i) { x.fillText(ln, 130, H - 222 + i * 34); });

    x.textAlign = 'center';
    x.fillStyle = MUTED; x.font = '400 24px ' + SANS;
    wrap(x, L.foot, W - 300).slice(0, 2).forEach(function (ln, i) { x.fillText(ln, W / 2, H - 112 + i * 32); });
  }

  var logoP = null;
  function loadLogo() {
    logoP = logoP || new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { res(null); };
      img.src = '/logo.svg';
      setTimeout(function () { res(img.complete && img.naturalWidth ? img : null); }, 1500);
    });
    return logoP;
  }

  var canvas = null;
  var drawSeq = 0;
  async function draw() {
    if (!cert) return;
    var seq = ++drawSeq;
    var logo = await loadLogo();
    if (seq !== drawSeq) return;
    canvas = canvas || document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    paint(canvas.getContext('2d'), lines(cert, $('cert-name').value), logo);
    $('cert-img').src = canvas.toDataURL('image/png');
    $('cert-img').alt = T('cert.card-title', 'Hawkeye Observer') + ' — ' + cert.code;
  }

  function done(c) {
    cert = { code: c.code, issuedOn: c.issuedOn, verifyUrl: c.verifyUrl || (ORIGIN + '/verify-cert?code=' + c.code) };
    var saved = '';
    try { saved = localStorage.getItem(NAME_KEY) || ''; } catch (e) { /* none */ }
    $('cert-name').value = saved.slice(0, 60);
    $('cert-code').textContent = cert.code;
    $('cert-link').textContent = cert.verifyUrl.replace(/^https?:\/\//, '');
    $('cert-link').href = cert.verifyUrl;
    // window.print does nothing inside the app shell's WebView.
    $('cert-print').hidden = !!(window.HAWKEYE && window.HAWKEYE.native);
    show('c-done');
    draw();
  }

  var nameTimer = null;
  $('cert-name').addEventListener('input', function () {
    var v = $('cert-name').value.slice(0, 60);
    try { if (v) localStorage.setItem(NAME_KEY, v); else localStorage.removeItem(NAME_KEY); } catch (e) { /* memory only */ }
    clearTimeout(nameTimer);
    nameTimer = setTimeout(draw, 150);
  });

  function pngBlob() {
    return new Promise(function (res) {
      if (!canvas || !canvas.toBlob) return res(null);
      canvas.toBlob(function (b) { res(b); }, 'image/png');
    });
  }
  var FILE = 'hawkeye-observer-certificate.png';
  var certStatus = null;
  function paintCertStatus() { $('cert-status').textContent = certStatus ? P(certStatus) : ''; }

  function download(blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = FILE; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  $('cert-share').addEventListener('click', async function () {
    if (!cert) return;
    await draw();
    var text = fill(T('cert.share-text', 'I completed a Hawkeye practice run and the observer quiz. Check my certificate: {url}'), { url: cert.verifyUrl });
    var blob = await pngBlob();
    var file = null;
    try { file = blob ? new File([blob], FILE, { type: 'image/png' }) : null; } catch (e) { file = null; }
    try {
      // To the phone's own share sheet — the person chooses where it goes.
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: text }); return; }
      if (navigator.share) { await navigator.share({ text: text }); return; }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(text);
      certStatus = ['cert.copied', 'Link copied']; paintCertStatus();
    } catch (e) {
      if (blob) download(blob);
    }
  });

  $('cert-save').addEventListener('click', async function () {
    if (!cert) return;
    await draw();
    var blob = await pngBlob();
    if (!blob) return;
    // Lite: into the phone's gallery through the same helper as report photos,
    // which honours the "keep copies on this phone" switch in My Profile.
    if (window.HAWKEYE && window.HAWKEYE.native && window.HAWKEYE_SAVE_MEDIA) {
      window.HAWKEYE_SAVE_MEDIA([{ blob: blob, kind: 'photo' }], 'certificate');
      certStatus = ['cert.saved', 'Saved to your phone.']; paintCertStatus();
      return;
    }
    download(blob);
  });

  $('cert-print').addEventListener('click', async function () {
    await draw();
    window.print();
  });

  /* ---------------------------------------------------------------------- */
  /* 6. Language: repaint whatever is showing.                              */
  /* ---------------------------------------------------------------------- */
  document.addEventListener('hawkeye-lang', function () {
    if (view === 'c-quiz') { paintQuiz(); paintStatus(); }
    if (view === 'c-done') { draw(); paintCertStatus(); }
  });

  if (frag && /^(en|ha|ig|yo)$/.test(frag.lang) && window.HawkeyeI18n === undefined) {
    // i18n.js loads after this file: pass the app's language to it when it does.
    document.addEventListener('DOMContentLoaded', function () {
      if (window.HawkeyeI18n && window.HawkeyeI18n.current !== frag.lang) window.HawkeyeI18n.set(frag.lang);
    });
  }

  window.HAWKEYE_CERT = { QUIZ: QUIZ, QUIZ_VERSION: QUIZ_VERSION, lines: lines };
  if (frag) loadFragment(); else load();
})();

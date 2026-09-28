/*
 * video-player.js — Hawkeye's own player for EVIDENCE videos (web + Lite).
 *
 * WHY. The incident feed and the review console drew each uploaded clip as a
 * bare <video controls>: a different control set in every browser, shrunk to
 * almost nothing at thumbnail size (Chrome drops Mute and Fullscreen from a
 * small element), and a play button that started a clip inside a 120px tile.
 * Native gets components/video-viewer.tsx; this is the same player for pages.
 *
 * HOW A PAGE USES IT. Render the clip as
 *     <video data-hk-evidence src="/uploads/…" preload="metadata" controls>
 * and load this file. Every such element — including ones a page writes later
 * with innerHTML — becomes a POSTER TILE: the clip's own first frame, a play
 * badge and its length. A tap opens a full-screen overlay with our controls:
 * large centre play/pause, a scrubber (drag, tap, or arrow keys) with elapsed /
 * total time, mute, close. `controls` stays in the markup on purpose: if this
 * script never loads, the browser's own player is still there.
 *
 * Keyboard: Space/K play-pause, ←/→ seek 5 s, M mute, Esc close; Tab stays
 * inside the overlay and focus goes back to the tile afterwards. Android's back
 * button closes the overlay rather than leaving the page (one history entry).
 * Controls fade after HIDE_AFTER_MS while playing — never while one of them has
 * keyboard focus — and a tap brings them back. prefers-reduced-motion drops
 * every transition and stops the spinner turning.
 *
 * CSP. No inline handlers, no eval, no network of its own: listeners are bound
 * here, icons are static SVG strings, and the stylesheet is a <style> element
 * (style-src allows 'unsafe-inline'). Videos are same-origin (media-src 'self');
 * in Lite, native.js rewrites a leading-slash src to the live host before the
 * tile is tapped, and the overlay takes that resolved URL.
 *
 * Every string goes through HawkeyeI18n (video-player.*, common.close), the
 * error line and every aria-label included, and is re-read on 'hawkeye-lang'.
 */
(function () {
  'use strict';
  if (window.HawkeyeVideo) return;

  const T = (k, en) => (window.HawkeyeI18n ? window.HawkeyeI18n.t(k, en) : en);
  const S = {
    open: () => T('video-player.open', 'Play video evidence'),
    dialog: () => T('video-player.dialog', 'Evidence video'),
    play: () => T('video-player.play', 'Play video'),
    pause: () => T('video-player.pause', 'Pause video'),
    replay: () => T('video-player.replay', 'Play again from the start'),
    mute: () => T('video-player.mute', 'Mute'),
    unmute: () => T('video-player.unmute', 'Turn sound on'),
    seek: () => T('video-player.seek', 'Playback position'),
    position: (a, b) => T('video-player.position', '{elapsed} of {total}').replace('{elapsed}', a).replace('{total}', b),
    loading: () => T('video-player.loading', 'Loading video…'),
    failed: () => T('video-player.failed', 'This video could not be played. Check your connection and try again.'),
    openFile: () => T('video-player.open-file', 'Open the video file'),
    close: () => T('common.close', 'Close'),
  };

  const HIDE_AFTER_MS = 3000;
  const STEP_S = 5;
  const SEL = 'video[data-hk-evidence]';

  /** 75.4 → "1:15", 3725 → "1:02:05". Never NaN on screen. */
  function clock(sec) {
    const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  /* Feather icon shapes (MIT), the same set native draws with @expo/vector-icons. */
  const svg = (body, fill) => '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="'
    + (fill ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  const I = {
    play: svg('<polygon points="6 3 20 12 6 21 6 3"/>', true),
    pause: svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', true),
    replay: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
    vol: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>'),
    volx: svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
    x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    ext: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    off: svg('<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  };

  /* Scoped by class, and specific enough to beat styles.css's global `button`
     and `input` rules (display:block, width:100%, the green fill, translateY on
     :active, brightness on :hover), which every rule below has to undo.
     z-index 135 sits inside the modal band (report sheet 120, language 125,
     tour 130, alert 140), so a blocking alert still lands on top of it. */
  const CSS = `
button.hk-vtile{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:120px;height:90px;margin:0;padding:0;border:0;border-radius:6px;overflow:hidden;background:#0b1a12;color:#fff;box-shadow:none;cursor:pointer;vertical-align:top;transition:none}
button.hk-vtile:hover{filter:none}
button.hk-vtile:active{transform:none;box-shadow:none;opacity:.85}
button.hk-vtile:focus{outline:none}
button.hk-vtile:focus-visible{outline:3px solid var(--focus,#ffdd00);outline-offset:2px}
button.hk-vtile>video.hk-vt-v{display:block;width:100%;height:100%;object-fit:cover;border:0;border-radius:0;pointer-events:none}
.hk-vt-play{position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
.hk-vt-play svg{width:18px;height:18px;margin-left:2px}
.hk-vt-dur{position:absolute;right:4px;bottom:4px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.65);font-size:11px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}
.hk-vt-dur[hidden]{display:none}
html.hk-vp-open,html.hk-vp-open body,html.hk-vp-open #page-scroll{overflow:hidden}
.hk-vp{position:fixed;inset:0;z-index:135;background:#000;color:#fff;-webkit-tap-highlight-color:transparent;outline:none}
.hk-vp[hidden]{display:none}
.hk-vp [hidden]{display:none!important}
.hk-vp-v{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.hk-vp .hk-vp-b{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;min-width:0;margin:0;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;box-shadow:none;cursor:pointer;font:inherit;transition:opacity .2s}
.hk-vp .hk-vp-b:hover{filter:none;background:rgba(0,0,0,.78)}
.hk-vp .hk-vp-b:active{transform:none;box-shadow:none;opacity:.7}
.hk-vp .hk-vp-b:focus,.hk-vp .hk-vp-seek:focus{outline:none}
.hk-vp .hk-vp-b:focus-visible,.hk-vp .hk-vp-seek:focus-visible,.hk-vp a:focus-visible{outline:3px solid var(--focus,#ffdd00);outline-offset:2px}
.hk-vp .hk-vp-x{position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);right:16px}
.hk-vp .hk-vp-big{position:absolute;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px}
.hk-vp .hk-vp-big svg{width:34px;height:34px}
.hk-vp .hk-vp-big.is-play svg{margin-left:4px}
.hk-vp-bar{position:absolute;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 12px);max-width:880px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:0 4px 0 14px;border-radius:16px;background:rgba(0,0,0,.6);transition:opacity .2s}
.hk-vp-t{flex:none;min-width:38px;font-size:12px;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
.hk-vp .hk-vp-mute{background:transparent}
.hk-vp .hk-vp-seek{-webkit-appearance:none;appearance:none;display:block;flex:1;min-width:0;width:auto;height:44px;margin:0;padding:0;border:0;border-radius:0;background:transparent;cursor:pointer;--p:0%}
.hk-vp .hk-vp-seek:hover{border-color:transparent}
.hk-vp-seek::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(to right,var(--gold,#f5b301) var(--p),rgba(255,255,255,.3) var(--p))}
.hk-vp-seek::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-6px;border:0;border-radius:50%;background:var(--gold,#f5b301)}
.hk-vp-seek::-moz-range-track{height:4px;border-radius:2px;background:rgba(255,255,255,.3)}
.hk-vp-seek::-moz-range-progress{height:4px;border-radius:2px;background:var(--gold,#f5b301)}
.hk-vp-seek::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--gold,#f5b301)}
.hk-vp-spin{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:12px;font-size:.85rem;pointer-events:none}
.hk-vp-ring{width:40px;height:40px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:hk-vp-turn .9s linear infinite}
@keyframes hk-vp-turn{to{transform:rotate(360deg)}}
.hk-vp-err{position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);padding:0 40px;text-align:center}
.hk-vp-err svg{width:28px;height:28px;color:#9ca3af}
.hk-vp-err p{margin:12px auto 16px;max-width:420px;font-size:.92rem;line-height:1.45}
.hk-vp-err a{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-weight:600;text-decoration:none}
.hk-vp-err a svg{width:16px;height:16px;color:#fff}
.hk-vp.is-idle{cursor:none}
.hk-vp.is-idle .hk-vp-bar,.hk-vp.is-idle .hk-vp-big,.hk-vp.is-idle .hk-vp-x{opacity:0;pointer-events:none}
@media (prefers-reduced-motion: reduce){.hk-vp .hk-vp-b,.hk-vp-bar{transition:none}.hk-vp-ring{animation:none}}
`;
  function injectCss() {
    if (document.getElementById('hk-vp-css')) return;
    const s = document.createElement('style');
    s.id = 'hk-vp-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------ the tiles */

  function upgrade(v) {
    if (v.dataset.hkUp || !v.parentNode) return;
    v.dataset.hkUp = '1';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hk-vtile';
    b.setAttribute('aria-label', S.open());
    v.parentNode.insertBefore(b, v);
    // A still, not a player: no controls, never focusable, never announced.
    v.removeAttribute('controls');
    v.controls = false;
    v.muted = true;
    v.preload = 'metadata';
    v.setAttribute('playsinline', '');
    v.tabIndex = -1;
    v.setAttribute('aria-hidden', 'true');
    v.classList.add('hk-vt-v');
    // iOS paints no frame for preload=metadata unless asked for a start time.
    const raw = v.getAttribute('src') || '';
    if (raw && raw.indexOf('#') < 0) v.setAttribute('src', raw + '#t=0.1');
    b.appendChild(v);
    const badge = document.createElement('span');
    badge.className = 'hk-vt-play';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = I.play;
    const len = document.createElement('span');
    len.className = 'hk-vt-dur';
    len.setAttribute('aria-hidden', 'true');
    len.hidden = true;
    b.append(badge, len);
    const showLen = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) { len.textContent = clock(v.duration); len.hidden = false; }
    };
    v.addEventListener('loadedmetadata', showLen);
    if (v.readyState >= 1) showLen();
  }

  function scan(root) {
    if (!root) return;
    if (root.matches && root.matches(SEL)) upgrade(root);
    if (root.querySelectorAll) root.querySelectorAll(SEL).forEach(upgrade);
  }

  /* ---------------------------------------------------------- the overlay */

  let ov = null;
  const ui = {};
  let opener = null;
  let idle = 0;
  let pushed = false;
  let ready = false;
  let scrubbing = false;

  function el(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function btn(cls, parent) {
    const b = el('button', 'hk-vp-b ' + cls, parent);
    b.type = 'button';
    return b;
  }

  function build() {
    if (ov) return;
    injectCss();
    ov = el('div', 'hk-vp');
    ov.hidden = true;
    ov.tabIndex = -1;
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');

    const v = ui.v = el('video', 'hk-vp-v', ov);
    v.preload = 'metadata';
    v.setAttribute('playsinline', '');
    v.setAttribute('disablepictureinpicture', '');
    v.tabIndex = -1;

    ui.spin = el('div', 'hk-vp-spin', ov);
    ui.spin.setAttribute('role', 'status');
    el('span', 'hk-vp-ring', ui.spin).setAttribute('aria-hidden', 'true');
    ui.spinT = el('span', '', ui.spin);

    ui.err = el('div', 'hk-vp-err', ov);
    ui.err.hidden = true;
    ui.err.setAttribute('role', 'alert');
    const off = el('span', '', ui.err);
    off.innerHTML = I.off;
    ui.errP = el('p', '', ui.err);
    ui.errA = el('a', '', ui.err);
    ui.errA.target = '_blank';
    ui.errA.rel = 'noopener';
    const ext = el('span', '', ui.errA);
    ext.innerHTML = I.ext;
    ui.errL = el('span', '', ui.errA);

    ui.big = btn('hk-vp-big', ov);

    ui.bar = el('div', 'hk-vp-bar', ov);
    ui.now = el('span', 'hk-vp-t', ui.bar);
    ui.now.setAttribute('aria-hidden', 'true');
    ui.seek = el('input', 'hk-vp-seek', ui.bar);
    ui.seek.type = 'range';
    ui.seek.min = '0';
    ui.seek.max = '0';
    ui.seek.step = 'any';
    ui.seek.value = '0';
    ui.dur = el('span', 'hk-vp-t', ui.bar);
    ui.dur.setAttribute('aria-hidden', 'true');
    ui.mute = btn('hk-vp-mute', ui.bar);

    ui.x = btn('hk-vp-x', ov);
    ui.x.innerHTML = I.x;

    ui.big.addEventListener('click', toggle);
    ui.mute.addEventListener('click', toggleMute);
    ui.x.addEventListener('click', () => close(false));
    ui.errA.addEventListener('click', () => close(false));

    ui.seek.addEventListener('input', () => {
      scrubbing = true;
      ui.v.currentTime = Number(ui.seek.value);
      tick();
      speak();
      wake();
    });
    const endScrub = () => { if (scrubbing) { scrubbing = false; tick(); speak(); wake(); } };
    ui.seek.addEventListener('change', endScrub);
    ui.seek.addEventListener('pointerup', endScrub);
    ui.seek.addEventListener('pointercancel', endScrub);
    ui.seek.addEventListener('focus', speak);

    /* THE PICTURE ITSELF. A finger taps it to bring the controls back, or to put
       them away while the clip plays. A mouse already brings them back by
       moving, so a click there does what it does in every desktop player:
       play/pause. (Treating a click like a tap hid the controls the instant
       the move before it had shown them.) */
    let pointer = 'mouse';
    ov.addEventListener('pointerdown', (e) => { pointer = e.pointerType || 'mouse'; });
    ov.addEventListener('click', (e) => {
      if (e.target !== ov && e.target !== ui.v) return;
      if (pointer === 'mouse') { toggle(); return; }
      if (ov.classList.contains('is-idle') || ui.v.paused) wake();
      else { clearTimeout(idle); ov.classList.add('is-idle'); }
    });
    ov.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); });

    v.addEventListener('loadstart', () => busy(true));
    v.addEventListener('loadedmetadata', () => { ui.bar.hidden = false; tick(); speak(); });
    v.addEventListener('durationchange', tick);
    v.addEventListener('loadeddata', onReady);
    v.addEventListener('canplay', onReady);
    v.addEventListener('waiting', () => { if (ready) busy(true); });
    v.addEventListener('playing', () => { busy(false); paint(); wake(); });
    v.addEventListener('play', () => { paint(); wake(); });
    v.addEventListener('pause', () => { paint(); speak(); wake(); });
    v.addEventListener('ended', () => { paint(); speak(); wake(); });
    v.addEventListener('seeked', () => { tick(); paint(); if (!scrubbing) speak(); });
    v.addEventListener('timeupdate', tick);
    v.addEventListener('volumechange', paint);
    v.addEventListener('error', fail);

    document.body.appendChild(ov);
    relabel();
  }

  function onReady() {
    if (!ov || ov.hidden) return;
    ready = true;
    busy(false);
    ui.bar.hidden = false;
    tick();
    paint();
  }

  function busy(on) {
    ui.spin.hidden = !on;
    ui.big.hidden = on || !ui.err.hidden;
  }

  function fail() {
    // Clearing the source on close is not a failure.
    if (!ov || ov.hidden || !ui.v.getAttribute('src')) return;
    clearTimeout(idle);
    ov.classList.remove('is-idle');
    ui.spin.hidden = true;
    ui.big.hidden = true;
    ui.bar.hidden = true;
    ui.errP.textContent = S.failed();
    ui.err.hidden = false;
  }

  function atEnd() {
    const v = ui.v;
    return v.ended || (v.duration > 0 && v.currentTime >= v.duration - 0.05);
  }

  function paint() {
    const v = ui.v;
    const playing = !v.paused && !v.ended;
    const end = !playing && atEnd();
    ui.big.innerHTML = playing ? I.pause : end ? I.replay : I.play;
    ui.big.classList.toggle('is-play', !playing && !end);
    ui.big.setAttribute('aria-label', playing ? S.pause() : end ? S.replay() : S.play());
    ui.mute.innerHTML = v.muted ? I.volx : I.vol;
    ui.mute.setAttribute('aria-label', v.muted ? S.unmute() : S.mute());
  }

  function tick() {
    const v = ui.v;
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    ui.seek.max = String(d);
    if (!scrubbing) ui.seek.value = String(Math.min(d, v.currentTime || 0));
    const at = Number(ui.seek.value) || 0;
    ui.now.textContent = clock(at);
    ui.dur.textContent = clock(d);
    ui.seek.style.setProperty('--p', (d > 0 ? (at / d) * 100 : 0) + '%');
  }

  /* The spoken position is refreshed when it means something — focus, a seek,
     a pause, the end — not four times a second while a screen reader sits on
     the slider. */
  function speak() {
    if (!ov) return;
    ui.seek.setAttribute('aria-valuetext', S.position(clock(Number(ui.seek.value) || 0), clock(ui.v.duration)));
  }

  function relabel() {
    document.querySelectorAll('.hk-vtile').forEach((b) => b.setAttribute('aria-label', S.open()));
    if (!ov) return;
    ov.setAttribute('aria-label', S.dialog());
    ui.x.setAttribute('aria-label', S.close());
    ui.seek.setAttribute('aria-label', S.seek());
    ui.spinT.textContent = S.loading();
    ui.errP.textContent = S.failed();
    ui.errL.textContent = S.openFile();
    paint();
    speak();
  }

  function toggle() {
    const v = ui.v;
    if (!ui.err.hidden) return;
    wake();
    if (!v.paused && !v.ended) { v.pause(); return; }
    if (atEnd()) v.currentTime = 0;
    const p = v.play();
    if (p && p.catch) p.catch(() => { /* a refused play() is followed by 'error' or nothing; never unhandled */ });
  }

  function toggleMute() {
    ui.v.muted = !ui.v.muted;
    paint(); // now, not on 'volumechange' a task later: the label must match the state it announces
    wake();
  }

  function seekTo(sec) {
    const v = ui.v;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.max(0, d > 0 ? Math.min(d, sec) : sec);
    tick();
  }

  function wake() {
    if (!ov || ov.hidden) return;
    ov.classList.remove('is-idle');
    clearTimeout(idle);
    if (!ui.v.paused && !ui.v.ended && !scrubbing) idle = setTimeout(sleep, HIDE_AFTER_MS);
  }

  function sleep() {
    if (!ov || ov.hidden || ui.v.paused || !ui.err.hidden) return;
    // A control with keyboard focus never disappears from under the reader.
    let kb = false;
    try { kb = !!ov.querySelector(':focus-visible'); } catch (e) { kb = false; }
    if (!kb) ov.classList.add('is-idle');
  }

  /** Tab and Shift+Tab cycle inside the overlay. */
  function trap(e) {
    const f = [ui.big, ui.seek, ui.mute, ui.errA, ui.x].filter((n) => !n.hidden && !n.closest('[hidden]'));
    if (!f.length) return;
    const a = document.activeElement;
    const i = f.indexOf(a);
    e.preventDefault();
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
    f[next].focus();
  }

  function onKey(e) {
    if (!ov || ov.hidden) return;
    const k = e.key;
    wake();
    if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if (k === 'Tab') { trap(e); return; }
    const onControl = e.target && e.target.closest && e.target.closest('button, a');
    const onSeek = e.target === ui.seek;
    if ((k === ' ' || k === 'Spacebar' || k === 'k' || k === 'K') && !onControl) { e.preventDefault(); toggle(); return; }
    if (k === 'm' || k === 'M') { e.preventDefault(); toggleMute(); return; }
    if (k === 'ArrowLeft' || (onSeek && k === 'ArrowDown')) { e.preventDefault(); seekTo(ui.v.currentTime - STEP_S); return; }
    if (k === 'ArrowRight' || (onSeek && k === 'ArrowUp')) { e.preventDefault(); seekTo(ui.v.currentTime + STEP_S); return; }
    if (onSeek && (k === 'Home' || k === 'End')) { e.preventDefault(); seekTo(k === 'Home' ? 0 : ui.v.duration); }
  }

  function open(src, from) {
    if (!src) return;
    build();
    opener = from || document.activeElement;
    ready = false;
    scrubbing = false;
    ui.err.hidden = true;
    ui.bar.hidden = true;
    ui.errA.href = src;
    const v = ui.v;
    // Heard, and watched once: not muted, not looping, not autoplaying.
    v.muted = false;
    v.loop = false;
    v.autoplay = false;
    v.src = src;
    v.load();
    busy(true);
    tick();
    relabel();
    ov.hidden = false;
    document.documentElement.classList.add('hk-vp-open');
    try { history.pushState({ hkVideo: 1 }, ''); pushed = true; } catch (e) { pushed = false; }
    ov.focus();
    wake();
  }

  function close(viaHistory) {
    if (!ov || ov.hidden) return;
    clearTimeout(idle);
    const v = ui.v;
    v.pause();
    v.removeAttribute('src');
    try { v.load(); } catch (e) { /* stops the download; nothing to recover */ }
    ov.hidden = true;
    ov.classList.remove('is-idle');
    document.documentElement.classList.remove('hk-vp-open');
    if (pushed && !viaHistory) { try { history.back(); } catch (e) { /* no history to unwind */ } }
    pushed = false;
    if (opener && opener.isConnected && opener.focus) opener.focus();
    opener = null;
  }

  /* ------------------------------------------------------------- wiring */

  injectCss();
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('.hk-vtile');
    if (!b) return;
    const v = b.querySelector('video');
    if (!v) return;
    e.preventDefault();
    open((v.src || '').split('#')[0], b);
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', () => { if (ov && !ov.hidden) { pushed = false; close(true); } });
  document.addEventListener('hawkeye-lang', relabel);

  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); })))
    .observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document));
  else scan(document);

  window.HawkeyeVideo = { open, close: () => close(false), upgrade: scan, clock };
})();

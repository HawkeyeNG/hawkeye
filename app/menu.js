// Resolve the effective theme before anything paints: a user-forced choice wins;
// otherwise follow the system, DEFAULTING TO DARK when the system expresses no
// (or a non-light) preference. A pre-paint inline copy of this lives in each
// page's <head> to avoid a flash; this re-affirms it (and covers any page that
// somehow lacks the inline tag).
(function () {
  let t = localStorage.getItem('hawkeye_theme');
  if (t !== 'dark' && t !== 'light') {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = t;
  if (document.documentElement.classList.contains('native-app')) {
    var mtc = document.querySelector('meta[name="theme-color"]');
    if (mtc) mtc.content = t === 'dark' ? '#00251a' : '#ffffff';
  }
})();

// Shared header-menu behaviour: close the dropdown when clicking anywhere
// outside it (the button's own inline onclick still toggles it) and on Escape.
(function () {
  function closeIfOutside(e) {
    const panel = document.getElementById('menu-panel');
    const btn = document.querySelector('.menu-btn');
    if (!panel || panel.hidden) return;
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    panel.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('click', closeIfOutside);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const panel = document.getElementById('menu-panel');
    const btn = document.querySelector('.menu-btn');
    if (panel && !panel.hidden) {
      panel.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });

  const panel = document.getElementById('menu-panel');
  const btn = document.querySelector('.menu-btn');

  // Desktop: a horizontal quick-nav of primary links (the ☰ still holds the full
  // list). Built from the panel so page HTML needs no changes. CSS shows it ≥900px.
  const PRIMARY = ['map-unit.html', 'incidents.html', 'how.html', 'observe.html'];
  if (panel && btn && !document.querySelector('.desktop-primary')) {
    const nav = document.createElement('nav');
    nav.className = 'desktop-primary';
    for (const href of PRIMARY) {
      const src = [...panel.querySelectorAll('a')].find((a) => a.getAttribute('href') === href);
      if (src) nav.appendChild(src.cloneNode(true));
    }
    // Primary action rendered as a pill CTA at the end of the quick-nav.
    const cta = nav.querySelector('a[href="observe.html"]');
    if (cta) { cta.classList.add('nav-cta'); nav.appendChild(cta); }
    // My Profile lives under "Take part" in the ☰ panel, but that whole section
    // is hidden on desktop (≥900px, .tp-hide) on the theory its links moved to
    // this header — and profile.html never did. Signed-in desktop users had NO
    // route to their profile. Signed-out users are skipped: the link would only
    // bounce them to sign-in.
    if (localStorage.getItem('hawkeye_token')) {
      const pf = document.createElement('a');
      pf.href = 'profile.html';
      pf.textContent = 'My Profile';
      nav.insertBefore(pf, cta || null);
    }
    if (nav.children.length) btn.parentNode.insertBefore(nav, btn);
  }

  /**
   * IS THIS THE APP SHELL? The Capacitor app (Hawkeye Lite) or an INSTALLED PWA
   * — both ARE the app experience, and both get the bottom tab bar. The
   * `inAppShell` const further down is now just this call.
   *
   * A hoisted FUNCTION rather than a const, because two things need the answer
   * at opposite ends of this file: the ☰ panel's "Take the tour" row is built up
   * here with the menu groups, and the tab bar (and the tour that rings it) is
   * built ~650 lines below. A `const` declared down there cannot be read from up
   * here — temporal dead zone — and a second copy of the expression is exactly
   * how the tour and the bar would come to disagree about what "the shell" is.
   */
  function isAppShell() {
    return !!(window.HAWKEYE && window.HAWKEYE.native)
      || window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }
  /** Set by the tour when it builds itself (shell only); see the tour block. */
  let openTour = null;

  // Group the (15-item) menu into scannable sections. Built dynamically from
  // the page's own links so page HTML stays a flat, JS-free fallback list.
  // Footer-only pages: not in the ☰ menu (menu stays short); the canonical
  // footer below carries them on every page.
  // On the WEB these live in the footer only, keeping the ☰ menu short. But the
  // app HIDES the footer (body.has-tabbar .gov-footer), and the "More" tab just
  // opens this same panel — so in the shell they had NO entry point at all.
  // "Privacy & Data" being unreachable is also a Play listing problem. Keep them
  // in the panel (under "Learn & about") whenever the footer isn't carrying them.
  const FOOTER_ONLY_HREFS = ['about.html', 'how.html', 'privacy.html', 'faq.html', 'guide.html'];
  const footerCarriesThem = !(window.HAWKEYE && window.HAWKEYE.native);
  const FOOTER_ONLY = footerCarriesThem ? FOOTER_ONLY_HREFS : [];
  // "Take part" is hidden on desktop (≥900px) — its links live in the header there.
  // Flat section labels, with TWO collapsible accordions nested inside — Report
  // (the three report flows) under Take part, and Races under Live data. Each item
  // is either a plain href or { acc, hrefs }. Only those two collapse; the section
  // labels themselves stay flat (a shorter menu, per the plan).
  // Mirror of native's More screen (native/src/app/(tabs)/more.tsx GROUPS), 1:1 in
  // section order AND item order within each section — the app is what ships for
  // Osun. My Profile leads Take part; Incident Reports (the public feed) sits under
  // Trust & verify beside the Docket, distinct from "Report an Incident" (filing,
  // inside the Report accordion). Ask Hawkeye is native-only (no web page yet), so
  // it's the one native entry with no counterpart here.
  const GROUPS = [
    ['Take part', ['profile.html', { acc: 'Report', hrefs: ['observe.html', 'collation.html', 'incidents.html'] }, 'practice.html', 'map-unit.html'], 'tp'],
    ['Trust & verify', ['ledger.html', 'integrity.html', 'docket.html', 'incident-reports.html']],
    // Races is ONE LINK, not an accordion. It listed All Races / Osun 2026 /
    // Presidency 2027 — a hand-kept list of three, hardcoded in the menu, while
    // races.html itself now derives every race from /api/contests, groups them
    // completed / ongoing / upcoming and offers all 36 governorships. The
    // accordion could only ever be a stale subset of the page it sat above, and
    // "Osun 2026" was already a finished election pinned to the menu.
    ['Live data', ['results.html', 'races.html', 'dashboard.html', 'political.html']],
    // Only populates in the app (see FOOTER_ONLY above); on the web these hrefs
    // aren't in the panel, the group finds no members and is skipped.
    // "Take the tour" LEADS this group, which is where native puts it
    // (more.tsx GROUPS: first item of "Learn & about", above "Ask Hawkeye").
    // Ask Hawkeye is native-only — no web page — so here the row lands directly
    // above "How Hawkeye Works", one position earlier but the same position in
    // the group. It is an ACTION, not a page, so it is INJECTED below rather
    // than static-listed in every page's <nav>, following the races.html /
    // profile.html precedent — and injected ONLY in the app shell. On the
    // website links.get('#tour') finds nothing, this item resolves to null and
    // the rendered group is byte-identical to before.
    ['Learn & about', ['#tour', 'how.html', 'guide.html', 'faq.html', 'about.html', 'support.html', 'privacy.html', 'terms.html']],
    /**
     * Where native puts it too — the app's More screen ends with a "Find
     * Hawkeye" section (components/social-row.tsx) and the share control sits
     * at the top of it. Its other members, the Telegram bot and the four
     * accounts, are on the web already: they are the strip in the footer below
     * this panel, which is why this group has one entry rather than six.
     */
    ['Find Hawkeye', ['download.html']],
  ];
  if (panel && !panel.querySelector('.menu-group')) {
    // The races selector. Injected so it appears on every page. Osun 2026 and
    // Presidency 2027 used to be injected beside it; races.html now derives
    // every race from the contest catalogue and groups them by whether they
    // are completed, ongoing or upcoming, so a hand-kept pair in the menu was
    // a stale subset of it — and one of them was a finished election.
    if (!panel.querySelector('a[href="races.html"]')) {
      const ra = document.createElement('a');
      ra.href = 'races.html';
      ra.textContent = 'Races';
      panel.appendChild(ra);
    }
    // My Profile leads Take part (mirrors native); injected so it appears on every
    // page, not only the signed-in "Your account" append it used to be.
    if (!panel.querySelector('a[href="profile.html"]')) {
      const pf = document.createElement('a');
      pf.href = 'profile.html';
      pf.textContent = 'My Profile';
      panel.appendChild(pf);
    }
    // Support Hawkeye — under Learn & about in native. The page exists (support.html)
    // but few pages static-list it, so inject it like Osun/Practice/Terms.
    if (!panel.querySelector('a[href="support.html"]')) {
      const sp = document.createElement('a');
      sp.href = 'support.html';
      sp.textContent = 'Support Hawkeye';
      panel.appendChild(sp);
    }
    // Public incident feed (viewing) — distinct from "Report an Incident" (filing).
    if (!panel.querySelector('a[href="incident-reports.html"]')) {
      const ir = document.createElement('a');
      ir.href = 'incident-reports.html';
      ir.textContent = 'Incident Reports';
      panel.appendChild(ir);
    }
    // Practice run — injected everywhere (like Osun) so new users can find it
    // without editing every page's static list.
    if (!panel.querySelector('a[href="practice.html"]')) {
      const pr = document.createElement('a');
      pr.href = 'practice.html';
      pr.textContent = 'Practice Run';
      panel.appendChild(pr);
    }
    /**
     * SHARE HAWKEYE. An election tool spreads by one person handing it to
     * another, and until now the only way to do that was to copy the address
     * bar.
     *
     * IT IS A LINK, and the href is not decoration: without JS — or before
     * share.js has loaded, or if it fails to — tapping this opens the download
     * page, which carries the same store badges and its own share button. The
     * click handler upgrades it to the phone's own share sheet.
     *
     * share.js is loaded HERE rather than fetched on the click. navigator.share
     * needs transient user activation, and a script fetched after the tap
     * finishes has already lost it — the share would be refused on exactly the
     * platforms it is for.
     */
    if (!panel.querySelector('a[href="download.html"]')) {
      var sh = document.createElement('a');
      sh.href = 'download.html';
      sh.textContent = 'Share Hawkeye';
      sh.setAttribute('data-share', '');
      panel.appendChild(sh);
      // Already loaded (download.html and profile.html carry it): its own sweep
      // for [data-share] ran before this link existed, so mount it by hand.
      // Otherwise load it — its sweep then finds this link on arrival.
      if (window.mountShare) window.mountShare(sh);
      else if (!document.querySelector('script[src^="share.js"]')) {
        var ss = document.createElement('script');
        ss.src = 'share.js?v=1';
        document.head.appendChild(ss);
      }
    }
    // Terms of Service — no page static-lists it, and its only other route
    // (privacy.html's footer nav) is overwritten by the canonical footer below,
    // so inject it here (like Osun/Practice above) so "Learn & about" surfaces it.
    if (!panel.querySelector('a[href="terms.html"]')) {
      const tm = document.createElement('a');
      tm.href = 'terms.html';
      tm.textContent = 'Terms of Service';
      panel.appendChild(tm);
    }
    /**
     * TAKE THE TOUR — the replay, and the only way back to the tour once the
     * first run is over. The tour shows itself once and its Skip button is meant
     * to be pressed, which would otherwise make it unreachable forever for
     * exactly the people who later wish they had watched it. Native reasons the
     * same way (more.tsx, `action:tour`).
     *
     * A LINK rather than a button because a link is the only thing the GROUPS
     * resolver below reads, and `#tour` is a harmless href with JS off. SHELL
     * ONLY: the five cards are literally about the five tabs, and the website
     * has no tab bar — a tour describing controls that are not on screen would
     * be worse than none.
     *
     * "In the shell" is necessary but not sufficient: an INSTALLED DESKTOP PWA
     * is the shell and still renders no bar (.tabbar is display:none above
     * 899px). The tour block below therefore hides this row whenever no bar is
     * on screen — a decision it can only make once the bar exists, 650 lines
     * from here. See syncTourRow().
     */
    if (isAppShell() && !panel.querySelector('a[href="#tour"]')) {
      const tr = document.createElement('a');
      tr.href = '#tour';
      tr.textContent = 'Take the tour';
      tr.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        panel.hidden = true;
        document.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'false');
        if (openTour) openTour();
      });
      panel.appendChild(tr);
    }
    const links = new Map([...panel.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a]));
    // Canonical label for the results page: its static link text drifts across
    // pages ("Leaderboard" / "Live Results" / "Public Results"). Native calls it
    // just "Leaderboard", so normalise every page's drifted label to that.
    const lb = links.get('results.html');
    if (lb) lb.textContent = 'Leaderboard';
    /**
     * PRESIDENCY 2027 IS NOT A MENU ENTRY. Native's More screen has no such
     * item, and this menu is a 1:1 mirror of it.
     *
     * It used to be relabelled here and left in place, which put it in the worst
     * possible spot: every GROUPS member gets APPENDED in order, so a link that
     * belongs to no group keeps its original position and ends up after
     * everything — under "Learn & about", below Terms of Service, as if a
     * presidential race were a policy document.
     *
     * Removed rather than regrouped, for the reason the Races accordion was
     * removed: /races derives every race from /api/contests and groups them
     * completed / ongoing / upcoming. One race hand-pinned to the menu beside it
     * is a stale subset of the page that already lists it — and Home's cards
     * link straight to it too, so nothing is orphaned.
     */
    const pres = links.get('candidates.html');
    if (pres) { pres.remove(); links.delete('candidates.html'); }
    // A collapsible accordion: a link-styled header that shows/hides its
    // sub-links, remembered in localStorage. Default CLOSED — the whole point of
    // an accordion here is a shorter menu.
    const makeAccordion = (title, members, tp) => {
      const head = document.createElement('div');
      head.className = 'menu-acc' + (tp ? ' tp-hide' : '');
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.innerHTML = '<span>' + title + '</span><svg class="mg-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
      const body = document.createElement('div');
      body.className = 'mg-body' + (tp ? ' tp-hide' : '');
      for (const a of members) body.appendChild(a);
      panel.appendChild(head);
      panel.appendChild(body);
      const key = 'hk_acc_' + title;
      const setOpen = (open) => head.setAttribute('aria-expanded', String(open));
      setOpen(localStorage.getItem(key) === '1');
      const toggle = () => {
        const open = head.getAttribute('aria-expanded') !== 'true';
        setOpen(open);
        try { localStorage.setItem(key, open ? '1' : '0'); } catch (e) {}
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    };
    for (const [label, items, tp] of GROUPS) {
      // Resolve items against the page's links: a string -> that link; an
      // { acc, hrefs } -> a collapsible group of the ones that exist.
      const resolved = items.map((it) => {
        if (typeof it === 'string') { const a = links.get(it); return a ? { a } : null; }
        const members = it.hrefs.map((h) => links.get(h)).filter(Boolean);
        return members.length ? { acc: it.acc, members } : null;
      }).filter(Boolean);
      if (!resolved.length) continue;
      const head = document.createElement('div');
      head.className = 'menu-group' + (tp ? ' tp-hide' : '');
      head.textContent = label;
      panel.appendChild(head);
      for (const r of resolved) {
        if (r.a) {
          if (tp) r.a.classList.add('tp-hide');
          panel.appendChild(r.a);
          links.delete(r.a.getAttribute('href'));
        } else {
          makeAccordion(r.acc, r.members, tp);
          r.members.forEach((a) => links.delete(a.getAttribute('href')));
        }
      }
    }
    for (const [href, a] of links) {
      if (FOOTER_ONLY.includes(href)) a.remove();
      else panel.appendChild(a); // anything unmapped keeps working
    }
  }

  // No copyright line here: a nav dropdown isn't where anyone looks for one.
  // It lives in the web footer, on the app's welcome screen, and in about.html
  // ("Who runs Hawkeye"), which the menu links to.

  // Light/dark toggle beside the hamburger. Toggles from the EFFECTIVE mode and
  // persists; greens are identical in both — only neutral surfaces change.
  if (btn && !document.querySelector('.theme-btn')) {
    const tb = document.createElement('button');
    tb.className = 'theme-btn';
    const effective = () => document.documentElement.dataset.theme || 'dark';
    // Inline SVG (sun/moon) instead of emoji — emoji render as tofu boxes on
    // fontless systems; SVG is always crisp and inherits currentColor.
    const SUN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const MOON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    const paint = () => { tb.innerHTML = effective() === 'dark' ? SUN : MOON; tb.setAttribute('aria-label', effective() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); };
    tb.addEventListener('click', () => {
      const next = effective() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('hawkeye_theme', next);
      if (document.documentElement.classList.contains('native-app')) {
        var m = document.querySelector('meta[name="theme-color"]');
        if (m) m.content = next === 'dark' ? '#00251a' : '#ffffff';
      }
      paint();
    });
    paint();
    btn.parentNode.insertBefore(tb, btn);
  }

  // Header slot, one control, state-dependent (called by syncAuthMenu below):
  /**
   * THE NUMBER ON THE APP ICON, the way Instagram and Gmail carry one.
   *
   * The Badging API is the only way a web app can write to its own launcher
   * icon, and it works only where the app is INSTALLED (an installed PWA on
   * Android Chrome, or a desktop PWA). In a browser tab it does not exist, which
   * is why this is feature-detected and silent rather than gated on some guess
   * about the platform.
   *
   * Deliberately not clamped to "9+" like the in-page dots: those are pills a
   * few pixels wide, whereas the launcher owns its own rendering and truncates
   * to taste. Zero CLEARS rather than showing a nought — an icon badge reading
   * "0" is worse than no badge.
   *
   * Capacitor's WebView does NOT implement this: Hawkeye Lite would need a
   * native badge plugin, which is why Lite is untouched here.
   */
  function appBadge(d) {
    try {
      const n = d && Number(d.unread) || 0;
      if (!navigator.setAppBadge) return;
      if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge?.();
    } catch (e) { /* unsupported, or denied — never break the page for a badge */ }
  }

  //   signed in  -> notifications bell + unread badge
  //   signed out -> "Sign in" for returning observers
  // A bell is meaningless before an account exists, and a first-time visitor has
  // no idea what it does — so the slot shows the thing that's actually useful.
  function headerAuthControl() {
    if (!btn) return;
    const slot = () => document.querySelector('.theme-btn') || btn;
    const signedIn = !!localStorage.getItem('hawkeye_token');
    const onNotifs = /notifications\.html/.test(location.pathname);
    const bell = document.querySelector('.bell-btn');
    const signin = document.querySelector('.signin-btn');

    if (signedIn) {
      if (signin) signin.remove();
      if (bell || onNotifs) return;
      const a = document.createElement('a');
      a.className = 'bell-btn';
      a.href = 'notifications.html';
      a.setAttribute('aria-label', 'Notifications');
      a.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 4.5 2 5.5 2 5.5H4S6 13.5 6 9"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="bell-dot" hidden></span>';
      btn.parentNode.insertBefore(a, slot());
      fetch('/api/notifications', { headers: { authorization: 'Bearer ' + localStorage.getItem('hawkeye_token') } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.unread > 0) { const dot = a.querySelector('.bell-dot'); dot.textContent = d.unread > 9 ? '9+' : d.unread; dot.hidden = false; }
          appBadge(d);
        })
        .catch(() => {});
      return;
    }
    if (bell) bell.remove();
    // The app's welcome screen already carries full-width Create account / Sign in
    // buttons — a second small one in the header is just noise there.
    const onAppWelcome = !!(window.HAWKEYE && window.HAWKEYE.native)
      && /^\/(index\.html)?$/.test(location.pathname);
    // No sign-in button ON the sign-in page, and not in the Telegram Mini App
    // (auth there is the Telegram identity, not our OTP flow).
    if (signin || onAppWelcome || /observe\.html/.test(location.pathname)
      || document.documentElement.classList.contains('tg-app')) return;
    const s = document.createElement('a');
    s.className = 'signin-btn';
    s.href = 'observe.html?intent=signin';   // password-first, lands on the dashboard
    s.textContent = 'Sign in';
    btn.parentNode.insertBefore(s, slot());
  }

  // The ☰ dropdown's height and the one-screen hero both need REAL measurements,
  // not magic numbers: the header grows by env(safe-area-inset-top) in the APK and
  // the tab bar only exists there. Publish both as CSS vars for styles.css.
  function publishChromeVars() {
    const hdr = document.querySelector('.gov-header');
    const bar = document.querySelector('.tabbar');
    const barShown = bar && getComputedStyle(bar).display !== 'none';
    const r = document.documentElement.style;
    if (hdr) r.setProperty('--hdr-h', Math.round(hdr.getBoundingClientRect().height) + 'px');
    r.setProperty('--bar-h', barShown ? Math.round(bar.getBoundingClientRect().height) + 'px' : '0px');
    // The government disclaimer sits ABOVE the landing hero, so it eats into the
    // one-screen fold the same way the header does. It was pushing the hero 96px
    // past the fold on a phone once the bar started rendering on index.html.
    // Measure it for the same reason --hdr-h is measured: its height depends on
    // how many lines the notice wraps to, which varies by width and font size,
    // and a magic number here is exactly what broke the fold before.
    const disc = document.querySelector('.gov-disclaimer');
    if (disc && disc.offsetParent !== null) {
      const cs = getComputedStyle(disc);
      const h = disc.getBoundingClientRect().height
        + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
      r.setProperty('--disc-h', Math.round(h) + 'px');
    } else {
      r.setProperty('--disc-h', '0px');
    }
  }
  publishChromeVars();
  addEventListener('resize', publishChromeVars);

  // Scroll-hiding top pane (native app feel). On mobile widths the sticky header
  // slides up on scroll-down and returns on scroll-up; it never hides at the very
  // top and is force-shown whenever the ☰ panel opens (its anchor must be on
  // screen). Desktop (>=900px) keeps a persistent header — that's where the
  // .desktop-primary quick-nav lives, so hiding it would strand navigation.
  (function () {
    const hdr = document.querySelector('.gov-header');
    if (!hdr) return;
    const panel = document.getElementById('menu-panel');
    const mobile = window.matchMedia('(max-width: 899px)');
    const show = () => hdr.classList.remove('hdr-hidden');
    const hide = () => hdr.classList.add('hdr-hidden');
    // Hysteresis, not per-frame direction. The old handler flipped on the sign of
    // every delta, so momentum and rubber-band scrolling — which jitter the scroll
    // position back and forth by a pixel or two near the turning point — strobed the
    // header hidden<->shown, each toggle restarting the .24s slide. That stutter IS
    // the "choppy". Instead accumulate distance in the current direction and only
    // flip past a threshold; a direction change resets the accumulator, so the next
    // flip needs a fresh, deliberate gesture rather than scroll noise.
    let lastY = Math.max(0, window.scrollY), accum = 0, ticking = false;
    const HIDE_AT = 48;   // sustained downward px before it hides
    const SHOW_AT = 24;   // upward px before it returns — smaller, so it comes back eagerly
    function onScroll() {
      if (!mobile.matches) { show(); return; }
      const y = Math.max(0, window.scrollY);
      const dy = y - lastY;
      lastY = y;
      // Always shown near the top, and whenever the ☰ panel is open (its anchor
      // must stay on screen).
      if (y < 8 || (panel && !panel.hidden)) { show(); accum = 0; return; }
      if ((dy > 0) !== (accum > 0)) accum = 0;   // reversal → start the count over
      accum += dy;
      if (accum > HIDE_AT) hide();
      else if (accum < -SHOW_AT) show();
    }
    addEventListener('scroll', () => {
      if (!ticking) { requestAnimationFrame(() => { onScroll(); ticking = false; }); ticking = true; }
    }, { passive: true });
    mobile.addEventListener('change', show);
    if (panel) new MutationObserver(() => { if (!panel.hidden) show(); })
      .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  })();
  addEventListener('orientationchange', () => setTimeout(publishChromeVars, 150));

  // The 🦅 emoji crest renders as a different glyph on every platform (and reads
  // like a sticky note next to the wordmark). Swap in the real crest once, here,
  // so all pages get it without touching 25 files.
  document.querySelectorAll('.crest').forEach((c) => {
    if (!/[\u{1F300}-\u{1FAFF}]/u.test(c.textContent)) return;
    // APP-ONLY divergence: inside the native shell the header follows the theme
    // (white bar in light mode - styles.css html.native-app), so the app uses the
    // TRANSPARENT crest (logo-crest.svg). The public website keeps its green bar
    // and its green badge (icon-192.png), which reads on green.
    c.innerHTML = document.documentElement.classList.contains('native-app')
      ? '<img src="logo-crest.svg?v=hdr1" alt="" width="30" height="30" style="display:block" />'
      : '<img src="icon-192.png?v=hawk2" alt="" width="30" height="30" style="display:block;border-radius:7px" />';
  });

  // Bottom tab bar (mobile app pattern) — one raised center action, 5 slots,
  // consistent on every page. APP SHELL: the Capacitor native app AND an
  // INSTALLED PWA (standalone display-mode) — both ARE the app experience, so
  // both get native-style bottom tabs (parity). A plain browser tab (mobile or
  // desktop web) keeps its header nav/bell/footer instead. has-tabbar hides the
  // footer, so an installed PWA gets exactly the native chrome, not both.
  const inAppShell = isAppShell();
  // GOOGLE PLAY "Misleading Claims" COMPLIANCE (rejection, 2026-08-03).
  // Any app presenting government-related information must, in-app, (a) state
  // plainly that it does not represent the government entity and (b) link the
  // official source. Injected on every page so it can never be missed, and it
  // sits directly under the page heading where the data is. The web footer says
  // the same thing, but the app shell hides that footer — which is exactly the
  // surface the reviewer saw.
  (function govDisclaimer() {
    /**
     * ONLY THE PAGES THAT NEED IT — mirroring the app, which renders
     * GovDisclaimer on eight screens and nowhere else.
     *
     * This is a compliance notice, not a brand element: it is a stain on the
     * design that we carry where we must, so it belongs on as few pages as
     * possible. It was being injected into EVERY page, including ones that show
     * no election figures at all and therefore cannot be mistaken for a
     * government source — Privacy, Terms, FAQ, the report flows.
     *
     * The list is the app's, page for page: the leaderboard, the presidency, a
     * race, the race index, Osun, integrity and political data — every surface
     * that presents FIGURES a reader could take for official. Native's More
     * screen is the eighth; its web counterpart is the ☰ panel, which is not a
     * page, so the notice rides the pages instead.
     */
    var NEEDS_DISCLAIMER = [
      'results.html', 'candidates.html', 'race.html', 'races.html',
      'osun.html', 'integrity.html', 'political.html',
    ];
    var page = (location.pathname.split('/').pop() || 'index.html');
    if (NEEDS_DISCLAIMER.indexOf(page) === -1) return;

    /**
     * THE LANDING PAGE HAD NO DISCLAIMER AT ALL.
     *
     * This required a <main>, and index.html's only <main> lives inside
     * div.home-obs — the SIGNED-IN Observer Home, which is display:none for a
     * visitor. The signed-out landing page is a run of <section>s with no
     * <main>, so this bailed and the first page every new user and every Play
     * reviewer sees carried no government disclaimer whatsoever. That is very
     * likely part of why Play flagged "government information" twice.
     *
     * Fall back to the first visible section, so a page cannot silently opt out
     * of the notice by not using <main>.
     */
    let main = document.querySelector('main');
    if (main && !main.offsetParent && main.closest('.home-obs')) main = null; // hidden Observer Home
    if (!main) {
      const cand = [...document.querySelectorAll('body > section, body > .wrap, body > div')]
        .find((el) => el.offsetParent !== null && !el.classList.contains('gov-disclaimer'));
      main = cand || null;
    }
    if (!main || document.querySelector('.gov-disclaimer')) return;
    // One-liner keeps the Play-critical claim (independent, not affiliated with
    // INEC) always visible without interaction; the full statement + official
    // links live in a modal so the banner stops dominating every page's layout.
    const bar = document.createElement('aside');
    bar.className = 'gov-disclaimer';
    // "Details" runs INLINE, right after the sentence it belongs to, so the whole
    // notice wraps as two lines of ordinary prose instead of a text column beside
    // its own right-aligned button.
    // "independent," is dropped so the notice + inline Details fit two lines on a
    // phone (73 chars ran to three). Both Play-critical claims survive: it is not
    // a government service, and it is not affiliated with INEC. "Independent" is
    // still stated in full in the modal.
    // A span, NOT a <button>: a button is inline-block, and its line box pushed
    // "Details" onto a third line even though the content only needed two.
    // role/tabindex + the keydown handler below keep it a real control.
    // One line. The modal carries the full statement, so the bar only has to
    // make the claim itself — that Hawkeye is neither government nor INEC.
    // THE SOURCE LINK IS VISIBLE, not only inside the modal. Google Play rejected
    // the app twice under Misleading Claims — "provides government information but
    // lacks one or more clear and accessible URL/link(s) to the original
    // source(s)". The full statement and both sources were already one tap away
    // under "Details", but a reviewer (and a reader) sees only the claim of
    // non-affiliation unless the source is on the face of the bar. It is now.
    // WORDING MATTERS AS MUCH AS THE LINK. "Official source: inecnigeria.org"
    // was wrong: Hawkeye's figures come from OBSERVERS, not from INEC, and
    // labelling INEC as the source of what is on screen implies exactly the
    // affiliation the rest of this bar denies. INEC is named as the official
    // BODY — whose site is the source for the register and the official
    // declaration we check against — not as where these numbers came from.
    /**
     * EXACTLY THE APP'S BAR — one line, claim then Details, nothing else.
     * (native/src/components/gov-disclaimer.tsx.)
     *
     * It used to carry the whole statement on its face — "Figures are crowd
     * reports; official results come from INEC — inecnigeria.org" — which ran to
     * three lines on a phone, above every page.
     *
     * ON THE PLAY REJECTION, since the long version was written to answer it:
     * Play rejected the Capacitor build twice under Misleading Claims for
     * lacking a visible source link, and the fix was putting inecnigeria.org on
     * the bar. That is no longer the evidence available. The native app SHIPPED
     * to Play on 2026-08-19 carrying this exact one-line bar, with the source
     * links in the modal, and was accepted. A published app beats an inference
     * drawn from an older rejection, and the sources are still one tap away.
     */
    bar.innerHTML = '<strong>Not government or INEC affiliated.</strong> '
      + '<span class="gov-disc-more" role="button" tabindex="0">Details ›</span>';
    // On the sign-in / sign-up screen the disclaimer goes BELOW the form: it is a
    // legal footnote, and at the top of a bare auth page it was the first and
    // loudest thing on screen, overshadowing the brand.
    if (document.documentElement.classList.contains('auth-screen')) main.appendChild(bar);
    else main.insertBefore(bar, main.firstChild);
    // publishChromeVars() already ran, before this bar existed, so --disc-h is
    // still 0 and the one-screen hero would size itself as if the notice were
    // not there. Re-measure now that it is in the document.
    publishChromeVars();
    let dlg = document.getElementById('gov-disc-modal');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'gov-disc-modal';
      dlg.className = 'gov-disc-modal';
      // tabindex on the heading so focus can land HERE on open. <dialog>.showModal()
      // otherwise focuses the first focusable child — the inecnigeria.org link —
      // which renders as a preselected link nobody asked for.
      // Same pinned-heading / scrolling-body / pinned-Close shape as the info
      // dialog — this one carries the INEC links at the BOTTOM of its text, and
      // a Play compliance notice whose sources scroll out of reach is worse than
      // one that is merely long.
      dlg.innerHTML = '<h2 tabindex="-1">Not a government service</h2>'
        + '<div class="info-body">'
        + '<p>Hawkeye is an independent, citizen-run transparency tool. It is not affiliated with, '
        + 'endorsed by, or acting on behalf of INEC or any government entity, and it does not declare '
        + 'election results. Figures here are unofficial crowd reports. Official results and electoral '
        + 'information come from INEC:</p>'
        + '<p class="gov-disc-links"><a href="https://www.inecnigeria.org" target="_blank" rel="noopener">inecnigeria.org</a> '
        + '&middot; <a href="https://www.inecelectionresults.ng" target="_blank" rel="noopener">inecelectionresults.ng</a></p>'
        + '</div>'
        + '<button type="button" class="gov-disc-close">Close</button>';
      document.body.appendChild(dlg);
      dlg.querySelector('.gov-disc-close').onclick = () => dlg.close();
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    }
    // Open, then move focus to the heading — announces the modal's title to a
    // screen reader and stops the first link reading as preselected.
    const openDisc = () => {
      dlg.showModal();
      dlg.querySelector('h2')?.focus();
    };
    const more = bar.querySelector('.gov-disc-more');
    more.onclick = () => openDisc();
    // A <span role="button"> gets no key handling for free, unlike the <button>
    // it replaced. Enter and Space are what a button responds to.
    more.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDisc(); }
    };
  })();

  /**
   * INFO DOTS. Explanatory prose is the single biggest consumer of vertical space
   * on these pages, and almost none of it is read twice. Anything that explains
   * rather than instructs becomes an ⓘ next to the thing it explains:
   *
   *   <h2>Election Integrity <button class="info-i" data-info="…long text…"></button></h2>
   *
   * Attribute-driven and delegated, so a page only has to move its paragraph
   * into `data-info` — no per-page JS. Instructions inside a flow (which photo
   * to take, what to type) stay visible; those are not explanations.
   */
  (function infoDots() {
    let dlg = null;
    const open = (title, body, links) => {
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.className = 'gov-disc-modal info-modal';
        // The prose and its links live in .info-body, which is the part that
        // SCROLLS — the heading and Close stay pinned either side of it. A dot
        // carrying four paragraphs (the docket) otherwise pushed Close off the
        // screen, or was clipped outright.
        dlg.innerHTML = '<h2 tabindex="-1"></h2>'
          + '<div class="info-body"><p></p><div class="info-links"></div></div>'
          + '<button type="button" class="gov-disc-close">Close</button>';
        document.body.appendChild(dlg);
        dlg.querySelector('.gov-disc-close').onclick = () => dlg.close();
        dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      }
      const h = dlg.querySelector('h2');
      h.textContent = title || 'About this';
      h.hidden = !title;
      dlg.querySelector('p').textContent = body;
      // Optional sources, as REAL links. The body is set with textContent (so a
      // dot can carry arbitrary text safely), which means a URL written in it
      // would render as dead characters. Anything a reader is meant to click
      // has to come through here instead: data-info-links="Name|https://…"
      // one per line.
      const box = dlg.querySelector('.info-links');
      const raw = links || '';
      box.innerHTML = '';
      box.hidden = !raw;
      for (const line of String(raw).split('\n')) {
        const [name, href] = line.split('|').map((x) => (x || '').trim());
        if (!name || !/^https?:\/\//.test(href || '')) continue;
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = name + ' \u2197';
        box.appendChild(a);
      }
      dlg.showModal();
      h.focus();
    };
    // Exposed so a flow can raise the SAME dialog for a blocking condition —
    // e.g. "reporting is not open yet" on submit — instead of a third modal
    // implementation, or a status line under a button nobody scrolls back to.
    window.HAWKEYE_MODAL = open;
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('.info-i');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      open(b.getAttribute('data-info-title') || '', b.getAttribute('data-info') || '',
        b.getAttribute('data-info-links') || '');
    });
    // Label every dot for screen readers without repeating it in the markup.
    const label = () => document.querySelectorAll('.info-i:not([aria-label])').forEach((b) => {
      b.setAttribute('aria-label', 'More information');
      b.setAttribute('type', 'button');
    });
    label();
    new MutationObserver(label).observe(document.body, { childList: true, subtree: true });
  })();

  // APP SHELL HEADER: the crest already says whose app this is, so the row
  // carries the PAGE's name instead of repeating "HAWKEYE" on every screen (and
  // the strapline, which read as clutter on a phone). Web keeps the wordmark.
  // Runs EVERYWHERE now, not only in the app shell: the website carried the page
  // name twice — once in an in-page <h1>, once implicitly in the tab title —
  // while the header said nothing about where you were. Naming the page in the
  // header and dropping the duplicate H1 is the same trade the Capacitor shell
  // already makes, and it buys back a whole heading's worth of vertical space on
  // every page. The crest still carries the brand.
  {
    const bt = document.querySelector('.gov-header .brand-text');
    if (bt) {
      const page = (location.pathname.replace(/^.*\//, '') || 'index.html');
      const h1 = document.querySelector('main h1');
      // Explicit header names where the page's own H1 is a poor fit — multi-step
      // flows whose H1 changes as you advance (observe, practice), and pages whose
      // H1 is longer or worded differently from what the menu calls them.
      const TITLES = {
        'index.html': 'HAWKEYE',
        'observe.html': 'Report a Result',
        'practice.html': 'Practice',
        'dashboard.html': 'Reports Log',
        'collation.html': 'Report Collation Result',
        'candidates.html': 'Presidency 2027',
        'osun.html': 'Osun 2026',
      };
      const title = TITLES[page]
        || ((h1 && h1.textContent) || document.title.split('—').pop() || '').trim();
      // The header now names the page, so an H1 repeating it is dead weight.
      if (h1 && title && h1.textContent.trim() === title) h1.hidden = true;
      if (title) {
        bt.innerHTML = '';
        const st = document.createElement('strong');
        st.textContent = title;
        bt.appendChild(st);
        // A page name is prose, not a wordmark — the brand's wide tracking and
        // uppercase treatment make "Report Collation Result" unreadable. Home
        // keeps the wordmark styling because its title IS the wordmark.
        bt.classList.toggle('is-page', title !== 'HAWKEYE');
      }
    }
  }

  if (inAppShell && !document.querySelector('.tabbar')) {
    const page = (location.pathname.replace(/^.*\//, '') || 'index.html');
    const ic = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    const TABS = [
      { href: 'index.html', label: 'Home', icon: '<path d="M3 11 12 4l9 7"/><path d="M5 10v9h5v-6h4v6h5v-9"/>' },
      { href: 'results.html', label: 'Results', icon: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="14" width="3" height="3"/>' },
      { href: 'observe.html', label: 'Report', cta: true, icon: '<circle cx="12" cy="13.5" r="3"/><path d="M4 8.5h3L8.5 6.5h7L17 8.5h3v10H4z"/>' },
      { href: 'notifications.html', label: 'Alerts', bell: true, icon: '<path d="M6 9a6 6 0 1 1 12 0c0 4.5 2 5.5 2 5.5H4S6 13.5 6 9"/><path d="M10 20a2 2 0 0 0 4 0"/>' },
      { href: '#more', label: 'More', more: true, icon: '<path d="M4 6h16M4 12h16M4 18h16"/>' },
    ];
    const isOn = (h) => h.replace(/#.*/, '') === page;
    const nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = TABS.map((t) => `<a class="tab${t.cta ? ' tab-cta' : ''}${isOn(t.href) ? ' on' : ''}" href="${t.href}"${t.more ? ' data-more="1"' : ''}${t.cta ? ' data-report="1"' : ''}>`
      + `<span class="ti">${t.bell ? '<span class="tab-dot" hidden></span>' : ''}${ic(t.icon)}</span><span class="tl">${t.label}</span></a>`).join('');
    document.body.appendChild(nav);
    document.body.classList.add('has-tabbar');
    nav.querySelector('[data-more]').addEventListener('click', (e) => {
      e.preventDefault();
      // stopPropagation: the document-level closeIfOutside handler treats this
      // click as "outside the panel" and would instantly re-close what we open.
      e.stopPropagation();
      const p = document.getElementById('menu-panel');
      if (p) { p.hidden = !p.hidden; document.querySelector('.menu-btn')?.setAttribute('aria-expanded', String(!p.hidden)); }
    });

    // Report is a chooser, not a page: bottom action sheet -> Result / Incident.
    const sheet = document.createElement('div');
    sheet.className = 'report-sheet';
    sheet.hidden = true;
    sheet.innerHTML = `<div class="rs-backdrop"></div><div class="rs-panel" role="dialog" aria-label="What are you reporting?">
      <div class="rs-grab"></div><h3>What are you reporting?</h3>
      <!-- LABELS AND SUB-LINES ARE THE APP'S, VERBATIM
           (native/src/components/report-sheet.tsx). The two sheets are the same
           control reached from the same tab, and they were naming the same three
           actions differently — "Polling-unit result" against "Report a Result",
           "Incident" against "Report an Incident". Each option is an ACTION, so
           it starts with the verb. -->
      <a class="rs-opt" href="observe.html?intent=observe">${ic('<circle cx="12" cy="13.5" r="3"/><path d="M4 8.5h3L8.5 6.5h7L17 8.5h3v10H4z"/>')}
        <span><strong>Report a Result</strong><small>Photograph result sheet at your unit</small></span></a>
      <a class="rs-opt" href="incidents.html">${ic('<path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.5"/>')}
        <span><strong>Report an Incident</strong><small>Photo or video of what you witnessed</small></span></a>
      <a class="rs-opt" href="collation.html">${ic('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>')}
        <span><strong>Report a Collation</strong><small>Ward or LGA collation announcement</small></span></a>
    </div>`;
    document.body.appendChild(sheet);
    const openSheet = (o) => { sheet.hidden = !o; document.body.style.overflow = o ? 'hidden' : ''; };
    nav.querySelector('[data-report]').addEventListener('click', (e) => { e.preventDefault(); openSheet(true); });
    sheet.querySelector('.rs-backdrop').addEventListener('click', () => openSheet(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) openSheet(false); });
    const tk = localStorage.getItem('hawkeye_token');
    if (tk && !/notifications\.html/.test(location.pathname)) {
      fetch('/api/notifications', { headers: { authorization: 'Bearer ' + tk } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.unread > 0) { const dot = nav.querySelector('.tab-dot'); if (dot) { dot.textContent = d.unread > 9 ? '9+' : d.unread; dot.hidden = false; } }
          appBadge(d);
        })
        .catch(() => {});
    }

    /* ================= FIRST-RUN TOUR ==================================
       The web twin of native's components/tour.tsx + lib/tour.ts: five cards,
       one per tab, in tab order, with Skip on every one.

       WHY IT LIVES IN menu.js, WITH ITS CSS IN styles.css, AND ADDS NO FILE.
       This file already builds the tab bar, the menu panel AND the report sheet
       on every page of the shell. `.report-sheet` directly above is the
       precedent: a modal owned by menu.js, styled in the shared sheet. A new
       app/tour.js would need a `?v=` pin added to every page plus a decision
       about app/sw.js's precache list; zero new files is zero pin coordination.

       SHELL ONLY, exactly like the tab bar it describes (this whole block sits
       inside `if (inAppShell ...)`). The five cards are literally about the five
       tabs, and the website has no tab bar -- a tour describing controls that
       are not on screen would be worse than no tour at all.
       =================================================================== */

    /** The SAME key name native uses for AsyncStorage (lib/tour.ts SEEN_KEY). */
    const TOUR_SEEN_KEY = 'hawkeye_tour_seen';
    /**
     * Five steps, one per tab, in tab order.
     *
     * TITLES AND BODIES ARE NATIVE'S, VERBATIM -- copied from TOUR_STEPS in
     * native/src/lib/tour.ts and not reworded. tests/tour_test.mjs PARSES that
     * file at test time and diffs it against what this renders, so the two
     * clients cannot drift apart silently: reword it there and here in the same
     * commit, or the test goes red.
     *
     * `route` is the tab's href in TABS above, not a position. Native learned
     * this the hard way: when order was the only link between a step and its
     * tab, reordering the steps silently pointed every one of them at the wrong
     * one. `cta` marks the step that describes the raised green Report button so
     * its chip is drawn AS that button rather than as a generic icon -- a flag,
     * not `icon === 'camera'`, because what makes Report special is that it is
     * the CTA, not which glyph it happens to use.
     */
    const TOUR = [
      { route: 'index.html', title: 'Home',
        body: 'Elections open now, reports accepted so far, and a live feed.' },
      { route: 'results.html', title: 'Results',
        body: 'Pick a race for its map and running tally. Follow one to get alerts.' },
      { route: 'observe.html', cta: true, title: 'Report — the green button',
        body: 'Report a result sheet, a collation result, or an incident. This is what makes you an observer.' },
      { route: 'notifications.html', title: 'Alerts',
        body: 'What has happened on the races you follow — reports accepted, units flagged, and anything Hawkeye needs to tell you.' },
      { route: '#more', title: 'More',
        body: 'Practice runs, the ledger, the docket and the guide. Start with Practice Run.' },
    ];
    /**
     * The nonpartisan line, on the FIRST card only (native: tour.tsx renders it
     * when i === 0). It is the first thing the app says to a new observer
     * everywhere else -- the board, the race pages and the store listing all
     * carry it -- and a welcome card that omitted it would be the one place
     * Hawkeye introduced itself without it.
     */
    const TOUR_NOTE = 'Hawkeye is independent and nonpartisan. It is not affiliated with INEC or any government body, and it does not declare results — it records what observers report and lets anyone check the record.';

    /**
     * HAS THIS DEVICE SEEN IT? FAILS CLOSED, the direction native argues for in
     * shouldShowTour(): an unreadable flag means we cannot prove the tour was
     * shown, and showing it once more to one person is a far smaller cost than a
     * storage fault putting it in front of everyone on every launch -- which is
     * what the other direction eventually does, once the write fails too.
     */
    let tourSeenThisRun = false;
    const tourSeen = () => {
      if (tourSeenThisRun) return true;
      try { return localStorage.getItem(TOUR_SEEN_KEY) !== null; } catch (e) { return true; }
    };
    /** Finished OR skipped -- the same fact. An app that re-asks tomorrow has not listened. */
    const markTourSeen = () => {
      tourSeenThisRun = true;   // synchronous first, before the write that can fail
      try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (e) { /* never worth an error */ }
    };

    const tour = document.createElement('div');
    tour.className = 'tour';
    tour.hidden = true;
    tour.innerHTML = '<div class="tour-backdrop"></div>'
      // tabindex=-1 so the CARD can take focus on open. Focusing the Next
      // button instead put a second, louder gold ring on screen at the exact
      // moment the tour is asking the reader to look at a gold ring on a tab —
      // and the dialog container is what WAI-ARIA says to focus anyway.
      + '<div class="tour-card" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="tour-title">'
      // A DELIBERATE EXIT, IN THE CORNER. The backdrop no longer dismisses (see
      // below), so leaving has to be possible somewhere obvious — and the footer
      // slot that used to do it is now Back.
      + '<button type="button" class="tour-x" aria-label="Close tour">\u00d7</button>'
      + '<h3 id="tour-title">Welcome to Hawkeye</h3>'
      // The body scrolls and the footer is its SIBLING, not its last child --
      // native's ModalCard exists to enforce exactly those two rules, because a
      // primary action reachable only by scrolling is a bug this codebase has
      // already shipped once.
      + '<div class="tour-body"><div class="tour-step">'
      + '<span class="tour-chip" aria-hidden="true"></span><strong class="tour-name"></strong></div>'
      + '<p class="tour-text"></p><p class="tour-note"></p></div>'
      + '<div class="tour-foot">'
      // Progress FIRST, so the reader knows how long this is before deciding
      // whether to skip. Five dots, not "1 of 5" -- the shape of the thing is
      // the answer to the question being asked.
      + '<div class="tour-dots" aria-hidden="true">' + TOUR.map(() => '<span></span>').join('') + '</div>'
      // BACK, NOT SKIP. Five cards is enough that missing one matters, and there
      // was no way back — the only two controls advanced or left. Leaving now
      // lives in the corner cross, which is harder to hit by accident than a
      // full-width footer button sitting under the thumb.
      + '<div class="tour-actions">'
      + '<button type="button" class="tour-skip"></button>'
      + '<button type="button" class="tour-next"></button>'
      + '</div></div></div>';
    document.body.appendChild(tour);

    /**
     * LIGHT THE REAL TAB THIS CARD IS ABOUT.
     *
     * Native has to publish the route to a module store and let the tab bar draw
     * the ring itself, because an RN <Modal> is a separate native window above
     * the React root. In Lite the bar is real DOM built a few lines up, so the
     * ring goes straight on it -- simpler, same result.
     *
     * Clearing matters as much as setting: a ring left burning after the tour
     * closes is a tab that looks permanently selected. Every exit runs through
     * endTour(), which calls this with null first.
     */
    const litTab = (route) => {
      for (const t of nav.querySelectorAll('.tab')) t.classList.remove('tour-lit');
      if (!route) return;
      const el = nav.querySelector('.tab[href="' + route + '"]');
      if (el) el.classList.add('tour-lit');
    };

    /**
     * HOW FAR SHORT OF THE BOTTOM THE SCRIM STOPS -- so the ringed tab shows
     * through LIT rather than dimmed to the same grey as everything else, which
     * is the opposite of pointing at it.
     *
     * MEASURED, never a magic number. The bar's height varies with
     * env(safe-area-inset-bottom) on the phone, and the raised Report circle
     * overhangs the bar's top edge (margin-top: -22px against the 9px of padding
     * above it), so a scrim that stopped at the bar would clip the ring on
     * exactly the step that most needs it. Native computes this from exported
     * constants (BAR_CONTENT_HEIGHT + insets.bottom + CTA_LIFT) because it has
     * no DOM to ask; here the DOM can just be asked. Returns 0 when no bar is on
     * screen, which is also the signal not to open at all.
     */
    const tourGap = () => {
      const bar = document.querySelector('.tabbar');
      if (!bar || getComputedStyle(bar).display === 'none') return 0;
      let top = bar.getBoundingClientRect().top;
      const cta = bar.querySelector('.tab-cta .ti');
      if (cta) top = Math.min(top, cta.getBoundingClientRect().top - 4);   // -4: clear the gold ring
      return Math.max(0, Math.round(window.innerHeight - top));
    };

    let ti = 0;
    const paintTour = () => {
      const s = TOUR[ti];
      const last = ti === TOUR.length - 1;
      const tab = TABS.find((t) => t.href === s.route);
      // The chip wears the tab bar's OWN glyph for that tab, not a lookalike:
      // the card is a picture of the control six centimetres below it.
      tour.querySelector('.tour-step').classList.toggle('is-cta', !!s.cta);
      tour.querySelector('.tour-chip').innerHTML = tab ? ic(tab.icon) : '';
      tour.querySelector('.tour-name').textContent = s.title;
      tour.querySelector('.tour-text').textContent = s.body;
      const note = tour.querySelector('.tour-note');
      note.textContent = ti === 0 ? TOUR_NOTE : '';
      note.hidden = ti !== 0;
      tour.querySelectorAll('.tour-dots span').forEach((d, n) => d.classList.toggle('on', n === ti));
      const back = tour.querySelector('.tour-skip');
      back.textContent = 'Back';
      // Nothing behind card one. Disabled rather than hidden, so the footer does
      // not change shape as the reader moves through it.
      back.disabled = ti === 0;
      tour.querySelector('.tour-next').textContent = last ? 'Start observing' : 'Next';
      tour.style.setProperty('--tour-gap', tourGap() + 'px');
      tour.querySelector('.tour-body').scrollTop = 0;
      litTab(s.route);
    };

    /**
     * THE REPLAY ROW ONLY EXISTS WHEN THE BAR DOES. `isAppShell()` is also true
     * for an INSTALLED DESKTOP PWA, where `.tabbar { display: none }` above
     * 899px -- and on any shell screen that hides the bar (the signed-out
     * landing, the auth screen). The row was injected regardless, so a desktop
     * reader could open five cards about a tab bar that is not on screen, under
     * a full-bleed scrim, with the ring on invisible elements. That is the exact
     * thing the shell-only gate exists to prevent, reached by the other door.
     *
     * Hidden rather than deleted: the same window becomes a phone-width one on
     * rotation or a resize, and the row comes back with the bar (see the resize
     * listener below). It needs `.menu-panel a[hidden] { display: none }` in
     * styles.css -- the panel sets `display: block` on its anchors, which
     * outranks the user agent's [hidden] rule.
     */
    const tourRow = document.querySelector('#menu-panel a[href="#tour"]');
    const syncTourRow = () => { if (tourRow) tourRow.hidden = tourGap() === 0; };
    syncTourRow();

    // Assigned to the outer `openTour`, which the menu panel's "Take the tour"
    // row (built ~650 lines above, before any of this exists) calls. Always from
    // card one, and regardless of the seen flag -- that row IS the replay.
    openTour = () => {
      // ONE GATE, BOTH DOORS. The first-run trigger at the foot of this block
      // asks the same question; asking it here too means the replay cannot walk
      // round it if the row is ever stale (a resize between opening the panel
      // and tapping the row).
      if (tourGap() === 0) return;
      ti = 0;
      tour.hidden = false;
      document.body.style.overflow = 'hidden';
      paintTour();
      tour.querySelector('.tour-card').focus();
    };
    /**
     * ONE EXIT for Skip, Close, the backdrop and Escape alike. Tapping the
     * backdrop is a deliberate exit too and counts as skipping -- an app that
     * reopened the tour on the next launch because the reader dismissed it the
     * quickest way would be arguing with them. All of them write the same flag.
     */
    const endTour = () => {
      litTab(null);
      markTourSeen();
      ti = 0;
      tour.hidden = true;
      // Give the page its scroll back only if nothing ELSE is holding it. The
      // report sheet locks the same single property, and `= ''` here would
      // unlock the page under a sheet that is still open. Unreachable today --
      // the scrim covers the bar, so the sheet cannot be opened from behind the
      // tour any more -- but the two modals share one lock and only one of them
      // can be right about releasing it.
      document.body.style.overflow = sheet.hidden ? '' : 'hidden';
    };
    // BACK, one card at a time.
    tour.querySelector('.tour-skip').addEventListener('click', () => {
      // paintTour, NOT paint. There is a `paint` in this file already — the theme
      // toggle's — so calling it here resolved to that closure instead of
      // throwing, and Back silently did nothing at all.
      if (ti > 0) { ti -= 1; paintTour(); }
    });
    tour.querySelector('.tour-x').addEventListener('click', endTour);
    // THE BACKDROP NO LONGER DISMISSES. A tap outside the card is the easiest
    // gesture to make by accident — reaching for a tab, steadying the phone —
    // and it silently ended the tour AND wrote the seen flag, so it never came
    // back. Leaving is now the corner cross or Escape: both deliberate.
    tour.querySelector('.tour-next').addEventListener('click', () => {
      if (ti >= TOUR.length - 1) { endTour(); return; }
      ti += 1;
      paintTour();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tour.hidden) endTour(); });
    /**
     * TAB STAYS INSIDE THE CARD. It says `aria-modal="true"`, and a dialog that
     * lets the keyboard walk out into the page it is covering has made that
     * claim untrue. Native gets this for free -- an RN <Modal> is a separate
     * window and there is nothing behind it to reach -- so this is the web
     * paying for the same guarantee. Two controls, so the cycle is two long;
     * from the card itself (which holds focus on open) Tab lands on Skip.
     */
    tour.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const f = [tour.querySelector('.tour-x'), tour.querySelector('.tour-skip'), tour.querySelector('.tour-next')]
        .filter((el) => el && !el.disabled);
      const at = f.indexOf(document.activeElement);
      const n = e.shiftKey ? (at <= 0 ? f.length - 1 : at - 1) : (at === f.length - 1 ? 0 : at + 1);
      f[n].focus();
    });
    /**
     * LEAVING THE PAGE IS AN EXIT TOO, and it writes the same flag.
     *
     * Android's hardware Back is outside this dialog's reach: native routes it
     * through `<Modal onRequestClose>` into the same finish(), a WebView just
     * navigates and the document goes away mid-tour with the flag unwritten --
     * and the tour would then reopen on the next visit to Home, which is the one
     * thing the flag exists to prevent. Deliberately NOT a Capacitor backButton
     * listener: registering one disables the app's default Back on every page of
     * the shell, which is a far larger change than a tour is worth.
     */
    addEventListener('pagehide', () => { if (!tour.hidden) markTourSeen(); });
    // The bar's height changes with rotation, the keyboard and the WebView's
    // retracting toolbar; a stale gap would either dim the bar or leave a band.
    // The same event decides whether the replay row belongs in the menu, since
    // what it depends on -- a rendered tab bar -- is what changed.
    addEventListener('resize', () => {
      if (!tour.hidden) tour.style.setProperty('--tour-gap', tourGap() + 'px');
      syncTourRow();
    });

    /**
     * FIRST RUN -- opens by itself the first time the app reaches Home, and
     * never again. Native hangs this off (tabs)/index rather than any auth
     * handler, deliberately: five different sign-in paths land on Home and a
     * trigger on one of them would silently miss the other four. index.html is
     * the web twin of that screen.
     *
     * ONE CONDITION MORE THAN NATIVE, forced by Lite rather than chosen:
     * index.html in the shell is TWO screens. Signed out it is the welcome/auth
     * screen, which hides the header AND the tab bar (styles.css:
     * `.native-app.is-landing:not(.obs-home) .tabbar { display: none }`). Native
     * has no such screen inside its tab shell. Five cards pointing at a bar that
     * is not rendered would be worse than none, so the trigger ASKS THE DOM
     * whether the bar is on screen rather than assuming it -- which also, for
     * free, keeps the tour off desktop widths, where the bar is display:none.
     */
    if (page === 'index.html' && tourGap() > 0 && !tourSeen()) openTour();
  }

  // Mascot trial: swap the emoji crest for the hawk mark on every page from
  // one place (pages keep the emoji as a no-JS fallback).
  for (const c of document.querySelectorAll('.crest')) {
    // APP-SHELL header (the Capacitor/tab-bar chrome) — same swap as the website
    // header above, and it must use the same artwork or the two disagree. This is
    // the one the phone actually shows.
    c.innerHTML = document.documentElement.classList.contains('native-app')
      ? '<img src="logo-crest.svg?v=hdr1" alt="" style="width:36px;height:36px;display:block" />'
      : '<img src="icon-192.png?v=hawk2" alt="" style="width:36px;height:36px;display:block;border-radius:8px" />';
  }

  // Accessibility: skip-to-content link, first in the tab order.
  const main = document.querySelector('main');
  if (main && !document.querySelector('.skip-link')) {
    if (!main.id) main.id = 'main';
    const skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = `#${main.id}`;
    skip.textContent = 'Skip to content';
    document.body.prepend(skip);
  }

  // Shared helpers + canonical footer (one source of truth for every page).
  window.timeAgo = (ts) => {
    const d = new Date(ts); const diff = (Date.now() - d.getTime()) / 1000;
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (d.toDateString() === new Date().toDateString()) return `today ${hm}`;
    if (diff < 172800) return `yesterday ${hm}`;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${hm}`;
  };
  const foot = document.querySelector('.gov-footer nav');
  if (foot) {
    foot.innerHTML = '<a href="about.html">About</a><a href="how.html">How Hawkeye Works</a>'
      + '<a href="privacy.html">Privacy Policy</a><a href="terms.html">Terms of Service</a>'
      + '<a href="faq.html">FAQ</a><a href="guide.html">Observer Guide</a>'
      + '<a href="support.html">Support</a>'
      + (localStorage.getItem('hawkeye_token') ? '<a href="profile.html">My Profile</a>' : '');
  }

  // Social bar in the footer — one source of truth, every page. Each icon renders
  // only when its `url` is a real link, so no dead/placeholder links ever ship.
  // Fill the four URLs below with the official Hawkeye account links.
  const SOCIAL = [
    { name: 'TikTok',    url: 'https://www.tiktok.com/@hawkeyengbot', svg: '<path d="M15.5 3c.3 2.3 1.9 3.9 4.5 4.1v2.7c-1.6.1-3.1-.4-4.5-1.3v6.1a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1v2.8a2.8 2.8 0 1 0 2 2.7V3z" fill="currentColor" stroke="none"/>' },
    { name: 'Instagram', url: 'https://www.instagram.com/hawkeyengbot/', svg: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="3.7"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/>' },
    { name: 'X',         url: 'https://x.com/HawkEyeNGBot', svg: '<path d="M4 4l6.9 8.4L4.3 20H7l5.1-5.7L16.6 20H20l-7.2-8.8L19.4 4H16.8l-4.6 5.2L8.2 4z" fill="currentColor" stroke="none"/>' },
    { name: 'Facebook',  url: 'https://www.facebook.com/people/Hawkeye/61591831703798/', svg: '<path d="M13.8 21v-8h2.2l.33-2.6H13.8V8.7c0-.75.23-1.26 1.3-1.26h1.4V5.1c-.24-.03-1.07-.1-2.03-.1-2.02 0-3.4 1.23-3.4 3.5v1.9H8.9V13h2.17v8z" fill="currentColor" stroke="none"/>' },
  ];
  const shownSocial = SOCIAL.filter((s) => s.url);
  const footWrap = document.querySelector('.gov-footer .wrap');
  if (shownSocial.length && footWrap && !footWrap.querySelector('.social-row')) {
    const row = document.createElement('div');
    row.className = 'social-row';
    row.innerHTML = shownSocial.map((s) => `<a href="${s.url}" target="_blank" rel="noopener me" aria-label="Hawkeye on ${s.name}" title="Hawkeye on ${s.name}"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.svg}</svg></a>`).join('');
    footWrap.insertBefore(row, footWrap.querySelector('nav') || footWrap.firstChild);
    if (!document.getElementById('social-row-css')) {
      const st = document.createElement('style');
      st.id = 'social-row-css';
      st.textContent = '.gov-footer .social-row{display:flex;gap:12px;justify-content:center;margin:0 0 14px}'
        + '.gov-footer .social-row a{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;border:1px solid var(--border,#dde4de);color:var(--muted,#5b6b62);margin:0;transition:color .15s,border-color .15s}'
        + '.gov-footer .social-row a:hover{color:var(--green,#004225);border-color:var(--green,#004225)}';
      document.head.appendChild(st);
    }
  }

  // "INEC" is linked to the commission's site ONLY inside the footer — never in
  // body copy (a link on every mention read as endorsement/affiliation and
  // cluttered the prose). Runs over the footer now and once more after async
  // content settles.
  const INEC_URL = 'https://www.inecnigeria.org';
  function linkInec(root) {
    const skip = /^(A|SCRIPT|STYLE|TITLE|TEXTAREA|INPUT|SELECT|OPTION|CODE)$/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\bINEC\b/.test(n.nodeValue) && n.parentElement && !skip.test(n.parentElement.tagName)
        // summary/button/label: injecting a link INSIDE another interactive
        // element is a WCAG nested-interactive violation (axe, integrity.html).
        && !n.parentElement.closest('a, svg, summary, button, label')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      const parts = n.nodeValue.split(/\b(INEC)\b/);
      for (const part of parts) {
        if (part === 'INEC') {
          const a = document.createElement('a');
          a.href = INEC_URL;
          a.target = '_blank';
          a.rel = 'noopener';
          a.className = 'inec-link';
          a.textContent = 'INEC';
          frag.appendChild(a);
        } else if (part) frag.appendChild(document.createTextNode(part));
      }
      n.parentNode.replaceChild(frag, n);
    }
  }
  const linkInecFooters = () => document.querySelectorAll('.gov-footer').forEach((f) => linkInec(f));
  linkInecFooters();
  setTimeout(linkInecFooters, 2500);

  // Signed-in menu items. Sign-in happens WITHOUT a page load (the OTP pane on
  // observe.html just flips screens), so this has to be re-runnable rather than a
  // one-shot at script time — otherwise the menu keeps showing the signed-out
  // links until the user manually refreshes. Idempotent in both directions:
  // adds the links when a token appears, strips them when it goes away.
  function syncAuthMenu() {
    const signedIn = !!localStorage.getItem('hawkeye_token');
    const p = document.getElementById('menu-panel');
    if (p) {
      const present = !!p.querySelector('.auth-only');
      if (signedIn && !present) {
        // Section label, so the account links read as a group instead of three
        // orphans dangling under "Live data".
        const gl = document.createElement('div');
        gl.className = 'menu-group auth-only';
        gl.textContent = 'Your account';
        p.appendChild(gl);
        const add = (href, text, cls) => {
          const a = document.createElement('a');
          a.href = href;
          a.textContent = text;
          a.className = 'auth-only' + (cls ? ' ' + cls : '');
          p.appendChild(a);
          return a;
        };
        // Dashboard removed (native has no such entry) and My Profile now leads the
        // "Take part" section for everyone — so "Your account" carries just Sign out.
        // Sign out clears the token AND the device key so auto-resume can't
        // silently sign back in; sends the user to a fresh sign-up.
        add('#', 'Sign out', 'sign-out').addEventListener('click', (e) => {
          e.preventDefault();
          localStorage.removeItem('hawkeye_token');
          try {
            const rq = indexedDB.open('hawkeye', 1);
            rq.onsuccess = () => { try { rq.result.transaction('kv', 'readwrite').objectStore('kv').delete('keypair'); } catch { /* ignore */ } };
          } catch { /* ignore */ }
          // Sign out lands on index.html, NOT the sign-in form: in the app that's
          // the welcome screen and on the web it's the landing page. Dropping a
          // signed-out user straight onto a password field reads like an error.
          location.href = 'index.html';
        });
        // ("Delete my ID" moved into profile.html — one authoritative place.)
      } else if (!signedIn && present) {
        p.querySelectorAll('.auth-only').forEach((n) => n.remove());
      }
    }
    // Footer "My Profile" follows the same state.
    const fnav = document.querySelector('.gov-footer nav');
    if (fnav) {
      const link = fnav.querySelector('a[href="profile.html"]');
      if (signedIn && !link) {
        const a = document.createElement('a');
        a.href = 'profile.html';
        a.textContent = 'My Profile';
        fnav.appendChild(a);
      } else if (!signedIn && link) { link.remove(); }
    }
    // Header slot follows the same state (bell when signed in, Sign in when not).
    headerAuthControl();
    publishChromeVars();
  }
  syncAuthMenu();

  // A dozen call sites across app.js and the pages set/clear hawkeye_token.
  // Wrapping the two mutators once catches all of them (and any added later)
  // instead of sprinkling refresh calls everywhere. `storage` covers other tabs.
  try {
    const ls = window.localStorage;
    const set = ls.setItem.bind(ls);
    const del = ls.removeItem.bind(ls);
    ls.setItem = (k, v) => { set(k, v); if (k === 'hawkeye_token') syncAuthMenu(); };
    ls.removeItem = (k) => { del(k); if (k === 'hawkeye_token') syncAuthMenu(); };
  } catch { /* non-fatal: menu still syncs on next page load */ }
  window.addEventListener('storage', (e) => { if (!e.key || e.key === 'hawkeye_token') syncAuthMenu(); });

  // Size the ☰ dropdown to the space that ACTUALLY exists. The old CSS used a
  // fixed `100dvh - 180px`, which assumed a header height and ignored
  // env(safe-area-inset-top) — inside the APK the edge-to-edge header sits lower,
  // so the panel ran past the bottom tab bar and its last items (My Profile /
  // Sign out) were unreachable. Measuring the panel's real top and the real tab
  // bar height fixes it on any device, header size or inset.
  function sizeMenuPanel() {
    const p = document.getElementById('menu-panel');
    if (!p || p.hidden) return;
    const bar = document.querySelector('.tabbar');
    const barH = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().height : 0;
    const top = p.getBoundingClientRect().top;
    // visualViewport is the ONLY reliable height on mobile: window.innerHeight
    // counts the area under a retracted browser toolbar, and in the Capacitor
    // WebView it counts the gesture-bar inset too, so both over-report and the
    // panel's tail ends up behind the tab bar.
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    // A fixed tab bar may or may not include the safe-area inset in its own box
    // depending on how it padded itself, so read the inset and take whichever
    // reservation is larger rather than assuming.
    const probe = getComputedStyle(document.documentElement)
      .getPropertyValue('--safe-bottom').trim();
    const inset = parseFloat(probe) || 0;
    const bottom = Math.max(barH, barH + inset - 8);
    // Clear the assistant button too — a menu that ends underneath it looks
    // like the list was cut off, and the last row is unclickable either way.
    const fab = document.getElementById('hk-fab');
    const fabH = fab && getComputedStyle(fab).display !== 'none'
      ? Math.max(0, vh - fab.getBoundingClientRect().top - bottom) : 0;
    const avail = vh - top - bottom - fabH - 16;   // 16px breathing room
    p.style.maxHeight = Math.max(160, Math.round(avail)) + 'px';
    p.style.overflowY = 'scroll';   // permanent gutter — bar visible whenever cut off
    markScrollCue(p);
  }
  // "There's more below" cue. A styled scrollbar alone isn't enough on touch,
  // where scrollbars are invisible until you already scroll — so a sticky fade at
  // the bottom edge shows whenever the list is cut off, and clears at the end.
  function markScrollCue(p) {
    if (!p.querySelector('.menu-fade')) {
      const f = document.createElement('div');
      f.className = 'menu-fade';
      f.setAttribute('aria-hidden', 'true');   // decorative: never announced
      p.appendChild(f);
    }
    const more = p.scrollHeight - p.clientHeight > 4;
    p.classList.toggle('is-scrollable', more);
    p.classList.toggle('at-end', more && p.scrollTop + p.clientHeight >= p.scrollHeight - 4);
  }
  if (panel) {
    // Every page toggles the panel via its own inline onclick (and the More tab),
    // so observe the attribute instead of hooking each trigger.
    new MutationObserver(() => sizeMenuPanel()).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    panel.addEventListener('scroll', () => markScrollCue(panel), { passive: true });
    addEventListener('resize', sizeMenuPanel);
    // The WebView fires visualViewport resize (toolbar retract, keyboard) without
    // firing window resize, and that is exactly when the panel is mis-sized.
    if (window.visualViewport) window.visualViewport.addEventListener('resize', sizeMenuPanel);
    addEventListener('orientationchange', () => setTimeout(sizeMenuPanel, 150));
  }
})();

// ---- show/hide password ----------------------------------------------------
// Applied to EVERY password field on the site from one place (sign-in, the
// optional sign-up password, profile change-password, and the admin consoles) —
// 10 inputs across 7 pages, so doing it per-page would guarantee drift. Typing a
// password blind on a phone keyboard is the single most common cause of a failed
// sign-in, and the toggle is a real button with aria-pressed rather than an icon
// glued to the input, so it works with a keyboard and a screen reader.
(function () {
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.7 9.7 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-2.5 3.3M6.4 8A17 17 0 0 0 2 12s3.6 6.5 10 6.5a9.4 9.4 0 0 0 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function attach(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const b = document.createElement('button');
    b.type = 'button';                 // never submit the surrounding form
    b.className = 'pw-eye';
    b.tabIndex = 0;
    b.setAttribute('aria-label', 'Show password');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = EYE;
    b.addEventListener('click', () => {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      b.innerHTML = reveal ? EYE_OFF : EYE;
      b.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      b.setAttribute('aria-pressed', String(reveal));
      // Keep the caret where it was; don't yank the page around on mobile.
      try { input.focus({ preventScroll: true }); } catch { /* ignore */ }
    });
    wrap.appendChild(b);
  }

  let queued = false;
  const scan = () => {
    queued = false;
    document.querySelectorAll('input[type="password"]').forEach(attach);
  };
  scan();
  // Some fields only appear later (the optional sign-up password reveals on a
  // checkbox). attach() is idempotent, so re-scanning settles immediately.
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

// Floating results assistant (bottom-right). Non-partisan, read-only; mounts only
// where the server reports the feature is switched on. Skipped inside the Telegram
// Mini App and on the private review console.
(function () {
  if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) return;
  if (/\/review\.html$/.test(location.pathname)) return;
  // Not over the landing fold for first-time visitors: the hero is now sized to
  // exactly one screen, and the FAB sat on top of the stats band, covering
  // "reports publicly verifiable". Signed-in users see Observer Home there (real
  // data to ask about), so they still get it.
  if (/^\/(index\.html)?$/.test(location.pathname) && !localStorage.getItem('hawkeye_token')) return;
  // Never on the sign-up/sign-in flow: that screen is deliberately chrome-free in
  // the app, and a floating chat bubble over an auth form is noise everywhere.
  if (/observe\.html$/.test(location.pathname)) return;
  fetch('/api/assistant/health').then((r) => r.json()).then((h) => { if (h && h.enabled) mount(); }).catch(() => {});

  function mount() {
    const css = `
    #hk-fab{position:fixed;right:18px;bottom:18px;z-index:110;width:56px;height:56px;margin:0;padding:0;border-radius:50%;border:none;cursor:pointer;background:var(--green,#004225);color:#fff;font-size:22px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
    /* z-index 110, NOT 1200. At 1200 this button floated above EVERY modal in
       the app — the report sheet (120), the tour (130), the refusal modal (140)
       and the menu panel (80). With the tour open it was the only thing on
       screen still reacting to a tap, which reads exactly like a frozen app,
       and that is how it was reported. 110 keeps it above the tab bar (95) and
       the page, and below everything that is meant to block. */
    #hk-fab:hover{filter:brightness(1.08)}
    /* GOLD border, not the usual hairline. This panel floats over whatever page
       you were reading, and a 1px var(--line) edge is the same colour as every
       card underneath it — in dark mode especially it camouflaged, so it read as
       part of the page rather than as a thing sitting on top of it. Brand gold
       is the one accent not already used for a party colour or a status state,
       so it says "assistant" without competing with the results palette. The
       tinted shadow does the rest of the lifting off the page. */
    #hk-panel{position:fixed;right:18px;bottom:84px;z-index:1200;width:min(360px,calc(100vw - 36px));max-height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;background:var(--card,#fff);border:2px solid var(--gold,#f5b301);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.32),0 0 0 4px rgba(245,179,1,.16)}
    #hk-panel.open{display:flex}
    #hk-head{background:var(--green-darker,#00331e);color:#fff;padding:11px 14px;font-weight:700;font-size:.95rem;display:flex;justify-content:space-between;align-items:center;gap:8px;white-space:nowrap}
    #hk-head button{display:inline-block;width:auto;margin:0;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 2px;flex:none;box-shadow:none}
    #hk-msgs{flex:1;min-height:120px;overflow-y:auto;overscroll-behavior:contain;padding:14px;display:flex;flex-direction:column;gap:10px;font-size:.94rem;background:var(--bg,#f7f8f6)}
    .hk-b{padding:9px 12px;border-radius:12px;max-width:85%;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
    .hk-u{align-self:flex-end;background:var(--green,#004225);color:#fff;border-bottom-right-radius:4px}
    .hk-a{align-self:flex-start;background:var(--card,#fff);border:1px solid var(--line,#e3e8e4);color:var(--ink,#14201a);border-bottom-left-radius:4px}
    #hk-form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line,#e3e8e4);background:var(--card,#fff)}
    #hk-in{flex:1;min-width:0;width:auto;display:block;margin:0;border:1px solid var(--border,#dde4de);border-radius:10px;padding:9px 11px;font:inherit;font-size:16px;background:var(--card,#fff);color:var(--ink,#14201a)}
    #hk-form button{display:inline-block;width:auto;margin:0;flex:none;background:var(--green,#004225);color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer}
    #hk-note{font-size:.72rem;color:var(--muted,#5b6b62);padding:0 14px 10px;background:var(--bg,#f7f8f6)}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const fab = document.createElement('button');
    fab.id = 'hk-fab'; fab.setAttribute('aria-label', 'Ask Hawkeye about the results');
    // SVG, not the 💬 emoji: the emoji rendered differently on every platform and
    // read like a sticky note next to otherwise line-art iconography.
    fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-4.6A8.2 8.2 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>';
    const panel = document.createElement('div'); panel.id = 'hk-panel';
    panel.innerHTML = '<div id="hk-head"><span>Ask Hawkeye</span><button aria-label="Close" id="hk-x">×</button></div>'
      + '<div id="hk-msgs"></div>'
      + '<div id="hk-note">Crowd-reported, unofficial figures. INEC declares official results.</div>'
      + '<form id="hk-form"><input id="hk-in" autocomplete="off" placeholder="e.g. presidential tally so far" /><button>Ask</button></form>';
    document.body.append(fab, panel);
    const msgs = panel.querySelector('#hk-msgs');
    const add = (who, text) => { const d = document.createElement('div'); d.className = 'hk-b ' + (who === 'u' ? 'hk-u' : 'hk-a'); d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };
    let greeted = false;
    const close = () => panel.classList.remove('open');
    // Ask Hawkeye and the ☰ dropdown are mutually exclusive. Both open at once
    // is two overlapping panels over the page — unreadable, and neither reads as
    // the thing you just tapped.
    const closeMenu = () => {
      const m = document.getElementById('menu-panel');
      if (m && !m.hidden) {
        m.hidden = true;
        document.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'false');
      }
    };
    fab.onclick = (e) => {
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      if (open) closeMenu();
      if (open && !greeted) { greeted = true; add('a', 'Hi! Ask me about the crowd-reported results — a national tally, a polling unit, or how much of the country is mapped.'); }
    };
    // The other direction. Capture phase, because the ☰ button's own inline
    // onclick and the app-shell "More" tab both stop propagation before a
    // bubbling listener would ever see the click.
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (t && t.closest && (t.closest('.menu-btn') || t.closest('[data-more]') || t.closest('#menu-panel'))) close();
      },
      true,
    );
    panel.querySelector('#hk-x').onclick = close;
    panel.addEventListener('click', (e) => e.stopPropagation());
    // Close on outside click / Escape, just like the header dropdown.
    document.addEventListener('click', () => { if (panel.classList.contains('open')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    panel.querySelector('#hk-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = panel.querySelector('#hk-in'); const q = inp.value.trim(); if (!q) return;
      inp.value = ''; add('u', q); const t = add('a', '…');
      try {
        const r = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) });
        const j = await r.json().catch(() => ({}));
        t.textContent = j.answer
          || (j.error === 'assistant_unconfigured' ? "The assistant isn't switched on yet." : 'Something went wrong — try again.');
      } catch { t.textContent = 'Network error — try again.'; }
      msgs.scrollTop = msgs.scrollHeight;
    });
  }

  /**
   * EXCLUSIVE ACCORDIONS: opening one closes its siblings.
   *
   * Same reasoning as the menu/assistant pair — two open panels at once is a
   * busier page than anyone reads, and nobody reads two at a time anyway. One
   * delegated listener covers every <details> on the site (terms, privacy, faq,
   * how, integrity) with no per-page markup, so pages added later inherit it.
   *
   * `toggle` does NOT bubble, hence the capture phase — a plain listener on
   * document never fires. Scope is the nearest .acc-wrap so independent groups
   * on one page stay independent, falling back to <main> for the pages whose
   * folds are loose siblings rather than wrapped.
   */
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open) return;
    const scope = d.closest('.acc-wrap') || d.closest('main') || document;
    scope.querySelectorAll('details[open]').forEach((other) => {
      // Only true siblings in this scope — a nested <details> must not be shut
      // by its own parent opening.
      if (other !== d && !other.contains(d) && !d.contains(other)) other.open = false;
    });
  }, true);

  /**
   * THE FULL RACES LIST, shared by every reporting flow (collation.html and
   * observe.html via app.js).
   *
   * /api/contests only returns races that are actually CONFIGURED — today that
   * is the Osun governorship alone — so a picker built straight from it showed a
   * single line and read as though Hawkeye only knows about one election. The
   * canonical five are rendered here instead, in seat-magnitude order, with the
   * unconfigured ones DISABLED. Disabled options cannot be submitted, so the
   * backend still only ever receives a code from `contestCodes`.
   *
   * Mirrors BARE_RACE_NAME in backend/src/db.js — keep the two in step if a race
   * is ever added. races.html no longer has a list to mirror: it builds itself
   * from /api/contests and groups by polling date.
   */
  const RACE_ORDER = [
    { code: 'PRES', name: 'Presidency' },
    { code: 'GOV', name: 'Governorship' },
    { code: 'SEN', name: 'Senate' },
    { code: 'REP', name: 'House of Reps' },
    { code: 'SHA', name: 'State Assembly' },
  ];

  window.HAWKEYE_RACES = {
    ORDER: RACE_ORDER,
    /**
     * Fill a <select> with all five races.
     * @param sel        the <select> element
     * @param available  configured contests that apply here (from /api/contests)
     * @param opts       { placeholder }
     * @returns the code auto-selected, or '' if the user still has to choose
     */
    fill(sel, available, opts) {
      const o = opts || {};
      const esc = (s) => String(s == null ? '' : s)
        .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const by = new Map((available || []).map((c) => [c.code, c]));
      const prev = sel.value;
      const head = o.placeholder === false ? '' : `<option value="">${esc(o.placeholder || '— select election —')}</option>`;
      /**
       * THE FIVE GENERAL CONTESTS, THEN ANY BY-ELECTION ON THE WIRE.
       *
       * RACE_ORDER is a fixed list of the five codes a general election has, so
       * anything else — every by-election, which carries its own code such as
       * SHA_BYE_DELTA_UDU_2026 — was silently dropped: it went into `by`,
       * matched nothing here, and never became an option. The consequence was
       * not cosmetic. Five by-elections are on the ballot on 19 September 2026
       * and neither this site nor Hawkeye Lite could file a result for any of
       * them; an observer reached this step, saw five general elections all
       * marked "not open yet", and had nothing to choose.
       *
       * The five stay first and stay in their fixed order — they are the shape
       * of a general election and the order people expect. By-elections follow,
       * named by the server, because there is no fixed list of them to hardcode:
       * they appear and finish between general elections.
       */
      const general = new Set(RACE_ORDER.map((r) => r.code));
      const extras = (available || []).filter((c) => !general.has(c.code));
      sel.innerHTML = head + RACE_ORDER.map((r) => {
        const c = by.get(r.code);
        if (c) return `<option value="${esc(c.code)}">${esc(c.name)}</option>`;
        // Named, visible, and unselectable — it tells people the race exists and
        // is coming without letting them file against an election with no date.
        return `<option value="${esc(r.code)}" disabled>${esc(r.name)} — not open yet</option>`;
      }).concat(extras.map((c) => `<option value="${esc(c.code)}">${esc(c.name)}</option>`)).join('');
      if (prev && by.has(prev)) { sel.value = prev; return prev; }
      // Exactly one race actually reportable (today: Osun GOV) ⇒ pick it, rather
      // than making everyone choose from a list of one enabled row.
      if (by.size === 1) {
        sel.value = [...by.keys()][0];
        return sel.value;
      }
      return sel.value || '';
    },
  };
})();

/* ---- Prerender the next screen -------------------------------------------
 * The other half of the "choppy transitions" problem. View transitions (see
 * styles.css) hide the SEAM between two documents; this removes the WAIT, by
 * letting the browser build the next page before the tap completes.
 *
 * Eagerness is deliberately "moderate", i.e. on hover/pointerdown, NOT
 * "eager". Eager would speculatively load every linked screen the moment a
 * page opens — on the slow mobile links this app is built for, that is a data
 * bill the user did not ask for, and this codebase has already had to strip
 * the service-worker precache back for exactly that reason. Moderate only
 * spends anything once the finger is already down on the link.
 *
 * Same-origin only, and the API is ignored entirely by browsers that lack it.
 */
(function () {
  try {
    if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
    if (document.querySelector('script[type="speculationrules"]')) return;
    // Respect an explicit data-saver signal; prerendering is a luxury.
    const conn = navigator.connection;
    if (conn && (conn.saveData || /^(slow-)?2g$/.test(conn.effectiveType || ''))) return;
    const s = document.createElement('script');
    s.type = 'speculationrules';
    s.textContent = JSON.stringify({
      prerender: [{
        source: 'document',
        where: { and: [{ href_matches: '/*' }, { not: { href_matches: '/api/*' } }] },
        eagerness: 'moderate',
      }],
    });
    document.head.appendChild(s);
  } catch { /* never let a nice-to-have break navigation */ }
})();

/**
 * ONE BLOCKING REFUSAL, SHARED BY EVERY FLOW.
 *
 * The report, collation and incident screens each refused a bad submit by
 * writing a sentence into a status line under the button. On a phone that line
 * is below the fold at the moment of the tap, so all three read as dead
 * buttons — the single most reported complaint about these screens.
 *
 * Built here for the same reason the report sheet and the tour are: menu.js is
 * the one script every page already loads, so this needs no new file, no new
 * pin and no service-worker entry. Styles live beside .hk-alert in styles.css.
 *
 * Fails silently and returns false if the DOM is not ready, and every caller
 * keeps its old status-line path as a fallback — a refusal that cannot be shown
 * must never become a refusal that does not happen.
 */
(function () {
  var box = null;
  var lastFocus = null;
  var after = null;
  function close() {
    if (!box) return;
    box.hidden = true;
    document.body.style.overflow = '';
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
    var fn = after; after = null;
    if (typeof fn === 'function') { try { fn(); } catch (e) {} }
  }
  window.HAWKEYE_ALERT = function (title, body, onClose) {
    try {
      if (!document.body) return false;
      if (!box) {
        box = document.createElement('div');
        box.className = 'hk-alert';
        box.hidden = true;
        box.innerHTML = '<div class="hk-alert-card" role="alertdialog" aria-modal="true" aria-labelledby="hk-alert-title">'
          + '<h3 id="hk-alert-title"></h3><p></p><button type="button" id="hk-alert-ok">OK</button></div>';
        document.body.appendChild(box);
        box.addEventListener('click', function (e) { if (e.target === box) close(); });
        box.querySelector('#hk-alert-ok').addEventListener('click', close);
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && box && !box.hidden) close();
        });
      }
      lastFocus = document.activeElement;
      after = onClose;
      box.querySelector('h3').textContent = title || 'Not yet';
      box.querySelector('p').textContent = body || '';
      box.hidden = false;
      document.body.style.overflow = 'hidden';
      box.querySelector('#hk-alert-ok').focus();
      return true;
    } catch (e) { return false; }
  };
})();

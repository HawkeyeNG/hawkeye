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
    if (nav.children.length) btn.parentNode.insertBefore(nav, btn);
  }

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
    ['Live data', ['results.html', { acc: 'Races', hrefs: ['races.html', 'osun.html', 'candidates.html'] }, 'dashboard.html', 'political.html']],
    // Only populates in the app (see FOOTER_ONLY above); on the web these hrefs
    // aren't in the panel, the group finds no members and is skipped.
    ['Learn & about', ['how.html', 'guide.html', 'faq.html', 'about.html', 'support.html', 'privacy.html', 'terms.html']],
  ];
  if (panel && !panel.querySelector('.menu-group')) {
    // Osun 2026 is the active pilot race — inject it once so it appears in the
    // menu on every page without editing each page's static link list.
    // All Races selector — leads the Races accordion; where every contest will live
    // as it opens. Injected so it appears on every page.
    if (!panel.querySelector('a[href="races.html"]')) {
      const ra = document.createElement('a');
      ra.href = 'races.html';
      ra.textContent = 'All Races';
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
    if (!panel.querySelector('a[href="osun.html"]')) {
      const o = document.createElement('a');
      o.href = 'osun.html';
      o.textContent = 'Osun 2026';
      panel.appendChild(o);
    }
    // Presidency 2027 — the presidential race (candidates.html). Injected like
    // Osun so it lands in the Races group on every page, even the two whose
    // static list omits it.
    if (!panel.querySelector('a[href="candidates.html"]')) {
      const c = document.createElement('a');
      c.href = 'candidates.html';
      c.textContent = 'Presidency 2027';
      panel.appendChild(c);
    }
    // Practice run — injected everywhere (like Osun) so new users can find it
    // without editing every page's static list.
    if (!panel.querySelector('a[href="practice.html"]')) {
      const pr = document.createElement('a');
      pr.href = 'practice.html';
      pr.textContent = 'Practice Run';
      panel.appendChild(pr);
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
    const links = new Map([...panel.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a]));
    // Canonical label for the results page: its static link text drifts across
    // pages ("Leaderboard" / "Live Results" / "Public Results"). Native calls it
    // just "Leaderboard", so normalise every page's drifted label to that.
    const lb = links.get('results.html');
    if (lb) lb.textContent = 'Leaderboard';
    // "2027 Candidates" -> "Presidency 2027" for every page's static copy.
    const pres = links.get('candidates.html');
    if (pres) pres.textContent = 'Presidency 2027';
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
      paint();
    });
    paint();
    btn.parentNode.insertBefore(tb, btn);
  }

  // Header slot, one control, state-dependent (called by syncAuthMenu below):
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
        .then((d) => { if (d && d.unread > 0) { const dot = a.querySelector('.bell-dot'); dot.textContent = d.unread > 9 ? '9+' : d.unread; dot.hidden = false; } })
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
    c.innerHTML = '<img src="logo-crest.svg?v=98" alt="" width="30" height="30" style="display:block" />';
  });

  // Bottom tab bar (mobile app pattern) — one raised center action, 5 slots,
  // consistent on every page. APP SHELL: the Capacitor native app AND an
  // INSTALLED PWA (standalone display-mode) — both ARE the app experience, so
  // both get native-style bottom tabs (parity). A plain browser tab (mobile or
  // desktop web) keeps its header nav/bell/footer instead. has-tabbar hides the
  // footer, so an installed PWA gets exactly the native chrome, not both.
  const inAppShell = (window.HAWKEYE && window.HAWKEYE.native)
    || window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  // GOOGLE PLAY "Misleading Claims" COMPLIANCE (rejection, 2026-08-03).
  // Any app presenting government-related information must, in-app, (a) state
  // plainly that it does not represent the government entity and (b) link the
  // official source. Injected on every page so it can never be missed, and it
  // sits directly under the page heading where the data is. The web footer says
  // the same thing, but the app shell hides that footer — which is exactly the
  // surface the reviewer saw.
  (function govDisclaimer() {
    const main = document.querySelector('main');
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
    bar.innerHTML = '<strong>Not government or INEC affiliated.</strong> '
      + '<span class="gov-disc-more" role="button" tabindex="0">Details</span>';
    // On the sign-in / sign-up screen the disclaimer goes BELOW the form: it is a
    // legal footnote, and at the top of a bare auth page it was the first and
    // loudest thing on screen, overshadowing the brand.
    if (document.documentElement.classList.contains('auth-screen')) main.appendChild(bar);
    else main.insertBefore(bar, main.firstChild);
    let dlg = document.getElementById('gov-disc-modal');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'gov-disc-modal';
      dlg.className = 'gov-disc-modal';
      // tabindex on the heading so focus can land HERE on open. <dialog>.showModal()
      // otherwise focuses the first focusable child — the inecnigeria.org link —
      // which renders as a preselected link nobody asked for.
      dlg.innerHTML = '<h2 tabindex="-1">Not a government service</h2>'
        + '<p>Hawkeye is an independent, citizen-run transparency tool. It is not affiliated with, '
        + 'endorsed by, or acting on behalf of INEC or any government entity, and it does not declare '
        + 'election results. Figures here are unofficial crowd reports. Official results and electoral '
        + 'information come from INEC:</p>'
        + '<p class="gov-disc-links"><a href="https://www.inecnigeria.org" target="_blank" rel="noopener">inecnigeria.org</a> '
        + '&middot; <a href="https://www.inecelectionresults.ng" target="_blank" rel="noopener">inecelectionresults.ng</a></p>'
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
    const open = (title, body) => {
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.className = 'gov-disc-modal info-modal';
        dlg.innerHTML = '<h2 tabindex="-1"></h2><p></p><button type="button" class="gov-disc-close">Close</button>';
        document.body.appendChild(dlg);
        dlg.querySelector('.gov-disc-close').onclick = () => dlg.close();
        dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
      }
      const h = dlg.querySelector('h2');
      h.textContent = title || 'About this';
      h.hidden = !title;
      dlg.querySelector('p').textContent = body;
      dlg.showModal();
      h.focus();
    };
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('.info-i');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      open(b.getAttribute('data-info-title') || '', b.getAttribute('data-info') || '');
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
      <a class="rs-opt" href="observe.html?intent=observe">${ic('<circle cx="12" cy="13.5" r="3"/><path d="M4 8.5h3L8.5 6.5h7L17 8.5h3v10H4z"/>')}
        <span><strong>Polling-unit result</strong><small>Photograph the EC8A sheet and enter the counts</small></span></a>
      <a class="rs-opt" href="incidents.html">${ic('<path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.5"/>')}
        <span><strong>Incident</strong><small>Violence, vote-buying, BVAS failure, obstruction…</small></span></a>
      <a class="rs-opt" href="collation.html">${ic('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>')}
        <span><strong>Collation result</strong><small>Ward, LGA or state collation (EC8B/C/D)</small></span></a>
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
        .then((d) => { if (d && d.unread > 0) { const dot = nav.querySelector('.tab-dot'); if (dot) { dot.textContent = d.unread > 9 ? '9+' : d.unread; dot.hidden = false; } } })
        .catch(() => {});
    }
  }

  // Mascot trial: swap the emoji crest for the hawk mark on every page from
  // one place (pages keep the emoji as a no-JS fallback).
  for (const c of document.querySelectorAll('.crest')) {
    c.innerHTML = '<img src="logo-crest.svg?v=98" alt="" style="width:36px;height:36px;display:block" />';
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
    const avail = window.innerHeight - top - barH - 12; // 12px breathing room
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
    #hk-fab{position:fixed;right:18px;bottom:18px;z-index:1200;width:56px;height:56px;margin:0;padding:0;border-radius:50%;border:none;cursor:pointer;background:var(--green,#004225);color:#fff;font-size:22px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
    #hk-fab:hover{filter:brightness(1.08)}
    #hk-panel{position:fixed;right:18px;bottom:84px;z-index:1200;width:min(360px,calc(100vw - 36px));max-height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;background:var(--card,#fff);border:1px solid var(--line,#dde4de);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.28)}
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
})();

// Apply a user-forced theme before anything paints under it; system preference
// rules when unset (styles.css handles both via tokens).
(function () {
  const t = localStorage.getItem('hawkeye_theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
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
  const FOOTER_ONLY = ['about.html', 'how.html', 'privacy.html', 'faq.html', 'guide.html'];
  // "Take part" is hidden on desktop (≥900px) — its links live in the header there.
  const GROUPS = [
    ['Take part', ['observe.html', 'collation.html', 'incidents.html', 'map-unit.html'], 'tp'],
    ['Trust & verify', ['ledger.html', 'integrity.html', 'docket.html']],
    ['Live data', ['results.html', 'dashboard.html', 'candidates.html', 'political.html']],
  ];
  if (panel && !panel.querySelector('.menu-group')) {
    const links = new Map([...panel.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a]));
    for (const [label, hrefs, tp] of GROUPS) {
      const members = hrefs.map((h) => links.get(h)).filter(Boolean);
      if (!members.length) continue;
      const g = document.createElement('div');
      g.className = 'menu-group' + (tp ? ' tp-hide' : '');
      g.textContent = label;
      panel.appendChild(g);
      for (const a of members) {
        if (tp) a.classList.add('tp-hide');
        panel.appendChild(a);
        links.delete(a.getAttribute('href'));
      }
    }
    for (const [href, a] of links) {
      if (FOOTER_ONLY.includes(href)) a.remove();
      else panel.appendChild(a); // anything unmapped keeps working
    }
  }

  // Light/dark toggle beside the hamburger. Toggles from the EFFECTIVE mode and
  // persists; greens are identical in both — only neutral surfaces change.
  if (btn && !document.querySelector('.theme-btn')) {
    const tb = document.createElement('button');
    tb.className = 'theme-btn';
    const effective = () => document.documentElement.dataset.theme || 'light';
    const paint = () => { tb.textContent = effective() === 'dark' ? '☀️' : '🌙'; tb.setAttribute('aria-label', effective() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); };
    tb.addEventListener('click', () => {
      const next = effective() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('hawkeye_theme', next);
      paint();
    });
    paint();
    btn.parentNode.insertBefore(tb, btn);
  }

  // Notifications bell (in-app feed). Shows an unread badge when signed in;
  // tapping opens notifications.html. Not on the notifications page itself.
  if (btn && !document.querySelector('.bell-btn') && !/notifications\.html/.test(location.pathname)) {
    const a = document.createElement('a');
    a.className = 'bell-btn';
    a.href = 'notifications.html';
    a.setAttribute('aria-label', 'Notifications');
    a.innerHTML = '🔔<span class="bell-dot" hidden></span>';
    btn.parentNode.insertBefore(a, document.querySelector('.theme-btn') || btn);
    const tok = localStorage.getItem('hawkeye_token');
    if (tok) {
      fetch('/api/notifications', { headers: { authorization: 'Bearer ' + tok } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d && d.unread > 0) { const dot = a.querySelector('.bell-dot'); dot.textContent = d.unread > 9 ? '9+' : d.unread; dot.hidden = false; } })
        .catch(() => {});
    }
  }

  // Bottom tab bar (mobile app pattern) — one raised center action, 5 slots,
  // consistent on every page. NATIVE SHELL ONLY: the web (even mobile web)
  // keeps its header nav/bell/footer — the bar is an app affordance.
  if (window.HAWKEYE && window.HAWKEYE.native && !document.querySelector('.tabbar')) {
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
      + '<a href="privacy.html">Privacy Policy</a><a href="faq.html">FAQ</a>'
      + '<a href="guide.html">Observer Guide</a>'
      + (localStorage.getItem('hawkeye_token') ? '<a href="profile.html">My Profile</a>' : '');
  }

  // Every visible "INEC" mention links to the commission's site. Runs over
  // static text now and once more after async content settles.
  const INEC_URL = 'https://www.inecnigeria.org';
  function linkInec(root) {
    const skip = /^(A|SCRIPT|STYLE|TITLE|TEXTAREA|INPUT|SELECT|OPTION|CODE)$/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\bINEC\b/.test(n.nodeValue) && n.parentElement && !skip.test(n.parentElement.tagName)
        && !n.parentElement.closest('a, svg')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
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
  linkInec(document.body);
  setTimeout(() => linkInec(document.body), 2500);

  // Sign out — shown only when signed in. Clears the token AND the device key so
  // auto-resume can't silently sign back in; sends the user to a fresh sign-up.
  if (panel && localStorage.getItem('hawkeye_token') && !panel.querySelector('.sign-out')) {
    // My Profile — identity hash, saved unit, past reports, password, delete-ID.
    const prof = document.createElement('a');
    prof.href = 'profile.html';
    prof.textContent = 'My Profile';
    panel.appendChild(prof);

    const a = document.createElement('a');
    a.href = '#';
    a.className = 'sign-out';
    a.textContent = 'Sign out';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('hawkeye_token');
      try {
        const rq = indexedDB.open('hawkeye', 1);
        rq.onsuccess = () => { try { rq.result.transaction('kv', 'readwrite').objectStore('kv').delete('keypair'); } catch { /* ignore */ } };
      } catch { /* ignore */ }
      location.href = 'observe.html?intent=observe';
    });
    panel.appendChild(a);
    // ("Delete my ID" moved into profile.html — one authoritative place.)
  }
})();

// Floating results assistant (bottom-right). Non-partisan, read-only; mounts only
// where the server reports the feature is switched on. Skipped inside the Telegram
// Mini App and on the private review console.
(function () {
  if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) return;
  if (/\/review\.html$/.test(location.pathname)) return;
  fetch('/api/assistant/health').then((r) => r.json()).then((h) => { if (h && h.enabled) mount(); }).catch(() => {});

  function mount() {
    const css = `
    #hk-fab{position:fixed;right:18px;bottom:18px;z-index:1200;width:56px;height:56px;margin:0;padding:0;border-radius:50%;border:none;cursor:pointer;background:var(--green,#008751);color:#fff;font-size:22px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
    #hk-fab:hover{filter:brightness(1.08)}
    #hk-panel{position:fixed;right:18px;bottom:84px;z-index:1200;width:min(360px,calc(100vw - 36px));max-height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;background:var(--card,#fff);border:1px solid var(--line,#dde4de);border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.28)}
    #hk-panel.open{display:flex}
    #hk-head{background:var(--green-darker,#00331e);color:#fff;padding:11px 14px;font-weight:700;font-size:.95rem;display:flex;justify-content:space-between;align-items:center;gap:8px;white-space:nowrap}
    #hk-head button{display:inline-block;width:auto;margin:0;background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 2px;flex:none;box-shadow:none}
    #hk-msgs{flex:1;min-height:120px;overflow-y:auto;overscroll-behavior:contain;padding:14px;display:flex;flex-direction:column;gap:10px;font-size:.94rem;background:var(--bg,#f7f8f6)}
    .hk-b{padding:9px 12px;border-radius:12px;max-width:85%;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
    .hk-u{align-self:flex-end;background:var(--green,#008751);color:#fff;border-bottom-right-radius:4px}
    .hk-a{align-self:flex-start;background:var(--card,#fff);border:1px solid var(--line,#e3e8e4);color:var(--ink,#14201a);border-bottom-left-radius:4px}
    #hk-form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line,#e3e8e4);background:var(--card,#fff)}
    #hk-in{flex:1;min-width:0;width:auto;display:block;margin:0;border:1px solid var(--border,#dde4de);border-radius:10px;padding:9px 11px;font:inherit;font-size:16px;background:var(--card,#fff);color:var(--ink,#14201a)}
    #hk-form button{display:inline-block;width:auto;margin:0;flex:none;background:var(--green,#008751);color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer}
    #hk-note{font-size:.72rem;color:var(--muted,#5b6b62);padding:0 14px 10px;background:var(--bg,#f7f8f6)}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const fab = document.createElement('button');
    fab.id = 'hk-fab'; fab.setAttribute('aria-label', 'Ask Hawkeye about the results'); fab.textContent = '💬';
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
    fab.onclick = (e) => {
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      if (open && !greeted) { greeted = true; add('a', 'Hi! Ask me about the crowd-reported results — a national tally, a polling unit, or how much of the country is mapped.'); }
    };
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

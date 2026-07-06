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
  const PRIMARY = ['observe.html', 'results.html', 'integrity.html', 'map-unit.html', 'how.html'];
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
  const GROUPS = [
    ['Take part', ['observe.html', 'collation.html', 'incidents.html', 'map-unit.html']],
    ['Live data', ['results.html', 'dashboard.html', 'candidates.html', 'political.html']],
    ['Trust & verify', ['ledger.html', 'integrity.html']],
    ['Learn', ['how.html', 'guide.html', 'faq.html']],
    ['About', ['about.html', 'privacy.html']],
  ];
  if (panel && !panel.querySelector('.menu-group')) {
    const links = new Map([...panel.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a]));
    for (const [label, hrefs] of GROUPS) {
      const members = hrefs.map((h) => links.get(h)).filter(Boolean);
      if (!members.length) continue;
      const g = document.createElement('div');
      g.className = 'menu-group';
      g.textContent = label;
      panel.appendChild(g);
      for (const a of members) { panel.appendChild(a); links.delete(a.getAttribute('href')); }
    }
    for (const a of links.values()) panel.appendChild(a); // anything unmapped keeps working
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
    foot.innerHTML = '<a href="observe.html">Report a Result</a><a href="results.html">Live Results</a>'
      + '<a href="how.html">How It Works</a><a href="ledger.html">Verify the Ledger</a><a href="faq.html">FAQ</a>'
      + '<a href="about.html">About &amp; Contact</a><a href="privacy.html">Privacy</a>';
  }

  // Sign out — shown only when signed in. Clears the token AND the device key so
  // auto-resume can't silently sign back in; sends the user to a fresh sign-up.
  if (panel && localStorage.getItem('hawkeye_token') && !panel.querySelector('.sign-out')) {
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
  }
})();

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
    ['Trust & verify', ['ledger.html', 'integrity.html']],
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
      + '<a href="guide.html">Observer Guide</a>';
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

    // Delete my ID — permanent, self-serve. Wipes key/device/Telegram link and
    // marks the observer deleted server-side; ledger reports remain (permanence
    // is the product) and re-registering the same number restores the same ID.
    const del = document.createElement('a');
    del.href = '#';
    del.className = 'sign-out';
    del.textContent = 'Delete my ID';
    del.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Delete your observer ID?\n\nYour signing key, device link, Telegram link and alert subscriptions are removed. Reports already on the public ledger stay (they are anonymous and permanent). Re-registering this number restores the same ID.')) return;
      try {
        await fetch('/api/observers/delete', {
          method: 'POST',
          headers: { authorization: `Bearer ${localStorage.getItem('hawkeye_token')}` },
        });
      } catch { /* still clear locally */ }
      localStorage.removeItem('hawkeye_token');
      try {
        const rq = indexedDB.open('hawkeye', 1);
        rq.onsuccess = () => { try { rq.result.transaction('kv', 'readwrite').objectStore('kv').delete('keypair'); } catch { /* ignore */ } };
      } catch { /* ignore */ }
      alert('Your ID has been deleted.');
      location.href = 'index.html';
    });
    panel.appendChild(del);
  }
})();

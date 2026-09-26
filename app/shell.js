/*
 * shell.js — the header stays put, everything under it scrolls.
 *
 * WHY. On a desktop window the platform's scrollbar runs the full height of the
 * viewport, straight past the header, and that trough is the one part of an
 * installed app that still reads as a browser. Making the header a flex row of
 * its own and giving the rest its own scroll container puts the bar where the
 * content is: starting below the header. Worked out on the situation room; this
 * is that treatment for every other page.
 *
 * WHAT MOVES. Every body child after the header EXCEPT the ones that must stay
 * at body level — anything already positioned fixed or absolute (overlays,
 * dialogs, the boot splash), plus scripts and templates. An inclusive rule
 * rather than "wrap main and footer", because `main` is not always a body child:
 * index.html nests it inside the hero wrapper, and a rule that looked only for
 * `body > main` silently skipped the busiest page on the site.
 *
 * KEYED ON A CLASS. The CSS does nothing without html.has-shell, and the class
 * is only set once the wrap succeeds — so a page this cannot handle keeps the
 * scrolling it always had rather than ending up with neither.
 *
 * ITS OWN FILE because the admin console does not load menu.js: the console has
 * no site menu by design, and it needs the shell like everything else.
 */
(function () {
  'use strict';

  function fixed(el) {
    const p = getComputedStyle(el).position;
    return p === 'fixed' || p === 'absolute';
  }

  function build() {
    if (document.getElementById('page-scroll')) return;
    const hdr = document.querySelector('body > .gov-header');
    if (!hdr || !document.querySelector('main')) return;

    const move = [];
    for (let n = hdr.nextElementSibling; n; n = n.nextElementSibling) {
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'TEMPLATE' || tag === 'NOSCRIPT' || tag === 'LINK' || tag === 'STYLE') continue;
      if (fixed(n)) continue;              // overlays, dialogs, the boot splash
      move.push(n);
    }
    if (!move.length) return;

    const wrap = document.createElement('div');
    wrap.id = 'page-scroll';
    hdr.parentNode.insertBefore(wrap, move[0]);
    move.forEach((n) => wrap.appendChild(n));
    document.documentElement.classList.add('has-shell');

    /* THE ANCHOR THAT WOULD HAVE STOPPED WORKING. `#id` links move the
       DOCUMENT, and above 900px the document no longer scrolls — so a jump link
       would land nowhere. Re-pointed at the pane that does scroll. */
    const jump = () => {
      const el = location.hash && document.querySelector(location.hash);
      if (!el || getComputedStyle(wrap).overflowY !== 'auto') return;
      wrap.scrollTop += el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - 12;
    };
    addEventListener('hashchange', jump);
    if (location.hash) setTimeout(jump, 60);

    /* WINDOW SCROLLING, FORWARDED. Where the pane scrolls instead of the
       document (desktop, and Lite on a phone), window.scrollTo(0, 0) would move
       nothing — and app.js, practice.js and incidents.html use it to start a
       screen at the top. */
    const paneScrolls = () => getComputedStyle(wrap).overflowY === 'auto';
    const to = window.scrollTo, by = window.scrollBy;
    window.scrollTo = function () { return (paneScrolls() ? wrap.scrollTo : to).apply(paneScrolls() ? wrap : window, arguments); };
    window.scrollBy = function () { return (paneScrolls() ? wrap.scrollBy : by).apply(paneScrolls() ? wrap : window, arguments); };
  }

  /* .scrolling for ~900ms after any scroll. CAPTURE phase, because scroll does
     not bubble and the element that moved is usually not the document. */
  function watchScroll() {
    let idle = null;
    addEventListener('scroll', () => {
      document.documentElement.classList.add('scrolling');
      clearTimeout(idle);
      idle = setTimeout(() => document.documentElement.classList.remove('scrolling'), 900);
    }, { capture: true, passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { build(); watchScroll(); });
  } else {
    build();
    watchScroll();
  }
})();

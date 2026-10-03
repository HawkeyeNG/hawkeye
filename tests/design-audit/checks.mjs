/**
 * In-page design checks, measured on the RENDERED page (never the source).
 * Each returns plain JSON. Shared by web, Lite and the react-native-web export.
 */

/** Runs in the page. Returns the metrics for the current viewport + document. */
export function pageChecks() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const vis = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (el.closest('[hidden],[aria-hidden="true"],template,noscript')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
  const pathOf = (el) => {
    const p = [];
    for (let e = el; e && e !== document.body && p.length < 4; e = e.parentElement) {
      p.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''));
    }
    return p.join('>');
  };
  // Inside a horizontal scroller (chips rows, tables) overflow is intended.
  const inXScroller = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1) return true;
    }
    return false;
  };

  // 1. horizontal overflow of the page
  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const spill = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (spill.length >= 8) break;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 && r.left < vw && !inXScroller(el) && getComputedStyle(el).position !== 'fixed') {
      spill.push({ el: pathOf(el), right: Math.round(r.right), text: label(el).slice(0, 40) });
    }
  }

  // 2. clipped text: ellipsis or hidden overflow cutting a text box
  const clipped = [];
  for (const el of document.body.querySelectorAll('h1,h2,h3,h4,p,span,a,button,label,strong,div,li,td,th')) {
    if (clipped.length >= 15) break;
    if (!vis(el)) continue;
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1)) continue;
    const cs = getComputedStyle(el);
    const hidesX = cs.textOverflow === 'ellipsis' || /(hidden|clip)/.test(cs.overflowX);
    const hidesY = /(hidden|clip)/.test(cs.overflowY) || Number(cs.webkitLineClamp) > 0;
    const overX = el.scrollWidth > el.clientWidth + 1;
    const overY = el.scrollHeight > el.clientHeight + 2;
    if ((hidesX && overX) || (hidesY && overY && cs.display !== 'inline')) {
      clipped.push({ el: pathOf(el), text: el.innerText.replace(/\s+/g, ' ').trim().slice(0, 60), need: el.scrollWidth, have: el.clientWidth });
    }
  }

  // 3. touch targets < 44px (inline links in running text are exempt, as in WCAG 2.5.8)
  const small = [];
  let targets = 0;
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=radio],summary,[onclick],[tabindex="0"]';
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    // react-native-web nests role=button inside role=button sometimes; count the outermost
    if (el.parentElement && el.parentElement.closest(sel) && seen.has(el.parentElement.closest(sel))) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (el.tagName === 'A' && cs.display === 'inline') {
      const p = el.parentElement;
      const txt = p ? (p.innerText || '').trim() : '';
      if (txt.length > (el.innerText || '').trim().length + 15) continue; // a link inside a sentence
    }
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) {
      const lab = el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`));
      if (lab) { const lr = lab.getBoundingClientRect(); if (lr.height >= 44) continue; }
    }
    targets++;
    if (r.width < 44 || r.height < 44) {
      small.push({ el: pathOf(el), label: label(el), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + (document.scrollingElement || document.documentElement).scrollTop) });
    }
  }
  // the worst ones first (smallest dimension), and anything under 24px is a WCAG 2.2 AA failure
  small.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h));

  // 4. small text (< 12px rendered)
  const tiny = [];
  let textNodes = 0;
  const sizes = {};
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (t.length < 2) continue;
    const el = n.parentElement;
    if (!vis(el)) continue;
    textNodes++;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const k = Math.round(fs);
    sizes[k] = (sizes[k] || 0) + 1;
    if (fs < 12 && tiny.length < 12) tiny.push({ el: pathOf(el), text: t.slice(0, 40), px: fs });
  }

  // 5. fixed / sticky layers (FABs, bars) and how much of a phone screen they take
  const fixed = [];
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 400) continue;
    if (r.bottom <= 0 || r.top >= vh) continue;
    fixed.push({ el: pathOf(el), pos: cs.position, top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) });
  }

  // 6. document structure
  const h1 = [...document.querySelectorAll('h1')].filter(vis).map((h) => h.innerText.trim().slice(0, 60));
  const scroller = (() => {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > se.clientHeight + 4) return { kind: 'document', h: se.scrollHeight };
    let best = null;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 4) continue;
      if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
    }
    return best ? { kind: pathOf(best), h: best.scrollHeight } : { kind: 'none', h: vh };
  })();

  return {
    vw, vh, docW, overflowX: docW > vw + 1, spill,
    clipped, smallTargets: small.slice(0, 25), smallTargetCount: small.length, under24: small.filter((s) => s.w < 24 || s.h < 24).length, targets,
    tinyText: tiny, textNodes, fontSizes: sizes,
    fixed, h1, pageHeight: scroller.h, scroller: scroller.kind,
    title: document.title, lang: document.documentElement.lang || null,
  };
}

/** Find the element that scrolls the page (document, Lite's #page-scroll, an RN ScrollView). */
export function findScroller() {
  const se = document.scrollingElement || document.documentElement;
  if (se.scrollHeight > se.clientHeight + 4) { window.__daScroller = se; return { h: se.scrollHeight, ch: se.clientHeight }; }
  let best = null;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 4) continue;
    if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
  }
  window.__daScroller = best || se;
  return { h: (best || se).scrollHeight, ch: (best || se).clientHeight };
}

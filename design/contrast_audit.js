localStorage.setItem('hawkeye_theme','dark'); document.documentElement.dataset.theme='dark';
window.__audit = function () {
  const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : null; };
  const bgOf = (el) => { let e = el; while (e && e !== document.documentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && (c.length < 4 || c[3] > 0.05)) return c; e = e.parentElement; } return parse(getComputedStyle(document.documentElement).backgroundColor) || [255,255,255]; };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const txt = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
    if (!txt || txt.length < 2) continue;
    const fg = parse(getComputedStyle(el).color); if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg[0], fg[1], fg[2]), L2 = lum(bg[0], bg[1], bg[2]);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 2.6) out.push({ ratio: +ratio.toFixed(2), tag: el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''), text: txt.slice(0, 45) });
  }
  const seen = new Set();
  return out.sort((a, b) => a.ratio - b.ratio).filter((x) => { const k = x.tag; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
};
JSON.stringify(window.__audit())

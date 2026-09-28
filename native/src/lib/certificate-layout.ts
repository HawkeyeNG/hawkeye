/**
 * The Hawkeye Observer certificate, LAID OUT ONCE — the native twin of paint()
 * in app/certificate.js.
 *
 * Two renderers read the same list of shapes, so the card on screen and the
 * PDF cannot drift apart:
 *   - components/certificate-card.tsx draws them with react-native-svg (the
 *     card on screen, and "Save image" through its toDataURL());
 *   - certificateHtml() below writes them as an SVG inside a one-page HTML
 *     document, which lib/certificate-pdf.ts hands to expo-print. Vector text,
 *     so the PDF prints sharp at any size.
 *
 * THE NAME is an argument, drawn and never sent: the HTML is rendered by the
 * phone's own print engine, and it carries a CSP that forbids every fetch (the
 * crest is an inline data: URI), so not even the print WebView can make a
 * request with the name in the page.
 */
import { type Cert } from '@/lib/certificate';
import { dayMonthYear } from '@/lib/dates';
import { t as i18nT } from '@/lib/i18n';
import { RECEIPT_CREST } from '@/lib/receipt-crest';

export const CERT_W = 1600;
export const CERT_H = 1131;   // A4 landscape proportions
export const CERT_COLORS = { green: '#004225', gold: '#f5b301', cream: '#fbf7ea', ink: '#1d2a24', muted: '#5b6b62' };

export type CertFont = 'sans' | 'serif' | 'mono';
export type CertShape =
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; sw?: number }
  | { k: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; sw?: number }
  | { k: 'path'; d: string; stroke: string; sw: number }
  | { k: 'image'; x: number; y: number; w: number; h: number; href: string }
  | { k: 'text'; x: number; y: number; size: number; text: string; fill: string; font: CertFont;
      bold?: boolean; italic?: boolean; middle?: boolean; spacing?: number };

/* i18nT returns the KEY for a missing string; on a certificate that would print
   "cert.card-title". The English is the floor, as on the receipt card. */
const T = (k: string, en: string, params?: Record<string, string>) => {
  const v = i18nT(k, params);
  return !v || v === k ? en.replace(/\{(\w+)\}/g, (m, n: string) => params?.[n] ?? m) : v;
};

/** react-native-svg has no text flow: wrap by an average glyph width. */
function wrap(text: string, size: number, maxPx: number): string[] {
  const per = Math.max(1, Math.floor(maxPx / (size * 0.52)));
  const out: string[] = [];
  let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    const t = line ? `${line} ${w}` : w;
    if (t.length > per && line) { out.push(line); line = w; } else { line = t; }
  }
  if (line) out.push(line);
  return out;
}
/** The largest size (down to 60%) at which one line of `text` fits. */
const fit = (text: string, size: number, maxPx: number, k = 0.55) =>
  Math.max(Math.round(size * 0.6), Math.min(size, Math.floor(maxPx / Math.max(1, text.length * k))));

export function certificateShapes(cert: Cert, name: string): CertShape[] {
  const { green: GREEN, gold: GOLD, cream: CREAM, ink: INK, muted: MUTED } = CERT_COLORS;
  const W = CERT_W;
  const H = CERT_H;
  const shortUrl = cert.verifyUrl.replace(/^https?:\/\//, '');
  const title = T('cert.card-title', 'Hawkeye Observer');
  const line = T('cert.card-line', 'Completed a practice run and the observer quiz');
  const issued = T('cert.card-issued', 'Issued {date}', { date: dayMonthYear(cert.issuedOn) });
  const code = T('cert.card-code', 'Verification code {code}', { code: cert.code });
  const check = T('cert.card-check', 'Check it at {url}', { url: shortUrl });
  const foot = T('cert.card-foot', 'Hawkeye is independent and nonpartisan. This certificate is not INEC accreditation.');
  const who = name.trim().slice(0, 60);

  const s: CertShape[] = [
    { k: 'rect', x: 0, y: 0, w: W, h: H, fill: GREEN },
    { k: 'rect', x: 34, y: 34, w: W - 68, h: H - 68, fill: CREAM },
    { k: 'rect', x: 58, y: 58, w: W - 116, h: H - 116, stroke: GOLD, sw: 5 },
  ];
  let y = 96;
  s.push({ k: 'image', x: W / 2 - 70, y, w: 140, h: 140, href: RECEIPT_CREST });
  y += 140 + 52;
  s.push({ k: 'text', x: W / 2, y, size: 30, text: 'HAWKEYE', fill: GREEN, font: 'sans', bold: true, middle: true, spacing: 10 });
  y += 108;
  s.push({ k: 'text', x: W / 2, y, size: fit(title, 104, W - 320, 0.58), text: title, fill: GREEN, font: 'sans', bold: true, middle: true });
  y += 44;
  s.push({ k: 'rect', x: W / 2 - 180, y, w: 360, h: 6, fill: GOLD });
  y += 96;
  if (who) {
    s.push({ k: 'text', x: W / 2, y, size: fit(who, 76, W - 360, 0.5), text: who, fill: INK, font: 'serif', italic: true, middle: true });
    y += 80;
  } else {
    y += 10;
  }
  for (const ln of wrap(line, 42, W - 400).slice(0, 2)) {
    s.push({ k: 'text', x: W / 2, y, size: 42, text: ln, fill: INK, font: 'sans', middle: true });
    y += 56;
  }
  s.push({ k: 'text', x: W / 2, y: y + 6, size: 34, text: issued, fill: MUTED, font: 'sans', middle: true });

  // The seal, bottom right.
  const cx = W - 250;
  const cy = H - 262;
  s.push({ k: 'circle', cx, cy, r: 92, fill: GOLD });
  s.push({ k: 'circle', cx, cy, r: 76, stroke: CREAM, sw: 4 });
  s.push({ k: 'path', d: `M ${cx - 36} ${cy + 2} L ${cx - 10} ${cy + 30} L ${cx + 40} ${cy - 28}`, stroke: GREEN, sw: 14 });

  // The code and where to check it, bottom left.
  s.push({ k: 'text', x: 130, y: H - 268, size: fit(code, 34, W - 620, 0.62), text: code, fill: GREEN, font: 'mono', bold: true });
  wrap(check, 26, W - 620).slice(0, 2).forEach((ln, i) => {
    s.push({ k: 'text', x: 130, y: H - 222 + i * 34, size: 26, text: ln, fill: MUTED, font: 'sans' });
  });
  wrap(foot, 24, W - 300).slice(0, 2).forEach((ln, i) => {
    s.push({ k: 'text', x: W / 2, y: H - 112 + i * 32, size: 24, text: ln, fill: MUTED, font: 'sans', middle: true });
  });
  return s;
}

/* ------------------------------------------------------------------------ */
/* The PDF's page: the same shapes as an SVG in a one-page HTML document.    */
/* ------------------------------------------------------------------------ */

const esc = (v: string | number) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS_FONT: Record<CertFont, string> = {
  sans: "-apple-system, 'Helvetica Neue', Roboto, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', 'Noto Serif', serif",
  mono: "Menlo, 'Roboto Mono', 'Courier New', monospace",
};

function svgOf(sh: CertShape): string {
  switch (sh.k) {
    case 'rect':
      return `<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" fill="${sh.fill ?? 'none'}"${sh.stroke ? ` stroke="${sh.stroke}" stroke-width="${sh.sw ?? 1}"` : ''}/>`;
    case 'circle':
      return `<circle cx="${sh.cx}" cy="${sh.cy}" r="${sh.r}" fill="${sh.fill ?? 'none'}"${sh.stroke ? ` stroke="${sh.stroke}" stroke-width="${sh.sw ?? 1}"` : ''}/>`;
    case 'path':
      return `<path d="${esc(sh.d)}" fill="none" stroke="${sh.stroke}" stroke-width="${sh.sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'image':
      return `<image x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" href="${esc(sh.href)}" preserveAspectRatio="xMidYMid meet"/>`;
    case 'text':
      return `<text x="${sh.x}" y="${sh.y}" font-size="${sh.size}" fill="${sh.fill}" font-family="${esc(CSS_FONT[sh.font])}"`
        + `${sh.bold ? ' font-weight="700"' : ''}${sh.italic ? ' font-style="italic"' : ''}`
        + `${sh.middle ? ' text-anchor="middle"' : ''}${sh.spacing ? ` letter-spacing="${sh.spacing}"` : ''}>${esc(sh.text)}</text>`;
  }
}

/** A4 landscape in points: what expo-print is asked for, and what the page is laid out to. */
export const PDF_PAGE = { width: 842, height: 595 };

/**
 * One A4-landscape page holding the certificate edge to edge. No script, and a
 * CSP of default-src 'none': the name is in this document, so nothing in it
 * may reach the network — the crest is inline.
 */
export function certificateHtml(cert: Cert, name: string, lang = 'en'): string {
  const body = certificateShapes(cert, name).map(svgOf).join('');
  return '<!doctype html><html lang="' + esc(lang) + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<title>Hawkeye Observer Certificate</title>'
    + '<style>@page{size:' + PDF_PAGE.width + 'pt ' + PDF_PAGE.height + 'pt;margin:0}'
    // A point short of the page and overflow clipped: a box exactly the page's
    // height can round over it and print a blank second page.
    + 'html,body{margin:0;padding:0;background:#fff;width:' + PDF_PAGE.width + 'pt;height:' + PDF_PAGE.height + 'pt;overflow:hidden}'
    + 'svg{display:block;width:' + PDF_PAGE.width + 'pt;height:' + (PDF_PAGE.height - 1) + 'pt}</style></head><body>'
    + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CERT_W} ${CERT_H}" preserveAspectRatio="xMidYMid meet">${body}</svg>`
    + '</body></html>';
}

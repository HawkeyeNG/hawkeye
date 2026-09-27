/**
 * The Hawkeye Observer certificate, drawn — the native twin of the canvas in
 * app/certificate.js, and saved the same way the receipt card is.
 *
 * DRAWN AS SVG, NOT CAPTURED FROM VIEWS: react-native-svg's <Svg> exposes
 * toDataURL(), so the PNG comes out of the element on screen with no new
 * native module (see receipt-card.tsx, and the precompiled-module note in
 * memory for why "just add view-shot" is not free in an OTA-only release).
 *
 * The name is a PROP, drawn here and nowhere else. It is never sent anywhere.
 */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, G, Image as SvgImage, Path, Rect, Text as SvgText } from 'react-native-svg';

import { type Cert } from '@/lib/certificate';
import { dayMonthYear } from '@/lib/dates';
import { t as i18nT } from '@/lib/i18n';
import { RECEIPT_CREST } from '@/lib/receipt-crest';

const W = 1600;
const H = 1131;
const GREEN = '#004225';
const GOLD = '#f5b301';
const CREAM = '#fbf7ea';
const INK = '#1d2a24';
const MUTED = '#5b6b62';
const SANS = 'System';
const SERIF = Platform.select({ ios: 'Georgia', default: 'serif' });
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

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

export type CertificateCardHandle = { toPng: () => Promise<string | null> };

export const CertificateCard = forwardRef<CertificateCardHandle, { cert: Cert; name: string; width?: number }>(
  function CertificateCard({ cert, name, width = 340 }, ref) {
    const svgRef = useRef<Svg>(null);

    useImperativeHandle(ref, () => ({
      toPng: () =>
        new Promise((resolve) => {
          const el = svgRef.current as unknown as { toDataURL?: (cb: (b: string) => void) => void };
          if (!el?.toDataURL) { resolve(null); return; }
          const timer = setTimeout(() => resolve(null), 4000);
          try {
            el.toDataURL((b64) => { clearTimeout(timer); resolve(b64 || null); });
          } catch { clearTimeout(timer); resolve(null); }
        }),
    }));

    const shortUrl = cert.verifyUrl.replace(/^https?:\/\//, '');
    const title = T('cert.card-title', 'Hawkeye Observer');
    const line = T('cert.card-line', 'Completed a practice run and the observer quiz');
    const issued = T('cert.card-issued', 'Issued {date}', { date: dayMonthYear(cert.issuedOn) });
    const code = T('cert.card-code', 'Verification code {code}', { code: cert.code });
    const check = T('cert.card-check', 'Check it at {url}', { url: shortUrl });
    const foot = T('cert.card-foot', 'Hawkeye is independent and nonpartisan. This certificate is not INEC accreditation.');
    const who = name.trim().slice(0, 60);

    const rows: React.ReactNode[] = [];
    let y = 96;
    rows.push(<SvgImage key="crest" href={RECEIPT_CREST} x={W / 2 - 70} y={y} width={140} height={140} preserveAspectRatio="xMidYMid meet" />);
    y += 140 + 52;
    rows.push(<SvgText key="brand" x={W / 2} y={y} fontSize={30} fontWeight="700" fill={GREEN} fontFamily={SANS} textAnchor="middle" letterSpacing={10}>HAWKEYE</SvgText>);
    y += 108;
    rows.push(<SvgText key="title" x={W / 2} y={y} fontSize={fit(title, 104, W - 320, 0.58)} fontWeight="700" fill={GREEN} fontFamily={SANS} textAnchor="middle">{title}</SvgText>);
    y += 44;
    rows.push(<Rect key="rule" x={W / 2 - 180} y={y} width={360} height={6} fill={GOLD} />);
    y += 96;
    if (who) {
      rows.push(<SvgText key="name" x={W / 2} y={y} fontSize={fit(who, 76, W - 360, 0.5)} fontStyle="italic" fill={INK} fontFamily={SERIF} textAnchor="middle">{who}</SvgText>);
      y += 80;
    } else {
      y += 10;
    }
    for (const ln of wrap(line, 42, W - 400).slice(0, 2)) {
      rows.push(<SvgText key={`l${y}`} x={W / 2} y={y} fontSize={42} fill={INK} fontFamily={SANS} textAnchor="middle">{ln}</SvgText>);
      y += 56;
    }
    rows.push(<SvgText key="issued" x={W / 2} y={y + 6} fontSize={34} fill={MUTED} fontFamily={SANS} textAnchor="middle">{issued}</SvgText>);

    // The seal, bottom right.
    const cx = W - 250;
    const cy = H - 262;
    rows.push(<Circle key="seal" cx={cx} cy={cy} r={92} fill={GOLD} />);
    rows.push(<Circle key="ring" cx={cx} cy={cy} r={76} fill="none" stroke={CREAM} strokeWidth={4} />);
    rows.push(<Path key="tick" d={`M ${cx - 36} ${cy + 2} L ${cx - 10} ${cy + 30} L ${cx + 40} ${cy - 28}`} fill="none" stroke={GREEN} strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" />);

    // The code and where to check it, bottom left.
    rows.push(<SvgText key="code" x={130} y={H - 268} fontSize={fit(code, 34, W - 620, 0.62)} fontWeight="700" fill={GREEN} fontFamily={MONO}>{code}</SvgText>);
    wrap(check, 26, W - 620).slice(0, 2).forEach((ln, i) => {
      rows.push(<SvgText key={`c${i}`} x={130} y={H - 222 + i * 34} fontSize={26} fill={MUTED} fontFamily={SANS}>{ln}</SvgText>);
    });
    wrap(foot, 24, W - 300).slice(0, 2).forEach((ln, i) => {
      rows.push(<SvgText key={`f${i}`} x={W / 2} y={H - 112 + i * 32} fontSize={24} fill={MUTED} fontFamily={SANS} textAnchor="middle">{ln}</SvgText>);
    });

    return (
      <Svg ref={svgRef} width={width} height={(width * H) / W} viewBox={`0 0 ${W} ${H}`}>
        <Rect x={0} y={0} width={W} height={H} fill={GREEN} />
        <Rect x={34} y={34} width={W - 68} height={H - 68} fill={CREAM} />
        <Rect x={58} y={58} width={W - 116} height={H - 116} fill="none" stroke={GOLD} strokeWidth={5} />
        <G>{rows}</G>
      </Svg>
    );
  },
);

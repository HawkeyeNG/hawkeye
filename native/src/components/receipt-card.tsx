/**
 * The observer's copy, drawn — and turned into a file they can keep.
 *
 * DRAWN AS SVG, NOT CAPTURED FROM VIEWS. react-native-svg is already a
 * dependency and its <Svg> exposes toDataURL(), so a PNG comes out of the same
 * element that is on screen with no new native module — no view-shot, no new
 * build risk of the kind that crashed 1.0.3 at launch (see
 * expo-precompiled-module-core-mismatch). The alternative was a capture library
 * for one screen.
 *
 * The web twin paints the identical card onto a canvas (app/receipt.js). The
 * two renderers are not compared to each other and cannot be; what is compared
 * is receiptLines(), which decides every string on it.
 */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import Svg, { Defs, G, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { t as i18nT } from '@/lib/i18n';
import { receiptLines, type ReceiptData } from '@/lib/receipt';

const W = 1080;
const GREEN_950 = '#00251a';
const GREEN_DARK = '#00482b';
const GOLD = '#f5b301';
const INK = '#ffffff';
const MUTED = '#a9c2b4';
const FAINT = '#8ba99a';
const PAD = 84;

const SANS = 'System';
const MONO = 'Menlo';

/**
 * Wrapping is done here rather than by the renderer because react-native-svg
 * has no text flow: an <SvgText> runs off the edge of the card rather than
 * breaking. Measured in characters against the glyph width the font actually
 * averages at each size — crude next to canvas measureText, and it only has to
 * be right enough that a long polling-unit name does not leave the card.
 */
function wrap(text: string, size: number, maxPx: number): string[] {
  const per = Math.max(1, Math.floor(maxPx / (size * 0.56)));
  const words = String(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (t.length > per && line) { out.push(line); line = w; } else { line = t; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** A hash has no spaces, so it breaks on characters or not at all. */
function chunk(s: string, size: number, maxPx: number): string[] {
  const per = Math.max(1, Math.floor(maxPx / (size * 0.6)));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += per) out.push(s.slice(i, i + per));
  return out;
}

export type ReceiptCardHandle = { toPng: () => Promise<string | null> };

export const ReceiptCard = forwardRef<ReceiptCardHandle, { data: ReceiptData; width?: number }>(
  function ReceiptCard({ data, width = 340 }, ref) {
    const svgRef = useRef<Svg>(null);
    /* i18nT returns the KEY when a string is missing, which on a card would
       print "receipt.foot" to an observer. Falling back to the English keeps
       the card readable in the one case native_keys_resolve did not catch. */
    const L = receiptLines(data, (k, en) => {
      const v = i18nT(k);
      return !v || v === k ? en : v;
    });

    useImperativeHandle(ref, () => ({
      toPng: () =>
        new Promise((resolve) => {
          const el = svgRef.current as unknown as { toDataURL?: (cb: (b: string) => void) => void };
          if (!el?.toDataURL) { resolve(null); return; }
          // Never hangs the screen on a picture of itself: if the bridge does
          // not answer, the card is still on screen to be screenshotted.
          const t = setTimeout(() => resolve(null), 4000);
          try {
            el.toDataURL((b64) => { clearTimeout(t); resolve(b64 || null); });
          } catch { clearTimeout(t); resolve(null); }
        }),
    }));

    // ---- lay the card out, top down, exactly as the canvas twin does -------
    const rows: React.ReactNode[] = [];
    let y = 96;
    const push = (node: React.ReactNode) => rows.push(node);
    const line = (t: string, size: number, fill: string, weight: '400' | '600' | '700', font = SANS) => {
      push(<SvgText key={`t${rows.length}`} x={PAD} y={y} fontSize={size} fill={fill} fontWeight={weight} fontFamily={font}>{t}</SvgText>);
    };

    line('Hawkeye', 46, INK, '700');
    y += 100;

    line(L.title.toUpperCase(), 30, GOLD, '700');
    y += 62;

    for (const ln of wrap(L.unit, 58, W - PAD * 2).slice(0, 2)) { line(ln, 58, INK, '700'); y += 68; }

    if (L.code) { line(L.code, 32, MUTED, '400'); y += 44; }
    for (const ln of wrap(L.where, 32, W - PAD * 2)) { if (L.where) { line(ln, 32, MUTED, '400'); y += 44; } }
    y += 18;

    for (const ln of wrap(L.contest, 36, W - PAD * 2)) { line(ln, 36, INK, '600'); y += 48; }
    line(L.when, 30, FAINT, '400');
    y += 56;

    // The tallies, right-aligned so the digits line up.
    const boxTop = y - 12;
    const rowH = 58;
    const boxH = 30 + L.votes.length * rowH + (L.votes.length ? 60 : 0);
    push(<Rect key="box" x={PAD - 24} y={boxTop} width={W - (PAD - 24) * 2} height={boxH} rx={20} fill="rgba(255,255,255,0.05)" />);
    y += 34;
    for (const v of L.votes) {
      push(<SvgText key={`p${v.party}`} x={PAD} y={y} fontSize={34} fill={INK} fontWeight="600" fontFamily={SANS}>{v.party}</SvgText>);
      push(<SvgText key={`n${v.party}`} x={W - PAD} y={y} fontSize={34} fill={INK} fontWeight="700" fontFamily={MONO} textAnchor="end">{String(v.count)}</SvgText>);
      y += rowH;
    }
    if (L.votes.length) {
      push(<Rect key="rule" x={PAD} y={y - 36} width={W - PAD * 2} height={2} fill="rgba(255,255,255,0.16)" />);
      push(<SvgText key="totl" x={PAD} y={y + 8} fontSize={30} fill={MUTED} fontWeight="600" fontFamily={SANS}>{L.totalLabel}</SvgText>);
      push(<SvgText key="totn" x={W - PAD} y={y + 8} fontSize={32} fill={INK} fontWeight="700" fontFamily={MONO} textAnchor="end">{String(L.total)}</SvgText>);
      y += 60;
    }
    y = boxTop + boxH + 64;

    if (L.practice) {
      /* SAID TWICE, because this is the card most likely to be forwarded out of
         context: once in the title at the top, once in a band of its own. */
      push(<Rect key="prac" x={PAD - 24} y={y - 40} width={W - (PAD - 24) * 2} height={96} rx={16} fill="rgba(245,179,1,0.14)" />);
      for (const ln of wrap(L.status, 28, W - PAD * 2 - 8)) { line(ln, 28, GOLD, '600'); y += 38; }
      y += 34;
      if (L.hash) {
        line(L.hashLabel, 24, MUTED, '600'); y += 36;
        for (const ln of chunk(L.hash, 26, W - PAD * 2)) { line(ln, 26, FAINT, '400', MONO); y += 32; }
        y += 10;
      }
    } else if (L.pending) {
      push(<Rect key="pend" x={PAD - 24} y={y - 40} width={W - (PAD - 24) * 2} height={96} rx={16} fill="rgba(245,179,1,0.14)" />);
      for (const ln of wrap(L.status, 28, W - PAD * 2 - 8)) { line(ln, 28, GOLD, '600'); y += 38; }
      y += 34;
    } else {
      line(L.hashLabel, 26, MUTED, '600'); y += 42;
      for (const ln of chunk(L.hash, 30, W - PAD * 2)) { line(ln, 30, GOLD, '700', MONO); y += 38; }
      y += 14;
      line(L.verifyLabel, 26, FAINT, '400');
      y += 44;
    }

    y += 30;
    for (const ln of wrap(L.foot, 25, W - PAD * 2)) { line(ln, 25, FAINT, '400'); y += 34; }

    /* CUT TO THE CONTENT. A fixed height left a third of the card empty on a
       short report and clipped a long one, and which it did depended on how
       many parties polled above zero. */
    const H = Math.round(y + 40);

    return (
      <Svg
        ref={svgRef}
        width={width}
        height={(width * H) / W}
        viewBox={`0 0 ${W} ${H}`}
      >
        <Defs>
          <LinearGradient id="rbg" x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor={GREEN_950} />
            <Stop offset="1" stopColor={GREEN_DARK} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={W} height={H} fill="url(#rbg)" />
        <G>{rows}</G>
      </Svg>
    );
  },
);

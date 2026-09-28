/**
 * The Hawkeye Observer certificate, drawn — the native twin of the canvas in
 * app/certificate.js, and saved the same way the receipt card is.
 *
 * DRAWN AS SVG, NOT CAPTURED FROM VIEWS: react-native-svg's <Svg> exposes
 * toDataURL(), so the PNG comes out of the element on screen with no new
 * native module (see receipt-card.tsx, and the precompiled-module note in
 * memory for why "just add view-shot" is not free in an OTA-only release).
 *
 * THE LAYOUT lives in lib/certificate-layout.ts, shared with the PDF, so what
 * prints is what is on screen. This file only maps its shapes to elements.
 *
 * The name is a PROP, drawn here and nowhere else. It is never sent anywhere.
 */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, G, Image as SvgImage, Path, Rect, Text as SvgText } from 'react-native-svg';

import { type Cert } from '@/lib/certificate';
import { CERT_H, CERT_W, certificateShapes, type CertFont, type CertShape } from '@/lib/certificate-layout';

const FONT: Record<CertFont, string | undefined> = {
  sans: 'System',
  serif: Platform.select({ ios: 'Georgia', default: 'serif' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
};

function el(sh: CertShape, key: number) {
  switch (sh.k) {
    case 'rect':
      return <Rect key={key} x={sh.x} y={sh.y} width={sh.w} height={sh.h} fill={sh.fill ?? 'none'} stroke={sh.stroke} strokeWidth={sh.sw} />;
    case 'circle':
      return <Circle key={key} cx={sh.cx} cy={sh.cy} r={sh.r} fill={sh.fill ?? 'none'} stroke={sh.stroke} strokeWidth={sh.sw} />;
    case 'path':
      return <Path key={key} d={sh.d} fill="none" stroke={sh.stroke} strokeWidth={sh.sw} strokeLinecap="round" strokeLinejoin="round" />;
    case 'image':
      return <SvgImage key={key} href={sh.href} x={sh.x} y={sh.y} width={sh.w} height={sh.h} preserveAspectRatio="xMidYMid meet" />;
    case 'text':
      return (
        <SvgText
          key={key}
          x={sh.x}
          y={sh.y}
          fontSize={sh.size}
          fill={sh.fill}
          fontFamily={FONT[sh.font]}
          fontWeight={sh.bold ? '700' : undefined}
          fontStyle={sh.italic ? 'italic' : undefined}
          textAnchor={sh.middle ? 'middle' : undefined}
          letterSpacing={sh.spacing}
        >
          {sh.text}
        </SvgText>
      );
  }
}

export type CertificateCardHandle = { toPng: () => Promise<string | null> };

export const CertificateCard = forwardRef<CertificateCardHandle, { cert: Cert; name: string; width?: number }>(
  function CertificateCard({ cert, name, width = 340 }, ref) {
    const svgRef = useRef<Svg>(null);

    useImperativeHandle(ref, () => ({
      toPng: () =>
        new Promise((resolve) => {
          const node = svgRef.current as unknown as { toDataURL?: (cb: (b: string) => void) => void };
          if (!node?.toDataURL) { resolve(null); return; }
          const timer = setTimeout(() => resolve(null), 4000);
          try {
            node.toDataURL((b64) => { clearTimeout(timer); resolve(b64 || null); });
          } catch { clearTimeout(timer); resolve(null); }
        }),
    }));

    return (
      <Svg ref={svgRef} width={width} height={(width * CERT_H) / CERT_W} viewBox={`0 0 ${CERT_W} ${CERT_H}`}>
        <G>{certificateShapes(cert, name).map(el)}</G>
      </Svg>
    );
  },
);

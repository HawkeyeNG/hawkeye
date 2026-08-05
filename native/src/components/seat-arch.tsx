import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { partyColor, type Chamber } from '@/lib/political';
import { useUi } from '@/lib/theme';

/**
 * A hemicycle — one dot per seat, the way a chamber actually sits. Port of the
 * website's seatArch(), kept deliberately identical in behaviour:
 *
 *  - Seats are dealt row by row from the outermost arc inwards, each row
 *    holding a share proportional to its radius, then filled left-to-right so
 *    every party occupies one contiguous block.
 *  - A bloc names ONLY the members a source actually places in that party.
 *    Seats it cannot name stay unnamed. Filling the remainder from members
 *    whose party nobody publishes is what the web version used to do, and it
 *    put Kano and Kaduna reps in the Labour bloc because Labour had spare
 *    seats. A coloured dot reads as a claim regardless of any caveat.
 *
 * Tap-first by design: this is a phone, there is no hover, and the web page's
 * <title> tooltip was invisible here.
 */
export function SeatArch({ parties, size, roster }: {
  parties: Record<string, number>;
  size: number;
  roster?: Chamber | null;
}) {
  const ui = useUi();
  const [open, setOpen] = useState<number | null>(null);

  const pool: Record<string, NonNullable<Chamber['members']>> = {};
  for (const m of roster?.members || []) {
    if (m.party) (pool[m.party] ||= []).push(m);
  }

  const entries = Object.entries(parties).sort((a, b) => b[1] - a[1]);
  const filled = entries.reduce((s, [, n]) => s + n, 0);
  const total = Math.max(size, filled);
  const ROWS = total > 200 ? 12 : 8;
  const R0 = 34;
  const R1 = 96;
  const radii = Array.from({ length: ROWS }, (_, i) => R0 + ((R1 - R0) * i) / (ROWS - 1));
  const weight = radii.reduce((a, r) => a + r, 0);
  const caps = radii.map((r) => Math.max(1, Math.round((total * r) / weight)));
  let drift = total - caps.reduce((a, b) => a + b, 0);
  for (let i = caps.length - 1; drift !== 0; i = (i - 1 + caps.length) % caps.length) {
    const d = drift > 0 ? 1 : -1;
    if (caps[i] + d >= 1) {
      caps[i] += d;
      drift -= d;
    }
  }

  const slots: { t: number; r: number }[] = [];
  caps.forEach((cap, row) => {
    for (let i = 0; i < cap; i++) slots.push({ t: cap === 1 ? 0.5 : i / (cap - 1), r: radii[row] });
  });
  slots.sort((a, b) => a.t - b.t || a.r - b.r);

  const seq: { party: string | null; m: Chamber['members'][number] | null }[] = [];
  entries.forEach(([p, n]) => {
    const named = (pool[p] || []).slice();
    for (let i = 0; i < n; i++) seq.push({ party: p, m: named[i] || null });
  });
  // The remainder are real sitting members whose party no source publishes.
  // They get a seat and their name, on a neutral grey dot with no party claim.
  const noParty = (roster?.members || []).filter((m) => !m.party);
  while (seq.length < total) seq.push({ party: null, m: noParty.shift() || null });

  const sel = open == null ? null : seq[open];

  return (
    <View>
      <Svg viewBox="0 0 220 124" width="100%" height={140}>
        {slots.map((s, i) => {
          const a = Math.PI * (1 - s.t);
          const x = 110 + Math.cos(a) * s.r;
          const y = 108 - Math.sin(a) * s.r;
          const { party: p, m } = seq[i];
          const boss = !!m?.office;
          return (
            <Circle
              key={i}
              cx={x}
              cy={y}
              r={boss ? 4.4 : 3.1}
              fill={p ? partyColor(p) : '#d7ded9'}
              // A transparent stroke widens the TAP area without changing what
              // is drawn. Unstroked, a seat is ~5px on a phone — well under the
              // ~9mm a fingertip covers, so most taps would land on nothing.
              // 2 units stays inside the gap between neighbours on the outer row.
              stroke={open === i ? ui.ink : boss ? '#d4a017' : 'rgba(0,0,0,0)'}
              strokeWidth={open === i ? 2 : boss ? 1.6 : 2}
              onPress={() => setOpen(open === i ? null : i)}
            />
          );
        })}
      </Svg>

      {sel ? (
        <Pressable
          onPress={() => setOpen(null)}
          className="mt-2 rounded-xl border border-line px-3 py-2"
          style={{ borderLeftWidth: 4, borderLeftColor: sel.party ? partyColor(sel.party) : '#9aa7a0' }}
        >
          {sel.m ? (
            <>
              <Text className="text-sm font-bold text-ink">{sel.m.name}</Text>
              {sel.m.office ? (
                <Text className="text-[11px] font-bold" style={{ color: '#a9791f' }}>
                  {sel.m.office}
                </Text>
              ) : null}
              <Text className="pt-0.5 text-[11px] text-muted">
                {sel.m.district || sel.m.state}
                {sel.m.party ? ` · ${sel.m.party}` : ''}
              </Text>
              <Text className="pt-1 text-[10px] text-faint">
                {!sel.m.party
                  ? 'No source publishes a party for this seat'
                  : sel.m.source
                    ? `Party per ${sel.m.source === 'hawkeye' ? 'Hawkeye (sourced attribution)' : sel.m.source}`
                    : ''}
              </Text>
            </>
          ) : (
            <>
              <Text className="text-sm font-bold text-ink">
                {sel.party ? `${sel.party} — seat not named` : 'Vacant / undeclared'}
              </Text>
              <Text className="pt-0.5 text-[11px] text-muted">
                {sel.party ? 'No source we have found names this seat' : 'No member declared'}
              </Text>
            </>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

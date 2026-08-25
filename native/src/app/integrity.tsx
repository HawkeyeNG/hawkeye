import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { SectionLabel, Stat } from '@/components/content-kit';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { flagLabel } from '@/lib/flags';
import { pick } from '@/lib/haptics';
import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';
import { GovDisclaimer } from '@/components/gov-disclaimer';
import { InfoDot } from '@/components/info-dot';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const REFRESH_MS = 30_000;

type Summary = {
  total: number;
  unitsFlagged: number;
  reports: number;
  bySeverity: { severity: string; c: number }[];
  byType: { type: string; severity: string; c: number }[];
};

type Discrepancy = {
  id: number;
  type: string;
  severity: 'high' | 'medium' | 'low';
  pu_code: string | null;
  pu_name: string | null;
  contest: string | null;
  state: string | null;
  detail: { summary?: string; reason?: string; docUrl?: string };
  created_at: number;
};

type Digit = { digit: number; observed: number; expectedPct: number };
type Benford = {
  n: number;
  nFirst: number;
  lastDigit: Digit[];
  firstDigit?: Digit[];
  mad: number;
  verdict: string;
};

type Irev = { electionId?: string | null; counts?: Record<string, number> };
type CollationStat = { byLevel?: Record<string, number>; flags?: Record<string, number> };

const VERDICT_TEXT: Record<string, (mad: number) => string> = {
  insufficient_data: () => 'needs ≥100 counts for a verdict',
  close_conformity: (m) => `close conformity (MAD ${m})`,
  acceptable_conformity: (m) => `acceptable conformity (MAD ${m})`,
  marginal_conformity: (m) => `marginal conformity (MAD ${m})`,
  nonconformity: (m) => `⚠ departs from Benford (MAD ${m})`,
};

/** The checklist from integrity.html — what an automated flag can even mean. */
const CHECKS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Against INEC & Collation Records',
    items: [
      ['INEC IReV mismatch', "the crowd's counts don't appear on INEC's own uploaded sheet for that unit."],
      ['Collation undercount', 'a ward/LGA/state form showing less for a party than its covered polling units alone add up to.'],
      ['Collation mismatch', "every unit in the scope is verified, yet the form's totals still differ."],
      ['Collation chain undercount', 'an LGA/state form showing less than the collation forms directly under it.'],
      ['Conflicting collation reports', 'observers at the same collation centre reporting different totals.'],
    ],
  },
  {
    title: 'Statistical Tripwires',
    items: [
      ['Over-voting', 'more votes than registered voters at a unit (impossible).'],
      ['Impossible turnout', 'turnout above ~95%, or a strong outlier vs. its state.'],
      ['Single-party sweep', 'one party taking ≥98% of a sizeable unit.'],
      ['Vote-share outlier', "a winner's share far above its own state's distribution for that race."],
      ['Neighbour divergence', 'a unit voting wildly unlike the rest of its own ward (≥50-point gap).'],
      ['Digit tests', 'first-digit Benford deviation and excess round numbers (…0/…5) per contest; screening signals, not proof.'],
    ],
  },
  {
    title: 'AI Vision on the Result Sheet',
    items: [
      ['Sheet authenticity', 'the EC8A photo flagged as a likely screenshot, edited, AI-generated, or not an EC8A form; advisory, for human review.'],
      ['Vision count mismatch', "an AI read of the sheet photo disagreeing with the observer's typed counts."],
    ],
  },
  {
    title: 'Provenance & Duplicates',
    items: [
      ['Duplicate form serial', 'the same EC8A serial reported at two units.'],
      ['Conflicting counts', 'independent observers at one unit disagreeing.'],
      ['Location inconsistency', 'a GPS cluster far from where a unit can be.'],
    ],
  },
  {
    title: 'Incident Patterns',
    items: [
      ['Incident hotspot', 'several incident reports of the same kind in one state within a short window.'],
    ],
  },
];

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Severity chip. Split into bg + text because React Native does not inherit a
 * colour class from a wrapping View onto the Text inside it — a single
 * "bg-x text-y" string on the View silently drops the foreground and the label
 * falls back to black, which on a dark tint is invisible. The tints themselves
 * are the semantic tokens, so the chip darkens with the theme instead of
 * staying pale under near-white text.
 */
const SEV_COLOR: Record<string, { bg: string; text: string }> = {
  high: { bg: 'bg-bad', text: 'text-bad-ink' },
  medium: { bg: 'bg-warn', text: 'text-warn-ink' },
  low: { bg: 'bg-line', text: 'text-good-ink' }, // green text, matching the website's low tag
};

function timeAgo(ts: number) {
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** One digit column: observed bar, with the expected level drawn across it. */
function DigitBars({ items, n }: { items: Digit[]; n: number }) {
  const max = Math.max(1, ...items.map((d) => d.observed));
  return (
    <View className="mt-2 h-28 flex-row items-end">
      {items.map((d) => {
        const h = Math.round((d.observed / max) * 100);
        const exp = Math.min(100, Math.round((((n * d.expectedPct) / 100) / max) * 100));
        return (
          <View key={d.digit} className="flex-1 items-center">
            <View className="h-24 w-full justify-end px-0.5">
              <View className="relative w-full" style={{ height: `${Math.max(h, 1)}%` }}>
                {/* bg-hawk-green is 1.4:1 on the dark card — the bars vanished.
                    good-ink is the same green in light mode and lifts in dark. */}
                <View className="h-full w-full rounded-t bg-good-ink" />
              </View>
              <View
                className="absolute left-0 right-0 h-0.5 bg-warn-ink/80"
                style={{ bottom: `${exp}%` }}
              />
            </View>
            <Text className="pt-1 text-[10px] text-muted">{d.digit}</Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Election Integrity — native twin of app/integrity.html.
 *
 * Automated checks run over every crowd-reported result and everything that
 * looks wrong is published here, flags and all. The framing matters as much as
 * the data: these are signals for scrutiny, never verdicts — a flag opens a
 * case in the Public Docket, where people (not the algorithm) decide.
 */
export default function Integrity() {
  const ui = useUi();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Discrepancy[] | null>(null);
  const [benford, setBenford] = useState<Benford | null>(null);
  const [irev, setIrev] = useState<Irev | null>(null);
  const [coll, setColl] = useState<CollationStat | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [sev, setSev] = useState('');
  const [type, setType] = useState('');
  const [stateSel, setStateSel] = useState('');
  const [states, setStates] = useState<string[]>([]);
  // Every "What We Check" group starts collapsed. Seeding this with { 0: true }
  // auto-opened "Against INEC & Collation Records" on load, which buried the
  // dashboard under a list nobody asked to see. Nothing in the render depends on
  // a panel being open — open[i] is read as a plain truthy check.
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  const loadRows = useCallback(async () => {
    const qs = new URLSearchParams();
    if (sev) qs.set('severity', sev);
    if (type) qs.set('type', type);
    if (stateSel) qs.set('state', stateSel);
    const d = await jget<{ discrepancies: Discrepancy[] }>(
      `/api/integrity/discrepancies?${qs.toString()}`,
    );
    setRows(d.discrepancies);
    // The state filter can only offer states that actually appear in the log.
    setStates((prev) => {
      const seen = new Set([...prev, ...d.discrepancies.map((x) => x.state).filter(Boolean)]);
      return [...seen].sort() as string[];
    });
  }, [sev, type, stateSel]);

  const loadAll = useCallback(async () => {
    try {
      const [s, b, i, c] = await Promise.all([
        jget<Summary>('/api/integrity/summary'),
        jget<Benford>('/api/integrity/benford'),
        jget<Irev>('/api/integrity/irev'),
        jget<CollationStat>('/api/integrity/collation'),
      ]);
      setSummary(s);
      setBenford(b);
      setIrev(i);
      setColl(c);
      await loadRows();
      setErr(null);
    } catch (e) {
      setErr(humanError(e));
    }
  }, [loadRows]);

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, REFRESH_MS);
    return () => clearInterval(t);
  }, [loadAll]);

  useEffect(() => {
    loadRows().catch(() => {});
  }, [loadRows]);

  const bySev = Object.fromEntries((summary?.bySeverity ?? []).map((r) => [r.severity, r.c]));
  const types = [...new Set((summary?.byType ?? []).map((r) => r.type))];

  const Chip = ({
    label,
    on,
    onPress,
  }: {
    label: string;
    on: boolean;
    onPress: () => void;
  }) => (
    <Pressable
      onPress={onPress}
      className={`mb-2 mr-2 rounded-full px-3.5 py-2 ${on ? 'bg-hawk-green' : 'bg-card'}`}
    >
      <Text className={`text-xs font-semibold ${on ? 'text-hawk-gold' : 'text-muted'}`}>
        {label}
      </Text>
    </Pressable>
  );

  const irevLine = !irev
    ? 'Loading…'
    : !irev.electionId
      ? 'Waiting for INEC to open the election on IReV — the check activates automatically once configured.'
      : (() => {
          const c = irev.counts ?? {};
          const total = Object.values(c).reduce((s, n) => s + n, 0);
          return `Checked ${total} unit(s): ${c.consistent || 0} consistent · ${c.mismatch || 0} mismatched · ${c.inconclusive || 0} inconclusive · ${c.no_doc || 0} not yet on IReV.`;
        })();

  const collLine = (() => {
    if (!coll) return 'Loading…';
    const b = coll.byLevel ?? {};
    const f = coll.flags ?? {};
    const total = (b.ward || 0) + (b.lga || 0) + (b.state || 0);
    return total
      ? `${total} collation report(s): ${b.ward || 0} ward · ${b.lga || 0} LGA · ${b.state || 0} state — ${f.collation_undercount || 0} undercount flag(s), ${f.collation_disputed || 0} disputed.`
      : 'No collation reports yet — they arrive on election night as results move up the ladder.';
  })();

  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Election Integrity" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ui.tint.good.ink}
            onRefresh={async () => {
              setRefreshing(true);
              await loadAll();
              setRefreshing(false);
            }}
          />
        }
      >
        <GovDisclaimer />
        {/* The Beta card is gone, and its "official results remain INEC's" tail
            with it — the disclaimer bar directly above already says that. The
            one point it carried that nothing else does (a flag is not a verdict)
            is folded into the sentence below. */}
        <View className="flex-row items-center pb-3">
          <Text className="flex-1 text-sm text-muted">
            Automated checks on every result. Anything that looks wrong is logged here.
          </Text>
          <InfoDot
            title="What gets checked"
            text="Over-voting, impossible turnout, forged form serials, conflicting counts and statistical outliers. A flag is a signal for scrutiny, not a verdict — and never proof of fraud."
          />
        </View>

        {err ? (
          <Text className="pb-2 text-sm font-semibold text-warn-ink">
            Could not refresh. ({err})
          </Text>
        ) : null}

        {/* The shared dashboard tile, same as the Ledger and the Docket. Severity
            tints the whole tile rather than just its numeral, and only when the
            count is non-zero — a screen with nothing flagged is not a red
            screen, which is the rule the other two dashboards already follow. */}
        <View className="flex-row flex-wrap">
          <Stat
            value={String(bySev.high || 0)}
            label="High-severity flags"
            tone={bySev.high ? 'bad' : undefined}
            topBar="#d4351c"
          />
          <Stat
            value={String(bySev.medium || 0)}
            label="Medium flags"
            tone={bySev.medium ? 'warn' : undefined}
            topBar="#d4770c"
          />
          <Stat value={String(bySev.low || 0)} label="Low flags" topBar="#004225" />
          <Stat value={String(summary?.unitsFlagged ?? 0)} label="Units flagged" topBar="#004225" />
          <Stat value={(summary?.reports ?? 0).toLocaleString()} label="Reports screened" topBar="#004225" />
        </View>

        <SectionLabel text="Detected Discrepancies" />
        <View className="flex-row flex-wrap">
          {[
            ['', 'All'],
            ['high', '🚩 High'],
            ['medium', '⚠️ Medium'],
            ['low', 'ℹ️ Low'],
          ].map(([k, label]) => (
            <Chip key={k || 'all'} label={label} on={sev === k} onPress={() => setSev(k)} />
          ))}
        </View>
        {types.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="pb-1">
            <Chip label="All types" on={!type} onPress={() => setType('')} />
            {types.map((t) => (
              <Chip
                key={t}
                label={flagLabel(t)}
                on={type === t}
                onPress={() => setType(type === t ? '' : t)}
              />
            ))}
          </ScrollView>
        ) : null}
        {states.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="pb-1">
            <Chip label="All states" on={!stateSel} onPress={() => setStateSel('')} />
            {states.map((s) => (
              <Chip
                key={s}
                label={s}
                on={stateSel === s}
                onPress={() => setStateSel(stateSel === s ? '' : s)}
              />
            ))}
          </ScrollView>
        ) : null}

        {rows === null ? (
          <ActivityIndicator className="py-4" color={ui.tint.good.ink} />
        ) : rows.length === 0 ? (
          <Text className="py-3 text-sm text-muted">
            No discrepancies match — nothing flagged yet.
          </Text>
        ) : (
          rows.map((d) => {
            const summaryText = d.detail.summary || '';
            const long = summaryText.length > 120;
            const show = expanded[d.id] || !long;
            return (
              <View key={d.id} className="mb-2 rounded-2xl bg-card px-4 py-3">
                <View className="flex-row items-center">
                  <View
                    className={`rounded-full px-2 py-0.5 ${(SEV_COLOR[d.severity] ?? SEV_COLOR.low).bg}`}
                  >
                    <Text
                      className={`text-[10px] font-bold ${(SEV_COLOR[d.severity] ?? SEV_COLOR.low).text}`}
                    >
                      {d.severity.toUpperCase()}
                    </Text>
                  </View>
                  <Text className="flex-1 pl-2 text-sm font-bold text-ink">
                    {flagLabel(d.type)}
                  </Text>
                  <Text className="text-[11px] text-faint">{timeAgo(d.created_at)}</Text>
                </View>
                <Text className="pt-1 text-sm text-ink">
                  {d.pu_name ? d.pu_name : d.state || '—'}
                </Text>
                {d.pu_code ? (
                  <Text className="text-[11px] text-muted">
                    {d.pu_code}
                    {d.state ? ` · ${d.state}` : ''}
                  </Text>
                ) : null}
                {summaryText ? (
                  <Text className="pt-1.5 text-sm text-ink">
                    {show ? summaryText : `${summaryText.slice(0, 120).replace(/\s+\S*$/, '')}…`}
                    {d.contest ? ` (${d.contest})` : ''}
                  </Text>
                ) : null}
                {long ? (
                  <Pressable onPress={() => setExpanded((e) => ({ ...e, [d.id]: !e[d.id] }))}>
                    <Text className="pt-1 text-xs font-bold text-good-ink">
                      {show ? 'less' : 'more'}
                    </Text>
                  </Pressable>
                ) : null}
                {d.detail.docUrl ? (
                  <Pressable
                    className="pt-1.5"
                    onPress={() => WebBrowser.openBrowserAsync(d.detail.docUrl!)}
                  >
                    <Text className="text-xs font-bold text-good-ink">
                      View INEC&apos;s sheet ↗
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}

        <SectionLabel text="Digit-Distribution Screening" />
        <View className="flex-row items-center pb-2">
          <Text className="flex-1 text-sm text-muted">
            Screening signal, never proof on its own.
            {benford ? ` Based on ${benford.n} unit result(s), ${benford.nFirst || 0} party count(s).` : ''}
          </Text>
          <InfoDot
            title="Digit-distribution screening"
            text="Fabricated figures cluster on favourite digits, while genuine counts follow known distributions — Benford's law for first digits, and a roughly even spread for last digits. A departure means these numbers are worth a closer look, nothing more. Real elections throw up odd-looking distributions for innocent reasons, so a flag here is a prompt to check the evidence, not a finding of fraud."
          />
        </View>
        <View className="rounded-2xl bg-card px-4 py-4">
          <Text className="text-sm font-bold text-ink">
            First Digit — Benford&apos;s Law{' '}
            <Text className="text-xs font-semibold text-muted">
              {benford && VERDICT_TEXT[benford.verdict]
                ? `— ${VERDICT_TEXT[benford.verdict](benford.mad)}`
                : ''}
            </Text>
          </Text>
          <Text className="pt-0.5 text-xs text-muted">
            First digit of every party count vs Benford&apos;s expected curve (amber line).
          </Text>
          {benford?.firstDigit ? (
            <DigitBars items={benford.firstDigit} n={benford.nFirst} />
          ) : (
            <Text className="pt-2 text-xs text-faint">No counts yet.</Text>
          )}

          <Text className="pt-4 text-sm font-bold text-ink">Last Digit — Uniformity</Text>
          <Text className="pt-0.5 text-xs text-muted">
            Last digit of winning-party counts. A healthy spread sits near the 10% line.
          </Text>
          {benford?.lastDigit?.length ? (
            <DigitBars items={benford.lastDigit} n={benford.n} />
          ) : (
            <Text className="pt-2 text-xs text-faint">No counts yet.</Text>
          )}
        </View>

        <SectionLabel text="INEC IReV Cross-Check" />
        <View className="flex-row items-center pb-2">
          <Text className="flex-1 text-sm text-muted">
            The crowd&apos;s count, checked against INEC&apos;s own uploaded sheet.
          </Text>
          <InfoDot
            title="INEC IReV cross-check"
            text="For each polling unit, the crowd's reported count is compared against the EC8A sheet INEC itself uploads to its Results Viewing portal (IReV) — INEC's own evidence checked against the crowd's, neither one trusted over the other. Any mismatch appears in the discrepancies above."
          />
        </View>
        <View className="rounded-2xl bg-card px-4 py-3">
          <Text className="text-sm text-ink">{irevLine}</Text>
        </View>

        <SectionLabel text="Collation Reconciliation (EC8B/C/D)" />
        <View className="flex-row items-center pb-2">
          <Text className="flex-1 text-sm text-muted">
            Announced totals, checked against the units underneath them.
          </Text>
          <InfoDot
            title="Collation reconciliation"
            text="Ward (EC8B), LGA (EC8C) and state (EC8D) collation totals are checked against the polling-unit sheets they are built from. A collated figure can never be LESS than the sum of the covered units alone — when it is, that is arithmetic proof of subtraction, not a matter of opinion. This is the step where a count is most often changed."
          />
        </View>
        <View className="rounded-2xl bg-card px-4 py-3">
          <Text className="text-sm text-ink">{collLine}</Text>
          <Pressable className="pt-2" onPress={() => router.push('/report/collation')}>
            <Text className="text-sm font-bold text-good-ink">Report a collation result →</Text>
          </Pressable>
        </View>

        <SectionLabel text="What We Check" />
        <Text className="pb-2 text-sm text-muted">
          Every result is run through these automated checks. Tap a group to see each one.
        </Text>
        <View className="overflow-hidden rounded-2xl bg-card">
          {CHECKS.map((g, i) => (
            <View key={g.title} className={i > 0 ? 'border-t border-line' : ''}>
              <Pressable
                className="flex-row items-center px-4 py-3.5 active:bg-surface"
                // Exclusive: replacing the map rather than spreading it shuts
                // whichever group was open. Twin of the delegated `toggle`
                // handler in app/menu.js; profile.tsx already behaves this way
                // via a single openSection.
                onPress={() => {
                  pick();
                  setOpen((o) => (o[i] ? {} : { [i]: true }));
                }}
              >
                <Text className="flex-1 text-sm font-bold text-ink">{g.title}</Text>
                <Feather name={open[i] ? 'chevron-up' : 'chevron-down'} size={16} color={ui.faint} />
              </Pressable>
              {/* Each item is a DISTINCT check, so partition the rows the way the
                  groups themselves are partitioned — same hairline border-line.
                  The first row is divided from its own summary already, hence
                  the j > 0 guard. Web twin: .acc-wrap.checks .acc li. */}
              {open[i]
                ? g.items.map(([name, what], j) => (
                    <View
                      key={name}
                      className={`px-4 py-2.5 ${j > 0 ? 'border-t border-line' : ''}`}
                    >
                      <Text className="text-sm text-ink">
                        <Text className="font-bold text-ink">{name}</Text> — {what}
                      </Text>
                    </View>
                  ))
                : null}
            </View>
          ))}
        </View>

        {/* Dropped: the "not proof" point is now made once, in the intro line at
            the top of this screen, and the INEC half is the disclaimer bar's job. */}
      </Animated.ScrollView>
    </View>
  );
}

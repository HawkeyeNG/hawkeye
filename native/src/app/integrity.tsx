import Feather from '@expo/vector-icons/Feather';
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
import { t as i18nT, lazyT } from '@/lib/i18n';

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
  insufficient_data: () => i18nT('n.app.integrity.needs-100-counts-for-a-verdict'),
  close_conformity: (m) => i18nT('n.app.integrity.close-conformity-mad', { v0: m }),
  acceptable_conformity: (m) => i18nT('n.app.integrity.acceptable-conformity-mad', { v0: m }),
  marginal_conformity: (m) => i18nT('n.app.integrity.marginal-conformity-mad', { v0: m }),
  nonconformity: (m) => i18nT('n.app.integrity.departs-from-benford-mad', { v0: m }),
};

/** The checklist from integrity.html — what an automated flag can even mean. */
/**
 * Each entry is [english-label, english-description, label-key, description-key].
 *
 * The English stays because this file still has to read as English source and
 * render correctly with no bundle; the keys are resolved during render, because
 * CHECKS is a module-level const evaluated once at import, before AsyncStorage
 * has returned the stored language.
 *
 * The label and section keys are the WEB's — the same terms, in the same
 * sentence case the web uses for them (flags.ts keeps its own Title Case keys
 * for card titles; see the note there). The description keys are n.* but their
 * VALUES were derived from the web's own translated sentences by
 * tmp/patch_native_integrity.py, so the two clients cannot describe the same
 * check differently.
 */
const CHECKS: { title: string; titleKey: string; items: [string, string, string, string][] }[] = lazyT([
  {
    title: 'integrity.against-inec-collation-records',
    titleKey: 'integrity.against-inec-collation-records',
    items: [
      ['INEC IReV mismatch', "the crowd's counts don't appear on INEC's own uploaded sheet for that unit.", 'integrity.inec-irev-mismatch', 'n.app.integrity.desc.inec-irev-mismatch'],
      ['Collation undercount', 'a ward/LGA/state form showing less for a party than its covered polling units alone add up to.', 'integrity.collation-undercount', 'n.app.integrity.desc.collation-undercount'],
      ['Collation mismatch', "every unit in the scope is verified, yet the form's totals still differ.", 'integrity.collation-mismatch', 'n.app.integrity.desc.collation-mismatch'],
      ['Collation chain undercount', 'an LGA/state form showing less than the collation forms directly under it.', 'integrity.collation-chain-undercount', 'n.app.integrity.desc.collation-chain-undercount'],
      ['Conflicting collation reports', 'observers at the same collation centre reporting different totals.', 'integrity.conflicting-collation-reports', 'n.app.integrity.desc.conflicting-collation-reports'],
    ],
  },
  {
    title: 'integrity.statistical-tripwires',
    titleKey: 'integrity.statistical-tripwires',
    items: [
      ['Over-voting', 'more votes than registered voters at a unit (impossible).', 'integrity.over-voting', 'n.app.integrity.desc.over-voting'],
      ['Impossible turnout', 'turnout above ~95%, or a strong outlier vs. its state.', 'integrity.impossible-turnout', 'n.app.integrity.desc.impossible-turnout'],
      ['Single-party sweep', 'one party taking ≥98% of a sizeable unit.', 'integrity.single-party-sweep', 'n.app.integrity.desc.single-party-sweep'],
      ['Vote-share outlier', "a winner's share far above its own state's distribution for that race.", 'integrity.vote-share-outlier', 'n.app.integrity.desc.vote-share-outlier'],
      ['Neighbour divergence', 'a unit voting wildly unlike the rest of its own ward (≥50-point gap).', 'integrity.neighbour-divergence', 'n.app.integrity.desc.neighbour-divergence'],
      ['Digit tests', 'first-digit Benford deviation and excess round numbers (…0/…5) per contest; screening signals, not proof.', 'integrity.digit-tests', 'n.app.integrity.desc.digit-tests'],
    ],
  },
  {
    title: 'integrity.ai-vision-on-the-result-sheet',
    titleKey: 'integrity.ai-vision-on-the-result-sheet',
    items: [
      ['Sheet authenticity', 'the EC8A photo flagged as a likely screenshot, edited, AI-generated, or not an EC8A form; advisory, for human review.', 'integrity.sheet-authenticity', 'n.app.integrity.desc.sheet-authenticity'],
      ['Vision count mismatch', "an AI read of the sheet photo disagreeing with the observer's typed counts.", 'integrity.vision-count-mismatch', 'n.app.integrity.desc.vision-count-mismatch'],
    ],
  },
  {
    title: 'integrity.provenance-duplicates',
    titleKey: 'integrity.provenance-duplicates',
    items: [
      ['Duplicate form serial', 'the same EC8A serial reported at two units.', 'integrity.duplicate-form-serial', 'n.app.integrity.desc.duplicate-form-serial'],
      ['Conflicting counts', 'independent observers at one unit disagreeing.', 'integrity.conflicting-counts', 'n.app.integrity.desc.conflicting-counts'],
      ['Location inconsistency', 'a GPS cluster far from where a unit can be.', 'integrity.location-inconsistency', 'n.app.integrity.desc.location-inconsistency'],
    ],
  },
  {
    title: 'integrity.incident-patterns',
    titleKey: 'integrity.incident-patterns',
    items: [
      ['Incident hotspot', 'several incident reports of the same kind in one state within a short window.', 'integrity.incident-hotspot', 'n.app.integrity.desc.incident-hotspot'],
    ],
  },
]);

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
  if (diff < 3600) return i18nT('n.app.integrity.min-ago', { v0: Math.floor(diff / 60) });
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
      ? i18nT('n.app.integrity.waiting-for-inec-to-open-the')
      : (() => {
          const c = irev.counts ?? {};
          const total = Object.values(c).reduce((s, n) => s + n, 0);
          return i18nT('n.app.integrity.checked-unit-s-consistent-mismatched-inconclusive', { v0: total, v1: c.consistent || 0, v2: c.mismatch || 0, v3: c.inconclusive || 0, v4: c.no_doc || 0 });
        })();

  const collLine = (() => {
    if (!coll) return 'Loading…';
    const b = coll.byLevel ?? {};
    const f = coll.flags ?? {};
    const total = (b.ward || 0) + (b.lga || 0) + (b.state || 0);
    return total
      ? i18nT('n.app.integrity.collation-report-s-ward-lga-state', { v0: total, v1: b.ward || 0, v2: b.lga || 0, v3: b.state || 0, v4: f.collation_undercount || 0, v5: f.collation_disputed || 0 })
      : i18nT('n.app.integrity.no-collation-reports-yet-they-arrive');
  })();

  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('common.election-integrity')} translateY={translateY} onClose={() => router.back()} />
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
            {i18nT('n.app.integrity.automated-checks-on-every-result-anything')}
          </Text>
          <InfoDot
            title={i18nT('n.app.integrity.what-gets-checked')}
            text={i18nT("n.app.integrity.over-voting-impossible-turnout-forged-form-serials")}
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
            label={i18nT('n.app.integrity.high-severity-flags')}
            tone={bySev.high ? 'bad' : undefined}
            topBar="#d4351c"
          />
          <Stat
            value={String(bySev.medium || 0)}
            label={i18nT('n.app.integrity.medium-flags')}
            tone={bySev.medium ? 'warn' : undefined}
            topBar="#d4770c"
          />
          <Stat value={String(bySev.low || 0)} label={i18nT('n.app.integrity.low-flags')} topBar="#004225" />
          <Stat value={String(summary?.unitsFlagged ?? 0)} label={i18nT('n.app.integrity.units-flagged')} topBar="#004225" />
          <Stat value={(summary?.reports ?? 0).toLocaleString()} label={i18nT('n.app.integrity.reports-screened')} topBar="#004225" />
        </View>

        <SectionLabel text={i18nT("n.app.integrity.detected-discrepancies")} />
        <View className="flex-row flex-wrap">
          {[
            ['', i18nT('n.app.integrity.severity-all')],
            ['high', '🚩 ' + i18nT('n.app.integrity.severity-high')],
            ['medium', '⚠️ ' + i18nT('n.app.integrity.severity-medium')],
            ['low', 'ℹ️ ' + i18nT('n.app.integrity.severity-low')],
          ].map(([k, label]) => (
            <Chip key={k || 'all'} label={label} on={sev === k} onPress={() => setSev(k)} />
          ))}
        </View>
        {types.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="pb-1">
            <Chip label={i18nT('integrity.all-types')} on={!type} onPress={() => setType('')} />
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
            <Chip label={i18nT('integrity.all-states')} on={!stateSel} onPress={() => setStateSel('')} />
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
            {i18nT('n.app.integrity.no-discrepancies-match-nothing-flagged-yet')}
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
                      {i18nT('n.app.integrity.view-inec-s-sheet')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}

        <SectionLabel text={i18nT("n.app.integrity.digit-distribution-screening")} />
        <View className="flex-row items-center pb-2">
          <Text className="flex-1 text-sm text-muted">
            {i18nT('n.app.integrity.screening-signal-never-proof-on-its')}
            {benford ? i18nT('n.app.integrity.based-on-unit-result-s-party', { v0: benford.n, v1: benford.nFirst || 0 }) : ''}
          </Text>
          <InfoDot
            title={i18nT('n.app.integrity.digit-distribution-screening')}
            text={i18nT("n.app.integrity.fabricated-figures-cluster-on-favourite-digits-while")}
          />
        </View>
        <View className="rounded-2xl bg-card px-4 py-4">
          <Text className="text-sm font-bold text-ink">
            {i18nT('n.app.integrity.first-digit-benford-s-law')}{' '}
            <Text className="text-xs font-semibold text-muted">
              {benford && VERDICT_TEXT[benford.verdict]
                ? `— ${VERDICT_TEXT[benford.verdict](benford.mad)}`
                : ''}
            </Text>
          </Text>
          <Text className="pt-0.5 text-xs text-muted">
            {i18nT('n.app.integrity.first-digit-of-every-party-count')}
          </Text>
          {benford?.firstDigit ? (
            <DigitBars items={benford.firstDigit} n={benford.nFirst} />
          ) : (
            <Text className="pt-2 text-xs text-faint">{i18nT('n.app.integrity.no-counts-yet')}</Text>
          )}

          <Text className="pt-4 text-sm font-bold text-ink">{i18nT('integrity.last-digit-uniformity')}</Text>
          <Text className="pt-0.5 text-xs text-muted">
            {i18nT('n.app.integrity.last-digit-of-winning-party-counts')}
          </Text>
          {benford?.lastDigit?.length ? (
            <DigitBars items={benford.lastDigit} n={benford.n} />
          ) : (
            <Text className="pt-2 text-xs text-faint">{i18nT('n.app.integrity.no-counts-yet')}</Text>
          )}
        </View>

        <SectionLabel text={i18nT("n.app.integrity.inec-irev-cross-check")} />
        <View className="flex-row items-center pb-2">
          <Text className="flex-1 text-sm text-muted">
            {i18nT('n.app.integrity.the-crowd-s-count-checked-against')}
          </Text>
          <InfoDot
            title={i18nT('n.app.integrity.inec-irev-cross-check')}
            text={i18nT("n.app.integrity.for-each-polling-unit-the-crowd-s")}
          />
        </View>
        <View className="rounded-2xl bg-card px-4 py-3">
          <Text className="text-sm text-ink">{irevLine}</Text>
        </View>

        <SectionLabel text={i18nT("n.app.integrity.collation-reconciliation-ec8b-c-d")} />
        <View className="flex-row items-center pb-2">
          <Text className="flex-1 text-sm text-muted">
            {i18nT('n.app.integrity.announced-totals-checked-against-the-units')}
          </Text>
          <InfoDot
            title={i18nT('n.app.integrity.collation-reconciliation')}
            text={i18nT("n.app.integrity.ward-ec8b-lga-ec8c-and-state-ec8d")}
          />
        </View>
        <View className="rounded-2xl bg-card px-4 py-3">
          <Text className="text-sm text-ink">{collLine}</Text>
          <Pressable className="pt-2" onPress={() => router.push('/report/collation')}>
            <Text className="text-sm font-bold text-good-ink">{i18nT('integrity.report-a-collation-result')}</Text>
          </Pressable>
        </View>

        <SectionLabel text={i18nT("n.app.integrity.what-we-check")} />
        <Text className="pb-2 text-sm text-muted">
          {i18nT('n.app.integrity.every-result-is-run-through-these')}
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
                <Text className="flex-1 text-sm font-bold text-ink">{i18nT(g.titleKey)}</Text>
                <Feather name={open[i] ? 'chevron-up' : 'chevron-down'} size={16} color={ui.faint} />
              </Pressable>
              {/* Each item is a DISTINCT check, so partition the rows the way the
                  groups themselves are partitioned — same hairline border-line.
                  The first row is divided from its own summary already, hence
                  the j > 0 guard. Web twin: .acc-wrap.checks .acc li. */}
              {open[i]
                ? g.items.map(([name, what, nameKey, whatKey], j) => (
                    <View
                      key={name}
                      className={`px-4 py-2.5 ${j > 0 ? 'border-t border-line' : ''}`}
                    >
                      <Text className="text-sm text-ink">
                        <Text className="font-bold text-ink">{i18nT(nameKey)}</Text> — {i18nT(whatKey)}
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

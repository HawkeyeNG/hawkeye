import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';

import { SectionLabel, Stat } from '@/components/content-kit';
import { InfoDot } from '@/components/info-dot';
import { ScreenHeader } from '@/components/screen-header';
import { StatusChip, TallyBar, type Tally } from '@/components/tally';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { api } from '@/lib/api';
import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

type Case = {
  id: number;
  puCode: string;
  contest: string;
  status: string;
  openedAt: number;
  closesAt: number;
  resolvedAt: number | null;
  tally: Tally;
  name: string | null;
  ward: string | null;
  lga: string | null;
  state: string | null;
};

type DocketFeed = {
  rule: string;
  quorum?: number;
  supermajority?: number;
  windowDays?: number;
  cases: Case[];
};

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : '');

/**
 * How many results are actually being withheld from the headline tallies —
 * asked of the server that does the withholding, never re-derived here.
 *
 * The server drops a result from the tally on EITHER an unresolved
 * high-severity flag on that (unit, contest) OR a case in open/upheld/
 * unresolved, and reports the true total as `inDispute`. The case rows on this
 * screen only see the second half of that test, so counting them understates
 * the real figure — badly, in the configuration this app ships:
 * DOCKET_AUTO_OPEN_CASES is off for the general election, so a flag withholds
 * a result immediately while its case is only opened in the batch after polls
 * close. Counting cases would have published a confident 0 while results were
 * genuinely being held back.
 *
 * Summed over every configured contest, because a result is withheld per
 * (unit, contest) and this screen is not scoped to one contest. Returns null —
 * not 0 — if anything is missing or fails, so the caller can drop the tile
 * rather than show a number it cannot stand behind. A partial sum is a wrong
 * number, and this tile is only allowed to be right or absent.
 */
async function fetchHeldOut(): Promise<number | null> {
  try {
    const contests = await api.contests();
    if (!contests.length) return null;
    const tallies = await Promise.all(contests.map((c) => api.national(c.code)));
    let total = 0;
    for (const t of tallies) {
      if (typeof t.inDispute !== 'number') return null;
      total += t.inDispute;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Public Docket — native twin of app/docket.html.
 *
 * A flag never decides anything; it withholds the result and queues it for a
 * case. Cases are published with their evidence and judged by verified
 * observers answering factual questions, with quorum and a supermajority
 * resolving them. Nobody at Hawkeye votes. (Queues, not opens: with
 * DOCKET_AUTO_OPEN_CASES off — the default, and the setting the real general
 * election runs — the case is only created by the post-election admin batch.)
 *
 * Shaped as a dashboard, same language as Election Integrity and Verify the
 * Ledger: the counts come first — including how many results are being held out
 * of the tallies, which is the page's actual claim — one sentence says what that
 * means, and the rules sit in collapsed folds. The case list underneath is
 * unchanged; it is what the reader came for.
 *
 * Where each number comes from: the five case tiles count the case rows in
 * /api/docket, which is the same list rendered below them. The "held out of
 * tallies" tile is the server's own `inDispute`, summed across contests from
 * /api/national/:contest — the count of results it actually excluded. It is
 * never inferred from the case rows, which cannot see it (fetchHeldOut), and
 * it is not rendered at all when the server hasn't supplied it.
 */
export default function Docket() {
  const ui = useUi();
  const [cases, setCases] = useState<Case[] | null>(null);
  const [rule, setRule] = useState('');
  const [quorum, setQuorum] = useState<number | null>(null);
  const [supermajority, setSupermajority] = useState<number | null>(null);
  const [windowDays, setWindowDays] = useState<number | null>(null);
  // null = we don't know yet (or couldn't find out) — the tile stays off screen.
  const [heldOut, setHeldOut] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();

  const load = useCallback(async () => {
    // Kicked off alongside the docket, and never rejects — a failure there
    // costs the one tile, not the page.
    const held = fetchHeldOut();
    try {
      const res = await fetch(`${BASE}/api/docket`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as DocketFeed;
      setRule(d.rule);
      setQuorum(d.quorum ?? null);
      setSupermajority(d.supermajority ?? null);
      setWindowDays(d.windowDays ?? null);
      setHeldOut(await held);
      setCases(d.cases);
      setErr(null);
    } catch (e) {
      setHeldOut(await held);
      setErr(humanError(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Case counts only. Each of these is a straight tally of the case rows this
   * screen already lists, so each measures exactly what its label says. The
   * count of results held out of the tallies is deliberately NOT derived here —
   * it isn't a function of these rows (see fetchHeldOut).
   */
  const n = useMemo(() => {
    const list = cases ?? [];
    const by = (s: string) => list.filter((c) => c.status === s).length;
    return {
      open: by('open'),
      upheld: by('upheld'),
      unresolved: by('unresolved'),
      cleared: by('cleared'),
      verdicts: list.reduce((sum, c) => sum + (c.tally?.total ?? 0), 0),
    };
  }, [cases]);

  const pct = supermajority ? Math.round(supermajority * 100) : null;

  const header = (
    <View className="px-4 pb-2 pt-3">
      <View className="mb-3 rounded-xl bg-warn px-3 py-2">
        <Text className="text-xs font-semibold text-warn-ink">
          Flagged results, judged by the crowd. Nobody at Hawkeye decides.
        </Text>
      </View>

      {err ? (
        <View className="mb-2 rounded-2xl bg-bad px-4 py-3">
          <Text className="text-sm font-semibold text-bad-ink">
            Could not load the docket. ({err})
          </Text>
          <Pressable
            className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
            onPress={load}
          >
            <Text className="text-base font-bold text-hawk-gold">Retry</Text>
          </Pressable>
        </View>
      ) : cases === null ? (
        <ActivityIndicator className="py-8" color={ui.tint.good.ink} />
      ) : (
        <View className="flex-row flex-wrap">
          <Stat
            value={String(n.open)}
            label="Open cases"
            tone={n.open ? 'warn' : undefined}
          />
          {/* Only rendered once the server has told us the real figure. */}
          {heldOut === null ? null : (
            <Stat
              value={String(heldOut)}
              label="Held out of tallies"
              tone={heldOut ? 'bad' : undefined}
            />
          )}
          <Stat
            value={String(n.upheld)}
            label="Struck by the crowd"
            tone={n.upheld ? 'bad' : undefined}
          />
          <Stat
            value={String(n.cleared)}
            label="Cleared by the crowd"
            tone={n.cleared ? 'good' : undefined}
          />
          <Stat value={String(n.unresolved)} label="Left unresolved" />
          <Stat value={n.verdicts.toLocaleString()} label="Verdicts cast" />
        </View>
      )}

      {/* The one sentence the screen's claim rests on, plus a dot carrying the
          four folds that used to sit here — all four explained, none instructed.
          Says what withholding a result actually depends on: the flag, not the
          case, does it first. Withholding is immediate, but with
          DOCKET_AUTO_OPEN_CASES off (the real general election) no case exists
          for the crowd to judge until the post-election batch opens it — the
          dot's first paragraph states both conditions. */}
      <View className="flex-row items-center pt-1">
        <Text className="flex-1 text-sm leading-5 text-muted">
          A flag never decides anything — it holds that unit&apos;s votes out of every tally until
          the crowd clears them.
        </Text>
        <InfoDot
          title="How the docket works"
          text={[
            'Why a disputed result is excluded — a unit is marked disputed while a serious flag on it is unresolved, or while its case is open, upheld, or timed out without quorum. Disputed means badged everywhere, barred from ever reading as verified, and left out of the headline tallies. That is why the count above can be higher than the number of cases below: a result is held back the moment it is flagged, and the case putting it to the crowd may only be opened once polls close. A result the crowd clears goes straight back into the count, and the flag stays on the public record either way.',
            'Who judges, and how — verified observers worldwide answer factual questions about evidence they can see, one verdict per person, published with the answers behind it. Nobody at Hawkeye votes, and no juror picks a side: a published rule computes each verdict from the answers.',
            quorum && pct
              ? `How a case resolves — a case needs ${quorum} verdicts and a ${pct}% supermajority${
                  windowDays ? ` inside a ${windowDays}-day window` : ''
                }. Anything short of that closes unresolved — still disputed, still revisitable.${
                  rule ? ` Resolution rule: ${rule}` : ''
                }`
              : 'How a case resolves — a case needs a quorum of verdicts and a supermajority. Anything short of that closes unresolved — still disputed, still revisitable.',
            "The docket is on the chain — every flag, case opening and verdict is appended to the docket's own hash chain, whose head is folded into the same public Rekor anchor as the results. The arbitration is as rollback-proof as what it judges.",
          ].join('\n\n')}
        />
      </View>

      <SectionLabel text="Cases" />
      <Text className="pb-2 text-sm text-muted">
        Newest first. Open one to see its evidence and judge it.
      </Text>
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Public Docket" translateY={translateY} onClose={() => router.back()} />
      <FlashList
        data={cases ?? []}
        keyExtractor={(c) => String(c.id)}
        ListHeaderComponent={header}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ui.tint.good.ink}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          cases === null ? null : (
            /* Not "nothing is in dispute" — an empty docket says only that no
               case is open for judging yet. Flagged results can already be
               held out of the tallies with no case on the list. */
            <Text className="px-4 pt-2 text-center text-sm text-muted">
              No cases are open for judging yet.
            </Text>
          )
        }
        renderItem={({ item: c }) => (
          <Pressable
            className="mx-4 mb-2 rounded-2xl bg-card px-4 py-3 active:opacity-80"
            onPress={() => router.push(`/case?id=${c.id}`)}
          >
            <View className="flex-row items-start">
              <Text className="flex-1 pr-2 text-base font-bold text-ink">
                {c.name || c.puCode} — {c.contest}
              </Text>
              <StatusChip status={c.status} />
            </View>
            <Text className="pt-1 text-xs text-muted">
              {[c.ward ? `${c.ward} ward` : null, c.lga, c.state].filter(Boolean).join(', ')} ·
              opened {when(c.openedAt)} ·{' '}
              {c.status === 'open'
                ? `closes ${when(c.closesAt)}`
                : `resolved ${when(c.resolvedAt ?? c.closesAt)}`}{' '}
              · {c.tally.total} verdict(s)
            </Text>
            <TallyBar t={c.tally} />
          </Pressable>
        )}
      />
    </View>
  );
}

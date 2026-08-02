import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';

const BASE = 'https://hawkeye.com.ng';

/**
 * The public-anchor line on a submission receipt.
 *
 * A receipt already hands the observer their entry hash. That hash only means
 * something if the chain it sits in has been committed somewhere Hawkeye cannot
 * reach — which is what `backend/src/services/anchor.js` does: it signs one
 * artifact carrying the ledger head, the collation head, the per-race Merkle
 * root, the docket head AND the practice head, and publishes it to the public
 * Sigstore Rekor transparency log. `GET /api/anchors` exposes every such anchor
 * with `rekorLogIndex` + `rekorSearchUrl` (search.sigstore.dev) and `rekorUrl`
 * (the raw Rekor API entry) — the exact two URL shapes app/ledger.html and
 * app/ledger.tsx already link to. Nothing is invented here.
 *
 * THE HONESTY PROBLEM this component exists to solve: anchoring is
 * asynchronous. The anchor runs on boot + every 24h (backend/src/server.js), so
 * a report filed one minute ago is almost certainly NOT in any published anchor
 * yet. Rendering "verify on Rekor ↗" at that moment is a link to a log entry
 * that does not commit to their entry — a proof that is really a promise. So:
 *
 *   - no anchor covers the entry yet  → say the entry is on the ledger now and
 *     will be in the next public anchor. NO link.
 *   - an anchor covers it             → show its Rekor log index, the time it
 *     was logged, and the live link.
 *   - we could not check (offline)    → say we could not check. NO link.
 *
 * "Covers it" is decided conservatively, and never on the phone's own clock:
 *   1. exact match — the anchored head for this chain IS this entry hash. Then
 *      the entry is provably the head that was signed.
 *   2. otherwise, the oldest published anchor stamped comfortably AFTER the
 *      entry was filed. An anchor commits to the whole chain as of its run, so
 *      any later anchor includes an earlier entry. The device clock is
 *      corrected by the server `Date` header of the same response before this
 *      comparison, and a LAG margin is required on top, because an anchor reads
 *      the chain head slightly before it stamps its own `created_at`. Both
 *      guards only ever err towards "not yet anchored".
 */

/** Which head in the daily anchor artifact this receipt's chain rides in. */
export type AnchorChain = 'ledger' | 'collation' | 'practice';

type Anchor = {
  id: number;
  day: string;
  at: string;
  head?: string | null;
  collationHead?: string | null;
  practiceHead?: string | null;
  rekorLogIndex?: number | null;
  rekorUrl?: string | null;
  rekorSearchUrl?: string | null;
};

const HEAD_FIELD: Record<AnchorChain, 'head' | 'collationHead' | 'practiceHead'> = {
  ledger: 'head',
  collation: 'collationHead',
  practice: 'practiceHead',
};

/** An anchor must be stamped at least this long after the entry before we will
 *  claim it covers it — see the note above on the read-then-stamp gap. Anchors
 *  are daily, so this costs the observer nothing. */
const LAG_MS = 60_000;

type State =
  | { kind: 'checking' }
  | { kind: 'anchored'; logIndex: number | null; url: string; at: number; exact: boolean }
  | { kind: 'pending' }
  | { kind: 'unknown' };

function stamp(ms: number) {
  return new Date(ms).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RekorAnchor({
  entryHash,
  chain,
  filedAtServer,
}: {
  entryHash: string;
  chain: AnchorChain;
  /**
   * When the entry was recorded, ON THE SERVER'S CLOCK — pass this only when the
   * submit response genuinely carried a server stamp (practice's `recordedAt`).
   *
   * The clock is in the name because it decides the arithmetic. A DEVICE
   * timestamp must be skew-corrected onto server time before it can be compared
   * with an anchor's `at`; a SERVER timestamp must not be, and correcting one
   * anyway shifts it by the device's error. On a phone running ahead that moves
   * the filing time EARLIER, which can match an anchor published before the
   * entry existed and claim an inclusion that never happened. Omit this and the
   * receipt's own mount time is used, which is a device value and is corrected.
   */
  filedAtServer?: number;
}) {
  const ui = useUi();
  /** Filled on the first check, not during render — the receipt mounts within a
   *  second of the submit that produced it, so this is the filing time whenever
   *  the caller has no server-issued stamp to pass. */
  const mounted = useRef<number | null>(null);
  const [state, setState] = useState<State>({ kind: 'checking' });

  const check = useCallback(async () => {
    if (mounted.current == null) mounted.current = Date.now();
    try {
      const res = await fetch(`${BASE}/api/anchors`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Server clock, so a phone with a wrong date cannot manufacture (or hide)
      // an inclusion claim. Missing/unparseable header → assume no skew.
      const served = Date.parse(res.headers.get('date') ?? '');
      const skew = Number.isFinite(served) ? served - Date.now() : 0;
      // Correct ONLY the device fallback. A server-issued stamp is already on
      // the server's clock; adding skew to it would move the filing time and
      // could fabricate an inclusion — see the prop's docstring.
      const filedOnServerClock = filedAtServer ?? (mounted.current as number) + skew;

      const body = (await res.json()) as { anchors?: Anchor[] };
      const published = (body.anchors ?? [])
        .filter((a) => a && (a.rekorSearchUrl || a.rekorUrl) && Number.isFinite(Date.parse(a.at)))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

      const field = HEAD_FIELD[chain];
      const exact = published.find((a) => a[field] && a[field] === entryHash);
      const covering =
        exact ?? published.find((a) => Date.parse(a.at) >= filedOnServerClock + LAG_MS);

      if (!covering) return setState({ kind: 'pending' });
      const url = covering.rekorSearchUrl || covering.rekorUrl!;
      setState({
        kind: 'anchored',
        logIndex: covering.rekorLogIndex ?? null,
        url,
        at: Date.parse(covering.at),
        exact: Boolean(exact),
      });
    } catch {
      setState({ kind: 'unknown' });
    }
  }, [chain, entryHash, filedAtServer]);

  useEffect(() => {
    check();
  }, [check]);

  /** Manual retry from either unproven state. Shows the spinner again, which the
   *  automatic first pass gets from the initial state instead. */
  const recheck = () => {
    setState({ kind: 'checking' });
    check();
  };

  const practice = chain === 'practice';
  const thisChain = practice
    ? 'practice chain'
    : chain === 'collation'
      ? 'collation chain'
      : 'ledger';

  let icon: 'anchor' | 'clock' | 'wifi-off' = 'clock';
  let tint: string = ui.muted;
  let title = '';
  let body = '';

  if (state.kind === 'checking') {
    title = 'Checking the public anchor…';
  } else if (state.kind === 'anchored') {
    icon = 'anchor';
    tint = ui.tint.good.ink;
    title = practice ? 'This practice chain is in the public log' : 'In the public log';
    const where = state.logIndex != null ? ` at entry #${state.logIndex}` : '';
    body = practice
      ? `The ${thisChain} was signed into Sigstore Rekor${where} on ${stamp(state.at)} — the same public, append-only log the real ledger uses. What that proves is that this practice chain existed at that moment. It is a rehearsal: not a result, never counted.`
      : `The ${thisChain} holding your entry was signed into Sigstore Rekor${where} on ${stamp(state.at)}. Rekor is not ours and cannot be edited, so that timestamp cannot be taken back — nor can your entry be removed from the chain it commits to.`;
    if (state.exact) {
      body += ' Your entry is the exact chain head that was signed.';
    }
  } else if (state.kind === 'pending') {
    title = 'Not in a public anchor yet';
    body = practice
      ? `Your run is chained on the ${thisChain}, and that chain's fingerprint is published to Sigstore Rekor — a public log Hawkeye does not run — at least once a day. This run will be inside the next one; the link appears here once it genuinely exists. Practice is never a result and never counted.`
      : `Your entry is on the ${thisChain} now. The ${thisChain}'s fingerprint is published to Sigstore Rekor — a public, append-only log Hawkeye does not run — at least once a day. Your entry will be inside the next anchor; the link appears here once it genuinely exists, not before.`;
  } else {
    icon = 'wifi-off';
    title = 'Could not check the public anchor';
    body = `No answer from the server just now, so we cannot say whether an anchor covering this entry has been published. Your entry hash above is unchanged either way — check again when you have signal.`;
  }

  return (
    <View className="mt-3 rounded-2xl bg-card px-4 py-4">
      <View className="flex-row items-center">
        <Feather name={icon} size={13} color={tint} />
        <Text className="pl-2 text-[11px] font-bold uppercase tracking-wider text-faint">
          Public anchor
        </Text>
      </View>

      {state.kind === 'checking' ? (
        <View className="flex-row items-center pt-2">
          <ActivityIndicator size="small" color={ui.muted} />
          <Text className="pl-2 text-[13px] text-muted">{title}</Text>
        </View>
      ) : (
        <>
          <Text
            className={`pt-2 text-sm font-bold ${state.kind === 'anchored' ? 'text-good-ink' : 'text-ink'}`}
          >
            {title}
          </Text>
          <Text className="pt-1 text-[13px] leading-5 text-muted">{body}</Text>
        </>
      )}

      {state.kind === 'anchored' ? (
        <Pressable
          className="mt-3 flex-row items-center justify-center rounded-xl border border-line py-2.5 active:opacity-70"
          onPress={() => WebBrowser.openBrowserAsync(state.url)}
        >
          <Text className="pr-1.5 text-sm font-bold text-good-ink">View in Sigstore Rekor</Text>
          <Feather name="external-link" size={14} color={ui.tint.good.ink} />
        </Pressable>
      ) : null}

      {/* No dead link in either unproven state — a way to look again instead. */}
      {state.kind === 'pending' || state.kind === 'unknown' ? (
        <Pressable className="mt-3 self-start py-1 active:opacity-70" onPress={recheck}>
          <Text className="text-sm font-semibold text-good-ink">Check again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

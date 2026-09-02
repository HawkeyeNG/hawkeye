import Feather from '@expo/vector-icons/Feather';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SectionLabel, Stat } from '@/components/content-kit';
import { InfoDot } from '@/components/info-dot';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { Prompt } from '@/components/wizard';
import { BRAND } from '@/lib/api';
import { useUi, type Tone } from '@/lib/theme';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const GENESIS = '0'.repeat(64);

type Verify = { ok: boolean; entries: number; head: string | null; brokenAtId?: number };

type Entry = {
  id: number;
  pu_code: string;
  contest: string;
  created_at: number;
  prev_hash: string;
  entry_hash: string;
  ledger_payload: string;
  image_sha256: string;
  venue_image_sha256: string;
};

type Anchor = {
  id: number;
  day: string;
  head: string;
  entries: number;
  racesRoot: string | null;
  racesCount: number;
  rekorUrl: string;
  rekorSearchUrl?: string;
};

type RaceProof = {
  raceKey: string;
  head: string;
  entries: number;
  leaf: string;
  proof: { side: 'left' | 'right'; hash: string }[];
  racesRoot: string;
  rekorUrl?: string;
  rekorSearchUrl?: string;
  error?: string;
};

/** A verdict card. Tinted through the semantic tokens, so the tint darkens with
 *  the theme instead of leaving pale-on-pale text in dark mode. */
function Result({ ok, text, link }: { ok: boolean; text: string; link?: string }) {
  const ui = useUi();
  return (
    <View className={`mt-2 rounded-2xl px-4 py-3 ${ok ? 'bg-good' : 'bg-bad'}`}>
      <View className="flex-row items-start">
        <Feather
          name={ok ? 'check-circle' : 'alert-triangle'}
          size={16}
          color={ok ? ui.tint.good.ink : ui.tint.bad.ink}
          style={{ marginTop: 1 }}
        />
        <Text
          className={`flex-1 pl-2 text-sm font-semibold ${ok ? 'text-good-ink' : 'text-bad-ink'}`}
        >
          {text}
        </Text>
      </View>
      {link ? (
        <Pressable className="pt-2" onPress={() => WebBrowser.openBrowserAsync(link)}>
          <Text className="text-sm font-bold text-good-ink">Confirm in Rekor ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const hex = (s: string) =>
  Array.from(sha256(utf8ToBytes(s)), (b) => b.toString(16).padStart(2, '0')).join('');

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * An anchor's `day` arrives from the server as ISO `YYYY-MM-DD`. A tile reading
 * "2026-07-28" is a database column, not a dashboard stat, so it is shown in the
 * same short form the entry rows use. Parsed part-by-part on purpose:
 * `new Date('2026-07-28')` is UTC midnight, which renders as the day before in
 * any negative-offset timezone.
 */
function shortDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function timeAgo(ts: number) {
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (d.toDateString() === new Date().toDateString()) return `today ${hm}`;
  if (diff < 172800) return `yesterday ${hm}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${hm}`;
}

async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Verify the Ledger — the trustless heart of the audit story, native twin of
 * app/ledger.html.
 *
 * Every accepted report is chained by hash: an entry commits to everything
 * before it, so altering or deleting any past report breaks every later hash.
 * The point of this screen is that the phone does the checking — the server's
 * own verdict is shown, but the observer can recompute the entire chain
 * locally and, separately, fold one race's Merkle proof up to a root that is
 * published in Sigstore's public Rekor log. Neither check trusts Hawkeye.
 *
 * Shaped as a dashboard: what the two checks compute goes into stat tiles at
 * the top, one sentence says what "verified" means, and the cryptography sits
 * in collapsed folds. The reader who only wants the verdict never scrolls.
 */
export default function Ledger() {
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();
  const [verify, setVerify] = useState<Verify | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [races, setRaces] = useState<{ race_key: string; entries: number }[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [chain, setChain] = useState<{ ok: boolean; text: string } | null>(null);

  const [raceSel, setRaceSel] = useState<string | null>(null);
  const [raceBusy, setRaceBusy] = useState(false);
  const [raceOut, setRaceOut] = useState<{ ok: boolean; text: string; link?: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const [v, e, a] = await Promise.all([
        jget<Verify>('/api/ledger/verify'),
        jget<Entry[]>('/api/ledger/entries'),
        jget<{ anchors: Anchor[] }>('/api/anchors'),
      ]);
      setVerify(v);
      setEntries(e);
      // Anchors come newest-first; only one with races batched into it can be
      // used for a single-race proof.
      const withRaces = a.anchors.find((x) => x.racesRoot && x.racesCount > 0) ?? null;
      setAnchor(withRaces ?? a.anchors[0] ?? null);
      if (withRaces) {
        const r = await jget<{ races: { race_key: string; entries: number }[] }>(
          `/api/anchors/${withRaces.id}/races`,
        );
        setRaces(r.races ?? []);
      } else {
        setRaces([]);
      }
    } catch (err) {
      setLoadErr(humanError(err, 'Could not load the ledger.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  /**
   * Recompute the whole chain on this device. Hashing runs on the JS thread,
   * so it yields every 100 entries — otherwise a busy election day's chain
   * would freeze the UI with no sign of progress.
   */
  const verifyChain = async () => {
    setChain(null);
    setProgress({ done: 0, total: entries.length });
    await tick();
    let prev = GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.prev_hash !== prev || hex(prev + e.ledger_payload) !== e.entry_hash) {
        setProgress(null);
        setChain({
          ok: false,
          text: `Chain broken at entry ${e.id} — a report was altered or removed.`,
        });
        return;
      }
      prev = e.entry_hash;
      if (i % 100 === 99) {
        setProgress({ done: i + 1, total: entries.length });
        await tick();
      }
    }
    setProgress(null);
    setChain({
      ok: true,
      text: entries.length
        ? `Verified all ${entries.length} entries on this phone. Head matches: ${prev}`
        : 'The chain is empty — no report has been recorded yet. Head is the genesis hash.',
    });
  };

  /** Fold one race's Merkle proof locally up to the Rekor-anchored root. */
  const verifyRace = async () => {
    if (!anchor || !raceSel) return;
    setRaceBusy(true);
    setRaceOut(null);
    try {
      const d = await jget<RaceProof>(
        `/api/anchors/${anchor.id}/races/${encodeURIComponent(raceSel)}`,
      );
      if (d.error) {
        setRaceOut({ ok: false, text: d.error });
        return;
      }
      if (hex(`race|v1|${d.raceKey}|${d.head}|${d.entries}`) !== d.leaf) {
        setRaceOut({
          ok: false,
          text: 'Leaf mismatch — the race head and count do not match the stored leaf.',
        });
        return;
      }
      let h = d.leaf;
      for (const step of d.proof) {
        h = step.side === 'left' ? hex(step.hash + h) : hex(h + step.hash);
      }
      setRaceOut(
        h === d.racesRoot
          ? {
              ok: true,
              text: `"${d.raceKey}" verified — ${d.entries} report(s) fold to the anchored root, computed here on your phone.`,
              link: d.rekorSearchUrl || d.rekorUrl,
            }
          : {
              ok: false,
              text: 'Proof does not fold to the anchored root — this race’s record may have been altered.',
            },
      );
    } catch (err) {
      setRaceOut({
        ok: false,
        text: humanError(err, 'Could not fetch the proof.'),
      });
    } finally {
      setRaceBusy(false);
    }
  };

  const rows = useMemo(() => [...entries].reverse(), [entries]);

  // The on-device check, as a tile: nothing run yet, counting, or a verdict.
  const local: { value: string; tone?: Tone; tight?: boolean } = progress
    ? { value: `${progress.done}/${progress.total}`, tight: true }
    : chain
      ? chain.ok
        ? { value: 'Verified', tone: 'good' }
        : { value: 'Broken', tone: 'bad' }
      : { value: 'Not run' };

  /* A failed load gets the error card and nothing else. The dashboard chrome —
     section labels, a dead Re-verify button, two accordions about Merkle roots —
     is not worth reading when the chain could not be fetched, so it stays off the
     screen until Retry succeeds. */
  const errorHeader = (
    <View className="px-4 pb-2 pt-3">
      <View className="rounded-2xl bg-bad px-4 py-4">
        <Text className="text-sm font-semibold text-bad-ink">
          Could not load the ledger. ({loadErr})
        </Text>
        <Pressable
          className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
          onPress={load}
        >
          <Text className="text-base font-bold text-hawk-gold">Retry</Text>
        </Pressable>
      </View>
    </View>
  );

  const header = (
    <View className="px-4 pb-2 pt-3">
      {loading ? (
        <ActivityIndicator className="py-8" color={ui.tint.good.ink} />
      ) : (
        <View className="flex-row flex-wrap">
          <Stat value={(verify?.entries ?? 0).toLocaleString()} label="Entries chained" />
          {/* A missing verdict is not a failing one — never colour it red. */}
          <Stat
            value={!verify ? '—' : verify.ok ? 'Intact' : `Broken at #${verify.brokenAtId ?? '?'}`}
            label="Server check"
            tone={!verify ? undefined : verify.ok ? 'good' : 'bad'}
            tight={!!verify && !verify.ok}
          />
          <Stat value={local.value} label="On this phone" tone={local.tone} tight={local.tight} />
          <Stat value={anchor ? shortDay(anchor.day) : 'None yet'} label="Last anchor" tight />
        </View>
      )}

      {/* The one sentence the screen's credibility rests on, plus the
          "How the chain is checked" fold that used to follow it. */}
      <View className="flex-row items-center pt-1">
        <Text className="flex-1 text-sm leading-5 text-muted">
          Verified means your phone recomputed every hash itself and got the same head we publish.
        </Text>
        <InfoDot
          title="How the chain is checked"
          text="Each entry stores the hash of the one before it, so altering or removing any past report breaks every hash after it. This screen recomputes the whole chain on your own device and compares the head it gets to the one we publish — you don't have to trust us."
        />
      </View>

      <SectionLabel text="Chain" />
      <Pressable
        disabled={loading || !!progress}
        onPress={verifyChain}
        className={`items-center rounded-2xl py-4 ${
          loading || progress ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
        }`}
      >
        {progress ? (
          <Text className="text-base font-bold text-muted">
            Recomputing… {progress.done}/{progress.total}
          </Text>
        ) : (
          <Text className="text-base font-bold text-hawk-gold">Re-verify on this phone</Text>
        )}
      </Pressable>
      {chain ? <Result ok={chain.ok} text={chain.text} /> : null}

      {/* The server's own head — shown so it can be compared, never relied on. */}
      {verify ? (
        <View className="mt-2 rounded-2xl bg-card px-4 py-3">
          <Text className="text-[10px] font-bold uppercase tracking-[1px] text-faint">
            Server head
          </Text>
          <Text numberOfLines={1} className="pt-1 font-mono text-xs text-muted">
            {verify.head || GENESIS}
          </Text>
        </View>
      ) : null}

      {/* Single-race proof: verify one contest without replaying the whole chain. */}
      <SectionLabel text="Single-Race Proof" />
      <View className="rounded-2xl bg-card px-4 py-4">
        {anchor ? (
          (() => {
            // The anchor row is written before publishToRekor runs, and publishing
            // is allowed to fail — so a real anchor can carry no Rekor URL at all.
            // Only offer the link when one genuinely exists; otherwise state the
            // batch honestly and say the public entry is still pending.
            const rekor = anchor.rekorSearchUrl || anchor.rekorUrl;
            const body = (
              <Text className="text-xs text-muted">
                <Text className="font-bold text-ink">{anchor.racesCount}</Text> race(s) · root{' '}
                {(anchor.racesRoot || GENESIS).slice(0, 16)}…{'  '}
                {rekor ? (
                  <Text className="font-bold text-good-ink">View in Rekor ↗</Text>
                ) : (
                  <Text className="font-bold text-warn-ink">Not published to Rekor yet</Text>
                )}
              </Text>
            );
            return rekor ? (
              <Pressable onPress={() => WebBrowser.openBrowserAsync(rekor)}>{body}</Pressable>
            ) : (
              body
            );
          })()
        ) : null}

        {races.length ? (
          <View className="pt-3">
            <Prompt>Select a race</Prompt>
            <View className="flex-row flex-wrap">
              {races.map((r) => {
                const on = raceSel === r.race_key;
                return (
                  <Pressable
                    key={r.race_key}
                    onPress={() => {
                      setRaceSel(r.race_key);
                      setRaceOut(null);
                    }}
                    className={`mb-2 mr-2 rounded-full px-4 py-2.5 ${
                      on ? 'bg-hawk-green' : 'bg-surface'
                    }`}
                  >
                    <Text
                      className={`text-sm font-semibold ${on ? 'text-hawk-gold' : 'text-ink'}`}
                    >
                      {r.race_key} ({r.entries})
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : !loading ? (
          <Text className={`${anchor ? 'pt-3 ' : ''}text-sm text-muted`}>
            No race is anchored yet — race roots start on reporting day.
          </Text>
        ) : null}
      </View>

      <View className="flex-row items-center pt-2">
        <Text className="flex-1 text-sm text-muted">Check one race&apos;s paper trail on its own.</Text>
        <InfoDot
          title="What a single-race proof shows"
          text="Each anchor folds every race into one Merkle root published to Sigstore's Rekor log, which we cannot rewrite. Your phone folds one race's proof up to that root, without replaying the others."
        />
      </View>

      <SectionLabel text="Ledger Entries" />
      <Text className="pb-2 text-sm text-muted">
        Newest first. Each photo&apos;s filename is its own hash.
      </Text>
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Verify the Ledger" translateY={translateY} onClose={() => router.back()} />
      {/* One virtualised list: on election day this chain is thousands of rows,
          so the header rides along rather than sitting in a ScrollView. */}
      <FlashList
        data={rows}
        keyExtractor={(e) => String(e.id)}
        ListHeaderComponent={loadErr ? errorHeader : header}
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH, paddingBottom: raceSel ? 16 : 32 }}
        ListEmptyComponent={
          loading || loadErr ? null : (
            <Text className="px-4 pt-2 text-sm text-muted">
              Nothing reported into the chain yet.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <View className="mx-4 mb-2 rounded-2xl bg-card px-4 py-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-bold text-ink">#{item.id}</Text>
              <Text className="text-xs text-muted">{timeAgo(item.created_at)}</Text>
            </View>
            <Text className="pt-1 text-sm text-ink">{item.pu_code}</Text>
            <Text className="text-xs text-muted">{item.contest}</Text>
            <Text className="pt-1 font-mono text-xs text-faint">
              {item.entry_hash.slice(0, 24)}…
            </Text>
            <View className="flex-row pt-2">
              <Pressable
                onPress={() =>
                  WebBrowser.openBrowserAsync(`${BASE}/uploads/${item.image_sha256}.jpg`)
                }
              >
                <Text className="text-sm font-bold text-good-ink">Sheet photo</Text>
              </Pressable>
              <Pressable
                className="pl-4"
                onPress={() =>
                  WebBrowser.openBrowserAsync(`${BASE}/uploads/${item.venue_image_sha256}.jpg`)
                }
              >
                <Text className="text-sm font-bold text-good-ink">Venue photo</Text>
              </Pressable>
            </View>
          </View>
        )}
      />

      {/* Pinned once a race is picked: the chips sit in the list header, and a
          national run carries ~1,500 of them, so the action they feed would be
          scrolled far above the entries by the time it is wanted. The verdict
          rides down with it — a proof that fails to fold is retried from this
          same button, and it must stay in sight to be read. */}
      {raceSel ? (
        <View className="border-t border-line bg-surface px-4 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
          {raceOut ? <Result ok={raceOut.ok} text={raceOut.text} link={raceOut.link} /> : null}
          <Pressable
            disabled={!raceSel || raceBusy}
            onPress={verifyRace}
            className={`mt-1 items-center rounded-2xl py-3.5 ${
              !raceSel || raceBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
            }`}
          >
            {raceBusy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <Text className="text-base font-bold text-hawk-gold">Verify this race</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

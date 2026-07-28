import { Feather } from '@expo/vector-icons';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Prompt } from '@/components/wizard';
import { BRAND } from '@/lib/api';

const BASE = 'https://hawkeye.com.ng';
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

const hex = (s: string) =>
  Array.from(sha256(utf8ToBytes(s)), (b) => b.toString(16).padStart(2, '0')).join('');

const tick = () => new Promise((r) => setTimeout(r, 0));

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
 */
export default function Ledger() {
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
      setLoadErr(err instanceof Error ? err.message : String(err));
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
        text: `Could not fetch the proof. (${err instanceof Error ? err.message : String(err)})`,
      });
    } finally {
      setRaceBusy(false);
    }
  };

  const rows = useMemo(() => [...entries].reverse(), [entries]);

  const Result = ({ ok, text, link }: { ok: boolean; text: string; link?: string }) => (
    <View className={`mt-2 rounded-2xl px-4 py-3 ${ok ? 'bg-emerald-50' : 'bg-red-50'}`}>
      <View className="flex-row items-start">
        <Feather
          name={ok ? 'check-circle' : 'alert-triangle'}
          size={16}
          color={ok ? BRAND.leaf : '#b91c1c'}
        />
        <Text
          className={`flex-1 pl-2 text-sm font-semibold ${ok ? 'text-hawk-leaf' : 'text-red-700'}`}
        >
          {text}
        </Text>
      </View>
      {link ? (
        <Pressable className="pt-2" onPress={() => WebBrowser.openBrowserAsync(link)}>
          <Text className="text-sm font-bold text-hawk-leaf">Confirm in Rekor ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const header = (
    <View className="px-4 pb-2 pt-3">
      <Text className="pb-3 text-sm text-neutral-600">
        Every accepted report is chained by hash: each entry commits to all before it, so
        changing or removing any past report breaks every later hash. You can recompute the
        whole chain here — you don&apos;t have to trust us.
      </Text>

      {/* The server's own verdict — shown, but never the thing you rely on. */}
      <View className="rounded-2xl bg-white px-4 py-4">
        {loading ? (
          <ActivityIndicator color={BRAND.leaf} />
        ) : loadErr ? (
          <>
            <Text className="text-sm font-semibold text-red-700">
              Could not load the ledger. ({loadErr})
            </Text>
            <Pressable
              className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
              onPress={load}
            >
              <Text className="text-base font-bold text-hawk-gold">Retry</Text>
            </Pressable>
          </>
        ) : verify?.ok ? (
          <>
            <View className="flex-row items-center">
              <Feather name="shield" size={18} color={BRAND.leaf} />
              <Text className="pl-2 text-base font-bold text-hawk-leaf">Chain intact</Text>
            </View>
            <Text className="pt-1 text-sm text-neutral-600">
              {verify.entries} {verify.entries === 1 ? 'entry' : 'entries'} · server says the head is
            </Text>
            <Text className="pt-1 font-mono text-xs text-neutral-500">
              {verify.head || GENESIS}
            </Text>
          </>
        ) : (
          <View className="flex-row items-center">
            <Feather name="alert-triangle" size={18} color="#b91c1c" />
            <Text className="pl-2 text-base font-bold text-red-700">
              Tamper detected at entry {verify?.brokenAtId}
            </Text>
          </View>
        )}
      </View>

      <Pressable
        disabled={loading || !!progress || !!loadErr}
        onPress={verifyChain}
        className={`mt-3 items-center rounded-2xl py-4 ${
          loading || progress || loadErr ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
        }`}
      >
        {progress ? (
          <Text className="text-base font-bold text-neutral-600">
            Recomputing… {progress.done}/{progress.total}
          </Text>
        ) : (
          <Text className="text-base font-bold text-hawk-gold">
            Re-verify the entire chain on this phone
          </Text>
        )}
      </Pressable>
      {chain ? <Result ok={chain.ok} text={chain.text} /> : null}

      {/* Single-race proof: verify one contest without replaying the whole chain. */}
      <View className="mt-4 rounded-2xl bg-white px-4 py-4">
        <Text className="text-base font-bold text-hawk-ink">Verify a single race</Text>
        <Text className="pt-1 text-sm text-neutral-600">
          Each anchor batches every race into one Merkle root published to Sigstore&apos;s public
          Rekor log. Check one race&apos;s paper trail here — folded on your phone — without
          replaying every other race.
        </Text>

        {anchor ? (
          <Pressable
            className="pt-2"
            onPress={() => WebBrowser.openBrowserAsync(anchor.rekorSearchUrl || anchor.rekorUrl)}
          >
            <Text className="text-xs text-neutral-500">
              Anchor <Text className="font-bold text-hawk-ink">{anchor.day}</Text> ·{' '}
              {anchor.racesCount} race(s) · root{' '}
              {(anchor.racesRoot || GENESIS).slice(0, 16)}…{'  '}
              <Text className="font-bold text-hawk-leaf">View in Rekor ↗</Text>
            </Text>
          </Pressable>
        ) : null}

        {races.length ? (
          <View className="pt-3">
            <Prompt>Select a race to verify</Prompt>
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
                      on ? 'bg-hawk-green' : 'bg-hawk-mist'
                    }`}
                  >
                    <Text
                      className={`text-sm font-semibold ${on ? 'text-hawk-gold' : 'text-neutral-700'}`}
                    >
                      {r.race_key} ({r.entries})
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : !loading && !loadErr ? (
          <Text className="pt-3 text-sm text-neutral-500">
            No race has been batched into an anchor yet — anchors start carrying race roots once
            reporting opens.
          </Text>
        ) : null}
      </View>

      <Text className="pb-2 pt-5 text-base font-bold text-hawk-ink">Ledger entries</Text>
      <Text className="pb-2 text-sm text-neutral-600">
        Newest first. Every row&apos;s evidence photos are public, content-addressed files.
      </Text>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-white"
        >
          <Feather name="x" size={18} color={BRAND.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Verify the Ledger</Text>
      </View>

      {/* One virtualised list: on election day this chain is thousands of rows,
          so the header rides along rather than sitting in a ScrollView. */}
      <FlashList
        data={rows}
        keyExtractor={(e) => String(e.id)}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: raceSel ? 16 : 32 }}
        ListEmptyComponent={
          loading || loadErr ? null : (
            <Text className="px-4 pt-2 text-sm text-neutral-500">
              No entries yet — nothing has been reported into the chain.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <View className="mx-4 mb-2 rounded-2xl bg-white px-4 py-3">
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-bold text-hawk-ink">#{item.id}</Text>
              <Text className="text-xs text-neutral-500">{timeAgo(item.created_at)}</Text>
            </View>
            <Text className="pt-1 text-sm text-hawk-ink">{item.pu_code}</Text>
            <Text className="text-xs text-neutral-500">{item.contest}</Text>
            <Text className="pt-1 font-mono text-xs text-neutral-400">
              {item.entry_hash.slice(0, 24)}…
            </Text>
            <View className="flex-row pt-2">
              <Pressable
                onPress={() =>
                  WebBrowser.openBrowserAsync(`${BASE}/uploads/${item.image_sha256}.jpg`)
                }
              >
                <Text className="text-sm font-bold text-hawk-leaf">Sheet photo</Text>
              </Pressable>
              <Pressable
                className="pl-4"
                onPress={() =>
                  WebBrowser.openBrowserAsync(`${BASE}/uploads/${item.venue_image_sha256}.jpg`)
                }
              >
                <Text className="text-sm font-bold text-hawk-leaf">Venue photo</Text>
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
        <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
          {raceOut ? <Result ok={raceOut.ok} text={raceOut.text} link={raceOut.link} /> : null}
          <Pressable
            disabled={!raceSel || raceBusy}
            onPress={verifyRace}
            className={`mt-1 items-center rounded-2xl py-3.5 ${
              !raceSel || raceBusy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
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
    </SafeAreaView>
  );
}

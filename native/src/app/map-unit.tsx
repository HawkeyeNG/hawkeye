import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Crumb, Prompt } from '@/components/wizard';
import { BRAND } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import { getQuickFix, getSubmitFix } from '@/lib/location';

type Unit = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state?: string;
  coords_source: string | null;
  crowd_reports: number;
  /** GPS discovery only (/api/polling-units, /api/mapping/nearby). */
  locationTier?: string;
  distanceM?: number;
};

/** /api/observers/my-unit LEFT JOINs the register, so every field but the code may be null. */
type SavedUnit = {
  pu_code: string;
  name: string | null;
  ward: string | null;
  lga: string | null;
  state: string | null;
};

type Stats = { total: number; verified: number; crowdMapped: number; unitsWithFixes: number };

/** /api/mapping/nearby's row shape — camelCase and thinner than a register row. */
type NearbyRow = {
  puCode: string;
  name: string;
  ward: string;
  distanceM: number;
  status: 'verified' | 'crowd' | 'approx';
  fixes: number;
};

const BASE = 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

/** How far /api/mapping/nearby is asked to look. You are standing at the unit;
 *  the slack is for GRID3 envelopes, which can sit a few hundred metres out. */
const NEARBY_RADIUS_M = 1000;

const TIER: Record<string, string> = {
  verified: '📍 already located',
  crowd: '◌ crowd-confirmed location',
  geocoded: '◌ located from map data (unconfirmed)',
  approx: '⚠ approximate position only — needs mapping',
  unmapped: '⚠ not yet located',
};

const num = (v: number) => v.toLocaleString();

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <View className="flex-1 pr-2">
      <Text className="text-lg font-bold text-hawk-ink">{value}</Text>
      <Text className="text-[11px] leading-4 text-neutral-500">{label}</Text>
    </View>
  );
}

/**
 * Map a polling unit — stand at the unit, record one GPS fix.
 *
 * INEC's official coordinate database is not public, so most register rows have
 * no verified location. When enough independent observer fixes cluster tightly,
 * the median is promoted to the unit's coordinate and it becomes geofence-ready.
 * That is why this screen matters out of proportion to its size: every unit
 * mapped before election day is a unit whose result reports can be location-proven.
 *
 * Unlike results, this is a plain JSON POST — no photos, no signature.
 */
export default function MapUnit() {
  const auth = useAuth();
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unit, setUnit] = useState<Unit | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [saved, setSaved] = useState<SavedUnit | null>(null);
  const [saving, setSaving] = useState(false);

  const [nearby, setNearby] = useState<Unit[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false);

  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; line: string } | null>(null);

  // NO contest filter: mapping is election-independent and nationwide. Passing
  // a contest narrows the register to that race's states (today: Osun only),
  // which made the whole rest of the country unmappable for no reason.
  useEffect(() => {
    fetch(`${REG}/states`)
      .then((r) => r.json())
      .then(setStates)
      .catch(() => {});
  }, []);

  // Coverage is the argument for doing this at all — an observer who can see
  // that most of the register has no location understands why one fix matters.
  useEffect(() => {
    fetch(`${BASE}/api/mapping/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {
        // Motivational, not functional — a failed count must not block mapping.
      });
  }, []);

  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let live = true;
    authedGet<{ unit: SavedUnit | null }>('/api/observers/my-unit')
      .then((r) => {
        if (live) setSaved(r.unit ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [auth.status]);

  useEffect(() => {
    if (!stateSel) return;
    fetch(`${REG}/lgas?state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json())
      .then(setLgas)
      .catch(() => {});
  }, [stateSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel) return;
    fetch(`${REG}/wards?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`)
      .then((r) => r.json())
      .then(setWards)
      .catch(() => {});
  }, [stateSel, lgaSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel || !wardSel) return;
    fetch(
      `${REG}/units?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}&ward=${encodeURIComponent(wardSel)}`,
    )
      .then((r) => r.json())
      .then((d) => setUnits(d.units ?? []))
      .catch(() => {});
  }, [stateSel, lgaSel, wardSel]);

  // Backing out must drop the selection, or the CTA stays live for a hidden unit.
  useEffect(() => {
    setUnit(null);
  }, [stateSel, lgaSel, wardSel]);

  /**
   * GPS discovery — the primary path, as on the web. An observer standing at
   * their unit knows where they are, not how their ward is spelled in the
   * register, and the drill-down is four taps deep before it shows a unit.
   *
   * Two lookups, because neither alone answers "which unit am I at?" on THIS
   * screen. /polling-units returns only units that already hold a coordinate —
   * exactly the ones that need no mapping — so on its own it hands an observer
   * at an unmapped unit an empty list. /mapping/nearby also returns units
   * placed only by a GRID3 approx envelope, which is the population this
   * screen exists to fix, but it carries no LGA and cannot replace the first.
   */
  const findNearby = async () => {
    setNearBusy(true);
    setNearby([]);
    setNearLine('Getting your location…');
    try {
      // Quick fix, not the submit-grade one: this only shortlists candidates.
      // The accurate fix is taken again at submit, where the server checks it.
      const fix = await getQuickFix();
      if (!fix) {
        setNearLine(
          'Location is off or not permitted — turn it on and retry, or browse the register below. (no GPS fix)',
        );
        setBrowse(true);
        return;
      }
      setNearLine(`Location fixed (±${Math.round(fix.accuracy)}m). Looking up units around you…`);

      const [located, envelope] = await Promise.all([
        fetch(`${BASE}/api/polling-units?lat=${fix.lat}&lng=${fix.lng}`),
        fetch(
          `${BASE}/api/mapping/nearby?lat=${fix.lat}&lng=${fix.lng}&radiusM=${NEARBY_RADIUS_M}`,
        ).catch(() => null),
      ]);

      const body = (await located.json().catch(() => ({}))) as {
        radiusM?: number;
        units?: Unit[];
        error?: string;
      };
      if (!located.ok) {
        setNearLine(
          `Could not look up nearby units — browse the register below. (${body.error ?? 'lookup_failed'} / HTTP ${located.status})`,
        );
        setBrowse(true);
        return;
      }

      const extra =
        envelope && envelope.ok
          ? (((await envelope.json().catch(() => ({}))) as { units?: NearbyRow[] }).units ?? [])
          : [];

      const merged = new Map<string, Unit>();
      for (const u of body.units ?? []) merged.set(u.pu_code, u);
      for (const n of extra) {
        if (merged.has(n.puCode)) continue;
        merged.set(n.puCode, {
          pu_code: n.puCode,
          name: n.name,
          ward: n.ward,
          lga: '',
          coords_source: null,
          crowd_reports: n.fixes,
          locationTier: n.status,
          distanceM: n.distanceM,
        });
      }
      const found = [...merged.values()]
        .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
        .slice(0, 12);

      setNearby(found);
      if (found.length === 0) {
        setNearLine(
          `No polling unit with a known position within ${NEARBY_RADIUS_M}m of you — browse the register below to find it by name.`,
        );
        setBrowse(true);
        return;
      }
      setNearLine('Tap the unit you are standing at:');
    } catch (e) {
      setNearLine(
        `Could not look up nearby units — browse the register below. (${e instanceof Error ? e.message : String(e)})`,
      );
      setBrowse(true);
    } finally {
      setNearBusy(false);
    }
  };

  /** Errors go to a modal: inline text below a long unit list is never seen. */
  const fail = (msg: string) => {
    setLine(msg);
    Alert.alert('Could not record the fix', msg);
  };

  const isSaved = !!unit && saved?.pu_code === unit.pu_code;

  /**
   * The star is the alert switch, not a bookmark: the server subscribes the
   * observer to every result report and approved incident at the saved unit,
   * and report/incident.tsx reads this same code to route an incident to a
   * unit. Asking here is the cheapest moment — they have just told us which
   * unit they are standing at.
   *
   * One saved unit per observer (saved_units is keyed by observer id), so
   * saving a different unit replaces the old one rather than adding to it.
   */
  const toggleSaved = async () => {
    if (!unit) return;
    const removing = isSaved;
    setSaving(true);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const id = await getIdentity();
      const res = await fetch(`${BASE}/api/observers/my-unit${removing ? '/clear' : ''}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify(removing ? {} : { puCode: unit.pu_code }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        const code = body.error ?? `http_${res.status}`;
        Alert.alert(
          removing ? 'Could not remove your polling unit' : 'Could not save your polling unit',
          code === 'unknown_unit'
            ? `${unit.name} is not in the register. (${code} / HTTP ${res.status})`
            : `Please check your connection and try again. (${code} / HTTP ${res.status})`,
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSaved(
        removing
          ? null
          : {
              pu_code: unit.pu_code,
              name: unit.name,
              ward: unit.ward,
              lga: unit.lga,
              state: unit.state ?? null,
            },
      );
    } catch (e) {
      Alert.alert(
        'Could not update your polling unit',
        `Please try again. (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = async () => {
    if (!unit) return;
    setBusy(true);
    setLine('Getting an accurate fix — stand still…');
    try {
      const fix = await getSubmitFix();
      if (!fix) {
        fail('No GPS fix — turn location on, step outside, and retry.');
        setBusy(false);
        return;
      }
      const id = await getIdentity();
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const res = await fetch(`${BASE}/api/mappings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify({
          puCode: unit.pu_code,
          lat: fix.lat,
          lng: fix.lng,
          accuracy: fix.accuracy,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        fixes?: number;
        needed?: number;
        mapped?: boolean;
        replaced?: boolean;
        error?: string;
        maxAccuracyM?: number;
      };
      if (res.ok && body.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone(
          body.mapped
            ? {
                title: 'Unit confirmed',
                line: `${unit.name} is now crowd-confirmed — ${body.fixes} observer fixes agreed. Result reports here can now be location-verified.`,
              }
            : {
                title: body.replaced ? 'Fix updated' : 'Fix recorded',
                line: `${body.fixes} of ${body.needed} observers needed to confirm ${unit.name}. Ask others at this unit to map it too.`,
              },
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const code = body.error ?? `http_${res.status}`;
      fail(
        code === 'gps_accuracy_too_low'
          ? `GPS accuracy too low (needs ${body.maxAccuracyM ?? 100}m or better) — step into the open and retry.`
          : code === 'too_far_from_unit'
            ? 'You are too far from this unit — map it while standing at the unit.'
            : code === 'unknown_polling_unit'
              ? 'That unit is not in the register.'
              : `Could not record the fix. (${code} / HTTP ${res.status})`,
      );
    } catch (e) {
      fail(`Could not record the fix. (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  if (auth.status !== 'signedIn') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <Feather name="lock" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
          Sign in to map a polling unit
        </Text>
        <Pressable
          className="mt-4 rounded-2xl bg-hawk-green px-6 py-3"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={() => router.back()}>
          <Text className="text-sm text-neutral-500">Not now</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (done) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
          <Feather name="map-pin" size={28} color={BRAND.gold} />
        </View>
        <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">{done.title}</Text>
        <Text className="pt-2 text-center text-sm text-neutral-600">{done.line}</Text>
        <Pressable
          className="mt-6 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
          onPress={() => router.back()}
        >
          <Text className="text-base font-bold text-hawk-gold">Done</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const Chip = ({ label, onPress }: { label: string; onPress: () => void }) => (
    <Pressable
      onPress={onPress}
      className="mb-2 mr-2 rounded-full bg-white px-4 py-2 active:opacity-70"
    >
      <Text className="text-sm font-semibold text-neutral-700">{label}</Text>
    </Pressable>
  );

  /** One sub-line for a unit row, whichever of the three paths found it. */
  const unitSub = (u: Unit) => {
    const tier = u.locationTier
      ? (TIER[u.locationTier] ?? TIER.unmapped)
      : u.coords_source && u.coords_source !== 'sample'
        ? `${TIER.verified} (${u.coords_source})`
        : u.crowd_reports
          ? `◌ ${u.crowd_reports} fix(es) so far`
          : TIER.unmapped;
    const where = u.distanceM != null ? `${u.pu_code} · ${u.distanceM}m away` : u.pu_code;
    return `${where} · ${tier}`;
  };

  const UnitRow = ({ u }: { u: Unit }) => {
    const on = unit?.pu_code === u.pu_code;
    return (
      <Pressable
        onPress={() => setUnit(u)}
        className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-white'}`}
      >
        <View className="flex-1 pr-2">
          <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-hawk-ink'}`}>
            {u.name}
          </Text>
          <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-neutral-500'}`}>
            {unitSub(u)}
          </Text>
        </View>
        {saved?.pu_code === u.pu_code ? (
          <Feather name="star" size={16} color={on ? BRAND.gold : BRAND.leaf} />
        ) : null}
      </Pressable>
    );
  };

  const pct = stats && stats.total ? (stats.verified / stats.total) * 100 : 0;

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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Map a polling unit</Text>
      </View>

      <ScrollView contentContainerClassName="px-4 pb-8 pt-3">
        <Text className="pb-3 text-sm text-neutral-600">
          Stand at the polling unit and record one GPS fix. When enough observers agree, the
          unit becomes location-verified — and every result reported there can be proven.
        </Text>

        {stats ? (
          <View className="mb-3 rounded-2xl bg-white px-4 py-3">
            <Text className="pb-2 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              Nationwide mapping coverage
            </Text>
            <View className="flex-row">
              <StatCell
                value={`${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`}
                label={`${num(stats.verified)} of ${num(stats.total)} located`}
              />
              <StatCell value={num(stats.crowdMapped)} label="crowd-mapped by observers" />
              <StatCell value={num(stats.unitsWithFixes)} label="have at least one fix" />
            </View>
          </View>
        ) : null}

        {saved ? (
          <Pressable
            onPress={() =>
              setUnit({
                pu_code: saved.pu_code,
                name: saved.name ?? saved.pu_code,
                ward: saved.ward ?? '',
                lga: saved.lga ?? '',
                state: saved.state ?? undefined,
                // Unknown from /my-unit, and never shown: this row is a jump
                // target for the footer, not a tier badge.
                coords_source: null,
                crowd_reports: 0,
              })
            }
            className={`mb-3 flex-row items-center rounded-2xl px-4 py-3 active:opacity-70 ${
              unit?.pu_code === saved.pu_code ? 'bg-hawk-green' : 'bg-white'
            }`}
          >
            <Feather
              name="star"
              size={18}
              color={unit?.pu_code === saved.pu_code ? BRAND.gold : BRAND.leaf}
            />
            <View className="flex-1 pl-2">
              <Text
                className={`text-[11px] font-bold uppercase tracking-wider ${
                  unit?.pu_code === saved.pu_code ? 'text-emerald-100' : 'text-neutral-400'
                }`}
              >
                Your polling unit
              </Text>
              <Text
                className={`text-base font-semibold ${
                  unit?.pu_code === saved.pu_code ? 'text-white' : 'text-hawk-ink'
                }`}
              >
                {saved.name ?? saved.pu_code}
              </Text>
              <Text
                className={`text-xs ${
                  unit?.pu_code === saved.pu_code ? 'text-emerald-100' : 'text-neutral-500'
                }`}
              >
                {[saved.ward ? `${saved.ward} ward` : null, saved.lga, saved.state]
                  .filter(Boolean)
                  .join(', ') || saved.pu_code}
              </Text>
            </View>
          </Pressable>
        ) : null}

        {/* GPS FIRST. The drill-down is four taps deep before it shows a unit;
            someone standing at their unit should not have to spell their ward. */}
        <Pressable
          disabled={nearBusy}
          onPress={findNearby}
          className={`flex-row items-center justify-center rounded-2xl py-4 ${nearBusy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'}`}
        >
          {nearBusy ? (
            <ActivityIndicator color={BRAND.gold} />
          ) : (
            <>
              <Feather name="crosshair" size={17} color={BRAND.gold} />
              <Text className="pl-2 text-base font-bold text-hawk-gold">Find units near me</Text>
            </>
          )}
        </Pressable>

        {nearLine ? (
          <Text className="pt-3 text-sm font-semibold text-amber-800">{nearLine}</Text>
        ) : null}

        {nearby.length ? (
          <View className="pt-3">
            {nearby.map((u) => (
              <UnitRow key={u.pu_code} u={u} />
            ))}
          </View>
        ) : null}

        <Pressable
          onPress={() => setBrowse((b) => !b)}
          className="mt-4 flex-row items-center rounded-2xl bg-white px-4 py-3 active:opacity-70"
        >
          <Feather name={browse ? 'chevron-down' : 'chevron-right'} size={16} color={BRAND.leaf} />
          <Text className="flex-1 pl-2 text-sm font-bold text-hawk-leaf">
            Browse the register instead
          </Text>
          <Text className="text-xs text-neutral-400">state › LGA › ward</Text>
        </Pressable>

        {browse ? (
          <View className="pt-3">
            {!stateSel ? (
              <>
                <Prompt>Select the state</Prompt>
                <View className="flex-row flex-wrap">
                  {states.map((s) => (
                    <Chip key={s} label={s} onPress={() => setStateSel(s)} />
                  ))}
                </View>
              </>
            ) : null}

            {stateSel && !lgaSel ? (
              <>
                <Crumb label={stateSel} onPress={() => setStateSel(null)} />
                <Prompt>Select the LGA</Prompt>
                <View className="flex-row flex-wrap">
                  {lgas.map((l) => (
                    <Chip key={l} label={l} onPress={() => setLgaSel(l)} />
                  ))}
                </View>
              </>
            ) : null}

            {lgaSel && !wardSel ? (
              <>
                <Crumb label={lgaSel} onPress={() => setLgaSel(null)} />
                <Prompt>Select the ward</Prompt>
                <View className="flex-row flex-wrap">
                  {wards.map((w) => (
                    <Chip key={w} label={w} onPress={() => setWardSel(w)} />
                  ))}
                </View>
              </>
            ) : null}

            {wardSel ? (
              <>
                <Crumb label={`${lgaSel} · ${wardSel}`} onPress={() => setWardSel(null)} />
                <Prompt>Select the unit you are standing at</Prompt>
                {units.map((u) => (
                  <UnitRow key={u.pu_code} u={u} />
                ))}
                {units.length === 0 ? (
                  <Text className="pt-2 text-sm text-neutral-500">
                    No units in the register for this ward yet.
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {unit ? (
        <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
          <Text className="pb-2 text-xs text-neutral-500" numberOfLines={1}>
            Selected: {unit.name}
          </Text>

          {/* The star commits server-side state of its own, so it belongs in the
              footer with the CTA rather than somewhere up the unit list. */}
          <Pressable
            disabled={saving}
            onPress={toggleSaved}
            className="mb-2 flex-row items-center rounded-2xl bg-white px-4 py-3 active:opacity-70"
          >
            {saving ? (
              <ActivityIndicator color={BRAND.leaf} />
            ) : (
              <Feather name="star" size={18} color={isSaved ? BRAND.gold : BRAND.leaf} />
            )}
            <View className="flex-1 pl-2">
              <Text className="text-sm font-bold text-hawk-leaf">
                {isSaved ? 'Saved as your polling unit — tap to remove' : 'Save as my polling unit'}
              </Text>
              <Text className="text-xs text-neutral-500">
                {isSaved
                  ? 'You are alerted for every result report and approved incident here.'
                  : saved
                    ? `Alerts you to every result and approved incident here — replaces ${saved.name ?? saved.pu_code}.`
                    : 'Alerts you to every result report and approved incident at this unit.'}
              </Text>
            </View>
          </Pressable>

          <Pressable
            disabled={busy}
            onPress={onSubmit}
            className={`items-center rounded-2xl py-4 ${busy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'}`}
          >
            {busy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <Text className="text-base font-bold text-hawk-gold">
                I am standing here — record fix
              </Text>
            )}
          </Pressable>

          {line ? (
            <Text className="pt-3 text-sm font-semibold text-amber-800">{line}</Text>
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

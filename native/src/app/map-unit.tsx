import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Crumb, Prompt } from '@/components/wizard';
import { BRAND } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import { getSubmitFix } from '@/lib/location';

type Unit = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  coords_source: string | null;
  crowd_reports: number;
};

const REG = 'https://hawkeye.com.ng/api/register';

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

  /** Errors go to a modal: inline text below a long unit list is never seen. */
  const fail = (msg: string) => {
    setLine(msg);
    Alert.alert('Could not record the fix', msg);
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
      const res = await fetch('https://hawkeye.com.ng/api/mappings', {
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
            {units.map((u) => {
              const on = unit?.pu_code === u.pu_code;
              const verified = u.coords_source && u.coords_source !== 'sample';
              return (
                <Pressable
                  key={u.pu_code}
                  onPress={() => setUnit(u)}
                  className={`mb-2 rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-white'}`}
                >
                  <Text
                    className={`text-base font-semibold ${on ? 'text-white' : 'text-hawk-ink'}`}
                  >
                    {u.name}
                  </Text>
                  <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-neutral-500'}`}>
                    {u.pu_code}
                    {verified
                      ? ` · already located (${u.coords_source})`
                      : u.crowd_reports
                        ? ` · ${u.crowd_reports} fix(es) so far`
                        : ' · not yet located'}
                  </Text>
                </Pressable>
              );
            })}
            {units.length === 0 ? (
              <Text className="pt-2 text-sm text-neutral-500">
                No units in the register for this ward yet.
              </Text>
            ) : null}
          </>
        ) : null}

        {line ? <Text className="pt-3 text-sm font-semibold text-amber-800">{line}</Text> : null}
      </ScrollView>

      {unit ? (
        <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
          <Text className="pb-2 text-xs text-neutral-500" numberOfLines={1}>
            Selected: {unit.name}
          </Text>
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
        </View>
      ) : null}
    </SafeAreaView>
  );
}

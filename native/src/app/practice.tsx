import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';

type PracticeConfig = {
  active: boolean;
  name?: string;
  office?: string;
  note?: string;
  unit?: { code: string; name: string; ward: string; lga: string; state: string };
  parties?: { code: string; color: string }[];
};

/**
 * Practice run — the no-auth sandbox (/api/practice). Deliberately isolated on
 * the backend: nothing here is published, counted, chained or anchored. The
 * confirmation mirrors the real flow's end screen so the rehearsal teaches the
 * full shape of a submission.
 */
export default function Practice() {
  const [cfg, setCfg] = useState<PracticeConfig | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ entryHash: string } | null>(null);

  useEffect(() => {
    fetch('https://hawkeye.com.ng/api/practice')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg({ active: false }));
  }, []);

  const votes = useMemo(
    () =>
      Object.entries(counts)
        .filter(([, v]) => v.trim() !== '' && Number.isInteger(Number(v)))
        .map(([party, v]) => ({ party, count: Number(v) })),
    [counts],
  );

  const onSubmit = async () => {
    setBusy(true);
    setLine(null);
    try {
      const res = await fetch('https://hawkeye.com.ng/api/practice/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ votes, puName: cfg?.unit?.name }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; entryHash?: string; error?: string };
      if (res.ok && body.ok && body.entryHash) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({ entryHash: body.entryHash });
      } else {
        setLine(body.error === 'no_counts' ? 'Enter at least one count.' : 'Practice submit failed — retry.');
      }
    } catch {
      setLine('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Practice run</Text>
      </View>

      {!cfg ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={BRAND.leaf} />
        </View>
      ) : !cfg.active ? (
        <View className="flex-1 items-center justify-center px-8">
          <Feather name="moon" size={28} color={BRAND.leaf} />
          <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
            Practice is closed
          </Text>
          <Text className="pt-1 text-center text-sm text-neutral-500">
            The sandbox shuts just before election day so every report filed is real.
          </Text>
        </View>
      ) : done ? (
        <View className="flex-1 items-center justify-center px-8">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
            <Feather name="check" size={28} color={BRAND.gold} />
          </View>
          <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">
            Practice report recorded
          </Text>
          <Text className="pt-2 text-center text-sm text-neutral-600">
            This is what filing feels like on election day — except then it is signed,
            GPS-checked and chained into the public ledger.
          </Text>
          <View className="mt-4 rounded-xl bg-white px-4 py-2">
            <Text className="font-mono text-xs text-neutral-500">{done.entryHash}</Text>
          </View>
          <Pressable
            className="mt-6 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
            onPress={() => router.back()}
          >
            <Text className="text-base font-bold text-hawk-gold">Done</Text>
          </Pressable>
        </View>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
            <View className="mb-3 rounded-2xl bg-hawk-green px-5 py-4">
              <Text className="text-xs font-semibold uppercase tracking-wider text-hawk-gold">
                {cfg.name}
              </Text>
              <Text className="pt-1 text-lg font-bold text-white">{cfg.unit?.name}</Text>
              <Text className="pt-0.5 text-xs text-emerald-100">
                {cfg.unit?.code} · {cfg.unit?.ward}, {cfg.unit?.lga}
              </Text>
            </View>
            <Text className="pb-3 text-sm text-neutral-600">{cfg.note}</Text>

            {(cfg.parties ?? []).map((p) => (
              <View key={p.code} className="mb-2 flex-row items-center rounded-2xl bg-white px-4 py-2">
                <View
                  className="mr-3 h-3 w-3 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <Text className="flex-1 text-base font-semibold text-hawk-ink">{p.code}</Text>
                <TextInput
                  className="w-24 rounded-xl bg-hawk-mist px-3 py-2 text-center text-lg font-bold text-hawk-ink"
                  placeholder="0"
                  placeholderTextColor="#9db5a7"
                  keyboardType="number-pad"
                  value={counts[p.code] ?? ''}
                  onChangeText={(t) =>
                    setCounts((c) => ({ ...c, [p.code]: t.replace(/[^0-9]/g, '') }))
                  }
                />
              </View>
            ))}

            {line ? <Text className="pt-2 text-sm font-semibold text-amber-800">{line}</Text> : null}

            <Pressable
              disabled={votes.length === 0 || busy}
              onPress={onSubmit}
              className={`mt-3 items-center rounded-2xl py-4 ${
                votes.length && !busy ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'
              }`}
            >
              {busy ? (
                <ActivityIndicator color={BRAND.gold} />
              ) : (
                <Text className="text-base font-bold text-hawk-gold">Submit practice report</Text>
              )}
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

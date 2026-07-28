import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
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

import { CaptureCamera, type Media } from '@/components/capture-camera';
import { Prompt } from '@/components/wizard';
import { BRAND } from '@/lib/api';

const BASE = 'https://hawkeye.com.ng';

type PracticeConfig = {
  active: boolean;
  name?: string;
  office?: string;
  note?: string;
  unit?: { code: string; name: string; ward: string; lga: string; state: string };
  parties?: { code: string; color: string }[];
};

type Step = 'sheet' | 'venue' | 'votes' | 'review' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'sheet', label: 'Sheet' },
  { key: 'venue', label: 'Venue' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

/**
 * Practice run — the no-auth sandbox (/api/practice), rehearsing the REAL shape
 * of a report: photograph the sheet, photograph the venue, type the counts,
 * review, sign & send. Same steps, same order, same screens as report/result,
 * so nothing on election day is a surprise.
 *
 * Two deliberate differences, both because this is a rehearsal:
 *  - a GPS fix is not required (people practise indoors), and
 *  - either photo can be skipped with "Use a sample" — the escape the PWA gives
 *    someone who would rather not open the camera.
 * Nothing here is published, counted, chained or anchored; the backend keeps
 * practice in its own disposable table.
 */
export default function Practice() {
  const [cfg, setCfg] = useState<PracticeConfig | null>(null);
  const [step, setStep] = useState<Step>('sheet');

  const [sheet, setSheet] = useState<Media | null>(null);
  const [venue, setVenue] = useState<Media | null>(null);
  /** True while re-shooting one photo from the review step. */
  const [retaking, setRetaking] = useState(false);

  const [counts, setCounts] = useState<Record<string, string>>({});
  const [sheetSerial, setSheetSerial] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ entryHash: string } | null>(null);

  useEffect(() => {
    fetch(`${BASE}/api/practice`)
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
      const res = await fetch(`${BASE}/api/practice/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ votes, puName: cfg?.unit?.name }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        entryHash?: string;
        error?: string;
      };
      if (res.ok && body.ok && body.entryHash) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({ entryHash: body.entryHash });
        setStep('done');
      } else {
        setLine(
          body.error === 'practice_closed'
            ? 'Practice has just closed — reopen this screen.'
            : body.error === 'no_counts'
              ? 'Enter at least one count.'
              : `Practice submit failed. (${body.error ?? 'error'} / HTTP ${res.status})`,
        );
      }
    } catch (e) {
      setLine(`Network error. (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setSheet(null);
    setVenue(null);
    setCounts({});
    setSheetSerial('');
    setDone(null);
    setLine(null);
    setStep('sheet');
  };

  if (!cfg) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist">
        <ActivityIndicator color={BRAND.leaf} />
      </SafeAreaView>
    );
  }

  if (!cfg.active) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <Feather name="moon" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
          Practice is closed
        </Text>
        <Text className="pt-1 text-center text-sm text-neutral-500">
          A fresh practice run reopens after the current election, so you can prepare for the next
          one.
        </Text>
        <Pressable
          className="mt-5 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
          onPress={() => router.back()}
        >
          <Text className="text-base font-bold text-hawk-gold">Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // Capture steps take over the whole screen, exactly as in the real flow.
  if (step === 'sheet' || step === 'venue') {
    const isSheet = step === 'sheet';
    /** "Use a sample": the slot counts as filled, with no photo attached. */
    const skip = () => {
      if (isSheet) setSheet(null);
      else setVenue(null);
      setStep(retaking ? 'review' : isSheet ? 'venue' : 'votes');
      setRetaking(false);
    };
    return (
      <CaptureCamera
        key={step}
        requireFix={false}
        title={
          isSheet
            ? 'Practice — photo 1 of 2, the result sheet'
            : 'Practice — photo 2 of 2, the venue'
        }
        frameGuide={isSheet}
        hint={
          isSheet
            ? 'On election day every figure must be readable. Try it now, or use a sample.'
            : 'Step back and capture the polling unit itself — building, banner, crowd.'
        }
        confirmTitle={isSheet ? 'Check the result sheet' : 'Check the venue photo'}
        confirmHint={
          isSheet
            ? 'Is every figure readable? On election day a blurry photo cannot back a report.'
            : 'Is the polling unit itself visible? On election day this photo proves you were there.'
        }
        extraAction={{ label: 'Use a sample', onPress: skip }}
        onCapture={(shot) => {
          if (isSheet) {
            setSheet(shot);
            setStep(retaking ? 'review' : 'venue');
          } else {
            setVenue(shot);
            setStep(retaking ? 'review' : 'votes');
          }
          setRetaking(false);
        }}
        onCancel={() => {
          if (retaking) {
            setRetaking(false);
            setStep('review');
          } else if (isSheet) {
            router.back();
          } else {
            setStep('sheet');
          }
        }}
      />
    );
  }

  const Slot = ({
    shot,
    label,
    onPress,
  }: {
    shot: Media | null;
    label: string;
    onPress: () => void;
  }) => (
    <Pressable
      disabled={busy}
      className="flex-1 overflow-hidden rounded-2xl bg-white active:opacity-80"
      onPress={onPress}
    >
      {shot ? (
        <Image
          source={{ uri: shot.uri }}
          style={{ width: '100%', height: 110 }}
          contentFit="cover"
        />
      ) : (
        <View className="h-[110px] items-center justify-center bg-hawk-mist">
          <Feather name="image" size={20} color={BRAND.leaf} />
          <Text className="pt-1 text-[11px] font-semibold text-neutral-500">Sample used</Text>
        </View>
      )}
      <View className="flex-row items-center justify-between px-3 py-2">
        <Text className="text-xs font-semibold text-neutral-500">{label}</Text>
        <Text className="text-xs font-bold text-hawk-leaf">{shot ? 'Retake' : 'Take photo'}</Text>
      </View>
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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Practice run</Text>
        <View className="ml-2 rounded-full bg-hawk-gold px-2 py-0.5">
          <Text className="text-[10px] font-bold text-hawk-ink">PRACTICE</Text>
        </View>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {STEPS.map((s, i) => {
            const idx = STEPS.findIndex((x) => x.key === step);
            const on = i <= idx;
            return (
              <View key={s.key} className="mr-1 flex-1">
                <View className={`h-1.5 rounded-full ${on ? 'bg-hawk-leaf' : 'bg-white'}`} />
                <Text
                  className={`pt-1 text-center text-[10px] font-semibold ${
                    on ? 'text-hawk-leaf' : 'text-neutral-400'
                  }`}
                >
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        {step === 'votes' ? (
          <ScrollView
            contentContainerClassName="px-4 pb-4 pt-4"
            keyboardShouldPersistTaps="handled"
          >
            <View className="mb-3 rounded-2xl bg-hawk-green px-5 py-4">
              <Text className="text-xs font-semibold uppercase tracking-wider text-hawk-gold">
                {cfg.name}
              </Text>
              <Text className="pt-1 text-lg font-bold text-white">{cfg.unit?.name}</Text>
              <Text className="pt-0.5 text-xs text-emerald-100">
                {cfg.unit?.code} · {cfg.unit?.ward}, {cfg.unit?.lga}
              </Text>
            </View>
            <Prompt>Enter the announced counts</Prompt>
            {(cfg.parties ?? []).map((p) => (
              <View
                key={p.code}
                className="mb-2 flex-row items-center rounded-2xl bg-white px-4 py-2"
              >
                <View className="mr-3 h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
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
          </ScrollView>
        ) : null}

        {/* Pinned, like the real flow's votes step: practice teaches the shape of
            election day, so the shape has to be the same one. */}
        {step === 'votes' ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            <Pressable
              disabled={votes.length === 0}
              onPress={() => setStep('review')}
              className={`items-center rounded-2xl py-4 ${
                votes.length ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'
              }`}
            >
              <Text className="text-base font-bold text-hawk-gold">Review</Text>
            </Pressable>
            <Pressable className="mt-3 items-center" onPress={() => setStep('venue')}>
              <Text className="text-sm font-semibold text-hawk-leaf">‹ Back to photos</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'review' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4">
            <Text className="pb-3 text-xl font-bold text-hawk-ink">Confirm and send</Text>
            <View className="mb-3 rounded-2xl bg-white px-4 py-3">
              <Text className="text-base font-semibold text-hawk-ink">{cfg.unit?.name}</Text>
              <Text className="text-xs text-neutral-500">
                {cfg.unit?.code} · {cfg.unit?.ward}, {cfg.unit?.lga}
              </Text>
            </View>
            <View className="mb-3 flex-row gap-3">
              <Slot
                shot={sheet}
                label="Result sheet"
                onPress={() => {
                  setRetaking(true);
                  setStep('sheet');
                }}
              />
              <Slot
                shot={venue}
                label="Venue"
                onPress={() => {
                  setRetaking(true);
                  setStep('venue');
                }}
              />
            </View>
            <View className="mb-3 rounded-2xl bg-white px-4 py-2">
              {votes
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((v) => (
                  <View key={v.party} className="flex-row justify-between py-1.5">
                    <Text className="text-base font-semibold text-hawk-ink">{v.party}</Text>
                    <Text className="text-base font-bold text-hawk-ink">
                      {v.count.toLocaleString()}
                    </Text>
                  </View>
                ))}
            </View>
            <Prompt>Enter the sheet serial number (optional)</Prompt>
            <TextInput
              className="mb-3 rounded-2xl bg-white px-4 py-3 text-base text-hawk-ink"
              placeholder="Printed on the EC8A, if visible"
              placeholderTextColor="#9db5a7"
              autoCapitalize="characters"
              value={sheetSerial}
              onChangeText={setSheetSerial}
              editable={!busy}
            />
            <Text className="pb-3 text-xs text-neutral-500">
              On election day this step takes a GPS fix, signs the report with this device&apos;s
              key and files it on the public ledger. Here it just completes the practice — nothing
              is published or counted.
            </Text>
          </ScrollView>
        ) : null}

        {/* Pinned CTA — the review grows with every party contesting, plus two
            photo slots and the serial field, so the send button must never sit
            below the fold. The failure line rides with it: a retry is pressed
            here, not wherever the scroll happens to have landed. */}
        {step === 'review' ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            {line ? (
              <Text className="pb-2 text-sm font-semibold text-amber-800">{line}</Text>
            ) : null}
            <Pressable
              disabled={busy}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${
                busy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
              }`}
            >
              {busy ? (
                <ActivityIndicator color={BRAND.gold} />
              ) : (
                <Text className="text-base font-bold text-hawk-gold">
                  Sign &amp; submit (practice)
                </Text>
              )}
            </Pressable>
            <Pressable
              className="mt-3 items-center"
              onPress={() => setStep('votes')}
              disabled={busy}
            >
              <Text className="text-sm font-semibold text-hawk-leaf">‹ Back to votes</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'done' && done ? (
          <View className="flex-1 items-center justify-center px-8">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
              <Feather name="check" size={28} color={BRAND.gold} />
            </View>
            <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">
              Practice complete
            </Text>
            <Text className="pt-2 text-center text-sm text-neutral-600">
              That is exactly how you report a result on election day — except then it is signed,
              GPS-checked and chained into the public ledger.
            </Text>
            <View className="mt-4 rounded-xl bg-white px-4 py-2">
              <Text className="font-mono text-xs text-neutral-500">{done.entryHash}</Text>
            </View>
            <Pressable
              className="mt-6 w-full items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80"
              onPress={() => router.replace('/report/result')}
            >
              <Text className="text-base font-bold text-hawk-gold">Report a real result</Text>
            </Pressable>
            <Pressable className="mt-3 w-full items-center py-2" onPress={restart}>
              <Text className="text-sm font-semibold text-hawk-leaf">Practise again</Text>
            </Pressable>
            <Pressable className="mt-1 w-full items-center py-2" onPress={() => router.back()}>
              <Text className="text-sm text-neutral-500">Done</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

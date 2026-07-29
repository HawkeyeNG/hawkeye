import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
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
import { getIdentity } from '@/lib/identity';
import { useUi } from '@/lib/theme';

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

/** A past run on this device — practice has no sign-in, so the device is the
 *  only identity it has. */
type PracticeRun = {
  id: number;
  pu_name?: string;
  pu_code?: string;
  entry_hash: string;
  created_at: number;
  votes: { party: string; count: number }[];
};

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
  const ui = useUi();
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
  const [history, setHistory] = useState<PracticeRun[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadHistory = () => {
    getIdentity()
      .then((id) =>
        fetch(`${BASE}/api/practice/mine`, { headers: { 'x-device-id': id.deviceId } }).then((r) =>
          r.ok ? (r.json() as Promise<{ runs: PracticeRun[] }>) : null,
        ),
      )
      .then((d) => setHistory(d?.runs ?? []))
      .catch(() => setHistory([]));
  };

  useEffect(() => {
    loadHistory();
  }, []);

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
      const ident = await getIdentity();
      const res = await fetch(`${BASE}/api/practice/submit`, {
        method: 'POST',
        // The device id is what makes this run appear in "past runs" later —
        // practice never asks anyone to sign in.
        headers: { 'content-type': 'application/json', 'x-device-id': ident.deviceId },
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
        loadHistory();
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
      <SafeAreaView className="flex-1 items-center justify-center bg-surface">
        <ActivityIndicator color={ui.tint.good.ink} />
      </SafeAreaView>
    );
  }

  if (!cfg.active) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-surface px-8">
        <Feather name="moon" size={28} color={ui.tint.good.ink} />
        <Text className="pt-3 text-center text-base font-semibold text-ink">
          Practice Is Closed
        </Text>
        <Text className="pt-1 text-center text-sm text-muted">
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
        readDocument={isSheet}
        partyCodes={(cfg.parties ?? []).map((p) => p.code)}
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
      className="flex-1 overflow-hidden rounded-2xl bg-card active:opacity-80"
      onPress={onPress}
    >
      {shot ? (
        <Image
          source={{ uri: shot.uri }}
          style={{ width: '100%', height: 110 }}
          contentFit="cover"
        />
      ) : (
        <View className="h-[110px] items-center justify-center bg-surface">
          <Feather name="image" size={20} color={ui.tint.good.ink} />
          <Text className="pt-1 text-[11px] font-semibold text-muted">Sample used</Text>
        </View>
      )}
      <View className="flex-row items-center justify-between px-3 py-2">
        <Text className="text-xs font-semibold text-muted">{label}</Text>
        <Text className="text-xs font-bold text-good-ink">{shot ? 'Retake' : 'Take photo'}</Text>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-card"
        >
          <Feather name="x" size={18} color={ui.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-ink">Practice Run</Text>
        {/* bg-hawk-gold is a fixed brand surface: its label must be the fixed
            hawk ink, since text-ink flips near-white and dies in the gold. */}
        <View className="ml-2 rounded-full bg-hawk-gold px-2 py-0.5">
          <Text className="text-[10px] font-bold text-hawk-ink">PRACTICE</Text>
        </View>
        <View className="flex-1" />
        {/* The step opens straight into the scanner, so past runs need a door
            that exists before that. */}
        <Pressable
          hitSlop={12}
          onPress={() => {
            loadHistory();
            setShowHistory(true);
          }}
          className="h-9 flex-row items-center rounded-full bg-card px-3 active:opacity-70"
        >
          <Feather name="clock" size={15} color={ui.tint.good.ink} />
          <Text className="pl-1.5 text-xs font-bold text-good-ink">
            {history?.length ? `${history.length} past` : 'Past runs'}
          </Text>
        </Pressable>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {STEPS.map((s, i) => {
            const idx = STEPS.findIndex((x) => x.key === step);
            const on = i <= idx;
            return (
              <View key={s.key} className="mr-1 flex-1">
                {/* good-ink, not hawk-leaf: #0b6b3a on the dark surface is a
                    2.5:1 bar nobody can see it move. */}
                <View className={`h-1.5 rounded-full ${on ? 'bg-good-ink' : 'bg-card'}`} />
                <Text
                  className={`pt-1 text-center text-[10px] font-semibold ${
                    on ? 'text-good-ink' : 'text-faint'
                  }`}
                >
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <Modal
        visible={showHistory}
        transparent
        animationType="slide"
        onRequestClose={() => setShowHistory(false)}
      >
        <View className="flex-1 justify-end bg-black/40">
          <View className="max-h-[70%] rounded-t-3xl bg-surface px-5 pb-8 pt-5">
            <View className="flex-row items-center pb-2">
              <Text className="flex-1 text-lg font-bold text-ink">Your Practice Runs</Text>
              <Pressable
                hitSlop={12}
                onPress={() => setShowHistory(false)}
                className="h-8 w-8 items-center justify-center rounded-full bg-card"
              >
                <Feather name="x" size={16} color={ui.ink} />
              </Pressable>
            </View>
            <Text className="pb-3 text-xs text-muted">
              Kept per device — practice never asks you to sign in. These sit on the practice
              chain, never the public ledger.
            </Text>
            <ScrollView>
              {history === null ? (
                <ActivityIndicator color={ui.tint.good.ink} />
              ) : history.length === 0 ? (
                <Text className="pb-4 text-sm text-muted">
                  No practice runs yet on this phone.
                </Text>
              ) : (
                history.map((r) => (
                  <View key={r.id} className="mb-2 rounded-2xl bg-card px-4 py-3">
                    <Text className="text-sm font-semibold text-ink">
                      {r.pu_name || r.pu_code || 'Practice polling unit'}
                    </Text>
                    <Text className="pt-0.5 text-xs text-muted">
                      {r.votes
                        .filter((v) => v.count > 0)
                        .map((v) => `${v.party} ${v.count}`)
                        .join(' · ') || 'all zero'}
                    </Text>
                    <Text className="pt-1 text-[11px] text-faint">
                      {new Date(r.created_at).toLocaleString()}
                    </Text>
                    <Text className="pt-0.5 font-mono text-[10px] text-faint">
                      {String(r.entry_hash).slice(0, 24)}…
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

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
                className="mb-2 flex-row items-center rounded-2xl bg-card px-4 py-2"
              >
                <View className="mr-3 h-3 w-3 rounded-full" style={{ backgroundColor: p.color }} />
                <Text className="flex-1 text-base font-semibold text-ink">{p.code}</Text>
                <TextInput
                  className="w-24 rounded-xl bg-surface px-3 py-2 text-center text-lg font-bold text-ink"
                  placeholder="0"
                  placeholderTextColor={ui.faint}
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
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Pressable
              disabled={votes.length === 0}
              onPress={() => setStep('review')}
              className={`items-center rounded-2xl py-4 ${
                votes.length ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'
              }`}
            >
              <Text className="text-base font-bold text-hawk-gold">Review</Text>
            </Pressable>
            <Pressable className="mt-3 items-center" onPress={() => setStep('venue')}>
              <Text className="text-sm font-semibold text-good-ink">‹ Back to photos</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'review' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4">
            <Text className="pb-3 text-xl font-bold text-ink">Confirm and Send</Text>
            <View className="mb-3 rounded-2xl bg-card px-4 py-3">
              <Text className="text-base font-semibold text-ink">{cfg.unit?.name}</Text>
              <Text className="text-xs text-muted">
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
            <View className="mb-3 rounded-2xl bg-card px-4 py-2">
              {votes
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((v) => (
                  <View key={v.party} className="flex-row justify-between py-1.5">
                    <Text className="text-base font-semibold text-ink">{v.party}</Text>
                    <Text className="text-base font-bold text-ink">
                      {v.count.toLocaleString()}
                    </Text>
                  </View>
                ))}
            </View>
            <Prompt>Enter the sheet serial number (optional)</Prompt>
            <TextInput
              className="mb-3 rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder="Printed on the EC8A, if visible"
              placeholderTextColor={ui.faint}
              autoCapitalize="characters"
              value={sheetSerial}
              onChangeText={setSheetSerial}
              editable={!busy}
            />
            <Text className="pb-3 text-xs text-muted">
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
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {line ? (
              <Text className="pb-2 text-sm font-semibold text-warn-ink">{line}</Text>
            ) : null}
            <Pressable
              disabled={busy}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${
                busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
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
              <Text className="text-sm font-semibold text-good-ink">‹ Back to votes</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'done' && done ? (
          <View className="flex-1 items-center justify-center px-8">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
              <Feather name="check" size={28} color={BRAND.gold} />
            </View>
            <Text className="pt-4 text-center text-lg font-bold text-ink">
              Practice Complete
            </Text>
            <Text className="pt-2 text-center text-sm text-muted">
              That is exactly how you report a result on election day — except then it is signed,
              GPS-checked and chained into the public ledger.
            </Text>
            <View className="mt-4 rounded-xl bg-card px-4 py-2">
              <Text className="font-mono text-xs text-muted">{done.entryHash}</Text>
            </View>
            <Pressable
              className="mt-6 w-full items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80"
              onPress={() => router.replace('/report/result')}
            >
              <Text className="text-base font-bold text-hawk-gold">Report a real result</Text>
            </Pressable>
            <Pressable className="mt-3 w-full items-center py-2" onPress={restart}>
              <Text className="text-sm font-semibold text-good-ink">Practise again</Text>
            </Pressable>
            <Pressable className="mt-1 w-full items-center py-2" onPress={() => router.back()}>
              <Text className="text-sm text-muted">Done</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

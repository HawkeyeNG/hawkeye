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

import { CaptureCamera } from '@/components/capture-camera';
import { api, BRAND, type Contest, type Party } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getSubmitFix } from '@/lib/location';
import { submitResult, type Shot, type Vote } from '@/lib/submit';

type Unit = { pu_code: string; name: string; ward: string; lga: string; state: string };
type Step = 'unit' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'unit', label: 'Unit' },
  { key: 'sheet', label: 'Sheet' },
  { key: 'venue', label: 'Venue' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

/** Report a result — unit → sheet photo → venue photo → votes → signed submit. */
export default function ReportResult() {
  const auth = useAuth();
  const [step, setStep] = useState<Step>('unit');

  // -- step 1: cascading unit picker --------------------------------------
  const [contest, setContest] = useState<Contest | null>(null);
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unit, setUnit] = useState<Unit | null>(null);

  useEffect(() => {
    api.contests().then((cs) => {
      const c = cs[0] ?? null;
      setContest(c);
      if (c) {
        if (c.states.length === 1) {
          setStateSel(c.states[0]);
        } else {
          api.states(c.code).then(setStates).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!contest || !stateSel) return;
    fetch(`https://hawkeye.com.ng/api/register/lgas?contest=${contest.code}&state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json()).then(setLgas).catch(() => {});
  }, [contest, stateSel]);

  useEffect(() => {
    if (!contest || !stateSel || !lgaSel) return;
    fetch(`https://hawkeye.com.ng/api/register/wards?contest=${contest.code}&state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`)
      .then((r) => r.json()).then(setWards).catch(() => {});
  }, [contest, stateSel, lgaSel]);

  useEffect(() => {
    if (!contest || !stateSel || !lgaSel || !wardSel) return;
    fetch(`https://hawkeye.com.ng/api/register/units?contest=${contest.code}&state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}&ward=${encodeURIComponent(wardSel)}`)
      .then((r) => r.json()).then((d) => setUnits(d.units ?? [])).catch(() => {});
  }, [contest, stateSel, lgaSel, wardSel]);

  // -- steps 2/3: photos ----------------------------------------------------
  const [sheet, setSheet] = useState<Shot | null>(null);
  const [venue, setVenue] = useState<Shot | null>(null);
  /** True while re-shooting a single photo from the review step. */
  const [retaking, setRetaking] = useState(false);

  // -- step 4: votes --------------------------------------------------------
  const [parties, setParties] = useState<Party[]>([]);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (step === 'votes' && parties.length === 0) {
      api.parties().then(setParties).catch(() => {});
      // Official INEC emblems (same manifest the web app uses) — several party
      // names read alike; the emblem is how observers actually recognise them.
      fetch('https://hawkeye.com.ng/logos/manifest.json')
        .then((r) => r.json())
        .then(setLogos)
        .catch(() => {});
    }
  }, [step, parties.length]);

  const votes: Vote[] = useMemo(
    () =>
      Object.entries(counts)
        .filter(([, v]) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0)
        .map(([party, v]) => ({ party, count: Number(v) })),
    [counts],
  );

  /**
   * Filter only — the ORDER IS FIXED while typing.
   *
   * Sorting entered parties to the top re-ordered the list on every keystroke,
   * which tore the focused input out from under the observer: the first digit
   * jumped the row away and a two-digit tally became impossible to enter.
   * Ranking belongs on the review step, which already sorts by count.
   */
  const filteredParties = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parties;
    return parties.filter(
      (p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
    );
  }, [parties, search]);

  // -- step 5: review + submit ---------------------------------------------
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; line: string }>({ title: '', line: '' });

  const onSubmit = async () => {
    if (!unit || !contest || !sheet || !venue) return;
    setBusy(true);
    setLine('Getting your location…');
    try {
      // Bounded, accuracy-aware fix — the server rejects accuracy >100m, and an
      // unbounded High wait indoors can hang the submit button indefinitely.
      const fix = await getSubmitFix();
      if (!fix) {
        setLine('No GPS fix — location must be on. Move near a window and retry.');
        setBusy(false);
        return;
      }
      setLine('Signing and submitting…');
      const r = await submitResult({
        puCode: unit.pu_code,
        contest: contest.code,
        votes,
        sheet,
        venue,
        fix,
      });
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Report filed',
          line: 'It is now queued for review and will appear on the public log.',
        });
        setStep('done');
      } else if (r.error === 'reporting_not_open') {
        // The flow worked end-to-end; only the election-day gate stopped it.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({ title: 'Dry run complete', line: r.message });
        setStep('done');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setLine(r.message);
      }
    } catch {
      setLine('Something went wrong — nothing was sent. Retry.');
    } finally {
      setBusy(false);
    }
  };

  // -- guards ---------------------------------------------------------------
  if (auth.status !== 'signedIn') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <Feather name="lock" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
          Sign in to report a result
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

  if (step === 'sheet' || step === 'venue') {
    const isSheet = step === 'sheet';
    return (
      <CaptureCamera
        // Fresh mount per step: without the key, the venue step inherits the
        // sheet step's internal preview/busy state (same element position).
        key={step}
        title={isSheet ? 'Photo 1 of 2 — the result sheet' : 'Photo 2 of 2 — the surroundings'}
        frameGuide={isSheet}
        hint={
          isSheet
            ? 'Fit the EC8A inside the frame. Every figure must be readable.'
            : 'Step back and capture the polling unit itself — building, banner, crowd.'
        }
        confirmTitle={isSheet ? 'Check the result sheet' : 'Check the venue photo'}
        confirmHint={
          isSheet
            ? 'Is every figure readable? Blurry photos cannot back a report.'
            : 'Is the polling unit itself visible — the building, banner or crowd? This photo proves you were there.'
        }
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
          } else {
            setStep(isSheet ? 'unit' : 'sheet');
          }
        }}
      />
    );
  }

  const Chip = ({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) => (
    <Pressable
      onPress={onPress}
      className={`mb-2 mr-2 rounded-full px-4 py-2 ${on ? 'bg-hawk-green' : 'bg-white'}`}
    >
      <Text className={`text-sm font-semibold ${on ? 'text-hawk-gold' : 'text-neutral-700'}`}>
        {label}
      </Text>
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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Report a result</Text>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {STEPS.map((s, i) => {
            const idx = STEPS.findIndex((x) => x.key === step);
            const on = i <= idx;
            return (
              <View key={s.key} className="mr-1 flex-1">
                <View className={`h-1.5 rounded-full ${on ? 'bg-hawk-leaf' : 'bg-white'}`} />
                <Text className={`pt-1 text-center text-[10px] font-semibold ${on ? 'text-hawk-leaf' : 'text-neutral-400'}`}>
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        {step === 'unit' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            <Text className="pb-1 text-xl font-bold text-hawk-ink">
              {contest ? contest.election : 'Loading election…'}
            </Text>
            <Text className="pb-4 text-sm text-neutral-600">Pick your polling unit.</Text>

            {states.length > 1 && !stateSel ? (
              <View className="flex-row flex-wrap">{states.map((s) => <Chip key={s} label={s} onPress={() => setStateSel(s)} />)}</View>
            ) : null}

            {stateSel && !lgaSel ? (
              <>
                <Text className="pb-2 text-sm font-semibold text-neutral-500">LGA — {stateSel}</Text>
                <View className="flex-row flex-wrap">{lgas.map((l) => <Chip key={l} label={l} onPress={() => setLgaSel(l)} />)}</View>
              </>
            ) : null}

            {lgaSel && !wardSel ? (
              <>
                <Pressable onPress={() => setLgaSel(null)}>
                  <Text className="pb-2 text-sm font-semibold text-hawk-leaf">‹ {lgaSel}</Text>
                </Pressable>
                <View className="flex-row flex-wrap">{wards.map((w) => <Chip key={w} label={w} onPress={() => setWardSel(w)} />)}</View>
              </>
            ) : null}

            {wardSel ? (
              <>
                <Pressable onPress={() => setWardSel(null)}>
                  <Text className="pb-2 text-sm font-semibold text-hawk-leaf">‹ {wardSel}</Text>
                </Pressable>
                {units.map((u) => {
                  const on = unit?.pu_code === u.pu_code;
                  return (
                    <Pressable
                      key={u.pu_code}
                      className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-white'}`}
                      onPress={() => setUnit(u)}
                    >
                      <View className="flex-1 pr-2">
                        <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-hawk-ink'}`}>
                          {u.name}
                        </Text>
                        <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-neutral-500'}`}>
                          {u.pu_code} · {u.ward}, {u.lga}
                        </Text>
                      </View>
                      {/* Inline Continue on the chosen row: in a long ward the
                          footer CTA can sit far below the unit you just tapped. */}
                      {on ? (
                        <Pressable
                          className="flex-row items-center rounded-xl bg-hawk-gold px-3 py-2 active:opacity-80"
                          onPress={() => setStep('sheet')}
                        >
                          <Text className="pr-1 text-sm font-bold text-hawk-ink">Continue</Text>
                          <Feather name="arrow-right" size={14} color={BRAND.ink} />
                        </Pressable>
                      ) : null}
                    </Pressable>
                  );
                })}
                {units.length === 0 ? (
                  <Text className="pt-2 text-sm text-neutral-500">No units in the register for this ward yet.</Text>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        ) : null}

        {/* Pinned CTA — a ward can list dozens of units, so the primary action
            must never be somewhere below the fold. */}
        {step === 'unit' && unit ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            <Text className="pb-2 text-xs text-neutral-500" numberOfLines={1}>
              Selected: {unit.name}
            </Text>
            <Pressable
              onPress={() => setStep('sheet')}
              className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
            >
              <Text className="text-base font-bold text-hawk-gold">Continue to photos</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'votes' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
            <Text className="pb-1 text-xl font-bold text-hawk-ink">Votes per party</Text>
            <Text className="pb-3 text-sm text-neutral-600">
              Copy the figures exactly as written on the sheet. Leave blank for parties not listed.
            </Text>
            <TextInput
              className="mb-3 rounded-2xl bg-white px-4 py-3 text-base text-hawk-ink"
              placeholder="Search party (APC, PDP, LP…)"
              placeholderTextColor="#9db5a7"
              value={search}
              onChangeText={setSearch}
            />
            {filteredParties.slice(0, 30).map((p) => (
              <View key={p.code} className="mb-2 flex-row items-center rounded-2xl bg-white px-4 py-2">
                {logos[p.code] ? (
                  <Image
                    source={{ uri: `https://hawkeye.com.ng/${logos[p.code]}` }}
                    style={{ width: 30, height: 30, borderRadius: 6, marginRight: 10 }}
                    contentFit="contain"
                    cachePolicy="disk"
                  />
                ) : (
                  <View
                    className="mr-2.5 items-center justify-center rounded-md bg-hawk-mist"
                    style={{ width: 30, height: 30 }}
                  >
                    <Text className="text-[10px] font-bold text-hawk-leaf">{p.code.slice(0, 3)}</Text>
                  </View>
                )}
                <View className="flex-1 pr-2">
                  <Text className="text-base font-semibold text-hawk-ink">{p.code}</Text>
                  <Text className="text-xs text-neutral-500" numberOfLines={1}>{p.name}</Text>
                </View>
                <TextInput
                  className="w-24 rounded-xl bg-hawk-mist px-3 py-2 text-center text-lg font-bold text-hawk-ink"
                  placeholder="0"
                  placeholderTextColor="#9db5a7"
                  keyboardType="number-pad"
                  value={counts[p.code] ?? ''}
                  onChangeText={(t) => setCounts((c) => ({ ...c, [p.code]: t.replace(/[^0-9]/g, '') }))}
                />
              </View>
            ))}
            <Pressable
              disabled={votes.length === 0}
              onPress={() => setStep('review')}
              className={`mt-3 items-center rounded-2xl py-4 ${votes.length ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">Review report</Text>
            </Pressable>
          </ScrollView>
        ) : null}

        {step === 'review' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            <Text className="pb-3 text-xl font-bold text-hawk-ink">Confirm and send</Text>
            <View className="mb-3 rounded-2xl bg-white px-4 py-3">
              <Text className="text-base font-semibold text-hawk-ink">{unit?.name}</Text>
              <Text className="text-xs text-neutral-500">{unit?.pu_code} · {unit?.ward}, {unit?.lga}</Text>
            </View>
            <View className="mb-3 flex-row gap-3">
              {[sheet, venue].map((s, i) =>
                s ? (
                  <Pressable
                    key={i}
                    disabled={busy}
                    className="flex-1 overflow-hidden rounded-2xl bg-white active:opacity-80"
                    onPress={() => {
                      setRetaking(true);
                      setStep(i === 0 ? 'sheet' : 'venue');
                    }}
                  >
                    <Image source={{ uri: s.uri }} style={{ width: '100%', height: 110 }} contentFit="cover" />
                    <View className="flex-row items-center justify-between px-3 py-2">
                      <Text className="text-xs font-semibold text-neutral-500">
                        {i === 0 ? 'Result sheet' : 'Venue'}
                      </Text>
                      <Text className="text-xs font-bold text-hawk-leaf">Retake</Text>
                    </View>
                  </Pressable>
                ) : null,
              )}
            </View>
            <View className="mb-3 rounded-2xl bg-white px-4 py-2">
              {votes
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((v) => (
                  <View key={v.party} className="flex-row justify-between py-1.5">
                    <Text className="text-base font-semibold text-hawk-ink">{v.party}</Text>
                    <Text className="text-base font-bold text-hawk-ink">{v.count.toLocaleString()}</Text>
                  </View>
                ))}
            </View>
            <Text className="pb-3 text-xs text-neutral-500">
              Submitting takes a GPS fix at your position, signs the report with this device's
              key, and files it for review. Your number is never attached — only your observer ID.
            </Text>
            {line ? <Text className="pb-3 text-sm font-semibold text-amber-800">{line}</Text> : null}
            <Pressable
              disabled={busy}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${busy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'}`}
            >
              {busy ? <ActivityIndicator color={BRAND.gold} /> : (
                <Text className="text-base font-bold text-hawk-gold">Sign & submit</Text>
              )}
            </Pressable>
            <Pressable className="mt-3 items-center" onPress={() => setStep('votes')} disabled={busy}>
              <Text className="text-sm font-semibold text-hawk-leaf">‹ Back to votes</Text>
            </Pressable>
          </ScrollView>
        ) : null}

        {step === 'done' ? (
          <View className="flex-1 items-center justify-center px-8">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
              <Feather name="check" size={28} color={BRAND.gold} />
            </View>
            <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">{done.title}</Text>
            <Text className="pt-2 text-center text-sm text-neutral-600">{done.line}</Text>
            <Pressable
              className="mt-6 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
              onPress={() => router.back()}
            >
              <Text className="text-base font-bold text-hawk-gold">Done</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

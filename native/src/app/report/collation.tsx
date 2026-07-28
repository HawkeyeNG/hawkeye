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
import { NoElection } from '@/components/no-election';
import { Crumb, Prompt } from '@/components/wizard';
import { api, BRAND, type Contest, type Party } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getSubmitFix } from '@/lib/location';
import { submitCollation, type CollationLevel, type Shot, type Vote } from '@/lib/submit';

type Step = 'scope' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'scope', label: 'Scope' },
  { key: 'sheet', label: 'Form' },
  { key: 'venue', label: 'Venue' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

const LEVELS: { key: CollationLevel; label: string; sub: string }[] = [
  { key: 'ward', label: 'Ward', sub: 'Ward collation centre (EC8B)' },
  { key: 'lga', label: 'LGA', sub: 'Local government collation (EC8C)' },
  { key: 'state', label: 'State', sub: 'State collation (EC8D)' },
];

const REG = 'https://hawkeye.com.ng/api/register';

/**
 * Report a collation — the announcement made at a ward/LGA/state centre.
 *
 * Same evidence discipline as a unit result (two in-app photos, GPS, signed),
 * but scoped to an administrative level: no polling unit, so no geofence.
 * Collation figures are where aggregation fraud actually happens, which is why
 * this carries the same proof burden as the unit sheets it should sum to.
 */
export default function ReportCollation() {
  const auth = useAuth();
  const [step, setStep] = useState<Step>('scope');

  // -- scope ---------------------------------------------------------------
  const [contest, setContest] = useState<Contest | null>(null);
  const [level, setLevel] = useState<CollationLevel | null>(null);
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);

  useEffect(() => {
    api.contests().then((cs) => setContest(cs[0] ?? null)).catch(() => {});
    fetch(`${REG}/states`)
      .then((r) => r.json())
      .then(setStates)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!contest || !stateSel) return;
    fetch(`${REG}/lgas?contest=${contest.code}&state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json())
      .then(setLgas)
      .catch(() => {});
  }, [contest, stateSel]);

  useEffect(() => {
    if (!contest || !stateSel || !lgaSel) return;
    fetch(
      `${REG}/wards?contest=${contest.code}&state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`,
    )
      .then((r) => r.json())
      .then(setWards)
      .catch(() => {});
  }, [contest, stateSel, lgaSel]);

  /** Is the chosen state inside the active contest? Drives the
   *  "no active election here" answer instead of hiding the state. */
  const covered = !!contest && !!stateSel && contest.states.includes(stateSel);

  /** Scope completeness mirrors the server rule exactly. */
  const scopeReady =
    !!contest &&
    !!level &&
    !!stateSel &&
    covered &&
    (level === 'state' || !!lgaSel) &&
    (level !== 'ward' || !!wardSel);


  // -- photos ---------------------------------------------------------------
  const [sheet, setSheet] = useState<Shot | null>(null);
  const [venue, setVenue] = useState<Shot | null>(null);
  const [retaking, setRetaking] = useState(false);

  // -- votes ----------------------------------------------------------------
  const [parties, setParties] = useState<Party[]>([]);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (step === 'votes' && parties.length === 0) {
      api.parties().then(setParties).catch(() => {});
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

  // Filter only — order stays fixed while typing (reordering steals focus).
  const filteredParties = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parties;
    return parties.filter(
      (p) => p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
    );
  }, [parties, search]);

  // -- submit ---------------------------------------------------------------
  /** Optional collation-form serial, mirroring the PWA field. */
  const [formSerial, setFormSerial] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState({ title: '', line: '' });

  const onSubmit = async () => {
    if (!contest || !level || !stateSel || !sheet || !venue) return;
    setBusy(true);
    setLine('Getting your location…');
    try {
      const fix = await getSubmitFix();
      if (!fix) {
        setLine('No GPS fix — location must be on. Move near a window and retry.');
        setBusy(false);
        return;
      }
      setLine('Signing and submitting…');
      const r = await submitCollation({
        level,
        contest: contest.code,
        state: stateSel,
        lga: level === 'state' ? null : lgaSel,
        ward: level === 'ward' ? wardSel : null,
        votes,
        sheet,
        venue,
        fix,
        formSerial: formSerial.trim() || undefined,
      });
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Collation filed',
          line: 'It is queued for review and will appear on the public log.',
        });
        setStep('done');
      } else if (r.error === 'reporting_not_open') {
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
          Sign in to report a collation
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
        key={step}
        title={isSheet ? 'Photo 1 of 2 — the collation form' : 'Photo 2 of 2 — the centre'}
        frameGuide={isSheet}
        hint={
          isSheet
            ? 'Fit the whole form in frame. Every figure must be readable.'
            : 'Step back and capture the collation centre — building, banner, officials.'
        }
        confirmTitle={isSheet ? 'Check the form' : 'Check the venue photo'}
        confirmHint={
          isSheet
            ? 'Is every figure readable? Blurry photos cannot back a report.'
            : 'Is the collation centre itself visible? This photo proves you were there.'
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
            setStep(isSheet ? 'scope' : 'sheet');
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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Report a collation</Text>
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
                  className={`pt-1 text-center text-[10px] font-semibold ${on ? 'text-hawk-leaf' : 'text-neutral-400'}`}
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
        {step === 'scope' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            <Text className="pb-1 text-xl font-bold text-hawk-ink">
              {contest ? contest.election : 'Loading election…'}
            </Text>
            <Text className="pb-4 text-sm text-neutral-600">
              Which collation are you reporting?
            </Text>

            {/* PROGRESSIVE DISCLOSURE: exactly one stage is on screen at a
                time. Stacking all of them made new options open below the fold
                with nothing to signal they existed. Completed stages collapse
                to a Crumb, which is also how you go back. */}
            {!level ? (
              <>
                <Prompt>Select the collation level</Prompt>
                {LEVELS.map((l) => (
                  <Pressable
                    key={l.key}
                    onPress={() => {
                      setLevel(l.key);
                      setLgaSel(null);
                      setWardSel(null);
                    }}
                    className="mb-2 rounded-2xl bg-white px-4 py-3 active:opacity-80"
                  >
                    <Text className="text-base font-semibold text-hawk-ink">{l.label}</Text>
                    <Text className="text-xs text-neutral-500">{l.sub}</Text>
                  </Pressable>
                ))}
              </>
            ) : (
              <Crumb
                label={LEVELS.find((l) => l.key === level)!.label}
                onPress={() => {
                  setLevel(null);
                  setLgaSel(null);
                  setWardSel(null);
                }}
              />
            )}

            {level && !stateSel ? (
              <>
                <Prompt>Select the state</Prompt>
                <View className="flex-row flex-wrap">
                  {states.map((s) => (
                    <Chip key={s} label={s} onPress={() => setStateSel(s)} />
                  ))}
                </View>
              </>
            ) : null}

            {level && stateSel && !covered ? (
              <>
                <Crumb label={stateSel} onPress={() => setStateSel(null)} />
                <NoElection state={stateSel} contest={contest} />
              </>
            ) : null}

            {level && covered && level !== 'state' && stateSel && !lgaSel ? (
              <>
                <Prompt>Select the LGA</Prompt>
                <View className="flex-row flex-wrap">
                  {lgas.map((l) => (
                    <Chip key={l} label={l} onPress={() => setLgaSel(l)} />
                  ))}
                </View>
              </>
            ) : null}

            {level && covered && level !== 'state' && lgaSel ? (
              <Crumb label={lgaSel} onPress={() => setLgaSel(null)} />
            ) : null}

            {level === 'ward' && lgaSel && !wardSel ? (
              <>
                <Prompt>Select the ward</Prompt>
                <View className="flex-row flex-wrap">
                  {wards.map((w) => (
                    <Chip key={w} label={w} onPress={() => setWardSel(w)} />
                  ))}
                </View>
              </>
            ) : null}

            {level === 'ward' && wardSel ? (
              <Crumb label={wardSel} onPress={() => setWardSel(null)} />
            ) : null}
          </ScrollView>
        ) : null}

        {step === 'scope' && scopeReady ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            <Text className="pb-2 text-xs text-neutral-500" numberOfLines={1}>
              {level === 'state'
                ? `State collation — ${stateSel}`
                : level === 'lga'
                  ? `LGA collation — ${lgaSel}, ${stateSel}`
                  : `Ward collation — ${wardSel}, ${lgaSel}`}
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
            <Text className="pb-1 text-xl font-bold text-hawk-ink">Collated totals</Text>
            <Text className="pb-3 text-sm text-neutral-600">
              Copy the figures exactly as announced. Leave blank for parties not listed.
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
                  <Text className="text-xs text-neutral-500" numberOfLines={1}>
                    {p.name}
                  </Text>
                </View>
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
              <Text className="text-base font-semibold text-hawk-ink">
                {LEVELS.find((l) => l.key === level)?.label} collation
              </Text>
              <Text className="text-xs text-neutral-500">
                {[wardSel, lgaSel, stateSel].filter(Boolean).join(', ')}
              </Text>
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
                    <Image
                      source={{ uri: s.uri }}
                      style={{ width: '100%', height: 110 }}
                      contentFit="cover"
                    />
                    <View className="flex-row items-center justify-between px-3 py-2">
                      <Text className="text-xs font-semibold text-neutral-500">
                        {i === 0 ? 'Collation form' : 'Venue'}
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
                    <Text className="text-base font-bold text-hawk-ink">
                      {v.count.toLocaleString()}
                    </Text>
                  </View>
                ))}
            </View>
            {/* Optional form serial — parity with the PWA's collation field. */}
            <Prompt>Enter the form serial number (optional)</Prompt>
            <TextInput
              className="mb-3 rounded-2xl bg-white px-4 py-3 text-base text-hawk-ink"
              placeholder="Printed on the collation form, if visible"
              placeholderTextColor="#9db5a7"
              autoCapitalize="characters"
              value={formSerial}
              onChangeText={setFormSerial}
              editable={!busy}
            />
            {line ? (
              <Text className="pb-3 text-sm font-semibold text-amber-800">{line}</Text>
            ) : null}
            <Pressable
              disabled={busy}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${busy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'}`}
            >
              {busy ? (
                <ActivityIndicator color={BRAND.gold} />
              ) : (
                <Text className="text-base font-bold text-hawk-gold">Sign &amp; submit</Text>
              )}
            </Pressable>
            <Pressable
              className="mt-3 items-center"
              onPress={() => setStep('votes')}
              disabled={busy}
            >
              <Text className="text-sm font-semibold text-hawk-leaf">‹ Back to totals</Text>
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

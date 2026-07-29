import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { useUi } from '@/lib/theme';
import { useAuth } from '@/lib/auth';
import { getSubmitFix } from '@/lib/location';
import { submitCollation, type CollationLevel, type Receipt, type Shot, type Vote } from '@/lib/submit';

const BASE = 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

type Step = 'scope' | 'contest' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'scope', label: 'Scope' },
  { key: 'contest', label: 'Race' },
  { key: 'sheet', label: 'Form' },
  { key: 'venue', label: 'Venue' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

const LEVELS: { key: CollationLevel; label: string; form: string; sub: string }[] = [
  { key: 'ward', label: 'Ward', form: 'EC8B', sub: 'Ward collation centre (EC8B)' },
  { key: 'lga', label: 'LGA', form: 'EC8C', sub: 'Local government collation (EC8C)' },
  { key: 'state', label: 'State', form: 'EC8D', sub: 'State collation (EC8D)' },
];

/**
 * Mirror of backend/src/services/scope.js (and app.js's contestApplies): the
 * state decides which races exist there. The FCT has an appointed minister — no
 * governorship, no state assembly — and a single-state election carries a
 * `states` allowlist; absent or empty means nationwide.
 */
const contestApplies = (state: string, c: Contest) =>
  !(state === 'FCT' && (c.code === 'GOV' || c.code === 'SHA')) &&
  (!c.states || c.states.length === 0 || c.states.includes(state));

const racesIn = (state: string, contests: Contest[]) =>
  contests.filter((c) => contestApplies(state, c));

/**
 * A scheduled election opens at poll-open on election day (the server sends
 * open:false + opensAt until then). Naming the instant is the whole point: an
 * observer who is told "not open" without a time comes back at random.
 */
function opensLine(c: Contest): string {
  if (!c.opensAt) return 'Reporting has not opened for this election yet.';
  const d = new Date(c.opensAt);
  if (Number.isNaN(d.getTime())) return `Reporting opens ${c.opensAt}.`;
  return `Reporting opens ${d.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })}.`;
}

/**
 * Report a collation — the announcement made at a ward/LGA/state centre.
 *
 * Same evidence discipline as a unit result (two in-app photos, GPS, signed),
 * but scoped to an administrative level: no polling unit, so no geofence.
 * Collation figures are where aggregation fraud actually happens, which is why
 * this carries the same proof burden as the unit sheets it should sum to.
 */
export default function ReportCollation() {
  const ui = useUi();
  const auth = useAuth();
  const [step, setStep] = useState<Step>('scope');

  // -- scope ---------------------------------------------------------------
  const [contests, setContests] = useState<Contest[]>([]);
  const [contest, setContest] = useState<Contest | null>(null);
  const [level, setLevel] = useState<CollationLevel | null>(null);
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);

  useEffect(() => {
    // Every state is listed, not just the covered ones — an observer outside the
    // active election should be told "nothing here yet", not shown an empty world.
    api.contests().then(setContests).catch(() => {});
    fetch(`${REG}/states`)
      .then((r) => r.json())
      .then(setStates)
      .catch(() => {});
  }, []);

  // No contest filter on the register drill: the server ignores the parameter
  // (pollingUnits.js selects on state/lga/ward alone), and passing it meant the
  // whole picker sat dead until /api/contests resolved. The race is chosen from
  // the scope further down, which is the direction the scope rule runs anyway.
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

  /** Is any race running in the chosen state? Drives the
   *  "no active election here" answer instead of hiding the state. */
  const covered = !!stateSel && racesIn(stateSel, contests).length > 0;

  /** The races that exist in the chosen state — the contest step's whole content. */
  const applicable = useMemo(
    () => (stateSel ? racesIn(stateSel, contests) : []),
    [stateSel, contests],
  );

  /** The race step is real only when there is a choice to make. */
  const steps = useMemo(
    () => STEPS.filter((s) => s.key !== 'contest' || applicable.length > 1),
    [applicable.length],
  );

  /** Scope completeness mirrors the server rule exactly. */
  const scopeReady =
    !!level &&
    !!stateSel &&
    covered &&
    (level === 'state' || !!lgaSel) &&
    (level !== 'ward' || !!wardSel);

  const scopeLine = [wardSel, lgaSel, stateSel].filter(Boolean).join(', ');
  const levelDef = LEVELS.find((l) => l.key === level) ?? null;

  /**
   * The state determines the race, so the contest step is built here rather than
   * up front — and skipped entirely when the state has exactly one race, which
   * is every state outside the FCT during a single-race election.
   */
  const continueFromScope = () => {
    if (!stateSel) return;
    if (contests.length === 0) {
      Alert.alert(
        'Election list not loaded',
        'Hawkeye could not load which elections are running — check your connection and reopen this screen. (no /api/contests response)',
      );
      return;
    }
    const races = racesIn(stateSel, contests);
    if (races.length === 0) {
      Alert.alert(
        `No active election in ${stateSel}`,
        `Hawkeye is covering the ${contests[0].election}. No collation is open for reporting in ${stateSel} yet — but you can still map polling units anywhere in Nigeria.`,
      );
      return;
    }
    if (races.length === 1) {
      setContest(races[0]);
      setStep('sheet');
      return;
    }
    setStep('contest');
  };

  /**
   * Choosing a state pre-picks its race when there is only one, and drops any
   * race chosen under the previous state: the contest is derived from the scope,
   * so it must never outlive it. Backing out to a different state otherwise left
   * the pinned Continue live for a contest that does not run where the observer
   * is now reporting from.
   *
   * Done here rather than in an effect on stateSel because /api/contests may
   * still be in flight — continueFromScope re-derives the race at press time,
   * which is the moment it actually has to be right.
   */
  const chooseState = (s: string | null) => {
    setStateSel(s);
    const races = s ? racesIn(s, contests) : [];
    setContest(races.length === 1 ? races[0] : null);
  };

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
      fetch(`${BASE}/logos/manifest.json`)
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

  /** Highest first — the ranking the review and the receipt are both checked against. */
  const rankedVotes = useMemo(() => votes.slice().sort((a, b) => b.count - a.count), [votes]);

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
  const [receipt, setReceipt] = useState<Receipt>({});
  /** Held in the offline outbox rather than delivered — a different ending. */
  const [queued, setQueued] = useState(false);
  const [copied, setCopied] = useState(false);

  /** Nothing can be filed before poll-open; the server enforces it either way. */
  const closed = contest?.open === false;

  const onSubmit = async () => {
    if (!contest || !level || !stateSel || !sheet || !venue || closed) return;
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
        setReceipt(r);
        setQueued(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Collation filed',
          line: 'It is on the public record and being checked against the polling-unit reports it should sum to.',
        });
        setStep('done');
      } else if (r.queued) {
        // Say what actually happened. "Collation filed" over a report still
        // sitting in the outbox is the one lie this app cannot tell — so this
        // ending has its own icon, its own words, and no entry hash to show,
        // because there is no ledger entry yet.
        setReceipt({});
        setQueued(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Saved on this phone',
          line: 'It will send when you have signal. The report is already signed, so it files exactly as you left it — keep the app installed and it goes on its own.',
        });
        setStep('done');
      } else if (r.error === 'reporting_not_open') {
        // The flow worked end-to-end; only the election-day gate stopped it.
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setReceipt({});
        setQueued(false);
        setDone({ title: 'Dry run complete', line: r.message });
        setStep('done');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setLine(r.message);
      }
    } catch (e) {
      setLine(
        `Something went wrong — nothing was sent. Retry. (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setBusy(false);
    }
  };

  // -- guards ---------------------------------------------------------------
  if (auth.status !== 'signedIn') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-surface px-8">
        <Feather name="lock" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-ink">
          Sign in to report a collation
        </Text>
        <Pressable
          className="mt-4 rounded-2xl bg-hawk-green px-6 py-3"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={() => router.back()}>
          <Text className="text-sm text-muted">Not now</Text>
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
        readDocument={isSheet}
        partyCodes={parties.map((p) => p.code)}
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
          } else if (isSheet) {
            setStep(applicable.length > 1 ? 'contest' : 'scope');
          } else {
            setStep('sheet');
          }
        }}
      />
    );
  }

  const Chip = ({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) => (
    <Pressable
      onPress={onPress}
      className={`mb-2 mr-2 rounded-full px-4 py-2 ${on ? 'bg-hawk-green' : 'bg-card'}`}
    >
      <Text className={`text-sm font-semibold ${on ? 'text-hawk-gold' : 'text-ink'}`}>
        {label}
      </Text>
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
        <Text className="pl-3 text-lg font-bold text-ink">Report a collation</Text>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {steps.map((s, i) => {
            const idx = steps.findIndex((x) => x.key === step);
            const on = i <= idx;
            return (
              <View key={s.key} className="mr-1 flex-1">
                <View className={`h-1.5 rounded-full ${on ? 'bg-hawk-leaf' : 'bg-card'}`} />
                <Text
                  className={`pt-1 text-center text-[10px] font-semibold ${on ? 'text-hawk-leaf' : 'text-faint'}`}
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
            <Text className="pb-1 text-xl font-bold text-ink">
              {contests.length ? contests[0].election : 'Loading election…'}
            </Text>
            <Text className="pb-4 text-sm text-muted">
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
                    className="mb-2 rounded-2xl bg-card px-4 py-3 active:opacity-80"
                  >
                    <Text className="text-base font-semibold text-ink">{l.label}</Text>
                    <Text className="text-xs text-muted">{l.sub}</Text>
                  </Pressable>
                ))}
              </>
            ) : (
              <Crumb
                label={levelDef!.label}
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
                    <Chip key={s} label={s} onPress={() => chooseState(s)} />
                  ))}
                </View>
              </>
            ) : null}

            {level && stateSel && !covered ? (
              <>
                <Crumb label={stateSel} onPress={() => chooseState(null)} />
                <NoElection state={stateSel} contest={contests[0] ?? null} />
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
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Text className="pb-2 text-xs text-muted" numberOfLines={1}>
              {level === 'state'
                ? `State collation — ${stateSel}`
                : level === 'lga'
                  ? `LGA collation — ${lgaSel}, ${stateSel}`
                  : `Ward collation — ${wardSel}, ${lgaSel}`}
            </Text>
            <Pressable
              onPress={continueFromScope}
              className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
            >
              <Text className="text-base font-bold text-hawk-gold">
                {applicable.length > 1 ? 'Continue — choose the race' : 'Continue to photos'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'contest' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            <Crumb label={scopeLine} onPress={() => setStep('scope')} />
            <Prompt>Which election are you reporting?</Prompt>
            <Text className="pb-3 text-sm text-muted">
              A collation centre announces every race on the same day. Only the ones that run in{' '}
              {stateSel} are listed — report each one separately.
            </Text>
            {applicable.map((c) => {
              const on = contest?.code === c.code;
              return (
                <Pressable
                  key={c.code}
                  onPress={() => setContest(c)}
                  className={`mb-2 rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-card'}`}
                >
                  <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-ink'}`}>
                    {c.name}
                  </Text>
                  <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-muted'}`}>
                    {c.election}
                  </Text>
                  {c.open === false ? (
                    <Text
                      className={`pt-1 text-xs font-semibold ${on ? 'text-hawk-gold' : 'text-amber-800'}`}
                    >
                      {opensLine(c)}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {step === 'contest' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {closed && contest ? (
              <Text className="pb-2 text-sm font-semibold text-amber-800">{opensLine(contest)}</Text>
            ) : null}
            <Pressable
              disabled={!contest}
              onPress={() => setStep('sheet')}
              className={`items-center rounded-2xl py-4 ${contest ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">Continue to photos</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'votes' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
            <Text className="pb-1 text-xl font-bold text-ink">Collated totals</Text>
            <Text className="pb-3 text-sm text-muted">
              Copy the figures exactly as announced. Leave blank for parties not listed.
            </Text>
            <TextInput
              className="mb-3 rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder="Search party (APC, PDP, LP…)"
              placeholderTextColor="#9db5a7"
              value={search}
              onChangeText={setSearch}
            />
            {filteredParties.slice(0, 30).map((p) => (
              <View key={p.code} className="mb-2 flex-row items-center rounded-2xl bg-card px-4 py-2">
                {logos[p.code] ? (
                  <Image
                    source={{ uri: `${BASE}/${logos[p.code]}` }}
                    style={{ width: 30, height: 30, borderRadius: 6, marginRight: 10 }}
                    contentFit="contain"
                    cachePolicy="disk"
                  />
                ) : (
                  <View
                    className="mr-2.5 items-center justify-center rounded-md bg-surface"
                    style={{ width: 30, height: 30 }}
                  >
                    <Text className="text-[10px] font-bold text-hawk-leaf">{p.code.slice(0, 3)}</Text>
                  </View>
                )}
                <View className="flex-1 pr-2">
                  <Text className="text-base font-semibold text-ink">{p.code}</Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>
                    {p.name}
                  </Text>
                </View>
                <TextInput
                  className="w-24 rounded-xl bg-surface px-3 py-2 text-center text-lg font-bold text-ink"
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

        {/* Pinned: the party list runs to 30 rows, so at the end of the scroll
            this sits far below whichever party was just typed into. */}
        {step === 'votes' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Pressable
              disabled={votes.length === 0}
              onPress={() => setStep('review')}
              className={`items-center rounded-2xl py-4 ${votes.length ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">Review report</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'review' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4">
            <Text className="pb-3 text-xl font-bold text-ink">Confirm and send</Text>
            <View className="mb-3 rounded-2xl bg-card px-4 py-3">
              <Text className="text-base font-semibold text-ink">
                {levelDef?.label} collation · {levelDef?.form}
              </Text>
              <Text className="text-xs text-muted">{scopeLine}</Text>
              {contest ? (
                <Text className="pt-0.5 text-xs font-semibold text-hawk-leaf">{contest.name}</Text>
              ) : null}
            </View>
            <View className="mb-3 flex-row gap-3">
              {[sheet, venue].map((s, i) =>
                s ? (
                  <Pressable
                    key={i}
                    disabled={busy}
                    className="flex-1 overflow-hidden rounded-2xl bg-card active:opacity-80"
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
                      <Text className="text-xs font-semibold text-muted">
                        {i === 0 ? 'Collation form' : 'Venue'}
                      </Text>
                      <Text className="text-xs font-bold text-hawk-leaf">Retake</Text>
                    </View>
                  </Pressable>
                ) : null,
              )}
            </View>
            <View className="mb-3 rounded-2xl bg-card px-4 py-2">
              {rankedVotes.map((v) => (
                <View key={v.party} className="flex-row justify-between py-1.5">
                  <Text className="text-base font-semibold text-ink">{v.party}</Text>
                  <Text className="text-base font-bold text-ink">
                    {v.count.toLocaleString()}
                  </Text>
                </View>
              ))}
            </View>
            {/* Optional form serial — parity with the PWA's collation field. */}
            <Prompt>Enter the form serial number (optional)</Prompt>
            <TextInput
              className="mb-3 rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder="Printed on the collation form, if visible"
              placeholderTextColor="#9db5a7"
              autoCapitalize="characters"
              value={formSerial}
              onChangeText={setFormSerial}
              editable={!busy}
            />
          </ScrollView>
        ) : null}

        {/* Pinned: the summary above grows with the vote list, and a failed
            submit ("No GPS fix…") is retried from here — the status line rides
            with the button so retrying never means scrolling back down. */}
        {step === 'review' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {/* Say when, not just no. The server refuses early reports anyway;
                finding that out after two photos and a full tally is the failure
                this replaces. */}
            {closed && contest ? (
              <Text className="pb-2 text-sm font-semibold text-amber-800">
                {opensLine(contest)} Nothing can be filed before then — your work stays here until
                you reopen this screen on election day.
              </Text>
            ) : null}
            {line ? (
              <Text className="pb-2 text-sm font-semibold text-amber-800">{line}</Text>
            ) : null}
            <Pressable
              disabled={busy || closed}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${busy || closed ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
            >
              {busy ? (
                <ActivityIndicator color={BRAND.gold} />
              ) : (
                <Text className="text-base font-bold text-hawk-gold">
                  {closed ? 'Reporting not open yet' : 'Sign & submit'}
                </Text>
              )}
            </Pressable>
            <Pressable
              className="mt-3 items-center"
              onPress={() => setStep('votes')}
              disabled={busy}
            >
              <Text className="text-sm font-semibold text-hawk-leaf">‹ Back to totals</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'done' ? (
          <ScrollView contentContainerClassName="px-6 pb-4 pt-8">
            <View className="items-center">
              <View
                className={`h-16 w-16 items-center justify-center rounded-full ${queued ? 'bg-amber-600' : 'bg-hawk-green'}`}
              >
                <Feather name={queued ? 'clock' : 'check'} size={28} color={BRAND.gold} />
              </View>
              <Text className="pt-4 text-center text-lg font-bold text-ink">{done.title}</Text>
              <Text className="pt-2 text-center text-sm text-muted">{done.line}</Text>
            </View>

            {/* THE RECEIPT. Until now the observer handed over evidence and got a
                sentence back. The entry hash is their copy of the record: it is
                what makes the ledger checkable by the person who filed it.
                Collations carry their own hash chain, so this is the only handle
                that finds this report again. */}
            {receipt.entryHash ? (
              <View className="mt-6 rounded-2xl bg-hawk-green px-4 py-4">
                <Text className="text-[11px] font-bold uppercase tracking-wider text-hawk-gold">
                  Ledger entry
                </Text>
                <Pressable
                  className="mt-2 flex-row items-center rounded-xl bg-card/10 px-3 py-2.5 active:opacity-70"
                  onPress={async () => {
                    await Clipboard.setStringAsync(receipt.entryHash!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Text className="flex-1 pr-2 font-mono text-[11px] text-emerald-100" numberOfLines={1}>
                    {receipt.entryHash}
                  </Text>
                  <Feather name={copied ? 'check' : 'copy'} size={15} color={BRAND.gold} />
                </Pressable>
                <Text className="pt-2 text-[11px] text-emerald-200/80">
                  {copied ? 'Copied.' : 'Tap to copy.'} This fingerprint is how you prove your report
                  is in the public ledger and has not been altered.
                </Text>
              </View>
            ) : null}

            {/* What was filed, in the observer's own figures. The collation route
                answers with the entry hash alone — no consensus or OCR block like
                a unit result — so the receipt states the record itself. */}
            <View className="mt-3 rounded-2xl bg-card px-4 py-2">
              <View className="flex-row items-center justify-between py-1.5">
                <Text className="text-sm text-muted">Status</Text>
                <Text
                  className={`text-sm font-bold ${queued ? 'text-amber-800' : receipt.entryHash ? 'text-hawk-leaf' : 'text-muted'}`}
                >
                  {queued ? 'WAITING TO SEND' : receipt.entryHash ? 'RECORDED' : 'NOT FILED'}
                </Text>
              </View>
              <View className="flex-row items-center justify-between py-1.5">
                <Text className="text-sm text-muted">Form</Text>
                <Text className="text-sm font-bold text-ink">
                  {levelDef?.form} · {levelDef?.label} collation
                </Text>
              </View>
              <View className="flex-row items-center justify-between py-1.5">
                <Text className="pr-3 text-sm text-muted">Scope</Text>
                <Text className="flex-1 text-right text-sm font-bold text-ink">{scopeLine}</Text>
              </View>
              {contest ? (
                <View className="flex-row items-center justify-between py-1.5">
                  <Text className="pr-3 text-sm text-muted">Election</Text>
                  <Text className="flex-1 text-right text-sm font-bold text-ink">
                    {contest.name}
                  </Text>
                </View>
              ) : null}
              <View className="mt-1 border-t border-line pt-2">
                <Text className="pb-1 text-[11px] font-bold uppercase tracking-wider text-faint">
                  Totals you reported
                </Text>
                {rankedVotes.map((v) => (
                  <View key={v.party} className="flex-row items-center justify-between py-1">
                    <Text className="text-sm font-semibold text-ink">{v.party}</Text>
                    <Text className="text-sm font-bold text-ink">
                      {v.count.toLocaleString()}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </ScrollView>
        ) : null}

        {step === 'done' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {/* Integrity, not the results log: a collation is cross-checked against
                the unit sheets underneath it, and that comparison is what surfaces
                publicly. replace, not push — the finished flow should not sit under
                the page the observer went to check. */}
            <Pressable className="items-center pb-3" onPress={() => router.replace('/integrity')}>
              <Text className="text-sm font-semibold text-hawk-leaf">
                {receipt.entryHash
                  ? 'See how collated figures are checked ›'
                  : 'See the integrity checks ›'}
              </Text>
            </Pressable>
            <Pressable
              className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
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

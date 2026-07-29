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
import { useAuth } from '@/lib/auth';
import { getQuickFix, getSubmitFix } from '@/lib/location';
import { submitResult, type Receipt, type Shot, type Vote } from '@/lib/submit';

const BASE = 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

type Unit = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  /** GPS discovery only (/api/polling-units) — absent on register rows. */
  distanceM?: number;
  locationTier?: string;
};

type Step = 'unit' | 'contest' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

const STEPS: { key: Step; label: string }[] = [
  { key: 'unit', label: 'Unit' },
  { key: 'contest', label: 'Race' },
  { key: 'sheet', label: 'Sheet' },
  { key: 'venue', label: 'Venue' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

/** Same wording as the public log and the PWA — one vocabulary for one fact. */
const TIER_LABEL: Record<string, string> = {
  verified: '📍 location verified',
  crowd: '◌ crowd-confirmed location',
  geocoded: '◌ located from map data (unconfirmed)',
  unmapped: '⚠ location not yet verified',
};

/**
 * Mirror of backend/src/services/scope.js (and app.js's contestApplies): the
 * polling unit decides which races exist there. The FCT has an appointed
 * minister — no governorship, no state assembly — and a single-state election
 * carries a `states` allowlist; absent or empty means nationwide.
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

/** The receipt's location line, in the same vocabulary as the public log. */
const receiptLocation = (r: Receipt) => {
  const status = r.result?.locationStatus ?? (r.locationVerified ? 'verified' : undefined);
  return status === 'verified'
    ? TIER_LABEL.verified
    : status === 'provisional'
      ? `${TIER_LABEL.crowd} (${r.result?.locationConfidence ?? 0}% agree)`
      : TIER_LABEL.unmapped;
};

/** Report a result — unit → race → sheet photo → venue photo → votes → signed submit. */
export default function ReportResult() {
  const auth = useAuth();
  const [step, setStep] = useState<Step>('unit');

  // -- step 1: which polling unit ------------------------------------------
  const [contests, setContests] = useState<Contest[]>([]);
  const [contest, setContest] = useState<Contest | null>(null);
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unit, setUnit] = useState<Unit | null>(null);

  // GPS discovery — the way an observer standing at their unit should find it.
  const [nearby, setNearby] = useState<Unit[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  /** The register drill-down is the fallback, so it starts folded away. */
  const [browse, setBrowse] = useState(false);

  useEffect(() => {
    // Every state is listed, not just the active contest's. Hiding the rest
    // of the country made the app look broken outside Osun; an observer should
    // be told "no election here yet", not shown an empty world.
    api.contests().then(setContests).catch(() => {});
    fetch(`${REG}/states`)
      .then((r) => r.json())
      .then(setStates)
      .catch(() => {});
  }, []);

  // No contest filter on the register drill: the server ignores the parameter
  // (pollingUnits.js selects on state/lga/ward alone), and passing it meant the
  // whole picker sat dead until /api/contests resolved. The race is chosen from
  // the unit further down, which is the direction the scope rule runs anyway.
  useEffect(() => {
    if (!stateSel) return;
    fetch(`${REG}/lgas?state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json()).then(setLgas).catch(() => {});
  }, [stateSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel) return;
    fetch(`${REG}/wards?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`)
      .then((r) => r.json()).then(setWards).catch(() => {});
  }, [stateSel, lgaSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel || !wardSel) return;
    fetch(`${REG}/units?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}&ward=${encodeURIComponent(wardSel)}`)
      .then((r) => r.json()).then((d) => setUnits(d.units ?? [])).catch(() => {});
  }, [stateSel, lgaSel, wardSel]);

  /**
   * Moving in the drill clears everything below it, including the chosen unit.
   * Two failures otherwise: the pinned Continue stays live for a unit that is no
   * longer on screen, and a stage the observer backed out of keeps rendering its
   * old list underneath the one they went back to.
   */
  const pickState = (s: string | null) => {
    setStateSel(s);
    setLgaSel(null);
    setWardSel(null);
    setUnits([]);
    setUnit(null);
  };
  const pickLga = (l: string | null) => {
    setLgaSel(l);
    setWardSel(null);
    setUnits([]);
    setUnit(null);
  };
  const pickWard = (w: string | null) => {
    setWardSel(w);
    setUnits([]);
    setUnit(null);
  };

  /** Is any race running in the chosen state? Drives the
   *  "no active election here" answer instead of hiding the state. */
  const covered = !!stateSel && racesIn(stateSel, contests).length > 0;

  /** The races that exist at the chosen unit — the contest step's whole content. */
  const applicable = useMemo(
    () => (unit ? racesIn(unit.state, contests) : []),
    [unit, contests],
  );

  /** The race step is real only when there is a choice to make. */
  const steps = useMemo(
    () => STEPS.filter((s) => s.key !== 'contest' || applicable.length > 1),
    [applicable.length],
  );

  const findNearby = async () => {
    setNearBusy(true);
    setNearby([]);
    setNearLine('Getting your location…');
    try {
      // Quick fix, not the submit-grade one: this is discovery, and the 200m
      // geofence does not need metre accuracy to shortlist eight units.
      const fix = await getQuickFix();
      if (!fix) {
        setNearLine('Location is off or not permitted — turn it on and retry, or browse the register below. (no GPS fix)');
        setBrowse(true);
        return;
      }
      setNearLine(`Location fixed (±${Math.round(fix.accuracy)}m). Looking up nearby units…`);
      const res = await fetch(`${BASE}/api/polling-units?lat=${fix.lat}&lng=${fix.lng}`);
      const body = (await res.json().catch(() => ({}))) as {
        radiusM?: number;
        units?: Unit[];
        error?: string;
      };
      if (!res.ok) {
        setNearLine(`Could not look up nearby units — browse the register below. (${body.error ?? 'lookup_failed'} / HTTP ${res.status})`);
        setBrowse(true);
        return;
      }
      const found = body.units ?? [];
      setNearby(found);
      if (found.length === 0) {
        setNearLine(`No located polling unit within ${body.radiusM ?? 200}m of you — browse the register below.`);
        setBrowse(true);
        return;
      }
      setNearLine('Tap the unit you are standing at:');
    } catch (e) {
      setNearLine(`Could not look up nearby units — browse the register below. (${e instanceof Error ? e.message : String(e)})`);
      setBrowse(true);
    } finally {
      setNearBusy(false);
    }
  };

  /** Selecting a unit pre-picks its race when there is only one. */
  const chooseUnit = (u: Unit) => {
    setUnit(u);
    const races = racesIn(u.state, contests);
    setContest(races.length === 1 ? races[0] : null);
  };

  /**
   * The unit determines the race, so the contest step is built here rather than
   * up front — and skipped entirely when the unit has exactly one race, which is
   * every unit outside the FCT during a single-race election.
   */
  const continueFromUnit = () => {
    if (!unit) return;
    if (contests.length === 0) {
      Alert.alert(
        'Election list not loaded',
        'Hawkeye could not load which elections are running — check your connection and reopen this screen. (no /api/contests response)',
      );
      return;
    }
    const races = racesIn(unit.state, contests);
    if (races.length === 0) {
      Alert.alert(
        `No active election in ${unit.state}`,
        `Hawkeye is covering the ${contests[0].election}. Nothing is open for reporting at ${unit.name} yet — but you can still map polling units anywhere in Nigeria.`,
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

  // -- steps 3/4: photos ----------------------------------------------------
  const [sheet, setSheet] = useState<Shot | null>(null);
  /** Party codes the on-device read proposed, so the UI can say which
   *  figures came off the sheet rather than from the observer. */
  const [readCodes, setReadCodes] = useState<string[]>([]);
  const [venue, setVenue] = useState<Shot | null>(null);
  /** True while re-shooting a single photo from the review step. */
  const [retaking, setRetaking] = useState(false);

  // -- step 5: votes --------------------------------------------------------
  const [parties, setParties] = useState<Party[]>([]);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');

  useEffect(() => {
    if ((step === 'votes' || step === 'sheet') && parties.length === 0) {
      api.parties().then(setParties).catch(() => {});
      // Official INEC emblems (same manifest the web app uses) — several party
      // names read alike; the emblem is how observers actually recognise them.
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

  // -- step 6: review + submit ---------------------------------------------
  /** Optional EC8A serial, mirroring the PWA's #sheet-serial field. */
  const [sheetSerial, setSheetSerial] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; line: string }>({ title: '', line: '' });
  const [receipt, setReceipt] = useState<Receipt>({});
  /** Held in the offline outbox rather than delivered — a different ending. */
  const [queued, setQueued] = useState(false);
  const [copied, setCopied] = useState(false);

  /** Nothing can be filed before poll-open; the server enforces it either way. */
  const closed = contest?.open === false;

  const onSubmit = async () => {
    if (!unit || !contest || !sheet || !venue || closed) return;
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
        sheetSerial: sheetSerial.trim() || undefined,
      });
      if (r.ok) {
        setReceipt(r);
        setQueued(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Report filed',
          line: 'It is now queued for review and will appear on the public log.',
        });
        setStep('done');
      } else if (r.queued) {
        // Say what actually happened. "Report filed" over a report still sitting
        // in the outbox is the one lie this app cannot tell — so this ending has
        // its own icon, its own words, and no entry hash to show, because there
        // is no ledger entry yet.
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
      setLine(`Something went wrong — nothing was sent. Retry. (${e instanceof Error ? e.message : String(e)})`);
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
        readDocument={isSheet}
        partyCodes={parties.map((p) => p.code)}
        onCapture={(shot) => {
          if (isSheet) {
            setSheet(shot);
            // Propose what the sheet said; never overwrite anything already
            // typed, and leave every field editable.
            const proposed = shot.read?.counts ?? {};
            const codes = Object.keys(proposed);
            if (codes.length) {
              setCounts((c) => {
                const next = { ...c };
                for (const [code, n] of Object.entries(proposed)) {
                  if (!next[code]) next[code] = String(n);
                }
                return next;
              });
              setReadCodes(codes);
            }
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
            setStep(applicable.length > 1 ? 'contest' : 'unit');
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
      className={`mb-2 mr-2 rounded-full px-4 py-2 ${on ? 'bg-hawk-green' : 'bg-white'}`}
    >
      <Text className={`text-sm font-semibold ${on ? 'text-hawk-gold' : 'text-neutral-700'}`}>
        {label}
      </Text>
    </Pressable>
  );

  /** One row shape for both discovery paths — the sub-line carries the difference. */
  const UnitRow = ({ u, sub }: { u: Unit; sub: string }) => {
    const on = unit?.pu_code === u.pu_code;
    return (
      <Pressable
        className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-white'}`}
        onPress={() => chooseUnit(u)}
      >
        <View className="flex-1 pr-2">
          <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-hawk-ink'}`}>
            {u.name}
          </Text>
          <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-neutral-500'}`}>{sub}</Text>
        </View>
        {/* Inline Continue on the chosen row: in a long ward the footer CTA can
            sit far below the unit you just tapped. */}
        {on ? (
          <Pressable
            className="flex-row items-center rounded-xl bg-hawk-gold px-3 py-2 active:opacity-80"
            onPress={continueFromUnit}
          >
            <Text className="pr-1 text-sm font-bold text-hawk-ink">Continue</Text>
            <Feather name="arrow-right" size={14} color={BRAND.ink} />
          </Pressable>
        ) : null}
      </Pressable>
    );
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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Report a result</Text>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {steps.map((s, i) => {
            const idx = steps.findIndex((x) => x.key === step);
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
              {contests.length ? contests[0].election : 'Loading election…'}
            </Text>
            <Text className="pb-3 text-sm text-neutral-600">
              Report from the unit you are standing at.
            </Text>

            {/* GPS FIRST. An observer at their unit knows where they are, not
                their ward's spelling in the register — the drill-down is the
                fallback for units without coordinates, exactly as on the web. */}
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
                  <UnitRow
                    key={u.pu_code}
                    u={u}
                    sub={`${u.pu_code} · ${u.ward}, ${u.lga} · ${u.distanceM}m away · ${
                      TIER_LABEL[u.locationTier ?? 'unmapped'] ?? TIER_LABEL.unmapped
                    }${
                      // Only once the contest list is in — before that, "no
                      // election here" would be the loading state talking.
                      contests.length && racesIn(u.state, contests).length === 0
                        ? ' · no election here yet'
                        : ''
                    }`}
                  />
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
                    <Prompt>Select your state</Prompt>
                    <View className="flex-row flex-wrap">{states.map((s) => <Chip key={s} label={s} onPress={() => pickState(s)} />)}</View>
                  </>
                ) : null}

                {stateSel && !covered ? (
                  <>
                    <Crumb label={stateSel} onPress={() => pickState(null)} />
                    <NoElection state={stateSel} contest={contests[0] ?? null} />
                  </>
                ) : null}

                {stateSel && covered && !lgaSel ? (
                  <>
                    <Crumb label={stateSel} onPress={() => pickState(null)} />
                    <Prompt>Select your LGA</Prompt>
                    <View className="flex-row flex-wrap">{lgas.map((l) => <Chip key={l} label={l} onPress={() => pickLga(l)} />)}</View>
                  </>
                ) : null}

                {stateSel && covered && lgaSel && !wardSel ? (
                  <>
                    <Crumb label={lgaSel} onPress={() => pickLga(null)} />
                    <Prompt>Select your ward</Prompt>
                    <View className="flex-row flex-wrap">{wards.map((w) => <Chip key={w} label={w} onPress={() => pickWard(w)} />)}</View>
                  </>
                ) : null}

                {stateSel && covered && wardSel ? (
                  <>
                    <Crumb label={`${lgaSel} · ${wardSel}`} onPress={() => pickWard(null)} />
                    <Prompt>Select your polling unit</Prompt>
                    {units.map((u) => (
                      <UnitRow key={u.pu_code} u={u} sub={`${u.pu_code} · ${u.ward}, ${u.lga}`} />
                    ))}
                    {units.length === 0 ? (
                      <Text className="pt-2 text-sm text-neutral-500">No units in the register for this ward yet.</Text>
                    ) : null}
                  </>
                ) : null}
              </View>
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
              onPress={continueFromUnit}
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
            {unit ? <Crumb label={unit.name} onPress={() => setStep('unit')} /> : null}
            <Prompt>Which election are you reporting?</Prompt>
            <Text className="pb-3 text-sm text-neutral-600">
              Only the races that run at this polling unit are listed. Report each one separately.
            </Text>
            {applicable.map((c) => {
              const on = contest?.code === c.code;
              return (
                <Pressable
                  key={c.code}
                  onPress={() => setContest(c)}
                  className={`mb-2 rounded-2xl px-4 py-3 ${on ? 'bg-hawk-green' : 'bg-white'}`}
                >
                  <Text className={`text-base font-semibold ${on ? 'text-white' : 'text-hawk-ink'}`}>
                    {c.name}
                  </Text>
                  <Text className={`text-xs ${on ? 'text-emerald-100' : 'text-neutral-500'}`}>
                    {c.election}
                  </Text>
                  {c.open === false ? (
                    <Text className={`pt-1 text-xs font-semibold ${on ? 'text-hawk-gold' : 'text-amber-800'}`}>
                      {opensLine(c)}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {step === 'contest' ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            {closed && contest ? (
              <Text className="pb-2 text-sm font-semibold text-amber-800">{opensLine(contest)}</Text>
            ) : null}
            <Pressable
              disabled={!contest}
              onPress={() => setStep('sheet')}
              className={`items-center rounded-2xl py-4 ${contest ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">Continue to photos</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'votes' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
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
                    source={{ uri: `${BASE}/${logos[p.code]}` }}
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
                {readCodes.includes(p.code) ? (
                  <View className="mr-2 rounded-full bg-hawk-mist px-2 py-0.5">
                    <Text className="text-[9px] font-bold text-hawk-leaf">FROM SHEET</Text>
                  </View>
                ) : null}
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
          </ScrollView>
        ) : null}

        {/* Pinned CTA — up to 30 party rows scroll above this, so the way out of
            the tally must not sit below the last figure the observer typed. */}
        {step === 'votes' ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            <Pressable
              disabled={votes.length === 0}
              onPress={() => setStep('review')}
              className={`items-center rounded-2xl py-4 ${votes.length ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">Review report</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'review' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4">
            <Text className="pb-3 text-xl font-bold text-hawk-ink">Confirm and send</Text>
            <View className="mb-3 rounded-2xl bg-white px-4 py-3">
              <Text className="text-base font-semibold text-hawk-ink">{unit?.name}</Text>
              <Text className="text-xs text-neutral-500">{unit?.pu_code} · {unit?.ward}, {unit?.lga}</Text>
              {contest ? (
                <Text className="pt-1 text-xs font-bold text-hawk-leaf">
                  {contest.name} — {contest.election}
                </Text>
              ) : null}
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
            {/* Optional serial — parity with the PWA's #sheet-serial input.
                Sits immediately above the submit CTA so it cannot be missed. */}
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
              Submitting takes a GPS fix at your position, signs the report with this device’s
              key, and files it for review. Your number is never attached — only your observer ID.
            </Text>
          </ScrollView>
        ) : null}

        {/* Pinned CTA — the summary above grows a row per party, and the status
            line rides with the button: on a failed submit the retry must stay
            under the observer's thumb, not be pushed further down the scroll. */}
        {step === 'review' ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            {/* Say when, not just no. The server refuses early reports anyway;
                finding that out after two photos and a full tally is the failure
                this replaces. */}
            {closed && contest ? (
              <Text className="pb-2 text-sm font-semibold text-amber-800">
                {opensLine(contest)} Nothing can be filed before then — your work stays here until you
                reopen this screen on election day.
              </Text>
            ) : null}
            {line ? <Text className="pb-2 text-sm font-semibold text-amber-800">{line}</Text> : null}
            <Pressable
              disabled={busy || closed}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${busy || closed ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'}`}
            >
              {busy ? <ActivityIndicator color={BRAND.gold} /> : (
                <Text className="text-base font-bold text-hawk-gold">
                  {closed ? 'Reporting not open yet' : 'Sign & submit'}
                </Text>
              )}
            </Pressable>
            <Pressable className="mt-3 items-center" onPress={() => setStep('votes')} disabled={busy}>
              <Text className="text-sm font-semibold text-hawk-leaf">‹ Back to votes</Text>
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
              <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">{done.title}</Text>
              <Text className="pt-2 text-center text-sm text-neutral-600">{done.line}</Text>
            </View>

            {/* THE RECEIPT. Until now the observer handed over evidence and got a
                sentence back. The entry hash is their copy of the record: it is
                what makes the ledger checkable by the person who filed it. */}
            {receipt.entryHash ? (
              <View className="mt-6 rounded-2xl bg-hawk-green px-4 py-4">
                <Text className="text-[11px] font-bold uppercase tracking-wider text-hawk-gold">
                  Ledger entry
                </Text>
                <Pressable
                  className="mt-2 flex-row items-center rounded-xl bg-white/10 px-3 py-2.5 active:opacity-70"
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

            {receipt.result || receipt.locationVerified != null || receipt.ocr ? (
              <View className="mt-3 rounded-2xl bg-white px-4 py-2">
                {receipt.result?.status ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-neutral-500">Status</Text>
                    <Text
                      className={`text-sm font-bold ${receipt.result.status === 'disputed' ? 'text-red-700' : receipt.result.status === 'pending' ? 'text-amber-800' : 'text-hawk-leaf'}`}
                    >
                      {receipt.result.status.toUpperCase()}
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.confidence != null ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-neutral-500">Confidence</Text>
                    <Text className="text-sm font-bold text-hawk-ink">
                      {receipt.result.confidence}%
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.totalReports != null ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-neutral-500">Reports agreeing</Text>
                    <Text className="text-sm font-bold text-hawk-ink">
                      {receipt.result.matchingReports ?? 0} of {receipt.result.totalReports}
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.locationStatus || receipt.locationVerified != null ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="pr-3 text-sm text-neutral-500">Location</Text>
                    <Text className="flex-1 text-right text-sm font-bold text-hawk-ink">
                      {receiptLocation(receipt)}
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.venueMatches ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-neutral-500">Venue photo matches</Text>
                    <Text className="text-sm font-bold text-hawk-ink">
                      {receipt.result.venueMatches}
                    </Text>
                  </View>
                ) : null}
                {/* What the phone read off the sheet versus what was typed —
                    the observer should see the machine's second opinion too. */}
                {receipt.ocr?.total ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="pr-3 text-sm text-neutral-500">Read off your photo</Text>
                    <Text className="text-sm font-bold text-hawk-ink">
                      {receipt.ocr.matched} of {receipt.ocr.total} counts matched
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.scope ? (
                  <Text className="py-1.5 text-xs text-neutral-500">{receipt.result.scope}</Text>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        ) : null}

        {step === 'done' ? (
          <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
            {/* replace, not push: the finished report flow should not sit under
                the log the observer went to check. */}
            <Pressable className="items-center pb-3" onPress={() => router.replace('/reports-log')}>
              <Text className="text-sm font-semibold text-hawk-leaf">
                {queued ? 'See the public log ›' : 'Find your report in the public log ›'}
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

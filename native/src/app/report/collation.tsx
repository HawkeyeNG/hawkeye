import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SafeScreen } from '@/components/safe-screen';
import { CaptureCamera } from '@/components/capture-camera';
import { ContestPicker } from '@/components/contest-picker';
import { NoElection } from '@/components/no-election';
import { useNotice, NoticeSheet } from '@/components/notice-sheet';
import { RekorAnchor } from '@/components/rekor-anchor';
import { Crumb, Prompt } from '@/components/wizard';
import { api, BRAND, type Contest, opensLine, type Party } from '@/lib/api';
import { pick, tap } from '@/lib/haptics';
import type { Race, StateName } from '@/lib/races';
import { useUi } from '@/lib/theme';
import { useAuth } from '@/lib/auth';
import { describeFixFailure, trySubmitFix } from '@/lib/location';
import { submitCollation, type CollationLevel, type Receipt, type Shot, type Vote } from '@/lib/submit';
import { regFetch } from '@/lib/register-fetch';
import { humanError } from '@/lib/errors';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

type Step = 'scope' | 'contest' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

// CAPTURE FIRST — same reasoning as result.tsx, and the same reason it is safe:
// the collation form (EC8B/C/D) is on display for a limited window, while the
// scope, the race and the figures keep. Step order does not touch the signature,
// which is one sign over the whole payload at submit.
// See docs/REPORT-FLOW-CAPTURE-FIRST.md.
const STEPS: { key: Step; label: string }[] = [
  { key: 'sheet', label: 'Form' },
  { key: 'venue', label: 'Venue' },
  { key: 'scope', label: 'Scope' },
  { key: 'contest', label: 'Race' },
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
  const notice = useNotice();
  // Opens straight into the camera: 'sheet' and 'venue' ARE the capture screen.
  const [step, setStep] = useState<Step>('sheet');

  // -- scope ---------------------------------------------------------------
  const [contests, setContests] = useState<Contest[]>([]);
  // `race` is the ContestPicker's controlled selection (a full 2027-catalogue
  // Race); `contest` is the matched /api/contests row derived from it, which is
  // what the submit + review + receipt read (its .code, .name, .open).
  const [contest, setContest] = useState<Contest | null>(null);
  const [race, setRace] = useState<Race | null>(null);
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
    regFetch(`${REG}/states`)
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
    regFetch(`${REG}/lgas?state=${encodeURIComponent(stateSel)}`)
      .then((r) => r.json())
      .then(setLgas)
      .catch(() => {});
  }, [stateSel]);

  useEffect(() => {
    if (!stateSel || !lgaSel) return;
    regFetch(`${REG}/wards?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`)
      .then((r) => r.json())
      .then(setWards)
      .catch(() => {});
  }, [stateSel, lgaSel]);

  /** Is any race running in the chosen state? Drives the
   *  "no active election here" answer instead of hiding the state. */
  const covered = !!stateSel && racesIn(stateSel, contests).length > 0;

  /** The contests that exist in the chosen state — used to derive the matched
   *  Contest from a picked Race, and to word the informational opens-on line. */
  const applicable = useMemo(
    () => (stateSel ? racesIn(stateSel, contests) : []),
    [stateSel, contests],
  );

  /**
   * The informational opens-on line for the contest step.
   *
   * Closed races are unselectable in the picker (which tags each with its own
   * "Opens …"), so this fires only when NOTHING is open for this scope yet — the
   * case where the observer reaches the race step with no selectable race and
   * the useful thing to tell them is when reporting opens. No practice-run
   * framing: the flow can no longer reach a rehearsal from here.
   */
  const opensInfo = useMemo(() => {
    if (applicable.length === 0 || applicable.some((c) => c.open)) return null;
    return applicable.find((c) => c.opensAt) ?? applicable[0];
  }, [applicable]);

  /** Every step is real now: closed races are unselectable rather than
   *  auto-picked, so the race step always renders (no single-race skip). */
  const steps = STEPS;

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
   * The state determines which races run there, so the race step comes AFTER the
   * scope: by the time it renders the state is always chosen, and the picker is
   * handed it as `lockedState` so it only has to ask type → race. The step always
   * renders now — a lone race may be closed (unselectable), so it can no longer
   * be auto-picked into the camera.
   */
  const continueFromScope = () => {
    tap();
    if (!stateSel) return;
    if (contests.length === 0) {
      notice.show(
        'Election list not loaded',
        'Hawkeye could not load which elections are running — check your connection and reopen this screen. (no /api/contests response)',
      );
      return;
    }
    const races = racesIn(stateSel, contests);
    if (races.length === 0) {
      notice.show(
        `No active election in ${stateSel}`,
        `Hawkeye is covering the ${contests[0].election}. No collation is open for reporting in ${stateSel} yet — but you can still map polling units anywhere in Nigeria.`,
      );
      return;
    }
    setStep('contest');
  };

  /**
   * Choosing a state drops any race chosen under the previous state: the contest
   * is derived from the scope, so it must never outlive it. Backing out to a
   * different state otherwise left a stale selection for a contest that does not
   * run where the observer is now reporting from.
   */
  const chooseState = (s: string | null) => {
    pick();
    setStateSel(s);
    setContest(null);
    setRace(null);
  };

  /**
   * The picker returns a full-catalogue Race; the rest of the screen speaks in
   * /api/contests rows, so match it back to one (open, by construction — the
   * picker's allowClosed is false) and advance to the figures. The photos are
   * already taken by this point — capture leads, attribution follows.
   */
  const chooseRace = (r: Race) => {
    pick();
    setRace(r);
    setContest(stateSel ? (racesIn(stateSel, contests).find((c) => c.code === r.contestCode) ?? null) : null);
    setStep('votes');
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
  /** Set only when the last GPS failure is one the OS settings app has to fix
   *  (location switched off, or permission blocked with no dialog left to
   *  show). A timeout must never raise it — permission is granted in that case,
   *  and marching someone into their settings over a weak signal is the wild
   *  goose chase the old one-size-fits-all message sent them on. */
  const [gpsSettings, setGpsSettings] = useState(false);
  const [done, setDone] = useState({ title: '', line: '' });
  const [receipt, setReceipt] = useState<Receipt>({});
  /** Held in the offline outbox rather than delivered — a different ending. */
  const [queued, setQueued] = useState(false);
  const [copied, setCopied] = useState(false);

  const onSubmit = async () => {
    tap();
    if (!contest || !level || !stateSel || !sheet || !venue) return;
    setBusy(true);
    setGpsSettings(false);
    setLine('Getting your location…');
    try {
      // DISCRIMINATED failure, named. A collation centre is an indoor room —
      // a hall, a party secretariat, an INEC office — which is precisely where
      // a perfectly granted permission still takes a slow satellite lock, and
      // the old sentence ("location must be on") told those observers their
      // location was off. There is no geofence on a collation: nothing here
      // checks WHERE the observer stands, the fix is only the stamp signed
      // into the record. So the copy names the real obstacle and never implies
      // a placement rule this form does not have.
      const got = await trySubmitFix();
      if (!got.ok) {
        const d = describeFixFailure(got);
        setLine(`${d.lead}. Nothing was sent — your figures and photos are still here. (${d.code})`);
        setGpsSettings(d.settings);
        setBusy(false);
        return;
      }
      const fix = got.fix;
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
          title: 'Collation Filed',
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
          title: 'Saved on This Phone',
          line: 'Already signed. It sends itself once you have signal.',
        });
        setStep('done');
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setLine(r.message);
      }
    } catch (e) {
      setLine(
        humanError(e, 'Something went wrong — nothing was sent. Retry.'),
      );
    } finally {
      setBusy(false);
    }
  };

  // -- guards ---------------------------------------------------------------
  if (auth.status !== 'signedIn') {
    return (
      <SafeScreen className="flex-1 items-center justify-center bg-surface px-8">
        <Feather name="lock" size={28} color={ui.tint.good.ink} />
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
      </SafeScreen>
    );
  }

  if (step === 'sheet' || step === 'venue') {
    const isSheet = step === 'sheet';
    return (
      <CaptureCamera
        key={step}
        title={isSheet ? 'Photo 1 of 2 — the collation form' : 'Photo 2 of 2 — the centre'}
        frameGuide={isSheet}
        venueGuide={isSheet ? undefined : '📸 VENUE PHOTO — aim at the collation centre itself: the building, the room or the officials. This is NOT the collation form.'}
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
            // Evidence is safe from here — scope and race follow, away from the room.
            setStep(retaking ? 'review' : 'scope');
          }
          setRetaking(false);
        }}
        onCancel={() => {
          if (retaking) {
            setRetaking(false);
            setStep('review');
          } else if (isSheet) {
            // The form is the FIRST step now, so there is no earlier screen to
            // fall back to — backing out of the camera leaves the report.
            router.back();
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
    <SafeScreen className="flex-1 bg-surface">
      <View className="flex-row items-center px-4 pt-2">
        {/* Hawkeye mark (tap → Home), matching the shared ScreenHeader
            convention; the rest of this bar is bespoke to the wizard. */}
        <Pressable
          onPress={() => router.navigate('/(tabs)' as never)}
          hitSlop={8}
          className="mr-1.5"
          accessibilityRole="button"
          accessibilityLabel="Home"
        >
          <Image
            source={require('@/assets/images/icon.png')}
            style={{ width: 30, height: 30, borderRadius: 8 }}
          />
        </Pressable>
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-card"
        >
          <Feather name="x" size={18} color={ui.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-ink">Report a Collation</Text>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {steps.map((s, i) => {
            const idx = steps.findIndex((x) => x.key === step);
            const on = i <= idx;
            return (
              <View key={s.key} className="mr-1 flex-1">
                {/* good-ink, not hawk-leaf: #0b6b3a on the dark surface is a
                    2.5:1 bar nobody can see it move. */}
                <View className={`h-1.5 rounded-full ${on ? 'bg-good-ink' : 'bg-card'}`} />
                <Text
                  className={`pt-1 text-center text-[10px] font-semibold ${on ? 'text-good-ink' : 'text-faint'}`}
                >
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        className="flex-1"
      >
        {step === 'scope' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
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
              <Text className="text-base font-bold text-hawk-gold">Continue — choose the race</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'contest' && stateSel ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
            <Crumb label={scopeLine} onPress={() => setStep('scope')} />
            <Text className="pb-3 text-sm text-muted">
              A collation centre announces every race on the same day. Choose the one you are
              reporting — only races open for reporting can be selected.
            </Text>
            {/* Informational opens-on line: shown only when nothing is open for
                this scope yet, so the observer who cannot select anything is at
                least told when reporting begins. No practice-run framing — a
                closed race can no longer be walked through from here. */}
            {opensInfo ? (
              <Text className="pb-3 text-sm font-semibold text-warn-ink">{opensLine(opensInfo)}</Text>
            ) : null}
            {/* The shared type → race selector, locked to the scope's state.
                allowClosed=false: closed races are visible but unselectable, and
                picking an open one advances straight to the camera. */}
            <ContestPicker
              contests={contests}
              value={race}
              onSelect={chooseRace}
              lockedState={stateSel as StateName}
              allowClosed={false}
            />
          </ScrollView>
        ) : null}

        {step === 'votes' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
            <Text className="pb-1 text-xl font-bold text-ink">Collated Totals</Text>
            <Text className="pb-3 text-sm text-muted">
              Copy the figures exactly as announced. Leave blank for parties not listed.
            </Text>
            <TextInput
              className="mb-3 rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder="Search party (APC, PDP, LP…)"
              placeholderTextColor={ui.faint}
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
                    <Text className="text-[10px] font-bold text-good-ink">{p.code.slice(0, 3)}</Text>
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
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
            <Text className="pb-3 text-xl font-bold text-ink">Confirm and Send</Text>
            <View className="mb-3 rounded-2xl bg-card px-4 py-3">
              <Text className="text-base font-semibold text-ink">
                {levelDef?.label} collation · {levelDef?.form}
              </Text>
              <Text className="text-xs text-muted">{scopeLine}</Text>
              {contest ? (
                <Text className="pt-0.5 text-xs font-semibold text-good-ink">{contest.name}</Text>
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
                      <Text className="text-xs font-bold text-good-ink">Retake</Text>
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
              placeholderTextColor={ui.faint}
              autoCapitalize="characters"
              value={formSerial}
              onChangeText={setFormSerial}
              editable={!busy}
            />
          </ScrollView>
        ) : null}

        {/* Pinned: the summary above grows with the vote list, and a failed
            submit (a named location failure, a rejected send) is retried from
            here — the status line rides with the button so retrying never
            means scrolling back down. */}
        {step === 'review' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {line ? (
              <Text className="pb-2 text-sm font-semibold text-warn-ink">{line}</Text>
            ) : null}

            {/* Only for the two failures the settings app is actually the cure
                for — location switched off, or a permanently blocked
                permission. "Sign & submit" directly below IS the retry, so a
                weak-signal timeout gets the honest sentence and another tap,
                never a detour into settings that were never wrong. */}
            {gpsSettings ? (
              <Pressable
                disabled={busy}
                onPress={() => Linking.openSettings()}
                className="mb-3 flex-row items-center self-start rounded-xl border border-line px-3 py-2 active:opacity-70"
              >
                <Feather name="settings" size={14} color={ui.muted} />
                <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
              </Pressable>
            ) : null}

            <Pressable
              disabled={busy}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
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
              <Text className="text-sm font-semibold text-good-ink">‹ Back to totals</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'done' ? (
          <ScrollView contentContainerClassName="px-6 pb-4 pt-8">
            <View className="items-center">
              {/* The waiting ending gets the warn tint + its own ink: gold on
                  amber-600 was ~1.8:1, and the tint follows the theme so the
                  disc darkens instead of staying a pale chip on a dark screen.
                  The green check means "this is on the ledger" and only the filed
                  report may wear it; a queued one is still waiting. */}
              <View
                className={`h-16 w-16 items-center justify-center rounded-full ${queued ? 'bg-warn' : 'bg-hawk-green'}`}
              >
                <Feather
                  name={queued ? 'clock' : 'check'}
                  size={28}
                  color={queued ? ui.tint.warn.ink : BRAND.gold}
                />
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
                {/* Fixed white scrim: the card underneath is the fixed brand
                    green, so bg-card/10 went dark-on-dark with the theme. */}
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

            {/* The independent half of that claim. Collations carry their own
                chain, and its head rides in the same daily Rekor artifact as the
                unit ledger (collationHead in services/anchor.js) — so this links
                to the same public log, once an anchor covering this entry
                exists. Before that it says so plainly rather than linking. */}
            {receipt.entryHash ? (
              <RekorAnchor entryHash={receipt.entryHash} chain="collation" />
            ) : null}

            {/* What was filed, in the observer's own figures. The collation route
                answers with the entry hash alone — no consensus or OCR block like
                a unit result — so the receipt states the record itself. */}
            <View className="mt-3 rounded-2xl bg-card px-4 py-2">
              <View className="flex-row items-center justify-between py-1.5">
                <Text className="text-sm text-muted">Status</Text>
                <Text
                  className={`text-sm font-bold ${queued ? 'text-warn-ink' : receipt.entryHash ? 'text-good-ink' : 'text-muted'}`}
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
                  {/* The ELECTION, not the contest's short name. This row was
                      labelled "Election" and printed "Governorship" — the tier,
                      which does not say which one or which year. `election` is
                      the full "2027 Governorship Election", and it is what the
                      result wizard's review card names too, so the two receipts
                      agree about what was filed. */}
                  <Text className="flex-1 text-right text-sm font-bold text-ink">
                    {contest.election || contest.name}
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
              <Text className="text-sm font-semibold text-good-ink">
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

      <NoticeSheet {...notice.props} />
    </SafeScreen>
  );
}

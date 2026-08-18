import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
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
import { ContestPicker } from '@/components/contest-picker';
import { RekorAnchor } from '@/components/rekor-anchor';
import {
  envelopeText,
  mapAvailable,
  RegisterTierBadge,
  toTier,
  TIER_COLOR,
  TIER_LABEL,
  UnitMap,
  type MapEnvelope,
  type MapUnit,
  type UnitTier,
} from '@/components/unit-map';
import { Crumb, Prompt } from '@/components/wizard';
import { UnitSearch } from '@/components/unit-search';
import { api, BRAND, type Contest } from '@/lib/api';
import { getIdentity } from '@/lib/identity';
import { describeFixFailure, DISCOVERY_RADIUS_M, tryQuickFix, type Fix } from '@/lib/location';
import { STATES, type Race, type StateName } from '@/lib/races';
import { useUi } from '@/lib/theme';
import { regFetch } from '@/lib/register-fetch';

const BASE = 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

type PracticeConfig = {
  active: boolean;
  name?: string;
  office?: string;
  note?: string;
  unit?: { code: string; name: string; ward: string; lga: string; state: string };
  parties?: { code: string; color: string }[];
};

/**
 * GENERIC / FAKE parties for practice — never the real INEC manifest, so a
 * rehearsal can never be mistaken for a real result. The backend already serves
 * neutral "Party A/B/C/D" placeholders (data/practice.json); this local set is
 * the fallback if the config ever arrives without them, so the votes step always
 * has clearly-labelled practice parties to enter.
 */
const PRACTICE_PARTIES: { code: string; color: string }[] = [
  { code: 'Party A', color: '#2e7d32' },
  { code: 'Party B', color: '#1565c0' },
  { code: 'Party C', color: '#c62828' },
  { code: 'Party D', color: '#f9a825' },
];

type Step = 'unit' | 'contest' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

/** A register row — every field the rest of the flow reads off the selection. */
type Unit = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  // Tier fields ride along (the API SELECT *s the register row) so browse rows
  // can carry the same location badge the nearby rows and the web show.
  coords_source?: string | null;
  locationTier?: string;
  lat?: number | null;
  crowd_lat?: number | null;
};

/** /api/polling-units row (whole register row, so it can name the state). */
type LocatedRow = Unit & {
  lat?: number | null;
  lng?: number | null;
  crowd_lat?: number | null;
  crowd_lng?: number | null;
  approx_radius_m?: number | null;
  approx_lat?: number | null;
  approx_lng?: number | null;
  coords_source?: string | null;
  crowd_reports?: number | null;
  locationTier?: string;
  distanceM?: number;
};

/** /api/mapping/nearby row (positioned, camelCase, no state/LGA). */
type NearbyRow = {
  puCode: string;
  name: string;
  ward: string;
  lat: number;
  lng: number;
  distanceM: number;
  status: string;
  approxRadiusM: number | null;
  fixes: number;
};

/** One row of the merged discovery list — list, map and selection read this. */
type NearRow = {
  puCode: string;
  name: string;
  ward: string;
  lat: number;
  lng: number;
  distanceM: number;
  tier: UnitTier;
  /** The area the map may DRAW — set only when the pin IS the envelope's centre. */
  envelope?: MapEnvelope;
  tierConfirmed: boolean;
  fixes: number;
  /** The register row, when the merge already had one (null ⇒ needs a lookup). */
  unit: Unit | null;
};

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

/** What each lookup searched, so the map ring / empty state describe the area
 *  actually queried rather than the one drawn. */
type Searched = {
  registerM: number | null;
  envelopeM: number | null;
  /** The row cap /api/polling-units applied — its own `maxRows`, so the copy
   *  quotes the server's number instead of a mirror that can drift from it. */
  maxRows: number;
  /** The register lookup hit that cap, so nearer units may be missing. Practice
   *  is where observers learn to trust this list; a silently short one here
   *  teaches the wrong lesson about the real screens. */
  capped: boolean;
};

const STEPS: { key: Step; label: string }[] = [
  { key: 'unit', label: 'Unit' },
  { key: 'contest', label: 'Race' },
  { key: 'sheet', label: 'Sheet' },
  { key: 'venue', label: 'Venue' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

/** Enough to find the unit you are standing at; short enough to still scan. */
const MAX_NEARBY = 12;
/**
 * /api/polling-units filters at config.discoveryRadiusM and caps at
 * config.discoveryMaxRows — a wider window than the submission geofence
 * (config.geofenceRadiusM), which is a different question entirely.
 *
 * Both are on the wire (`radiusM`/`maxRows`, plus an explicit `capped`) and the
 * wire value always wins; these mirrors only cover a server too old to send
 * them. Mirroring a server-owned number is how the other three screens ended up
 * announcing truncation at eight rows long after the cap had moved.
 */
const REGISTER_RADIUS_M = 500; // config.discoveryRadiusM, as of writing
const REGISTER_MAX_ROWS = 40; // config.discoveryMaxRows, as of writing
/** React Native's fetch has no default timeout — a stalled register lookup would
 *  otherwise leave a tapped row spinning forever with no way out. */
const PICK_TIMEOUT_MS = 12_000;

/** The map ring names one circle; the search was two. Say which, so an empty
 *  ring is never read as "nothing is near you". */
const ringLine = (_s: Searched): string =>
  'Units found within an 800m radius. Unmapped units may not appear on map.';

const nothingFoundLine = (s: Searched): string => {
  if (s.envelopeM != null && s.registerM != null) {
    return `No polling unit found nearby. Hawkeye searched ${s.registerM}m around you for units observers have already placed, and ${s.envelopeM}m for units known only by their mapped area — browse the register below, or just practise without a specific unit.`;
  }
  if (s.envelopeM != null) {
    return `No polling unit with a mapped area within ${s.envelopeM}m — browse the register below, or practise without a specific unit.`;
  }
  if (s.registerM != null) {
    return `No polling unit within ${s.registerM}m of you — browse the register below, or practise without a specific unit.`;
  }
  // Point at SEARCH, not browse: browsing is network-backed (/lgas, /wards,
  // /units), so on a lookup failure it is the one other path that cannot work
  // either. Search answers from the register bundled into the app.
  return 'Could not look up nearby units. Search for yours by name below (the list works without a connection), or practise without a specific unit.';
};

/** The tier's colour, sized for a line of text, so a row and the pin it refers
 *  to carry the same mark. */
const TierDot = ({ tier }: { tier: UnitTier }) => (
  <View
    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TIER_COLOR[tier] }}
    className="mr-1.5"
  />
);

/**
 * THE LIST / UI COMPONENTS LIVE AT MODULE SCOPE, and must stay here.
 *
 * They used to be declared inside Practice's body. A component created during
 * render is a NEW function identity every render, so React treats it as a
 * different component type and unmounts the whole subtree rather than updating
 * it: every discovery row was torn down and rebuilt on any state change — a
 * selection tap sets `picking`, which remounted the entire nearby list and lost
 * the press/ripple feedback mid-gesture. Hoisted, the type is stable and a
 * re-render is a re-render. Mirrors report/incident.tsx.
 *
 * Everything they need therefore arrives as props — no closure over the
 * screen's state.
 */

/** One of the review step's two photo slots — tap to (re)take, or the
 *  "sample used" placeholder when practice skipped the camera. */
const Slot = ({
  shot,
  label,
  busy,
  ui,
  onPress,
}: {
  shot: Media | null;
  label: string;
  busy: boolean;
  ui: ReturnType<typeof useUi>;
  onPress: () => void;
}) => (
  <Pressable
    disabled={busy}
    className="flex-1 overflow-hidden rounded-2xl bg-card active:opacity-80"
    onPress={onPress}
  >
    {shot ? (
      <Image source={{ uri: shot.uri }} style={{ width: '100%', height: 110 }} contentFit="cover" />
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

/** A register-browse row. Tapping selects; the inline Continue advances. */
const UnitRow = ({
  u,
  selected,
  onChoose,
  onContinue,
}: {
  u: Unit;
  selected: boolean;
  onChoose: (u: Unit) => void;
  onContinue: () => void;
}) => (
  <Pressable
    className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${selected ? 'bg-hawk-green' : 'bg-card'}`}
    onPress={() => onChoose(u)}
  >
    <View className="flex-1 pr-2">
      <Text className={`text-base font-semibold ${selected ? 'text-white' : 'text-ink'}`}>
        {u.name}
      </Text>
      <Text className={`text-xs ${selected ? 'text-emerald-100' : 'text-muted'}`}>
        {u.pu_code} · {u.ward}, {u.lga}
      </Text>
      {/* Same badge the nearby rows carry — browse rows shipped without it
          while the web's browse rows had one. */}
      <RegisterTierBadge u={u} selected={selected} />
    </View>
    {selected ? (
      <Pressable
        className="flex-row items-center rounded-xl bg-hawk-gold px-3 py-2 active:opacity-80"
        onPress={onContinue}
      >
        <Text className="pr-1 text-sm font-bold text-hawk-ink">Continue</Text>
        <Feather name="arrow-right" size={14} color={BRAND.ink} />
      </Pressable>
    ) : null}
  </Pressable>
);

/** A GPS-discovered row — tier stated in the map legend's own words and colour. */
const NearbyRow = ({
  n,
  selected,
  loading,
  ui,
  onChoose,
  onContinue,
}: {
  n: NearRow;
  selected: boolean;
  loading: boolean;
  ui: ReturnType<typeof useUi>;
  onChoose: (n: NearRow) => void;
  onContinue: () => void;
}) => (
  <View className={`mb-2 overflow-hidden rounded-2xl ${selected ? 'bg-hawk-green' : 'bg-card'}`}>
    <Pressable
      className="flex-row items-center px-4 py-3"
      disabled={loading}
      onPress={() => onChoose(n)}
    >
      <View className="flex-1 pr-2">
        <Text className={`text-base font-semibold ${selected ? 'text-white' : 'text-ink'}`}>
          {n.name}
        </Text>
        <Text className={`text-xs ${selected ? 'text-emerald-100' : 'text-muted'}`}>
          {n.puCode} · {n.ward} · {n.distanceM}m away
        </Text>
        <View className="flex-row items-center pt-0.5">
          <TierDot tier={n.tier} />
          <Text className={`flex-1 text-xs ${selected ? 'text-emerald-100' : 'text-muted'}`}>
            {TIER_LABEL[n.tier]}
            {n.tier === 'approx' && n.envelope ? envelopeText(n.envelope.radiusM) : ''}
            {n.tier !== 'approx' && n.fixes ? ` · ${n.fixes} observer fix(es)` : ''}
          </Text>
        </View>
      </View>
      {loading ? (
        // good-ink, not BRAND.leaf: an unselected row is bg-card, and #0b6b3a on
        // the dark card is 2.5:1 — the one mark saying "this row is loading",
        // invisible. Selected rows keep the gold, which is on fixed brand green.
        <ActivityIndicator color={selected ? BRAND.gold : ui.tint.good.ink} />
      ) : selected ? (
        <Pressable
          className="flex-row items-center rounded-xl bg-hawk-gold px-3 py-2 active:opacity-80"
          onPress={onContinue}
        >
          <Text className="pr-1 text-sm font-bold text-hawk-ink">Continue</Text>
          <Feather name="arrow-right" size={14} color={BRAND.ink} />
        </Pressable>
      ) : null}
    </Pressable>
  </View>
);

const Chip = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <Pressable onPress={onPress} className="mb-2 mr-2 rounded-full bg-card px-4 py-2 active:opacity-70">
    <Text className="text-sm font-semibold text-ink">{label}</Text>
  </Pressable>
);

/**
 * Practice run — the no-auth sandbox (/api/practice), rehearsing the REAL shape
 * of a report end to end: find your polling unit → choose the race → photograph
 * the sheet and the venue → type the counts → review, sign & send. Same steps,
 * same order, same screens as report/result, so nothing on election day is a
 * surprise.
 *
 * Deliberate differences, all because this is a rehearsal:
 *  - NO geofence. Any unit (or none) may be chosen; a calm advisory notes that a
 *    real race rejects a report filed from anywhere but the unit itself. Practice
 *    does not enforce it, because people practise indoors.
 *  - NO GPS fix required on the photos ("Use a sample" skips the camera).
 *  - Any race, open or closed, may be rehearsed — the race picker runs with
 *    allowClosed, so a closed 2027 race is a legitimate practice target.
 *  - GENERIC parties (Party A/B/C…), never the real manifest.
 * Nothing here is published, counted, chained to the public ledger or anchored;
 * the backend keeps practice in its own disposable table on its own chain.
 */
export default function Practice() {
  const ui = useUi();
  const [cfg, setCfg] = useState<PracticeConfig | null>(null);
  const [step, setStep] = useState<Step>('unit');

  // -- which elections exist (for the race picker's open/closed styling) ------
  const [contests, setContests] = useState<Contest[]>([]);

  // -- step 1: which polling unit --------------------------------------------
  const [unit, setUnit] = useState<Unit | null>(null);
  // GPS discovery — the way an observer standing at their unit finds it.
  const [nearby, setNearby] = useState<NearRow[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  const [searched, setSearched] = useState<Searched | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  /** Set only when the last GPS failure is one the settings app has to fix
   *  (location off, or permission blocked with no dialog left) — never for a
   *  timeout, where permission is granted and settings would be a dead end. */
  const [gpsSettings, setGpsSettings] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const pickReq = useRef<AbortController | null>(null);
  const [browse, setBrowse] = useState(false);
  // Register drill-down. Practice allows ANY unit, so it is NOT gated on whether
  // an election is running in the state — that is the whole point of rehearsing
  // at your own unit in a state with no live race.
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);

  // -- step 2: which race -----------------------------------------------------
  const [race, setRace] = useState<Race | null>(null);

  // -- steps 3/4: photos ------------------------------------------------------
  const [sheet, setSheet] = useState<Media | null>(null);
  const [venue, setVenue] = useState<Media | null>(null);
  /** True while re-shooting one photo from the review step. */
  const [retaking, setRetaking] = useState(false);

  // -- step 5: votes ----------------------------------------------------------
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [sheetSerial, setSheetSerial] = useState('');

  // -- step 6: review + submit ------------------------------------------------
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  /** `recordedAt` is the SERVER's stamp for the run (POST /api/practice/submit
   *  returns it), used so the anchor check on the receipt never depends on this
   *  phone's clock being right. */
  const [done, setDone] = useState<{ entryHash: string; recordedAt?: number } | null>(null);
  const [history, setHistory] = useState<PracticeRun[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const parties = cfg?.parties?.length ? cfg.parties : PRACTICE_PARTIES;

  /** The state to scope the race picker to, when the chosen unit sits in a real
   *  register state. The sample unit ("Practice") and "no unit" both fall
   *  through to the full type → state → race path. */
  const lockedState = useMemo<StateName | undefined>(() => {
    const s = unit?.state;
    return s && (STATES as readonly string[]).includes(s) ? (s as StateName) : undefined;
  }, [unit]);

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

  useEffect(() => {
    api.contests().then(setContests).catch(() => {});
    regFetch(`${REG}/states`)
      .then((r) => r.json())
      .then(setStates)
      .catch(() => {});
  }, []);

  // Register drill-down cascade — no contest filter (practice is not scoped to a
  // live election), exactly the state/lga/ward selects the server understands.
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

  useEffect(() => {
    if (!stateSel || !lgaSel || !wardSel) return;
    fetch(
      `${REG}/units?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}&ward=${encodeURIComponent(wardSel)}`,
    )
      .then((r) => r.json())
      .then((d) => setUnits(d.units ?? []))
      .catch(() => {});
  }, [stateSel, lgaSel, wardSel]);

  const pickState = (s: string | null) => {
    setStateSel(s);
    setLgaSel(null);
    setWardSel(null);
    setUnits([]);
  };
  const pickLga = (l: string | null) => {
    setLgaSel(l);
    setWardSel(null);
    setUnits([]);
  };
  const pickWard = (w: string | null) => {
    setWardSel(w);
    setUnits([]);
  };

  /**
   * TWO LOOKUPS, merged by pu_code — the same discovery as report/result, so the
   * two flows agree about which units exist, where their pins sit and how they
   * are tiered. /api/mapping/nearby alone is blind to the 7,652 units positioned
   * solely by crowd_lat, which only /api/polling-units can see. Either lookup may
   * fail on its own; only losing both is fatal.
   */
  const findNearby = async () => {
    setNearBusy(true);
    setNearby([]);
    setFix(null);
    setSearched(null);
    // A re-search invalidates the selection it was made from.
    setUnit(null);
    setGpsSettings(false);
    setNearLine('Getting your location…');
    try {
      // DISCRIMINATED failure — the reason decides the sentence. Practice is
      // where people learn the app; teaching them that a slow GPS lock means
      // "permission denied" is teaching them to distrust the real thing.
      const r = await tryQuickFix();
      if (!r.ok) {
        const d = describeFixFailure(r);
        setNearLine(
          `${d.lead}, browse the register below, or just practise without a specific unit. (${d.code})`,
        );
        setGpsSettings(d.settings);
        return;
      }
      const f = r.fix;
      setFix(f);
      setNearLine(`Location fixed (±${Math.round(f.accuracy)}m). Looking up nearby units…`);

      const [located, envelope] = await Promise.all([
        fetch(`${BASE}/api/polling-units?lat=${f.lat}&lng=${f.lng}`).catch(() => null),
        fetch(
          `${BASE}/api/mapping/nearby?lat=${f.lat}&lng=${f.lng}&radiusM=${DISCOVERY_RADIUS_M}`,
        ).catch(() => null),
      ]);

      if (!located?.ok && !envelope?.ok) {
        const status = located?.status ?? envelope?.status;
        setNearLine(
          `Could not look up nearby units. Search for yours by name below (the list works without a connection), or practise without a specific unit. (lookup_failed${status ? ` / HTTP ${status}` : ''})`,
        );
        return;
      }

      const locatedBody = located?.ok
        ? ((await located.json().catch(() => ({}))) as {
            units?: LocatedRow[];
            radiusM?: number;
            maxRows?: number;
            capped?: boolean;
          })
        : null;
      const locatedRows = locatedBody?.units ?? [];
      const envelopeRows = envelope?.ok
        ? (((await envelope.json().catch(() => ({}))) as { units?: NearbyRow[] }).units ?? [])
        : [];

      // Radius, cap and truncation all come off the response — see the note on
      // REGISTER_RADIUS_M. The constants only cover a server that omits them.
      const registerMaxRows = Number.isFinite(locatedBody?.maxRows)
        ? Number(locatedBody?.maxRows)
        : REGISTER_MAX_ROWS;
      const scope: Searched = {
        registerM: located?.ok
          ? Number.isFinite(locatedBody?.radiusM)
            ? Number(locatedBody?.radiusM)
            : REGISTER_RADIUS_M
          : null,
        envelopeM: envelope?.ok ? DISCOVERY_RADIUS_M : null,
        maxRows: registerMaxRows,
        // Only inferred against an older server, where a full answer and a
        // truncated one look identical and the full one is treated as truncated.
        capped:
          typeof locatedBody?.capped === 'boolean'
            ? locatedBody.capped
            : locatedRows.length >= registerMaxRows,
      };
      setSearched(scope);

      // THE MERGE. Keyed by pu_code; seeded from register rows, then filled in by
      // /api/mapping/nearby. A unit in both keeps the register POSITION but takes
      // its TIER from mapping/nearby, and the envelope never travels with the
      // position — see report/result.tsx for the full rationale.
      const merged = new Map<string, NearRow>();
      for (const u of locatedRows) {
        const uLat = u.lat ?? u.crowd_lat;
        const uLng = u.lng ?? u.crowd_lng;
        if (uLat == null || uLng == null) continue;
        const crowdMapped = u.coords_source === 'crowd_mapped';
        merged.set(u.pu_code, {
          puCode: u.pu_code,
          name: u.name,
          ward: u.ward,
          lat: uLat,
          lng: uLng,
          distanceM: u.distanceM ?? 0,
          tier: crowdMapped ? 'crowd' : toTier(u.locationTier),
          tierConfirmed: crowdMapped,
          fixes: u.crowd_reports ?? 0,
          unit:
            u.state && u.lga
              ? { pu_code: u.pu_code, name: u.name, ward: u.ward, lga: u.lga, state: u.state }
              : null,
        });
      }
      for (const n of envelopeRows) {
        const seed = merged.get(n.puCode);
        const tier = seed?.tierConfirmed ? seed.tier : toTier(n.status);
        const drawnIsEnvelopeCentre = !seed;
        const area =
          tier === 'approx' &&
          Number.isFinite(n.lat) &&
          Number.isFinite(n.lng) &&
          n.approxRadiusM != null &&
          n.approxRadiusM > 0
            ? ({ lat: n.lat, lng: n.lng, radiusM: n.approxRadiusM } satisfies MapEnvelope)
            : undefined;
        merged.set(n.puCode, {
          puCode: n.puCode,
          name: seed?.name ?? n.name,
          ward: seed?.ward ?? n.ward,
          lat: seed?.lat ?? n.lat,
          lng: seed?.lng ?? n.lng,
          distanceM: seed?.distanceM ?? n.distanceM,
          tier,
          // Drawn only when the pin IS the centre (unseeded approx rows).
          envelope: drawnIsEnvelopeCentre ? area : undefined,
          tierConfirmed: true,
          fixes: n.fixes || seed?.fixes || 0,
          unit: seed?.unit ?? null,
        });
      }

      const all = [...merged.values()].sort((a, b) => a.distanceM - b.distanceM);
      const found = all.slice(0, MAX_NEARBY);
      setNearby(found);
      if (found.length === 0) {
        setNearLine(nothingFoundLine(scope));
        return;
      }
      setNearLine(
        all.length > found.length
          ? `Tap the unit you are standing at — the ${found.length} closest of the ${all.length} found:`
          : 'Tap the unit you are standing at:',
      );
    } catch (e) {
      setNearLine(
        `Could not look up nearby units. Search for yours by name below (the list works without a connection), or practise without a specific unit. (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setNearBusy(false);
    }
  };

  const chooseUnit = (u: Unit) => {
    // Changing the unit can change which state the race picker is scoped to, so
    // a race chosen under a different unit must not silently carry over.
    setUnit(u);
    setRace(null);
  };

  /**
   * Turn a nearby row into a selection. A row without a state has to fetch its
   * register row first (state decides which races run there); that fetch is raced
   * against a timeout and superseded by any later tap, so a lost tap can never
   * strand the spinner. Mirrors report/result.tsx.
   */
  const chooseNearby = async (n: NearRow) => {
    if (unit?.pu_code === n.puCode) {
      pickReq.current?.abort();
      pickReq.current = null;
      setPicking(null);
      return;
    }
    if (n.unit) {
      pickReq.current?.abort();
      pickReq.current = null;
      setPicking(null);
      chooseUnit(n.unit);
      return;
    }

    pickReq.current?.abort();
    const ctl = new AbortController();
    pickReq.current = ctl;
    const current = () => pickReq.current === ctl;
    setPicking(n.puCode);
    const timer = setTimeout(() => ctl.abort(), PICK_TIMEOUT_MS);
    try {
      const res = await fetch(`${REG}/unit?pu_code=${encodeURIComponent(n.puCode)}`, {
        signal: ctl.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { unit?: Unit; error?: string };
      if (!current()) return;
      if (ctl.signal.aborted) throw new Error('timeout');
      if (!res.ok || !body.unit) {
        Alert.alert(
          'Could not open that unit',
          `${n.name} could not be loaded from the register — retry, or find it under “Browse the register”. (${body.error ?? 'lookup_failed'} / HTTP ${res.status})`,
        );
        return;
      }
      chooseUnit(body.unit);
    } catch (e) {
      if (!current()) return;
      Alert.alert(
        'Could not open that unit',
        ctl.signal.aborted
          ? `Looking up ${n.name} took too long. Check your signal and tap it again, or find it under “Browse the register”. (timed out after ${PICK_TIMEOUT_MS / 1000}s)`
          : `Check your connection and retry. (${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      clearTimeout(timer);
      if (current()) {
        pickReq.current = null;
        setPicking(null);
      }
    }
  };

  // Leaving the screen must take any in-flight lookup with it.
  useEffect(
    () => () => {
      pickReq.current?.abort();
      pickReq.current = null;
    },
    [],
  );

  const mapUnits = useMemo<MapUnit[]>(
    () =>
      nearby.map((n) => ({
        puCode: n.puCode,
        name: n.name,
        lat: n.lat,
        lng: n.lng,
        tier: n.tier,
        envelope: n.envelope,
      })),
    [nearby],
  );

  const ringM = searched?.envelopeM ?? searched?.registerM ?? DISCOVERY_RADIUS_M;

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
        body: JSON.stringify({
          votes,
          // The chosen unit if there is one, else the sample the backend holds.
          puName: unit?.name ?? cfg?.unit?.name,
          puCode: unit?.pu_code ?? cfg?.unit?.code,
          // The race being rehearsed, so a past run records what it was against.
          contest: race?.contestCode ?? 'PRACTICE',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        entryHash?: string;
        recordedAt?: number;
        error?: string;
      };
      if (res.ok && body.ok && body.entryHash) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({ entryHash: body.entryHash, recordedAt: body.recordedAt });
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
    setUnit(null);
    setRace(null);
    setSheet(null);
    setVenue(null);
    setCounts({});
    setSheetSerial('');
    setDone(null);
    setLine(null);
    setNearby([]);
    setNearLine(null);
    setSearched(null);
    setFix(null);
    setBrowse(false);
    setStep('unit');
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
        venueGuide={isSheet ? undefined : '📸 VENUE PHOTO — aim at the polling unit itself: the building, booth, banner or the crowd. This is NOT the results sheet.'}
        hint={
          isSheet
            ? 'On election day every figure must be readable. Try it now, or use a sample.'
            : 'Step back and capture the polling unit itself — building, banner, crowd.'
        }
        confirmTitle={isSheet ? 'Check the result sheet' : 'Check the venue photo'}
        readDocument={isSheet}
        partyCodes={parties.map((p) => p.code)}
        confirmHint={
          isSheet
            ? 'Is every figure readable? On election day a blurry photo cannot back a report.'
            : 'Is the polling unit itself visible? On election day this photo proves you were there.'
        }
        extraAction={{ label: 'Use a sample', onPress: skip }}
        onCapture={(shot) => {
          if (isSheet) {
            setSheet(shot);
            // Propose what the sheet said; never overwrite anything already typed.
            const proposed = shot.read?.counts ?? {};
            if (Object.keys(proposed).length) {
              setCounts((c) => {
                const next = { ...c };
                for (const [code, n] of Object.entries(proposed)) {
                  if (!next[code]) next[code] = String(n);
                }
                return next;
              });
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
            setStep('contest');
          } else {
            setStep('sheet');
          }
        }}
      />
    );
  }

  const selectedName = unit?.name ?? cfg.unit?.name ?? 'Practice polling unit';
  const selectedSub = unit
    ? `${unit.pu_code} · ${unit.ward}, ${unit.lga}`
    : cfg.unit
      ? `${cfg.unit.code} · ${cfg.unit.ward}, ${cfg.unit.lga}`
      : 'the sample practice unit';

  return (
    <SafeAreaView className="flex-1 bg-surface">
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
        <Text className="pl-3 text-lg font-bold text-ink">Practice Run</Text>
        {/* bg-hawk-gold is a fixed brand surface: its label must be the fixed
            hawk ink, since text-ink flips near-white and dies in the gold. */}
        <View className="ml-2 rounded-full bg-hawk-gold px-2 py-0.5">
          <Text className="text-[10px] font-bold text-hawk-ink">PRACTICE</Text>
        </View>
        <View className="flex-1" />
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
        <Pressable className="flex-1 justify-end bg-black/40" onPress={() => setShowHistory(false)}>
          <Pressable className="max-h-[70%] rounded-t-3xl bg-surface px-5 pb-8 pt-5" onPress={() => {}}>
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
          </Pressable>
        </Pressable>
      </Modal>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        className="flex-1"
      >
        {/* ── STEP 1: which polling unit ── */}
        {step === 'unit' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            <Text className="pb-1 text-xl font-bold text-ink">Which Polling Unit?</Text>
            <Text className="pb-3 text-sm text-muted">
              Practise from your unit, from anywhere, or skip and use a sample.
            </Text>

            <Pressable
              disabled={nearBusy}
              onPress={findNearby}
              className={`flex-row items-center justify-center rounded-2xl py-4 ${
                nearBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
              }`}
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
              <Text className="pt-3 text-sm font-semibold text-good-ink">{nearLine}</Text>
            ) : null}

            {/* Only for the failures system settings can actually fix. The
                near-me button above is already the retry. */}
            {gpsSettings ? (
              <Pressable
                onPress={() => Linking.openSettings()}
                className="mt-2 flex-row items-center self-start rounded-xl border border-line px-3 py-2 active:opacity-70"
              >
                <Feather name="settings" size={14} color={ui.muted} />
                <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
              </Pressable>
            ) : null}

            {/* The register lookup caps its answer, and until now this screen
                was the one that never said so — it showed the short list and
                let the observer conclude their unit does not exist. Practice is
                where people learn what to trust on the real screens, so it says
                the same sentence they do, off the same wire fields. */}
            {searched?.capped && nearby.length ? (
              <Text className="pt-1 text-xs text-muted">
                Units already placed by observers are looked up {searched.maxRows} at a time within{' '}
                {searched.registerM}m, and that limit was reached — if yours is not listed, browse
                the register below.
              </Text>
            ) : null}

            {fix && searched && mapAvailable() ? (
              <View className="pt-3">
                <UnitMap
                  center={{ lat: fix.lat, lng: fix.lng }}
                  accuracyM={fix.accuracy}
                  units={mapUnits}
                  selected={picking ?? unit?.pu_code}
                  onSelect={(code) => {
                    const row = nearby.find((n) => n.puCode === code);
                    if (row) chooseNearby(row);
                  }}
                  radiusM={ringM}
                />
                {ringLine(searched) ? (
                  <Text className="pt-1.5 text-xs text-muted">{ringLine(searched)}</Text>
                ) : null}
              </View>
            ) : null}

            {nearby.length ? (
              <View className="pt-3">
                {nearby.map((n) => (
                  <NearbyRow
                    key={n.puCode}
                    n={n}
                    selected={unit?.pu_code === n.puCode}
                    loading={picking === n.puCode}
                    ui={ui}
                    onChoose={chooseNearby}
                    onContinue={() => setStep('contest')}
                  />
                ))}
              </View>
            ) : null}

            {/* Search by name/code, above the cascade — knowing the unit's name
                but not its ward is the case the cascade cannot serve. */}
            <UnitSearch<Unit> onSelect={chooseUnit} selectedCode={unit?.pu_code} />
            <Pressable
              onPress={() => setBrowse((b) => !b)}
              className="mt-4 flex-row items-center rounded-2xl bg-hawk-green px-4 py-3.5 active:opacity-80"
            >
              {/* Gold on hawk-green — the pairing Prompt uses, and it sidesteps the
                  contrast trap this row used to have: hawk-leaf (#0b6b3a) on
                  bg-card measured 2.5:1 in dark mode and the label and chevron
                  both disappeared. On the filled green card that cannot recur. */}
              <Feather
                name={browse ? 'chevron-down' : 'chevron-right'}
                size={16}
                color={BRAND.gold}
              />
              <Text className="flex-1 pl-2 text-base font-bold text-hawk-gold">
                Browse the register instead
              </Text>
              <Text className="text-xs text-emerald-100">state › LGA › ward</Text>
            </Pressable>

            {browse ? (
              <View className="pt-3">
                {!stateSel ? (
                  <>
                    <Prompt>Select a state</Prompt>
                    <View className="flex-row flex-wrap">
                      {states.map((s) => (
                        <Chip key={s} label={s} onPress={() => pickState(s)} />
                      ))}
                    </View>
                  </>
                ) : null}

                {stateSel && !lgaSel ? (
                  <>
                    <Crumb label={stateSel} onPress={() => pickState(null)} />
                    <Prompt>Select an LGA</Prompt>
                    <View className="flex-row flex-wrap">
                      {lgas.map((l) => (
                        <Chip key={l} label={l} onPress={() => pickLga(l)} />
                      ))}
                    </View>
                  </>
                ) : null}

                {stateSel && lgaSel && !wardSel ? (
                  <>
                    <Crumb label={lgaSel} onPress={() => pickLga(null)} />
                    <Prompt>Select a ward</Prompt>
                    <View className="flex-row flex-wrap">
                      {wards.map((w) => (
                        <Chip key={w} label={w} onPress={() => pickWard(w)} />
                      ))}
                    </View>
                  </>
                ) : null}

                {stateSel && lgaSel && wardSel ? (
                  <>
                    <Crumb label={`${lgaSel} · ${wardSel}`} onPress={() => pickWard(null)} />
                    <Prompt>Select a polling unit</Prompt>
                    {units.map((u) => (
                      <UnitRow
                        key={u.pu_code}
                        u={u}
                        selected={unit?.pu_code === u.pu_code}
                        onChoose={chooseUnit}
                        onContinue={() => setStep('contest')}
                      />
                    ))}
                    {units.length === 0 ? (
                      <Text className="pt-2 text-sm text-muted">
                        No units in the register for this ward yet.
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        ) : null}

        {/* Pinned CTA — always live: practice may run against a chosen unit OR
            none at all (the sample). The advisory is calm, not alarming: it
            states the real-race rule and that practice does not enforce it. */}
        {step === 'unit' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Text className="pb-1 text-xs text-muted" numberOfLines={1}>
              {unit ? `Selected: ${unit.name}` : 'No unit chosen — you’ll practise against the sample.'}
            </Text>
            <Text className="pb-2 text-xs text-muted">
              A real report is only accepted at the polling unit itself. Practice isn’t checked, so
              you can rehearse from anywhere.
            </Text>
            <Pressable
              onPress={() => setStep('contest')}
              className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
            >
              <Text className="text-base font-bold text-hawk-gold">
                {unit ? 'Continue — choose the race' : 'Continue without a unit'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* ── STEP 2: which race (allowClosed — practice rehearses ANY race) ── */}
        {step === 'contest' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            <Crumb label={selectedName} onPress={() => setStep('unit')} />
            <Text className="pb-1 text-xl font-bold text-ink">Which Race?</Text>
            <Text className="pb-3 text-sm text-muted">
              Green races are live now; the rest are the full 2027 picture. Practice can rehearse any
              of them — a dim one is just a rehearsal.
            </Text>
            <ContestPicker
              contests={contests}
              value={race}
              onSelect={setRace}
              lockedState={lockedState}
              allowClosed
            />
          </ScrollView>
        ) : null}

        {step === 'contest' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {race ? (
              <Text className="pb-2 text-xs font-semibold text-good-ink" numberOfLines={2}>
                {race.label}
              </Text>
            ) : null}
            <Pressable
              disabled={!race}
              onPress={() => setStep('sheet')}
              className={`items-center rounded-2xl py-4 ${
                race ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'
              }`}
            >
              <Text className="text-base font-bold text-hawk-gold">Continue to photos</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ── STEP 5: votes ── */}
        {step === 'votes' ? (
          <ScrollView
            contentContainerClassName="px-4 pb-4 pt-4"
            keyboardShouldPersistTaps="handled"
          >
            <View className="mb-3 rounded-2xl bg-hawk-green px-5 py-4">
              <Text className="text-xs font-semibold uppercase tracking-wider text-hawk-gold">
                {race?.label ?? cfg.office ?? 'Practice race'}
              </Text>
              <Text className="pt-1 text-lg font-bold text-white">{selectedName}</Text>
              <Text className="pt-0.5 text-xs text-emerald-100">{selectedSub}</Text>
            </View>
            <Prompt>Enter the announced counts (practice parties)</Prompt>
            {parties.map((p) => (
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

        {/* ── STEP 6: review + submit ── */}
        {step === 'review' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4">
            <Text className="pb-3 text-xl font-bold text-ink">Confirm and Send</Text>
            <View className="mb-3 rounded-2xl bg-card px-4 py-3">
              <Text className="text-base font-semibold text-ink">{selectedName}</Text>
              <Text className="text-xs text-muted">{selectedSub}</Text>
              {race ? (
                <Text className="pt-1 text-xs font-bold text-good-ink">{race.label}</Text>
              ) : null}
            </View>
            <View className="mb-3 flex-row gap-3">
              <Slot
                shot={sheet}
                label="Result sheet"
                busy={busy}
                ui={ui}
                onPress={() => {
                  setRetaking(true);
                  setStep('sheet');
                }}
              />
              <Slot
                shot={venue}
                label="Venue"
                busy={busy}
                ui={ui}
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

        {/* The receipt scrolls, the three endings do not. The anchor block below
            added real height to what used to be one centred column, and on a
            small screen that pushed "Report a real result" off the bottom — a
            primary action must never be reachable only by scrolling. Same
            ScrollView + pinned-footer shape the review step already uses. */}
        {step === 'done' && done ? (
          <ScrollView contentContainerClassName="grow items-center justify-center px-8 py-6">
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
            <View className="mt-4 w-full rounded-xl bg-card px-4 py-2">
              <Text className="font-mono text-xs text-muted">{done.entryHash}</Text>
            </View>
            {/* Practice is its own chain — and its head is published in the SAME
                daily Sigstore Rekor artifact as the real ledger (practiceHead in
                backend/src/services/anchor.js). So a rehearsal really can be
                followed to a public log; the copy in RekorAnchor is careful that
                what gets proven is the practice chain's existence, never a
                result. */}
            <View className="w-full">
              <RekorAnchor
                entryHash={done.entryHash}
                chain="practice"
                filedAtServer={done.recordedAt}
              />
            </View>
          </ScrollView>
        ) : null}

        {step === 'done' && done ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Pressable
              className="w-full items-center rounded-2xl bg-hawk-green py-3.5 active:opacity-80"
              onPress={() => router.replace('/report/result')}
            >
              <Text className="text-base font-bold text-hawk-gold">Report a real result</Text>
            </Pressable>
            <Pressable className="mt-3 w-full items-center py-2" onPress={restart}>
              <Text className="text-sm font-semibold text-good-ink">Practise again</Text>
            </Pressable>
            <Pressable className="mt-1 w-full items-center py-1" onPress={() => router.back()}>
              <Text className="text-sm text-muted">Done</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

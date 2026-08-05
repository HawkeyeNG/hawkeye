import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { CaptureCamera, type Media } from '@/components/capture-camera';
import {
  envelopeText,
  mapAvailable,
  RegisterTierBadge,
  toTier,
  UnitMap,
  TIER_COLOR,
  TIER_LABEL,
  type MapEnvelope,
  type MapUnit,
  type UnitTier,
} from '@/components/unit-map';
import { Crumb, Prompt } from '@/components/wizard';
import { UnitSearch } from '@/components/unit-search';
import { BRAND } from '@/lib/api';
import { tap } from '@/lib/haptics';
import { useUi } from '@/lib/theme';
import { authedGet, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import {
  describeFixFailure,
  DISCOVERY_RADIUS_M,
  getStampFix,
  tryQuickFix,
  type Fix,
} from '@/lib/location';
import { queueJob } from '@/lib/outbox';
import { filePart } from '@/lib/submit';

const BASE = 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

/** Kind codes from /api/incidents/kinds, with observer-facing labels. */
const KINDS: { code: string; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { code: 'violence', label: 'Violence', icon: 'alert-octagon' },
  { code: 'ballot_snatching', label: 'Ballot snatching', icon: 'box' },
  { code: 'vote_buying', label: 'Vote buying', icon: 'dollar-sign' },
  { code: 'intimidation', label: 'Intimidation', icon: 'user-x' },
  { code: 'bvas_failure', label: 'BVAS failure', icon: 'cpu' },
  { code: 'late_materials', label: 'Late materials', icon: 'clock' },
  { code: 'obstruction', label: 'Obstruction', icon: 'slash' },
  { code: 'other', label: 'Other', icon: 'more-horizontal' },
];

const MAX_MEDIA = 4;

/** The reporter's saved unit. `name` is nullable — the server LEFT JOINs the
 *  register, so a saved code that is no longer listed comes back bare. */
type MyUnit = { pu_code: string; name: string | null };

/**
 * THE UNIT THIS REPORT IS ABOUT — not necessarily the reporter's own.
 *
 * All the server reads is `puCode` (backend/src/routes/incidents.js:76-77): it
 * looks the code up in `polling_units` and stores the row's `state` beside it.
 * So a code is the whole payload. `where` is display only; `via` and `unlisted`
 * are what the screen needs in order to describe that payload honestly — which
 * path chose the code, and whether the lookup it will get is going to find
 * anything.
 */
type PickedUnit = {
  pu_code: string;
  name: string;
  /** Ward/LGA, when whatever produced this selection knew them. */
  where?: string;
  /**
   * WHICH PATH CHOSE THIS UNIT — set explicitly at every call site, never
   * inferred. A re-search may only invalidate a selection that was made FROM a
   * fix, and there is no way to recognise one after the fact: a register pick
   * and a GPS pick both arrive through choose() carrying the same fields, so
   * "no saved flag" used to mean "found on the ground". An observer who browsed
   * state › LGA › ward, tapped their unit and then tapped "Find units near me"
   * to double-check lost the selection to that test.
   */
  via: 'gps' | 'register' | 'saved';
  /**
   * SAVED-CODE-ONLY, AND IT CHANGES WHAT THE REPORT CAN PROMISE.
   *
   * /api/observers/my-unit LEFT JOINs the register, so a saved code that is no
   * longer listed comes back with a null name. incidents.js looks the code up
   * in `polling_units` to copy the row's state across; with no row it stores
   * the code and leaves state NULL — no state on the public log, no unit
   * watchers alerted, i.e. the "no unit" outcome plus a code a reviewer can
   * read. The screen has to say so instead of promising watchers.
   */
  unlisted?: boolean;
};

/** A register row from the drill-down. */
type RegisterUnit = {
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

/**
 * /api/polling-units' row shape. Coordinates arrive raw: officially verified
 * ones in lat/lng, everything else (crowd medians and geocodes alike) in
 * crowd_lat/crowd_lng.
 */
type LocatedRow = RegisterUnit & {
  lat?: number | null;
  lng?: number | null;
  crowd_lat?: number | null;
  crowd_lng?: number | null;
  coords_source?: string | null;
  crowd_reports?: number | null;
  locationTier?: string;
  distanceM?: number;
};

/**
 * /api/mapping/nearby's row shape: camelCase, positioned, thinner than a
 * register row — no LGA and no state. Its lat/lng are already coalesced
 * server-side (verified coordinate, else the GRID3 envelope centre).
 */
type NearbyApiRow = {
  puCode: string;
  name: string;
  ward: string;
  lat: number;
  lng: number;
  distanceM: number;
  status: string;
  /** Radius of the GRID3 envelope an `approx` unit sits somewhere inside. */
  approxRadiusM: number | null;
  fixes: number;
};

/** One row of the merged discovery list — the list, the map and the selection
 *  all read from this and nothing else. */
type NearRow = {
  puCode: string;
  name: string;
  ward: string;
  /** Where the PIN goes: a position somebody stood at, when there is one. */
  lat: number;
  lng: number;
  distanceM: number;
  tier: UnitTier;
  /**
   * THE AREA THE MAP MAY DRAW — set only when `lat`/`lng` above ARE this
   * envelope's centre, i.e. when /api/mapping/nearby was the only source for
   * this unit and the position it gave is the GRID3 centre itself.
   *
   * Whenever the register lookup also saw the unit, its crowd position wins the
   * pin — a median 2.5km from the envelope centre — and this field is then
   * EMPTY, because the circle would no longer be about the dot. Same rule
   * result.tsx and map-unit.tsx follow.
   */
  envelope?: MapEnvelope;
  /**
   * Did /api/mapping/nearby actually grade this row? Only that endpoint can
   * tell a crowd-mapped unit from an officially verified one — /api/polling-units
   * reports both as `verified`, because it tiers on which COLUMN is filled and
   * a crowd median is promoted into `lat`.
   */
  tierConfirmed: boolean;
  fixes: number;
  /** Ward/LGA for the confirmation line, when the register row was to hand. */
  where?: string;
};

/** Enough to find the unit you are standing at; short enough to still scan. */
const MAX_NEARBY = 12;

/**
 * /api/polling-units does NOT take a radius — it filters at
 * `config.discoveryRadiusM` and slices to `config.discoveryMaxRows`, a
 * deliberately wider window than the submission geofence
 * (`config.geofenceRadiusM`), which is a different question. It is also the only
 * lookup that can see the 7,652 units positioned solely by `crowd_lat`, so those
 * units are reachable at the discovery radius and nowhere else.
 *
 * The response carries `radiusM`, `maxRows` and an explicit `capped`, and all
 * three are preferred over the mirrors below — those are fallbacks for a server
 * too old to send them, nothing more. A mirrored server-owned number is wrong
 * from the moment the server moves it, which is how this screen went on warning
 * about truncation at eight rows after the cap had already changed.
 */
const REGISTER_RADIUS_M = 500; // config.discoveryRadiusM, as of writing
const REGISTER_MAX_ROWS = 40; // config.discoveryMaxRows, as of writing

/** What the two lookups covered on the last run, so the screen can describe the
 *  area it really searched instead of the area it drew. */
type Searched = {
  registerM: number | null;
  envelopeM: number | null;
  /** The cap /api/polling-units applied — its `maxRows`, so the copy quotes the
   *  server's number rather than a mirror of it. */
  maxRows: number;
  /** The lookup hit that cap. Stated by the server; only an older one leaves it
   *  to be inferred from the row count. */
  capped: boolean;
};

/**
 * What the ring on the map is, in words, given what actually answered — the
 * ring can only ever be one circle and the two lookups search two different
 * ones (DISCOVERY_RADIUS_M for units with a GRID3 area, and whatever
 * /api/polling-units reports as its own `radiusM` — config.discoveryRadiusM —
 * for units an observer placed). Both are interpolated off the answers below,
 * never written as literals.
 */
const ringLine = (_s: Searched): string =>
  'Units found within an 800m radius. Unmapped units may not appear on map.';

/** The same honesty for an empty answer: name the circles that were searched,
 *  rather than the one that was drawn. */
const nothingFoundLine = (s: Searched): string => {
  if (s.envelopeM != null && s.registerM != null) {
    return `No polling unit found. Hawkeye searched ${s.registerM}m around you for units observers have already placed, and ${s.envelopeM}m for units known only by their mapped area — browse the register below to find the one you are at.`;
  }
  if (s.envelopeM != null) {
    return `No polling unit with a mapped area within ${s.envelopeM}m of you, and the lookup that finds units placed by observers did not answer — browse the register below.`;
  }
  if (s.registerM != null) {
    return `No polling unit within ${s.registerM}m of you, and the wider search for units with a mapped area did not answer — browse the register below.`;
  }
  return 'Could not look up nearby units — browse the register below to find the one you are at.';
};

/** The tier's colour, sized for a line of text — so a row and the pin it refers
 *  to carry the same mark. */
const TierDot = ({ tier }: { tier: UnitTier }) => (
  <View
    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TIER_COLOR[tier] }}
    className="mr-1.5"
  />
);

/**
 * THE THREE LIST COMPONENTS LIVE AT MODULE SCOPE, and must stay here.
 *
 * They used to be declared inside ReportIncident's body. A component created
 * during render is a NEW function identity every render, so React treats it as
 * a different component type and unmounts the whole subtree rather than
 * updating it: every register row and every nearby row was torn down and
 * rebuilt on each keystroke while browsing and on each selection tap. Hoisted,
 * the type is stable and a re-render is a re-render.
 *
 * Everything they need therefore arrives as props — no closure over the
 * screen's state.
 */

/** A register-browse row: the drill-down already said where you are, so the
 *  sub-line only has to name the unit. */
const RegisterRow = ({
  u,
  selected,
  onPick,
}: {
  u: RegisterUnit;
  selected: boolean;
  onPick: (u: PickedUnit) => void;
}) => (
  <Pressable
    className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${selected ? 'bg-hawk-green' : 'bg-card'}`}
    onPress={() =>
      onPick({
        pu_code: u.pu_code,
        name: u.name,
        where: `${u.ward}, ${u.lga}`,
        // Chosen off the register, NOT off a fix — a later GPS search must
        // leave this alone.
        via: 'register',
      })
    }
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
    {selected ? <Feather name="check" size={18} color={BRAND.gold} /> : null}
  </Pressable>
);

/** A GPS-discovered row. Its tier is stated in the same words the map legend
 *  uses, so the pin and the row beside it cannot grade the same unit
 *  differently. */
const NearbyRow = ({
  n,
  selected,
  onPick,
}: {
  n: NearRow;
  selected: boolean;
  onPick: (u: PickedUnit) => void;
}) => (
  <Pressable
    className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${selected ? 'bg-hawk-green' : 'bg-card'}`}
    onPress={() => onPick({ pu_code: n.puCode, name: n.name, where: n.where, via: 'gps' })}
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
          {/* Read off `n.envelope`, so the area appears only where the dot
              beside it IS that area's centre. */}
          {n.tier === 'approx' && n.envelope ? envelopeText(n.envelope.radiusM) : ''}
          {n.tier !== 'approx' && n.fixes ? ` · ${n.fixes} observer fix(es)` : ''}
        </Text>
      </View>
    </View>
    {selected ? <Feather name="check" size={18} color={BRAND.gold} /> : null}
  </Pressable>
);

const Chip = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <Pressable onPress={onPress} className="mb-2 mr-2 rounded-full bg-card px-4 py-2">
    <Text className="text-sm font-semibold text-ink">{label}</Text>
  </Pressable>
);

type Step = 'unit' | 'report';

/** Report an incident — polling unit, then kind, evidence, description, GPS. */
export default function ReportIncident() {
  const ui = useUi();
  const auth = useAuth();

  /**
   * THE UNIT IS CHOSEN FIRST, and never assumed.
   *
   * This screen used to stamp every report with the reporter's SAVED polling
   * unit. Plenty of observers stand at a unit they are not registered at — they
   * are there to watch, not to vote — so that stamp silently attached a
   * location claim to a published report about a place the reporter was
   * nowhere near. The unit is now a deliberate first step, and the saved one is
   * an opt-IN checkbox rather than a default that fills itself in.
   */
  const [step, setStep] = useState<Step>('unit');
  const [unit, setUnit] = useState<PickedUnit | null>(null);
  /** Filing deliberately without a unit — an explicit choice, not the absence
   *  of one. The server accepts it: pu_code and state both land null. */
  const [noUnit, setNoUnit] = useState(false);

  const [kind, setKind] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [camera, setCamera] = useState(false);
  const [useGps, setUseGps] = useState(true);

  /** The observer's own saved unit — offered, never applied on its own. */
  const [savedUnit, setSavedUnit] = useState<MyUnit | null>(null);
  /** Tells "this observer saved no unit" apart from "we never got an answer". */
  const [savedKnown, setSavedKnown] = useState(false);

  // -- GPS discovery --------------------------------------------------------
  const [nearby, setNearby] = useState<NearRow[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  const [searched, setSearched] = useState<Searched | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  /** Set only when the last GPS failure is one the settings app has to fix
   *  (location off, or permission blocked with no dialog left). Never for a
   *  timeout: permission is granted in that case and the settings screen has
   *  nothing to offer. */
  const [gpsSettings, setGpsSettings] = useState(false);

  // -- register drill-down (the fallback, so it starts folded away) ---------
  const [browse, setBrowse] = useState(false);
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [regUnits, setRegUnits] = useState<RegisterUnit[]>([]);

  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; line: string; icon: 'check' | 'clock' } | null>(
    null,
  );

  /** A decision about the unit has been made, either way. */
  const unitDecided = !!unit || noUnit;

  /** The saved-unit checkbox's own state — provenance, not identity, because
   *  the same code can also be reached through the register drill. */
  const savedPicked = unit?.via === 'saved';

  const canSubmit = useMemo(
    () => unitDecided && !!kind && (description.trim().length > 0 || media.length > 0),
    [unitDecided, kind, description, media],
  );

  /**
   * The saved unit is fetched so the checkbox can NAME it — nothing here
   * selects it. A lookup failure just means the shortcut is not offered; the
   * GPS path and the register drill are unaffected, and reporting is never
   * blocked on it.
   */
  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let live = true;
    authedGet<{ unit: MyUnit | null }>('/api/observers/my-unit')
      .then((r) => {
        if (!live) return;
        setSavedUnit(r.unit ?? null);
        setSavedKnown(true);
      })
      .catch(() => {
        if (live) setSavedKnown(true);
      });
    return () => {
      live = false;
    };
  }, [auth.status]);

  /**
   * NO CONTEST FILTER ANYWHERE ON THIS SCREEN.
   *
   * An incident is not tied to a race — there is no `contest` field on
   * POST /api/incidents — so the register must list all 36 states plus the FCT,
   * exactly as the mapping flow does. Narrowing the register to the states of
   * the running election made the whole app look broken outside Osun, and doing
   * it here would additionally refuse to let an observer report violence
   * somewhere no election is scheduled.
   */
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
      .then((d) => setRegUnits(d.units ?? []))
      .catch(() => {});
  }, [stateSel, lgaSel, wardSel]);

  /** Moving in the drill clears everything below it, including the selection —
   *  otherwise the pinned Continue stays live for a unit no longer on screen. */
  const pickState = (s: string | null) => {
    setStateSel(s);
    setLgaSel(null);
    setWardSel(null);
    setRegUnits([]);
  };
  const pickLga = (l: string | null) => {
    setLgaSel(l);
    setWardSel(null);
    setRegUnits([]);
  };
  const pickWard = (w: string | null) => {
    setWardSel(w);
    setRegUnits([]);
  };

  /** Every path into a selection goes through here, so choosing a unit always
   *  clears the "no unit" choice and vice versa. */
  const choose = (u: PickedUnit) => {
    setUnit(u);
    setNoUnit(false);
  };

  /**
   * Discovery — TWO LOOKUPS, because neither endpoint alone can list the units
   * an observer might be standing at, and each is blind to a large population
   * the other sees:
   *
   * - /api/polling-units selects `lat IS NOT NULL OR crowd_lat IS NOT NULL`. It
   *   is the only lookup that sees the 7,652 units located solely by crowd_lat
   *   with no GRID3 envelope (Rivers 3,781, Akwa Ibom 534, Delta 431, Edo 384,
   *   Abia 361, Lagos 245 …). But it measures at config.discoveryRadiusM and
   *   stops at config.discoveryMaxRows, both reported on the wire.
   * - /api/mapping/nearby reaches DISCOVERY_RADIUS_M and includes units placed
   *   only by their GRID3 envelope, but it never reads crowd_lat, so every one
   *   of those 7,652 units is structurally invisible to it.
   *
   * So both are asked and the answers merged, exactly as result.tsx and
   * map-unit.tsx do it — the screens have to agree about which units exist,
   * where their pins sit and how they are tiered.
   *
   * Either lookup may fail on its own; only losing both is fatal, and even then
   * the register drill below is still there.
   */
  const findNearby = async () => {
    setNearBusy(true);
    setNearby([]);
    setFix(null);
    setSearched(null);
    // A re-search invalidates the selection it was made from: the observer can
    // pick a unit at 150m, walk 600m and search again, and the old pick would
    // otherwise stay live in the footer while dropping out of the list. Only a
    // GPS-found selection is cleared — a saved-unit or register pick was not
    // made from this fix and is not invalidated by a new one, so this reads the
    // explicit provenance rather than inferring it from a missing flag.
    if (unit?.via === 'gps' && nearby.some((n) => n.puCode === unit.pu_code)) setUnit(null);
    setGpsSettings(false);
    setNearLine('Getting your location…');
    try {
      // Quick fix, not the submit-grade one: this only shortlists candidates,
      // and an incident report must never wait on a satellite lock.
      //
      // DISCRIMINATED failure. The old single message accused observers who had
      // granted permission of not having granted it; on an incident screen that
      // is a person mid-incident being sent into their settings for nothing.
      const r = await tryQuickFix();
      if (!r.ok) {
        const d = describeFixFailure(r);
        setNearLine(`${d.lead}, or browse the register below. (${d.code})`);
        setGpsSettings(d.settings);
        setBrowse(true);
        return;
      }
      const f = r.fix;
      setFix(f);
      setNearLine(`Location fixed (±${Math.round(f.accuracy)}m). Looking up nearby units…`);

      const [located, envelope] = await Promise.all([
        // No radius parameter exists on this one — it filters at
        // config.discoveryRadiusM and caps at config.discoveryMaxRows, and
        // reports both back rather than leaving them to be guessed.
        fetch(`${BASE}/api/polling-units?lat=${f.lat}&lng=${f.lng}`).catch(() => null),
        // This one does take a radius, and would otherwise default to 5km.
        fetch(
          `${BASE}/api/mapping/nearby?lat=${f.lat}&lng=${f.lng}&radiusM=${DISCOVERY_RADIUS_M}`,
        ).catch(() => null),
      ]);

      if (!located?.ok && !envelope?.ok) {
        const status = located?.status ?? envelope?.status;
        setNearLine(
          `Could not look up nearby units — browse the register below. (lookup_failed${status ? ` / HTTP ${status}` : ''})`,
        );
        setBrowse(true);
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
        ? (((await envelope.json().catch(() => ({}))) as { units?: NearbyApiRow[] }).units ?? [])
        : [];

      /** Recorded BEFORE the merge — afterwards the two populations are
       *  indistinguishable, and every sentence about "within Xm" needs to know
       *  which circle it is talking about. Radius, cap and truncation all come
       *  off the response; the constants only cover a server that omits them. */
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

      /**
       * THE MERGE. Keyed by pu_code; seeded from the register rows, then
       * /api/mapping/nearby fills in every unit they could not reach.
       *
       * A unit in both keeps the register row's POSITION — `lat ?? crowd_lat`,
       * the same coalesce the other two screens make, so a pin does not move
       * between them — but takes its TIER from /api/mapping/nearby, which
       * derives it from coords_source rather than from which column is filled.
       *
       * THE ENVELOPE NEVER TRAVELS WITH THE POSITION: it is attached in the
       * second loop only, from the row whose own lat/lng ARE its centre.
       */
      const merged = new Map<string, NearRow>();
      for (const u of locatedRows) {
        // Nullish, not `||`, so a genuine 0 is not thrown away.
        const uLat = u.lat ?? u.crowd_lat;
        const uLng = u.lng ?? u.crowd_lng;
        if (uLat == null || uLng == null) continue;
        // Read ahead of the server's own tier, and for one value only, exactly
        // as map-unit.tsx's rowTier does: pollingUnits.js calls any row holding
        // `lat` 'verified', and a confirmed crowd median is promoted straight
        // into `lat`. Without this a crowd-mapped unit reads as officially
        // verified on a screen that draws the two in different colours.
        const crowdMapped = u.coords_source === 'crowd_mapped';
        merged.set(u.pu_code, {
          puCode: u.pu_code,
          name: u.name,
          ward: u.ward,
          lat: uLat,
          lng: uLng,
          distanceM: u.distanceM ?? 0,
          tier: crowdMapped ? 'crowd' : toTier(u.locationTier),
          // No envelope, deliberately. This row's position is `lat ?? crowd_lat`
          // — somewhere somebody stood — while its GRID3 radius measures a box
          // around `approx_lat`, a median 2.5km elsewhere. Nothing here to draw
          // an area from, so no area is claimed.
          tierConfirmed: crowdMapped,
          fixes: u.crowd_reports ?? 0,
          where: u.lga ? `${u.ward}, ${u.lga}` : u.ward,
        });
      }
      for (const n of envelopeRows) {
        const seed = merged.get(n.puCode);
        // A register row already graded `crowd` off its own coords_source was
        // graded from the very column this endpoint grades from — nothing to
        // correct, and re-deriving it risks the two screens disagreeing.
        const tier = seed?.tierConfirmed ? seed.tier : toTier(n.status);
        /**
         * Is the point being DRAWN for this unit the envelope's own centre?
         * Only when nothing seeded it — mapping.js coalesces lat/lng to
         * approx_lat/approx_lng on precisely the rows it calls `approx`. A
         * seeded row's pin is the register's crowd fix instead, a median
         * 2,533m away, and an amber circle round it would describe a place the
         * envelope says nothing about.
         */
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
          envelope: drawnIsEnvelopeCentre ? area : undefined,
          tierConfirmed: true,
          fixes: n.fixes || seed?.fixes || 0,
          where: seed?.where ?? n.ward,
        });
      }

      // Each endpoint sorts its own answer; the union has to be sorted again.
      const all = [...merged.values()].sort((a, b) => a.distanceM - b.distanceM);
      const found = all.slice(0, MAX_NEARBY);
      setNearby(found);
      if (found.length === 0) {
        setNearLine(nothingFoundLine(scope));
        setBrowse(true);
        return;
      }
      setNearLine(
        all.length > found.length
          ? `Tap the unit this happened at — the ${found.length} closest of the ${all.length} found:`
          : 'Tap the unit this happened at:',
      );
    } catch (e) {
      setNearLine(
        `Could not look up nearby units — browse the register below. (${e instanceof Error ? e.message : String(e)})`,
      );
      setBrowse(true);
    } finally {
      setNearBusy(false);
    }
  };

  /**
   * Gallery/files picker — parity with the PWA's
   * <input type="file" accept="image/*,video/*" multiple>. Evidence often
   * already exists on the phone (filmed before opening Hawkeye, or received
   * from someone at the unit), so camera-only would lose real reports.
   *
   * Unlike result submissions, incidents carry NO photo-location coherence
   * requirement server-side — GPS is an optional stamp on the report itself —
   * so a library file is a legitimate source here. Result sheets stay
   * camera-only by design.
   */
  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setLine('Allow photo access to attach files from your device.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_MEDIA - media.length,
      quality: 0.7,
      videoMaxDuration: 90,
    });
    if (res.canceled) return;
    const picked: Media[] = res.assets.map((a) => ({
      uri: a.uri,
      capturedAt: Date.now(),
      lat: 0,
      lng: 0,
      type: a.type === 'video' ? 'video' : 'image',
    }));
    setMedia((arr) => [...arr, ...picked].slice(0, MAX_MEDIA));
  };

  const onSubmit = async () => {
    tap();
    if (!kind || !unitDecided) return;
    setBusy(true);
    setLine('Submitting…');
    try {
      const id = await getIdentity();
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      // GPS is optional for incidents — a bounded stamp fix (≤8s), never a stall.
      // An urgent report must not wait on a satellite lock indoors. Skipped
      // outright when the stamp is switched off: someone reporting the people
      // standing next to them has a real reason not to pin themselves to a map.
      //
      // NOT named `fix`: that is the discovery fix's state variable in this
      // component, and shadowing it here was only harmless by accident of
      // ordering — any future read of the discovery fix ABOVE this line would
      // have hit the local's temporal dead zone and thrown at runtime instead
      // of failing to compile. This one is the submit stamp; they are different
      // claims (where the reporter is now vs. where the unit list came from).
      //
      // getStampFix, NOT the discovery tier: this one keeps the 8s budget and
      // raises no permission dialog, because nothing on screen reports its
      // failure — the report simply files without coordinates. The longer,
      // prompting tier belongs to the near-me button, which does explain itself.
      const stampFix = useGps ? await getStampFix() : null;

      /**
       * The unit was decided on step 1, so there is nothing to look up and
       * nothing to race here. `null` is a real, supported answer — incidents.js
       * stores pu_code and state as NULL and the report still files — and it is
       * now the outcome of someone ticking "not tied to a polling unit" rather
       * than of a lookup that quietly failed.
       */
      const puCode = unit?.pu_code ?? null;

      // One description of the body, shared by the live POST and the queued
      // copy, so what the outbox eventually sends is what this attempt built.
      //
      // EVERY OPTIONAL KEY IS ADDED ONLY WHEN IT HAS A VALUE — this map is what
      // buildForm() appends to FormData, and FormData stringifies: appending a
      // null puCode would put the literal "null" on the wire, and an empty one
      // would put "". Both are truthy-enough server-side to be looked up and
      // both would fail the register lookup differently from an absent key. A
      // unit-less report therefore omits `puCode` entirely.
      const fields: Record<string, string> = { kind };
      if (description.trim()) fields.description = description.trim().slice(0, 2000);
      if (stampFix) {
        fields.lat = String(stampFix.lat);
        fields.lng = String(stampFix.lng);
      }
      if (puCode) fields.puCode = puCode;
      const files = media.map((m, i) => ({
        field: 'media',
        uri: m.uri,
        name: m.type === 'video' ? `clip${i}.mp4` : `photo${i}.jpg`,
        type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
      }));

      // Fresh FormData PER ATTEMPT: on Android a body whose file parts were
      // already streamed by a failed attempt cannot be replayed — reusing it
      // makes the retry throw instantly and masks the original error.
      const buildForm = () => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        for (const f of files) form.append(f.field, filePart(f.uri, f.name, f.type));
        return form;
      };
      const post = () =>
        fetch(`${BASE}/api/incidents`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-device-id': id.deviceId },
          body: buildForm(),
        });
      // One silent retry: a reset connection on Nigerian mobile networks is a
      // transient, not a verdict. (Server-side dedupe is not a concern here —
      // a retried incident that DID land twice just shows twice in the queue.)
      let res: Response | null = null;
      try {
        res = await post();
      } catch {
        setLine('Connection dropped — retrying…');
        try {
          res = await post();
        } catch {
          res = null;
        }
      }
      if (!res) {
        // Both attempts threw, so nothing reached the server — hand the report
        // to the outbox instead of asking someone in the middle of an incident
        // to hold the screen open until the network returns. Queued ONLY on
        // this path: a request that came back with an HTTP answer WAS received,
        // and replaying it would file the same incident twice.
        try {
          await queueJob({
            kind: 'incident',
            body: fields,
            files,
            label: `Incident — ${KINDS.find((k) => k.code === kind)?.label ?? kind}`,
          });
        } catch (e) {
          setLine(
            `Upload failed and the report could not be saved for later — nothing was sent. (${e instanceof Error ? e.message : String(e)})`,
          );
          return;
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Saved to send later',
          icon: 'clock',
          line: 'No connection right now. Your report and its evidence are stored on this phone and go out on their own once you are back online — you can close the app.',
        });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: number;
        error?: string;
        hint?: string;
      };
      if (res.ok && body.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Incident reported',
          icon: 'check',
          line: 'Your report is under review. If accepted, it appears on the public incident log — your identity stays your observer ID only.',
        });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        // Always name the failure: a code the user can read back beats a shrug.
        const code = body.error ?? `HTTP ${res.status}`;
        setLine(
          body.error === 'empty_report' ? 'Add a photo, video or a description.'
          : body.error === 'invalid_media' ? (body.hint ?? 'One file could not be processed — retake it.')
          : `${body.hint ?? 'Submission failed — try again.'} (${code})`,
        );
      }
    } catch (e) {
      // Getting here means the upload itself did NOT fail (that path queues) —
      // identity, the token read or the GPS fix threw. Name the exception:
      // "Network request failed" and a JS error are very different diagnoses.
      const msg = e instanceof Error ? e.message : String(e);
      setLine(`Could not prepare the report — nothing was sent. (${msg})`);
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
          Sign in to report an incident
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

  if (camera) {
    return (
      <CaptureCamera
        title="Capture Evidence"
        hint="Photo, or switch to video (up to 90s). Stay safe — distance first."
        allowVideo
        onCapture={(m) => {
          setMedia((arr) => [...arr, m].slice(0, MAX_MEDIA));
          setCamera(false);
        }}
        onCancel={() => setCamera(false)}
      />
    );
  }

  if (done) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-surface px-8">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
          {/* A tick on a queued report would claim a delivery that has not
              happened — the icon has to tell the two outcomes apart. */}
          <Feather name={done.icon} size={28} color={BRAND.gold} />
        </View>
        <Text className="pt-4 text-center text-lg font-bold text-ink">{done.title}</Text>
        <Text className="pt-2 text-center text-sm text-muted">{done.line}</Text>
        <Pressable
          className="mt-6 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
          onPress={() => router.back()}
        >
          <Text className="text-base font-bold text-hawk-gold">Done</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  /** Map markers and list rows are built from one array, so a tap on either
   *  lands in the same selection. */
  const mapUnits: MapUnit[] = nearby.map((n) => ({
    puCode: n.puCode,
    name: n.name,
    lat: n.lat,
    lng: n.lng,
    tier: n.tier,
    envelope: n.envelope,
  }));

  const ringM = searched?.envelopeM ?? searched?.registerM ?? DISCOVERY_RADIUS_M;

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
        <Text className="pl-3 text-lg font-bold text-ink">Report an incident</Text>
      </View>

      {/* Two stages, so the observer can see that naming the place comes first
          and is not a field they may skip past without noticing. */}
      <View className="flex-row px-4 pt-3">
        {(['unit', 'report'] as Step[]).map((s, i) => {
          const on = s === 'unit' || step === 'report';
          return (
            <View key={s} className="mr-1 flex-1">
              <View className={`h-1.5 rounded-full ${on ? 'bg-hawk-leaf' : 'bg-card'}`} />
              <Text
                className={`pt-1 text-center text-[10px] font-semibold ${on ? 'text-hawk-leaf' : 'text-faint'}`}
              >
                {i === 0 ? 'Where' : 'What happened'}
              </Text>
            </View>
          );
        })}
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        className="flex-1"
      >
        {step === 'unit' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
            <Prompt>Which polling unit is this about?</Prompt>
            <Text className="pb-3 text-sm text-muted">
              The unit you are AT, which may not be the one you are registered at. It decides which
              state the report is filed under and which watchers are alerted.
            </Text>

            {/* GPS FIRST. Someone standing at a unit they are only observing
                knows where they are, not that ward's spelling in the register. */}
            <Pressable
              disabled={nearBusy}
              onPress={findNearby}
              className={`flex-row items-center justify-center rounded-2xl py-4 ${nearBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
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
              <Text className="pt-3 text-sm font-semibold text-warn-ink">{nearLine}</Text>
            ) : null}

            {/* Only for the failures system settings can actually fix. The
                "Find units near me" button is already the retry. */}
            {gpsSettings ? (
              <Pressable
                onPress={() => Linking.openSettings()}
                className="mt-2 flex-row items-center self-start rounded-xl border border-line px-3 py-2 active:opacity-70"
              >
                <Feather name="settings" size={14} color={ui.muted} />
                <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
              </Pressable>
            ) : null}

            {/* The register lookup caps its answer — in a dense ward the one
                you are at can be the row past the cap, and the list above would
                look complete. Shown only when the server reports the answer as
                truncated, and quoting the server's own cap and radius. */}
            {searched?.capped && nearby.length ? (
              <Text className="pt-1 text-xs text-muted">
                Units already placed by observers are looked up {searched.maxRows} at a time within{' '}
                {searched.registerM}m, and that limit was reached — if the one you want is not
                listed, browse the register below.
              </Text>
            ) : null}

            {/* Gated on `searched` as well as `fix`: the ring is a claim about a
                radius something was queried at, and between the fix landing and
                the lookups answering nothing has been queried at any radius. */}
            {fix && searched && mapAvailable() ? (
              <View className="pt-3">
                <UnitMap
                  center={{ lat: fix.lat, lng: fix.lng }}
                  accuracyM={fix.accuracy}
                  units={mapUnits}
                  selected={unit?.pu_code}
                  onSelect={(code) => {
                    const row = nearby.find((n) => n.puCode === code);
                    if (row)
                      choose({
                        pu_code: row.puCode,
                        name: row.name,
                        where: row.where,
                        via: 'gps',
                      });
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
                    onPick={choose}
                  />
                ))}
              </View>
            ) : null}

            {/* THE SAVED UNIT — OFFERED, NEVER APPLIED. Unticked on arrival, so
                a report can only be labelled with the reporter's own unit
                because they said so. Rendered only once we know the code, since
                the code is the entire payload the server reads.

                A NULL NAME IS NOT A COSMETIC GAP. my-unit LEFT JOINs the
                register, so a bare row means the saved code is not in
                `polling_units` — incidents.js will find nothing to copy a state
                from and file the report with state NULL, which is the "no unit"
                outcome wearing a code. The shortcut is still offered (a
                reviewer can read the code, which is more than the no-unit path
                carries) but it says what it will actually do rather than
                inheriting the promise above that watchers get alerted. */}
            {savedUnit ? (
              <Pressable
                onPress={() =>
                  savedPicked
                    ? setUnit(null)
                    : choose({
                        pu_code: savedUnit.pu_code,
                        name: savedUnit.name ?? savedUnit.pu_code,
                        via: 'saved',
                        unlisted: !savedUnit.name,
                      })
                }
                accessibilityRole="checkbox"
                accessibilityState={{ checked: savedPicked }}
                className="mt-4 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80"
              >
                <Feather
                  name={savedPicked ? 'check-square' : 'square'}
                  size={19}
                  color={savedPicked ? BRAND.leaf : ui.faint}
                />
                <View className="flex-1 pl-3">
                  <Text className="text-sm font-semibold text-ink">
                    I am at my own polling unit
                  </Text>
                  <Text className="text-xs text-muted">
                    {savedUnit.name ?? savedUnit.pu_code} ({savedUnit.pu_code})
                  </Text>
                  {savedUnit.name ? null : (
                    <Text className="pt-1 text-xs font-semibold text-warn-ink">
                      This code is not in the register, so the report would carry the code but no
                      state, and no unit watchers would be alerted. Use “Find units near me” or
                      the register below if you can.
                    </Text>
                  )}
                </View>
              </Pressable>
            ) : savedKnown ? null : (
              <Text className="mt-4 text-xs text-faint">Checking your saved polling unit…</Text>
            )}

            {/* FILING WITH NO UNIT STAYS POSSIBLE, and is labelled for what it
                is. incidents.js stores pu_code and state as NULL on this path;
                the report is still reviewed and can still be published, it just
                carries no place. */}
            <Pressable
              onPress={() => {
                setNoUnit((v) => !v);
                setUnit(null);
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: noUnit }}
              className="mt-2 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80"
            >
              <Feather
                name={noUnit ? 'check-square' : 'square'}
                size={19}
                color={noUnit ? BRAND.leaf : ui.faint}
              />
              <View className="flex-1 pl-3">
                <Text className="text-sm font-semibold text-ink">
                  This is not tied to a polling unit
                </Text>
                <Text className="text-xs text-muted">
                  Filed with no unit and no state. Reviewers still see it; unit watchers are not
                  alerted, and it will not appear under any state on the public log.
                </Text>
              </View>
            </Pressable>

            {/* Search by name/code, above the cascade — knowing the unit's name
                but not its ward is the case the cascade cannot serve. */}
            <UnitSearch<PickedUnit> onSelect={choose} />
            <Pressable
              onPress={() => setBrowse((b) => !b)}
              className="mt-4 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-70"
            >
              <Feather
                name={browse ? 'chevron-down' : 'chevron-right'}
                size={16}
                color={BRAND.leaf}
              />
              <Text className="flex-1 pl-2 text-sm font-bold text-hawk-leaf">
                Browse the register instead
              </Text>
              <Text className="text-xs text-faint">state › LGA › ward</Text>
            </Pressable>

            {browse ? (
              <View className="pt-3">
                {!stateSel ? (
                  <>
                    <Prompt>Select the state</Prompt>
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
                    <Prompt>Select the LGA</Prompt>
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
                    <Prompt>Select the ward</Prompt>
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
                    <Prompt>Select the polling unit</Prompt>
                    {regUnits.map((u) => (
                      <RegisterRow
                        key={u.pu_code}
                        u={u}
                        selected={unit?.pu_code === u.pu_code}
                        onPick={choose}
                      />
                    ))}
                    {regUnits.length === 0 ? (
                      <Text className="pt-2 text-sm text-muted">
                        No units in the register for this ward yet.
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        ) : (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
            {/* What this report will claim about WHERE, one tap from being
                changed — the observer sees it above every field they fill in
                rather than as a footnote under the description box. */}
            <Crumb
              label={unit ? `${unit.name} (${unit.pu_code})` : 'No polling unit'}
              onPress={() => setStep('unit')}
            />

            <Prompt>Select what happened</Prompt>
            <View className="flex-row flex-wrap">
              {KINDS.map((k) => (
                <Pressable
                  key={k.code}
                  onPress={() => setKind(k.code)}
                  className={`mb-2 mr-2 flex-row items-center rounded-full px-4 py-2 ${
                    kind === k.code ? 'bg-hawk-green' : 'bg-card'
                  }`}
                >
                  <Feather
                    name={k.icon}
                    size={13}
                    color={kind === k.code ? BRAND.gold : ui.faint}
                  />
                  <Text
                    className={`pl-1.5 text-sm font-semibold ${
                      kind === k.code ? 'text-hawk-gold' : 'text-ink'
                    }`}
                  >
                    {k.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View className="pt-3">
              <Prompt>Add evidence, or describe it below</Prompt>
            </View>
            <View className="flex-row flex-wrap">
              {media.map((m, i) => (
                <View key={m.uri} className="mb-2 mr-2 overflow-hidden rounded-xl bg-card">
                  <Image
                    source={{ uri: m.uri }}
                    style={{ width: 76, height: 76 }}
                    contentFit="cover"
                  />
                  {m.type === 'video' ? (
                    <View className="absolute inset-0 items-center justify-center bg-black/30">
                      <Feather name="play" size={20} color="#fff" />
                    </View>
                  ) : null}
                  <Pressable
                    hitSlop={8}
                    className="absolute right-1 top-1 h-5 w-5 items-center justify-center rounded-full bg-black/60"
                    onPress={() => setMedia((arr) => arr.filter((_, j) => j !== i))}
                  >
                    <Feather name="x" size={11} color="#fff" />
                  </Pressable>
                </View>
              ))}
              {media.length < MAX_MEDIA ? (
                <>
                  <Pressable
                    className="mb-2 mr-2 h-[76px] w-[76px] items-center justify-center rounded-xl border-2 border-dashed border-hawk-leaf bg-card"
                    onPress={() => setCamera(true)}
                  >
                    <Feather name="camera" size={20} color={BRAND.leaf} />
                    <Text className="pt-1 text-[10px] font-semibold text-hawk-leaf">Camera</Text>
                  </Pressable>
                  <Pressable
                    className="mb-2 h-[76px] w-[76px] items-center justify-center rounded-xl border-2 border-dashed border-hawk-leaf bg-card"
                    onPress={pickFromLibrary}
                  >
                    <Feather name="image" size={20} color={BRAND.leaf} />
                    <Text className="pt-1 text-[10px] font-semibold text-hawk-leaf">Upload</Text>
                  </Pressable>
                </>
              ) : null}
            </View>

            <Text className="pb-2 pt-3 text-sm font-semibold text-muted">Description</Text>
            <TextInput
              className="min-h-[110px] rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder="What did you witness? Where, when, who was involved…"
              placeholderTextColor={ui.faint}
              multiline
              textAlignVertical="top"
              maxLength={2000}
              value={description}
              onChangeText={setDescription}
            />

            {/* Location is opt-OUT, matching the PWA's checked-by-default box.
                This is the reporter's OWN position, which is a different claim
                from the polling unit chosen on step 1 — an observer standing
                among the people they are reporting has a real reason to give
                the unit and withhold themselves. */}
            <Pressable
              onPress={() => setUseGps((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: useGps }}
              className="mt-3 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80"
            >
              <Feather
                name={useGps ? 'check-square' : 'square'}
                size={19}
                color={useGps ? BRAND.leaf : ui.faint}
              />
              <View className="flex-1 pl-3">
                <Text className="text-sm font-semibold text-ink">Attach my current location</Text>
                <Text className="text-xs text-muted">
                  {useGps
                    ? 'Helps reviewers place the incident. Coordinates are never published.'
                    : 'No coordinates will be attached to this report.'}
                </Text>
              </View>
            </Pressable>

            {/* THREE OUTCOMES, NOT TWO. A unit chosen from a code the register
                does not list sits between "filed under X" and "no unit": the
                code travels, the state does not, and nobody is watching a unit
                the register has never heard of. */}
            {unit && !unit.unlisted ? (
              <Text className="pt-3 text-xs text-muted">
                Filed under {unit.name} ({unit.pu_code})
                {unit.where ? ` — ${unit.where}` : ''}. Watchers there are alerted once a reviewer
                approves it.
              </Text>
            ) : unit ? (
              <Text className="pt-3 text-xs text-muted">
                Filed with the code {unit.pu_code}, which is not in the register — reviewers see
                the code, but the report carries no state and no unit watchers are alerted.
              </Text>
            ) : (
              <Text className="pt-3 text-xs text-muted">
                Filed without a polling unit, so it carries no state and no unit watchers are
                alerted. Reviewers still see it.
              </Text>
            )}

            {/* BACK IN THE SCROLL, where it was before the safety card took it
                into the footer. This is reassurance you read once while filling
                the form, not an instruction you need in front of you at the
                moment of submitting — and the footer is fixed space it was
                taking straight off the description box's scroll height. */}
            <Text className="pt-2 text-xs text-muted">
              Reports are reviewed before publication, and your phone number is never attached —
              a published report carries your observer ID only.
            </Text>
          </ScrollView>
        )}

        {/* PINNED, on both steps: the kind grid, evidence thumbnails and the
            description box all grow above it, so the one committing action
            would otherwise sit off-screen — and an incident is filed one-handed,
            under time pressure. The status line rides in the footer too, so a
            failed attempt doesn't push the retry button further away. */}
        <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
          {/* THE SAFETY WARNING, ON ITS OWN HAZARD CARD AND OUT OF THE SCROLL.
              It used to be a grey line below the description box, which scrolled
              away exactly when someone was deep in filing.

              ONE SENTENCE, AND IT HAS TO STAY ONE. This card shares fixed
              footer space with the submit button, so every line here comes
              straight off the description box's scroll height — on a small
              phone with the keyboard up, the two-sentence version left the box
              shorter than the card warning about it. Anything that is context
              rather than an instruction (review, phone numbers) belongs in the
              scroll on step 2, and now is.

              bg-caution / text-caution-ink, NOT bg-warn: --warn is the app's
              informational tint and is soft on purpose — it carries the docket,
              collation and result notices, i.e. most of the screens — so it
              could never make this one unmistakable without shouting
              everywhere else. --caution is the hazard pair, reserved for safety
              of person, and this card takes BOTH halves of it. The old version
              set warn-tinted fill under text-ink, the one place in the app
              where a tinted surface and its copy came from different families;
              the ink now comes from the same pair as the fill (5.9:1 light,
              5.6:1 dark, so it carries body copy and not just the icon). */}
          <View className="mb-3 flex-row items-center rounded-2xl border border-caution-ink/30 bg-caution px-3 py-2.5">
            <Feather name="alert-triangle" size={18} color={ui.tint.caution.ink} />
            <Text className="flex-1 pl-2.5 text-xs font-semibold text-caution-ink">
              Your safety comes first — never confront anyone to get footage.
            </Text>
          </View>

          {step === 'unit' ? (
            <Pressable
              disabled={!unitDecided}
              onPress={() => setStep('report')}
              className={`items-center rounded-2xl py-4 ${unitDecided ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">
                {unit
                  ? 'Continue — what happened'
                  : noUnit
                    ? 'Continue without a unit'
                    : 'Choose a unit, or tick an option above'}
              </Text>
            </Pressable>
          ) : (
            <>
              {line ? (
                <Text className="pb-2 text-sm font-semibold text-warn-ink">{line}</Text>
              ) : null}
              <Pressable
                disabled={!canSubmit || busy}
                onPress={onSubmit}
                className={`items-center rounded-2xl py-4 ${
                  canSubmit && !busy ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Submit incident report</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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

import { CaptureCamera } from '@/components/capture-camera';
import { ContestPicker } from '@/components/contest-picker';
import { NoElection } from '@/components/no-election';
import { RekorAnchor } from '@/components/rekor-anchor';
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
import { api, BRAND, type Contest, type Party } from '@/lib/api';
import { pick, tap } from '@/lib/haptics';
import {
  ELECTION_TYPES,
  isRaceOpen,
  listRaces,
  type Race,
  type StateName,
} from '@/lib/races';
import { extractCandidates, resolveUnitFromText } from '@/lib/pu-code';
import { useUi } from '@/lib/theme';
import { useAuth } from '@/lib/auth';
import {
  describeFixFailure,
  DISCOVERY_RADIUS_M,
  trySubmitFix,
  tryQuickFix,
  type Fix,
} from '@/lib/location';
import { submitResult, type Receipt, type Shot, type Vote } from '@/lib/submit';

const BASE = 'https://hawkeye.com.ng';
const REG = `${BASE}/api/register`;

/** A register row — every field the rest of this screen reads off the selection.
 *  The tier fields ride along (the API SELECT *s the register row) so browse
 *  rows can carry the same location badge the nearby rows and the web show. */
type Unit = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
  coords_source?: string | null;
  locationTier?: string;
  lat?: number | null;
  crowd_lat?: number | null;
};

/**
 * /api/polling-units hands back whole register rows, so it is the only lookup
 * that can name a unit's state — and its coordinates arrive raw: officially
 * verified ones in lat/lng, everything else (crowd medians and geocodes alike)
 * in crowd_lat/crowd_lng.
 */
type LocatedRow = Unit & {
  lat?: number | null;
  lng?: number | null;
  crowd_lat?: number | null;
  crowd_lng?: number | null;
  /**
   * On the wire (`SELECT *`). NEVER used to draw.
   *
   * It measures a GRID3 box centred on `approx_lat`/`approx_lng`, which this
   * row does not position itself by — `lat ?? crowd_lat` above is a median
   * 2.5km from it. Pairing this radius with that point was the original bug,
   * so no map circle may ever be built from it.
   *
   * It IS read for the server's gate, which measures from the envelope centre
   * regardless of where the pin sits — and it must be, because rows that only
   * reach us through /api/mapping/nearby are already within 800m of that
   * centre and so can never trip a limit that starts at 2,900m. The three
   * fields travel together into `fenceEnvelope`, never into `MapUnit.envelope`.
   */
  approx_radius_m?: number | null;
  approx_lat?: number | null;
  approx_lng?: number | null;
  coords_source?: string | null;
  crowd_reports?: number | null;
  locationTier?: string;
  distanceM?: number;
};

/**
 * /api/mapping/nearby's row shape: camelCase, positioned, and thinner than a
 * register row — it carries no LGA and, crucially, no state. Its lat/lng are
 * already coalesced server-side (verified coordinate, else the GRID3 envelope
 * centre), and `status` is derived from coords_source rather than from which
 * column happened to be filled.
 */
type NearbyRow = {
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
   * This is not `lat`/`lng` with a radius bolted on. For the 109,507 units that
   * have both a crowd fix and an envelope the two are a median 2.5km apart
   * (10km at p90, 145km at worst), so pairing one source's point with the
   * other's radius asserts an area centred on a place the envelope says nothing
   * about. Whenever the register lookup also saw the unit its crowd position
   * wins the pin — and this field is then EMPTY, because the circle would no
   * longer be about the dot. The area is still known; it lives in
   * `fenceEnvelope` below, which nothing draws.
   */
  envelope?: MapEnvelope;
  /**
   * THE AREA THE SERVER GATES ON — never drawn, never passed to
   * `MapUnit.envelope`, and set for every `approx` row whether or not the
   * register lookup also placed the unit.
   *
   * backend/src/routes/submissions.js:143-150 hard-403s `too_far_from_unit`
   * when the submit fix is further than `approx_radius_m * 1.5 + 2000` from
   * `approx_lat`/`approx_lng` — the ENVELOPE's centre, not the pin's. That
   * branch runs exactly when `pu.lat IS NULL`, which is exactly when
   * /api/mapping/nearby reports `approx`, so an approx row's fence is this
   * circle even when the pin sits on a crowd median kilometres away.
   *
   * Kept apart from `envelope` on purpose: the map's contract is that a circle
   * is drawn at its own centre, and this centre is not the drawn point. It is
   * read by the pre-capture warning and by nothing else.
   */
  fenceEnvelope?: MapEnvelope;
  /**
   * Did /api/mapping/nearby actually grade this row?
   *
   * Only that endpoint can tell a crowd-mapped unit from an officially verified
   * one — /api/polling-units reports both as `verified`, because it tiers on
   * which COLUMN is filled and a crowd median is promoted into `lat`. The
   * geofence the observer is warned against differs by a factor of nearly four
   * between the two (200m vs 750m), so a row that only the register lookup saw
   * must not be judged as though the distinction had been made.
   */
  tierConfirmed: boolean;
  fixes: number;
  /**
   * The register row, when the merge already had one. `null` means only
   * /api/mapping/nearby knew about this unit, so its state — which decides
   * which races run there — still has to be fetched before it can be selected.
   */
  unit: Unit | null;
};

/** Enough to find the unit you are standing at; short enough to still scan. */
const MAX_NEARBY = 12;

/**
 * WHAT EACH LOOKUP ACTUALLY SEARCHED — the numbers the copy on this screen is
 * only allowed to make claims about.
 *
 * /api/polling-units does NOT take a radius. It filters at
 * `config.discoveryRadiusM` and slices to `config.discoveryMaxRows`
 * (backend/src/routes/pollingUnits.js) — a deliberately WIDER window than the
 * submission geofence (`config.geofenceRadiusM`), which answers a different
 * question and is a different number. It is also the only lookup that can see
 * the 7,652 units positioned solely by `crowd_lat`, so those units are reachable
 * at the discovery radius and nowhere else — no matter what the map's ring is
 * drawn at.
 *
 * BOTH numbers now come off the wire: the response carries `radiusM`, `maxRows`
 * and an explicit `capped`, and all three are preferred over the mirrors below.
 * The mirrors exist only for a server too old to report them. A client-side copy
 * of a server-owned number rots silently the moment the server changes it —
 * which is precisely how this screen came to warn about truncation at eight rows
 * long after the server had stopped truncating there.
 */
const REGISTER_RADIUS_M = 500; // config.discoveryRadiusM, as of writing
const REGISTER_MAX_ROWS = 40; // config.discoveryMaxRows, as of writing

/** What the two lookups covered on the last run, so the screen can describe the
 *  area it really searched instead of the area it drew. */
type Searched = {
  /** Radius /api/polling-units filtered at, or null if it never answered. */
  registerM: number | null;
  /** Radius /api/mapping/nearby was asked for, or null if it never answered. */
  envelopeM: number | null;
  /**
   * The row cap /api/polling-units applied — its own `maxRows`, so the copy
   * quotes the server's number instead of a mirror that can drift from it.
   */
  maxRows: number;
  /**
   * The register lookup hit that cap, so nearer units may be missing. The
   * server states this outright in `capped`; only a server too old to send it
   * leaves the row count to be compared against the cap.
   */
  capped: boolean;
};

/**
 * How long a register lookup may hang before the tap is given back.
 *
 * React Native's fetch has no default timeout, so on a stalled connection —
 * election day, one mast, ten thousand phones — a tap would otherwise leave the
 * row spinning forever with no error and no way out of the screen.
 */
const PICK_TIMEOUT_MS = 12_000;

/**
 * Where the screen starts saying out loud that a located unit is far away.
 *
 * Discovery reaches 800m, the submission geofence does not — so a unit can be
 * listed here and still be too far to file from. These mirror
 * backend/src/routes/submissions.js: the fence widens for crowd-mapped
 * coordinates, because the booth can stand anywhere inside the area observers
 * mapped, and warning at 200m there would talk observers out of submissions the
 * server would have accepted.
 *
 * `approx` is INFINITY here and that is not "no gate" — it is "no gate measured
 * from this point". submissions.js fences on distance to `pu.lat` and only runs
 * that branch when `pu.lat` is set, which an approx unit's is not by
 * definition. Its gate is a circle round a DIFFERENT centre and is checked
 * separately, against `fenceEnvelope`, by `envelopeHardLimitM` below.
 *
 * The server still owns the actual decision; these numbers only pick the moment
 * to warn, before two photos and a full tally have been spent.
 */
const FAR_ENOUGH_TO_WARN_M: Record<UnitTier, number> = {
  verified: 200, // config.geofenceRadiusM
  crowd: 750, // config.crowdGeofenceRadiusM
  approx: Number.POSITIVE_INFINITY,
};

/**
 * The gate an approx unit really has, copied from
 * backend/src/routes/submissions.js:143-150:
 *
 *   } else if (pu.approx_lat != null) {
 *     const approxDist = haversineM(lat, lng, pu.approx_lat, pu.approx_lng);
 *     if (approxDist > pu.approx_radius_m * 1.5 + 2000) {
 *       return res.status(403).json({ error: 'too_far_from_unit' });
 *
 * A hard 403, not a flag — the flag is the second, 1000m-and-accuracy test one
 * line further down, which only downgrades `locationPlausible` and is none of
 * this screen's business. Roughly the top decile of the 109,507 geocoded units
 * are far enough out to cross this, and crossing it costs the observer two
 * photos and a full tally before the server says no.
 */
const envelopeHardLimitM = (radiusM: number) => radiusM * 1.5 + 2000;

/**
 * Metres between two positions — the same arithmetic as
 * backend/src/services/geo.js (same earth radius, same formula), because this
 * one number decides whether the screen contradicts the server about a
 * threshold the server is about to enforce.
 */
const haversineM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * The fence to warn at when the tier was never confirmed — i.e. the row came
 * only from /api/polling-units, because /api/mapping/nearby failed.
 *
 * That lookup is wrapped in a catch and is ALLOWED to fail; on election day, on
 * one overloaded mast, it is the likelier of the two to. Without it every row
 * carries `verified`, since /api/polling-units tiers on which column is filled
 * and a crowd-mapped median lives in `lat` — so the narrow 200m fence would be
 * asserted over units the server accepts to 750m, and an observer standing 400m
 * from their own polling unit would be told to move for no reason.
 *
 * So the widest fence the server states in metres is used instead
 * (config.crowdGeofenceRadiusM). It is the widest any row this endpoint can
 * return is subject to: submissions.js fences only when `pu.lat` is set, at 200m
 * or 750m, and applies a far looser envelope check to everything else. Warning
 * late is recoverable — the server refuses and says the real distance. Warning
 * early on a guess talks an observer out of a submission that would have stood.
 */
const UNCONFIRMED_FENCE_M = 750;

type Step = 'unit' | 'contest' | 'sheet' | 'venue' | 'votes' | 'review' | 'done';

// CAPTURE FIRST. The EC8A sheet is the perishable thing on election day — an
// INEC agent may display it briefly, a crowd forms, access closes. Which unit,
// which race and what the figures say are all still true five minutes later,
// from somewhere safer. The old order (unit, race, THEN sheet) made the durable
// steps block the perishable one, and cost observers the shot.
//
// Both photos sit together at the front: same physical position, one context
// switch. Interleaving capture with typing would spend the freshness budget in
// the crowd and make the observer re-settle for the second shot.
//
// Step order is cryptographically free — the observer signature is one ECDSA
// sign over the whole canonical payload at submit, so nothing here touches the
// ledger or any server-side gate. See docs/REPORT-FLOW-CAPTURE-FIRST.md.
const STEPS: { key: Step; label: string }[] = [
  { key: 'sheet', label: 'Sheet' },
  { key: 'venue', label: 'Venue' },
  { key: 'unit', label: 'Unit' },
  { key: 'contest', label: 'Race' },
  { key: 'votes', label: 'Votes' },
  { key: 'review', label: 'Send' },
];

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
 * The receipt's location line.
 *
 * Two of its three endings are tiers the map also draws, so they borrow its
 * wording and its colour verbatim — the dot beside this line is the same dot as
 * the pin the observer tapped. The third is not a tier at all: a report can be
 * filed at a unit that has no position, and "Approximate area only" would be
 * describing the unit when the sentence is about the report.
 */
const receiptLocation = (r: Receipt): { label: string; color: string } => {
  const status = r.result?.locationStatus ?? (r.locationVerified ? 'verified' : undefined);
  if (status === 'verified') return { label: TIER_LABEL.verified, color: TIER_COLOR.verified };
  if (status === 'provisional') {
    return {
      label: `${TIER_LABEL.crowd} (${r.result?.locationConfidence ?? 0}% agree)`,
      color: TIER_COLOR.crowd,
    };
  }
  return { label: 'Location not verified', color: TIER_COLOR.approx };
};

/**
 * What the ring on the map is, in words, given what actually answered.
 *
 * The ring can only ever be one circle, and the two lookups behind this screen
 * search two different ones — DISCOVERY_RADIUS_M for units with a GRID3 area,
 * and whatever /api/polling-units reports as its own `radiusM`
 * (config.discoveryRadiusM) for units an observer has already placed. Both
 * numbers are read off the answers rather than asserted, which is why the
 * sentences below interpolate `s.envelopeM`/`s.registerM` and never a literal.
 * Drawing the wider and leaving it unlabelled
 * reads as "everything in here was checked", which is false for the 7,652 units
 * only the narrow lookup can see. So the ring is named.
 */
const ringLine = (_s: Searched): string =>
  'Units found within an 800m radius. Unmapped units may not appear on map.';

/** The same honesty for an empty answer: name the circles that were searched,
 *  rather than the one that was drawn. */
const nothingFoundLine = (s: Searched): string => {
  if (s.envelopeM != null && s.registerM != null) {
    return `No polling unit found. Hawkeye searched ${s.registerM}m around you for units observers have already placed, and ${s.envelopeM}m for units known only by their mapped area — browse the register below to find yours by name.`;
  }
  if (s.envelopeM != null) {
    return `No polling unit with a mapped area within ${s.envelopeM}m of you, and the lookup that finds units placed by observers did not answer — browse the register below to find yours by name.`;
  }
  if (s.registerM != null) {
    return `No polling unit within ${s.registerM}m of you, and the wider search for units with a mapped area did not answer — browse the register below to find yours by name.`;
  }
  // POINT AT SEARCH, NOT BROWSE. This is the NETWORK-failure case, and browsing
  // the register is itself network-backed (/lgas, /wards, /units) — so the old
  // copy sent an observer whose DNS had just failed to the one other path that
  // could not work either. Search answers from the register bundled into the
  // app, which is the only unit lookup that survives having no connection.
  return 'Could not look up nearby units. Search for yours by name below — the polling unit list works without a connection.';
};

/**
 * The line for a lookup that FAILED rather than one that came back empty, and
 * the one an observer whose DNS has just died actually sees. Same correction as
 * above and for the same reason: browsing is network-backed (/lgas, /wards,
 * /units), so on this failure it is the one other path that cannot work either,
 * while search answers from the register bundled into the app.
 *
 * The detail stays. "lookup_failed" with nothing after it was unactionable — it
 * could not be told apart from a timeout, a DNS failure or a 500, which cost a
 * whole debugging round once.
 */
const lookupFailedLine = (detail: string): string =>
  `Could not look up nearby units. Search for yours by name below — the polling unit list works without a connection. (${detail})`;

/** The tier's colour, sized for a line of text — so a row, a receipt line and
 *  the pin they refer to all carry the same mark. */
const TierDot = ({ tier }: { tier: UnitTier }) => (
  <View
    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TIER_COLOR[tier] }}
    className="mr-1.5"
  />
);

/**
 * THE LIST / UI COMPONENTS LIVE AT MODULE SCOPE, and must stay here.
 *
 * They used to be declared inside ReportResult's body. A component created
 * during render is a NEW function identity every render, so React treats it as a
 * different component type and unmounts the whole subtree rather than updating
 * it: every register row and every nearby row was torn down and rebuilt on any
 * state change — a selection tap sets `picking`, which remounted the entire
 * nearby list and lost the press/ripple feedback mid-gesture. Hoisted, the type
 * is stable and a re-render is a re-render. Mirrors report/incident.tsx.
 *
 * Everything they need therefore arrives as props — no closure over the
 * screen's state.
 */

const Chip = ({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) => (
  <Pressable
    onPress={onPress}
    className={`mb-2 mr-2 rounded-full px-4 py-2 ${on ? 'bg-hawk-green' : 'bg-card'}`}
  >
    <Text className={`text-sm font-semibold ${on ? 'text-hawk-gold' : 'text-ink'}`}>{label}</Text>
  </Pressable>
);

/** A register-browse row: the drill-down already said where you are, so the
 *  sub-line only has to name the unit. */
const UnitRow = ({
  u,
  sub,
  selected,
  onChoose,
  onContinue,
}: {
  u: Unit;
  sub: string;
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
      <Text className={`text-xs ${selected ? 'text-emerald-100' : 'text-muted'}`}>{sub}</Text>
      {/* Same badge the nearby rows carry — browse rows shipped without it
          while the web's browse rows had one. */}
      <RegisterTierBadge u={u} selected={selected} />
    </View>
    {/* Inline Continue on the chosen row: in a long ward the footer CTA can
        sit far below the unit you just tapped. */}
    {selected ? (
      <Pressable
        className="flex-row items-center rounded-xl bg-hawk-gold px-3 py-2 active:opacity-80"
        onPress={onContinue}
      >
        {/* Fixed ink on a fixed brand surface. text-ink/ui.ink flip with the
            theme, and near-white on hawk-gold is 1.6:1 — invisible in dark
            mode. The gold does not flip, so neither may the text on it. */}
        <Text className="pr-1 text-sm font-bold text-hawk-ink">Continue</Text>
        <Feather name="arrow-right" size={14} color={BRAND.ink} />
      </Pressable>
    ) : null}
  </Pressable>
);

/**
 * A GPS-discovered row. Its tier is stated in the same words the map legend
 * uses, so the pin and the row beside it cannot grade the same unit
 * differently — and an approx unit says plainly what it costs, with the fix
 * for it one tap away rather than buried in another screen's menu entry.
 */
const NearbyRow = ({
  n,
  selected,
  loading,
  onChoose,
  onContinue,
}: {
  n: NearRow;
  selected: boolean;
  loading: boolean;
  onChoose: (n: NearRow) => void;
  onContinue: () => void;
}) => {
  const tier = n.tier;
  return (
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
          {/* Same words and same colour as the pin this row refers to —
              TierDot carries the map's palette down onto the list. */}
          <View className="flex-row items-center pt-0.5">
            <TierDot tier={tier} />
            <Text className={`flex-1 text-xs ${selected ? 'text-emerald-100' : 'text-muted'}`}>
              {TIER_LABEL[tier]}
              {/* The area in words, from the SHARED formatter — both screens
                  describe the same envelope and had drifted (~1,200m here
                  against ~1200m there for one unit).

                  Read off `n.envelope`, so it appears only where the dot
                  beside it IS that area's centre. On a unit the register also
                  placed, the dot is a crowd fix kilometres from the centre and
                  "within ~2,800m" beside it would be read as a claim about the
                  dot; that area is stated in the selected row's paragraph
                  below, which has room to say whose centre it is.

                  This is the ONLY channel for a large one either way: the map
                  stops drawing envelopes it cannot show the edge of, and real
                  radii average 2.8km against an 800m search. */}
              {tier === 'approx' && n.envelope ? envelopeText(n.envelope.radiusM) : ''}
              {tier !== 'approx' && n.fixes ? ` · ${n.fixes} observer fix(es)` : ''}
            </Text>
          </View>
        </View>
        {/* Inline Continue on the chosen row: in a dense ward the footer CTA
            can sit far below the unit you just tapped. */}
        {loading ? (
          <ActivityIndicator color={selected ? BRAND.gold : BRAND.leaf} />
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

      {/* Only on the selected row: ten of these paragraphs stacked in a ward
          where nothing is mapped yet would say nothing at all. */}
      {selected && tier === 'approx' ? (
        <View className="border-t border-emerald-100/30 px-4 pb-3 pt-2">
          <Text className="text-xs text-emerald-100">
            Hawkeye knows this unit&apos;s approximate area, not where it stands. You can report
            from here — the report just will not be location-verified until observers standing at
            the unit map it.
          </Text>
          {/* Where the number goes when the row above could not carry it: the
              area exists, but its centre is not the dot, and only a sentence
              with room to say so can state both honestly. */}
          {!n.envelope && n.fenceEnvelope ? (
            <Text className="pt-1 text-xs text-emerald-100">
              That area is a ~{Math.round(n.fenceEnvelope.radiusM).toLocaleString()}m circle
              around a centre of its own — the point shown for this unit is the coordinate the
              register holds for it, which is somewhere else.
            </Text>
          ) : null}
          <Pressable
            className="mt-2 flex-row items-center self-start rounded-xl bg-card px-3 py-2 active:opacity-70"
            onPress={() => router.push('/map-unit')}
          >
            <Feather name="map-pin" size={13} color={BRAND.leaf} />
            <Text className="pl-1.5 text-xs font-bold text-hawk-leaf">
              Map this unit — one GPS fix ›
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
};

/** Report a result — unit → race → sheet photo → venue photo → votes → signed submit. */
export default function ReportResult() {
  const ui = useUi();
  const auth = useAuth();
  // Opens straight into the camera: 'sheet' and 'venue' ARE the capture screen,
  // so there is nothing between arriving here and shooting.
  const [step, setStep] = useState<Step>('sheet');

  // -- step 1: which polling unit ------------------------------------------
  const [contests, setContests] = useState<Contest[]>([]);
  /** Set when /api/contests failed AND no cached copy existed, so the header can
   *  say so and offer a retry instead of pretending to still be loading. */
  const [contestsFailed, setContestsFailed] = useState(false);
  const loadContests = () => {
    setContestsFailed(false);
    api.contests()
      .then((c) => { setContests(c); setContestsFailed(false); })
      .catch(() => setContestsFailed(true));
  };
  /**
   * The selected race, from the shared ContestPicker's authoritative catalogue
   * (races.ts). It is the selection's identity and the picker's controlled
   * value; `contest` below is the matching GET /api/contests object it resolves
   * to, which is what the submit and the review screen actually read.
   */
  const [race, setRace] = useState<Race | null>(null);
  const [contest, setContest] = useState<Contest | null>(null);
  /**
   * The observer asked to browse the full 2027 catalogue even though exactly one
   * race is open here and could have been auto-selected. Forces the picker step
   * to render instead of the short auto-skip path.
   */
  const [wantsPicker, setWantsPicker] = useState(false);
  const [states, setStates] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgas, setLgas] = useState<string[]>([]);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wards, setWards] = useState<string[]>([]);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unit, setUnit] = useState<Unit | null>(null);

  // GPS discovery — the way an observer standing at their unit should find it.
  const [nearby, setNearby] = useState<NearRow[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  /** What the last run actually searched — the map ring, the empty state and
   *  the truncation note all read from this rather than from the radius the
   *  screen would like to have searched. */
  const [searched, setSearched] = useState<Searched | null>(null);
  /** The discovery fix, kept so the map has something to centre on. */
  const [fix, setFix] = useState<Fix | null>(null);
  /** Set only when the last GPS failure is one the OS settings app has to fix
   *  (location switched off, or permission blocked with no dialog left to
   *  show). A timeout must never raise this — sending an observer with working
   *  permission into their settings is the exact wild goose chase the old
   *  one-size-fits-all message caused. */
  const [gpsSettings, setGpsSettings] = useState(false);
  /** puCode whose register row is being fetched — a tap has landed, the
   *  selection has not yet. */
  const [picking, setPicking] = useState<string | null>(null);
  /** The register lookup currently in flight, so a later tap can cancel it
   *  rather than queue behind it. Only the newest one may touch `picking`. */
  const pickReq = useRef<AbortController | null>(null);
  /** The register drill-down is the fallback, so it starts folded away. */
  const [browse, setBrowse] = useState(false);
  /** Typing in unit search (or opening the register drill) clears the map and
   *  the nearby list: typing means "my unit is NOT in what you showed me", so
   *  keeping them pushes the observer's actual task off-screen. Mirrors
   *  map-unit.tsx. */
  const [searchTyping, setSearchTyping] = useState(false);
  const searchBusyHiding = searchTyping || browse;

  useEffect(() => {
    // Every state is listed, not just the active contest's. Hiding the rest
    // of the country made the app look broken outside Osun; an observer should
    // be told "no election here yet", not shown an empty world.
    // Record the failure instead of swallowing it. Every screen here is gated on
    // this list, and a silent catch rendered as "Loading election…" forever —
    // an observer at a polling unit cannot tell that apart from a slow network,
    // so they wait instead of retrying.
    loadContests();
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

  /**
   * Whether ANY contest — open or not — covers this unit's state. Drives only
   * the "no election is running at this unit yet" warning; the race choice
   * itself now runs through the ContestPicker, so this is no longer the contest
   * step's content.
   */
  const applicable = useMemo(
    () => (unit ? racesIn(unit.state, contests) : []),
    [unit, contests],
  );

  /**
   * The races that are OPEN and selectable at this unit right now, drawn from
   * the authoritative catalogue (races.ts) rather than from /api/contests
   * directly — the same set the picker would let the observer choose. Openness
   * is read only from `contests` via isRaceOpen, never hardcoded.
   *
   * SHA never appears here (its seat names are unpublished, so listRaces('SHA',…)
   * is empty), which is correct: a State House seat cannot be selected yet, so it
   * can never be the one race we auto-skip into.
   */
  const openRacesHere = useMemo<Race[]>(() => {
    if (!unit) return [];
    const st = unit.state as StateName;
    return ELECTION_TYPES.flatMap((t) => listRaces(t.code, st)).filter((r) =>
      isRaceOpen(r, contests),
    );
  }, [unit, contests]);

  /**
   * The picker step can be skipped ONLY when there is exactly one open,
   * selectable race here and the observer has not asked to browse the full
   * catalogue. Any other case — several open races, none open (but the state is
   * covered), or an explicit "browse" — shows the picker so the 2027 structure is
   * never hidden and a closed race is never a silent dead end.
   */
  const skipPicker = openRacesHere.length === 1 && !wantsPicker;

  /** The race step is real only when the picker is actually shown. */
  const steps = useMemo(
    () => STEPS.filter((s) => s.key !== 'contest' || !skipPicker),
    [skipPicker],
  );

  /**
   * Discovery, which is NOT the same question as the submission geofence.
   *
   * TWO LOOKUPS, because neither endpoint alone can list the units an observer
   * might be standing at, and each is blind to a large population the other
   * sees:
   *
   * - /api/polling-units selects `lat IS NOT NULL OR crowd_lat IS NOT NULL`. It
   *   is the only lookup that sees the 7,652 units located solely by crowd_lat
   *   with no GRID3 envelope (Rivers 3,781, Akwa Ibom 534, Delta 431, Edo 384,
   *   Abia 361, Lagos 245 …). It is also the only one that returns whole
   *   register rows, so it is the only one that knows a unit's state. But it
   *   measures at config.discoveryRadiusM and stops at config.discoveryMaxRows,
   *   both of which it reports on the wire (`radiusM`/`maxRows`/`capped`).
   * - /api/mapping/nearby reaches DISCOVERY_RADIUS_M and includes units placed
   *   only by their GRID3 envelope — the population an observer at an unmapped
   *   unit is standing in — but it never reads crowd_lat, so every one of those
   *   7,652 units is structurally invisible to it. Asking it alone meant an
   *   observer at Ogboi P/S (10-01-09-012, Delta) standing on the spot got an
   *   empty list. Osun has none of these, so a state-level test would never
   *   have shown it.
   *
   * So both are asked and the answers merged, exactly as map-unit.tsx does it —
   * the two screens have to agree about which units exist, where their pins sit
   * and how they are tiered, or the app grades the same unit two ways.
   *
   * Either lookup is allowed to fail on its own; only losing both is fatal.
   * Half a list beats none when the alternative is an observer with a filled-in
   * result sheet and no way to name their unit.
   */
  const findNearby = async () => {
    setNearBusy(true);
    setNearby([]);
    setFix(null);
    setSearched(null);
    // A re-search invalidates the selection it was made from. Without this the
    // observer can select a unit at 150m, walk 600m, search again — the unit
    // drops out of the new list, so pickedRow goes null and BOTH distance
    // warnings silently vanish, while the pinned footer still says "Selected:"
    // with a live Continue. The scope pickers already clear downstream state
    // for the same reason; discovery is no different.
    setUnit(null);
    setGpsSettings(false);
    setNearLine('Getting your location…');
    try {
      // Quick fix, not the submit-grade one: this only shortlists candidates.
      // The accurate fix is taken again at submit, where the server checks it.
      //
      // The result is DISCRIMINATED, and the copy below says which of the four
      // things went wrong. This screen used to print "Location is off or not
      // permitted" for all of them, which was a lie to the commonest caller of
      // all: an observer who granted permission and whose GPS simply had not
      // locked yet indoors. Being told to fix a permission that is already
      // granted is worse than being told nothing.
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

      /**
       * ONE RETRY, AND A REAL DEADLINE. These two were plain fetches whose only
       * failure handling was `.catch(() => null)`, so any network hiccup became
       * the bare word "lookup_failed" with no status and no second chance.
       * /api/polling-units measures ~6.4s from a good link — close enough to
       * Android's ~10s socket timeout that mobile data pushes it over, which is
       * precisely how both requests end up null.
       */
      const tryFetch = async (url: string) => {
        for (let i = 0; i < 2; i++) {
          try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 20000);
            const r = await fetch(url, { signal: ctl.signal });
            clearTimeout(t);
            return r;
          } catch (e) {
            if (i === 1) { lastNetErr = e instanceof Error ? e.message : String(e); return null; }
          }
        }
        return null;
      };
      let lastNetErr = '';
      const [located, envelope] = await Promise.all([
        // No radius parameter exists on this one — it filters at
        // config.discoveryRadiusM and caps at config.discoveryMaxRows. Both
        // facts are load-bearing for the copy below, neither can be asked for,
        // and both are now read back out of the response instead of mirrored.
        tryFetch(`${BASE}/api/polling-units?lat=${f.lat}&lng=${f.lng}`),
        // This one does take a radius, and would otherwise default to 5km.
        tryFetch(`${BASE}/api/mapping/nearby?lat=${f.lat}&lng=${f.lng}&radiusM=${DISCOVERY_RADIUS_M}`),
      ]);

      if (!located?.ok && !envelope?.ok) {
        const status = located?.status ?? envelope?.status;
        setNearLine(
          lookupFailedLine(status ? `HTTP ${status}` : lastNetErr || 'network unreachable'),
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
        ? (((await envelope.json().catch(() => ({}))) as { units?: NearbyRow[] }).units ?? [])
        : [];

      /**
       * Recorded BEFORE the merge, because after it the two populations are
       * indistinguishable and every sentence this screen prints about "within
       * Xm" needs to know which circle it is talking about. The register lookup
       * reports the radius it used, so that is taken over the local mirror; a
       * lookup that did not answer contributes no radius rather than its
       * intended one, since nothing inside it was searched at all.
       *
       * The cap and the truncation flag are taken the same way and for the same
       * reason — the server owns those numbers, and a mirror of them is wrong
       * from the moment the server moves.
       */
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
        // Truncation is stated outright now. Only against a server too old to
        // send `capped` is it inferred from the row count — and there a full
        // answer and a truncated one look identical, so a full one is treated
        // as truncated.
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
       * the same coalesce map-unit.tsx makes, so a pin does not move between
       * the two screens — but takes its TIER from /api/mapping/nearby, which
       * derives it from coords_source rather than from which column is filled.
       * That distinction is not cosmetic: a crowd-mapped unit reads as
       * `verified` in /api/polling-units' tier, and the tier is what picks the
       * geofence this screen warns against (200m official, 750m crowd).
       *
       * THE ENVELOPE NEVER TRAVELS WITH THE POSITION. It is attached in the
       * second loop only, from the row whose own lat/lng ARE its centre, and
       * never in the first — see the note on NearRow.envelope.
       */
      const merged = new Map<string, NearRow>();
      for (const u of locatedRows) {
        // Nullish, not `||`, so a genuine 0 is not thrown away.
        const uLat = u.lat ?? u.crowd_lat;
        const uLng = u.lng ?? u.crowd_lng;
        if (uLat == null || uLng == null) continue;
        /**
         * `coords_source` is read HERE, ahead of the server's own tier, and for
         * one value only — exactly as map-unit.tsx's rowTier does, so the two
         * screens cannot grade the same unit differently.
         *
         * pollingUnits.js's tierOf() calls any row holding `lat` 'verified',
         * and POST /api/mappings promotes a confirmed crowd median straight
         * into `lat` alongside `coords_source = 'crowd_mapped'`. Only
         * /api/mapping/nearby reads that column — and that lookup is allowed to
         * fail (it is wrapped in a catch) and is allowed to omit a unit even
         * when it succeeds (mapping.js takes a raw `LIMIT 400` BEFORE it
         * filters by distance and sorts, so in a dense urban bbox a unit 50m
         * away can be dropped). Without this line either of those turns a
         * crowd-mapped unit green, and — worse than the colour — fences it at
         * 200m when the server accepts it to 750m.
         */
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
          // — somewhere somebody stood — while its `approx_radius_m` measures a
          // GRID3 box around `approx_lat`, a median 2.5km elsewhere. Pairing
          // them was the original bug; there is nothing here to draw an area
          // from, so no area is claimed.
          //
          // Confirmed only on the crowd_mapped path: that row was graded from
          // the same column /api/mapping/nearby would have graded it from, so
          // the 750m fence below is being applied on evidence rather than on
          // the "widest plausible" guess UNCONFIRMED_FENCE_M exists for.
          tierConfirmed: crowdMapped,
          /**
           * The envelope, for the SERVER's gate only — never for the map.
           *
           * It has to be built here as well as in the /mapping/nearby loop, or
           * the pre-capture warning is unreachable: that loop's rows are already
           * filtered to within DISCOVERY_RADIUS_M (800m) OF THE ENVELOPE CENTRE,
           * while the server's limit starts at radius*1.5+2000 — a minimum of
           * 2,900m given the register's smallest radius of 600m. A distance
           * capped at 800 can never exceed a floor of 2,900, so the warning
           * could never fire, and the ~35,858 units it exists for would still
           * hit the 403 after two photos and a full tally.
           *
           * This row IS the far-away case: it is listed because the observer is
           * near its crowd point, which says nothing about how far the envelope
           * centre is. `approx_lat`/`approx_lng` ride along on `SELECT *`.
           */
          fenceEnvelope:
            u.approx_lat != null && u.approx_lng != null && (u.approx_radius_m ?? 0) > 0
              ? { lat: u.approx_lat, lng: u.approx_lng, radiusM: u.approx_radius_m as number }
              : undefined,
          fixes: u.crowd_reports ?? 0,
          // A whole register row arrived with it, so selecting this one needs
          // no second lookup — but only if it really carries the fields the
          // race rules read; a half-built unit dead-ends two taps later.
          unit: u.state && u.lga ? { pu_code: u.pu_code, name: u.name, ward: u.ward, lga: u.lga, state: u.state } : null,
        });
      }
      for (const n of envelopeRows) {
        const seed = merged.get(n.puCode);
        // A register row already graded `crowd` off its own coords_source has
        // been graded from the very column this endpoint grades from, so there
        // is nothing here to correct — and re-deriving it would put the two
        // screens back at risk of disagreeing over the same row.
        const tier = seed?.tierConfirmed ? seed.tier : toTier(n.status);
        /**
         * Is the point being DRAWN for this unit the envelope's own centre?
         *
         * Only when nothing seeded it. mapping.js coalesces lat/lng to
         * approx_lat/approx_lng on precisely the rows it calls `approx`, so an
         * unseeded approx row's point IS the centre. A seeded one's is not: the
         * register row's `lat ?? crowd_lat` wins the pin below, and that is a
         * median 2,533m from this centre (10km at p90, 145km at worst).
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
          /**
           * DRAWN ONLY WHEN THE PIN IS THE CENTRE.
           *
           * Centre and radius come off this one row as a unit — mapping.js sets
           * `approxRadiusM` only when `lat IS NULL`, and coalesces lat/lng to
           * approx_lat/approx_lng on exactly those rows — but that only makes
           * them the same circle as the PIN when the pin is `n.lat/n.lng` too.
           * Where a register row seeded this unit the pin stays on its crowd
           * coordinate, and attaching the area here would put an amber circle a
           * median 2,533m from the amber dot it claims to describe. ~40,650
           * units reach that state on a single lookup, and map-unit.tsx already
           * refuses to do it.
           *
           * `approx` only, additionally: the status is derived from the same
           * `lat IS NULL` test, so a `verified` or `crowd` row carries no radius
           * to read, and amber around a confirmed pin would contradict the pin.
           *
           * Not `seed?.envelope` in the else: the seed is a register row, which
           * by the rule above never has one. Nothing to inherit.
           */
          envelope: drawnIsEnvelopeCentre ? area : undefined,
          /**
           * The same circle, kept for the SERVER's gate rather than the map's.
           * submissions.js measures `too_far_from_unit` from this centre on
           * every row whose `pu.lat IS NULL` — which is every `approx` row,
           * seeded or not — so it is carried whether or not it may be drawn.
           */
          fenceEnvelope: area ?? seed?.fenceEnvelope,
          tierConfirmed: true,
          fixes: n.fixes || seed?.fixes || 0,
          unit: seed?.unit ?? null,
        });
      }

      // Each endpoint sorts its own answer; the union has to be sorted again.
      const all = [...merged.values()].sort((a, b) => a.distanceM - b.distanceM);
      const found = all.slice(0, MAX_NEARBY);
      setNearby(found);
      if (found.length === 0) {
        // Not "within 800m": the 7,652 units that only /api/polling-units can
        // see were searched at the narrower radius that lookup reports for
        // itself, so a single radius in this sentence would be a positive claim
        // about a circle nothing ever looked in.
        setNearLine(nothingFoundLine(scope));
        setBrowse(true);
        return;
      }
      setNearLine(
        all.length > found.length
          ? `Tap the unit you are standing at — the ${found.length} closest of the ${all.length} found:`
          : 'Tap the unit you are standing at:',
      );
    } catch (e) {
      setNearLine(lookupFailedLine(e instanceof Error ? e.message : String(e)));
      setBrowse(true);
    } finally {
      setNearBusy(false);
    }
  };

  /**
   * TIER A resolution. The resolver reads the ALREADY-FETCHED nearby list first,
   * which is what lets this work offline on the election-day network the outbox
   * exists to survive; a single exact lookup is the online extra. Repairs stay
   * cache-only, because an 81-probe sweep must never touch the network.
   */
  /**
   * What the sheet said about its own unit — OFFERED, never assumed.
   *
   * `sheetMiss` is the other half and matters as much: a Tier A that fails in
   * silence is indistinguishable from one that never ran, which is exactly what
   * made this cost several rounds of guessing at the parser instead of reading
   * one line on screen. Whatever happens, this step now says so.
   */
  const [sheetGuess, setSheetGuess] = useState<
    { code: string; name: string; where: string; repaired: boolean; row: NearRow | null; unit: Unit | null } | null
  >(null);
  const [sheetMiss, setSheetMiss] = useState('');

  const resolveUnitFromSheet = async (text: string) => {
    if (unit) return;
    const byCode = new Map(nearby.map((n) => [n.puCode, n]));
    const toUnit = (n: NearRow) => ({ name: n.name, lat: n.lat, lng: n.lng });
    const local = async (code: string) => {
      const n = byCode.get(code);
      return n ? toUnit(n) : null;
    };
    // Return the WHOLE register row, not three fields off it. The full row is
    // what chooseUnit needs to bind a unit that is not in `nearby`, and it also
    // gives the resolver's name-match check something to corroborate against.
    const withNet = async (code: string) => {
      const hit = await local(code);
      if (hit) return hit;
      try {
        const r = await fetch(`${REG}/unit?pu_code=${encodeURIComponent(code)}`);
        const b = r.ok ? await r.json() : null;
        return b?.unit ?? null;
      } catch { return null; }
    };
    const f = fix ? { lat: fix.lat, lng: fix.lng } : undefined;
    let hit = null;
    try {
      hit = await resolveUnitFromText(text, { resolve: withNet, fix: f, maxRepair: 0 })
        ?? await resolveUnitFromText(text, { resolve: local, fix: f });
    } catch { return; }
    if (unit) return;
    if (!hit) {
      let codes: string[] = [];
      try { codes = extractCandidates(text); } catch { /* report as unread */ }
      setSheetMiss(
        codes.length
          ? `Read ${codes[0]} off the sheet, but no unit with that code was found — pick yours below.`
          : 'Could not read the unit code off the sheet — pick yours below.',
      );
      return;
    }
    // ASK, DO NOT ASSUME. Auto-selecting was silent in both directions: when it
    // worked nobody could tell it had, and when it read the wrong unit it was
    // already chosen. It also stranded any code that resolved from the REGISTER
    // rather than the nearby list — the branch below simply found no row and did
    // nothing at all. Offering it covers both: the observer sees the code and
    // the unit it names, and one tap binds it through the normal path.
    const row = byCode.get(hit.code) ?? null;
    const u = (row ? null : (hit.unit as unknown as Unit)) ?? null;
    setSheetMiss('');
    setSheetGuess({
      code: hit.code,
      // The register row always carries a name; the resolver's shape allows it
      // to be absent, and a blank confirm card would be worse than the code alone.
      name: hit.unit.name || row?.name || hit.code,
      where: [u?.ward ?? row?.ward, u?.lga, u?.state].filter(Boolean).join(', '),
      repaired: hit.source === 'repaired',
      row,
      unit: u,
    });
  };

  /** The observer said yes: bind it exactly as a tapped unit binds. */
  const acceptSheetGuess = () => {
    const g = sheetGuess;
    setSheetGuess(null);
    if (!g) return;
    if (g.row) void chooseNearby(g.row);
    else if (g.unit) chooseUnit(g.unit);
  };

  /**
   * The lookup runs ON MOUNT, not on reaching the unit step — GPS first, always.
   *
   * IT USED TO WAIT FOR THE UNIT STEP, and that quietly broke Tier A. With
   * capture first, the unit step comes AFTER both photographs, so `nearby` was
   * still empty when the sheet was read: resolveUnitFromSheet could resolve the
   * code but then found no row to select and did nothing at all. Silent, and
   * indistinguishable from the OCR simply failing.
   *
   * Firing on mount fixes that and is what the flow wants anyway — the list is
   * warm before the observer has finished shooting, so the unit step opens
   * populated instead of starting a round trip.
   *
   * The rule across every flow and platform: asking "which unit?" IS the request
   * to find it. Every failure path inside findNearby already ends somewhere
   * usable (a discriminated message plus the register browser opened for them),
   * so firing it unprompted cannot strand anyone; it only removes a button press
   * from an observer who has just walked away from a crowd.
   *
   * Runs ONCE, never when a unit is already chosen (they may have come back
   * through a crumb). It SUGGESTS only — nothing here selects.
   */
  const [autoNearRan, setAutoNearRan] = useState(false);
  useEffect(() => {
    if (autoNearRan || unit) return;
    setAutoNearRan(true);
    void findNearby();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNearRan, unit]);
  /**
   * ONE silent retry. The auto-fire above runs at mount — the coldest moment a
   * GPS ever has — so its first attempt can time out where a tap ten seconds
   * later succeeds purely because the first attempt warmed the chip. The
   * observer saw exactly that: "failed", then a manual press that worked. If no
   * fix has landed 6s after the first attempt, try once more; a fix arriving
   * (or a unit being chosen) cancels the timer via the effect cleanup.
   */
  const nearRetried = useRef(false);
  useEffect(() => {
    if (!autoNearRan || nearRetried.current || fix || unit) return;
    const t = setTimeout(() => {
      nearRetried.current = true;
      void findNearby();
    }, 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNearRan, fix, unit]);

  /**
   * Selecting a unit clears any race chosen for a previous one — the race is
   * (re)chosen through the picker, or auto-selected in continueFromUnit when
   * exactly one is open here.
   */
  const chooseUnit = (u: Unit) => {
    pick();
    setUnit(u);
    setRace(null);
    setContest(null);
    setWantsPicker(false);
  };

  /**
   * Resolve a picked Race to its GET /api/contests object — what the submit and
   * the review screen actually read — and record both. The match rule mirrors
   * races.ts:matchContest (code + states[] scope), inlined so it returns the
   * concrete api Contest rather than the loose races.ts shape.
   */
  const selectRace = (r: Race) => {
    setRace(r);
    setContest(
      contests.find(
        (c) =>
          c.code === r.contestCode &&
          (!c.states || c.states.length === 0 || (r.state != null && c.states.includes(r.state))),
      ) ?? null,
    );
  };

  /**
   * Turn a nearby row into a selection.
   *
   * State is what decides which races run at the unit, so a row that arrived
   * without one has to fetch its register row first, and that fetch is allowed
   * to fail loudly. Selecting a half-built unit would instead dead-end two taps
   * later on "no active election in undefined", with nothing on screen
   * explaining why.
   *
   * Every way out of the in-flight state is covered, because there is no way
   * back into this screen once a tap is lost: React Native's fetch never times
   * out on its own, so the request is raced against PICK_TIMEOUT_MS, and a tap
   * on a DIFFERENT unit aborts the one in flight rather than being swallowed by
   * it. Only the newest request is allowed to speak — an older one that loses
   * the race must not clear the spinner belonging to the tap that replaced it,
   * nor raise its own cancellation as an error the observer has to read.
   */
  const chooseNearby = async (n: NearRow) => {
    pick();
    // Already selected: nothing to fetch, but a lookup for a DIFFERENT unit may
    // still be in flight, and returning without killing it hands the screen to
    // whichever unit that request names when it lands. The observer's last tap
    // must be the one that decides — re-affirming a selection cannot be the one
    // gesture that silently loses it, or they press Continue against a unit
    // they deliberately backed out of.
    if (unit?.pu_code === n.puCode) {
      pickReq.current?.abort();
      pickReq.current = null;
      setPicking(null);
      return;
    }

    // A row that came with its register row needs no network at all.
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
      // A timeout that lands while the body is still arriving is still a
      // timeout; json()'s own catch would otherwise report it as a bare
      // "lookup_failed" against an HTTP 200.
      if (ctl.signal.aborted) throw new Error('timeout');
      if (!res.ok || !body.unit) {
        Alert.alert(
          'Could not open that unit',
          `${n.name} could not be loaded from the register — retry, or find it under “Browse the register instead”. (${body.error ?? 'lookup_failed'} / HTTP ${res.status})`,
        );
        return;
      }
      chooseUnit(body.unit);
    } catch (e) {
      // Superseded by a later tap: that tap owns the screen now, and this one
      // has nothing to report.
      if (!current()) return;
      Alert.alert(
        'Could not open that unit',
        ctl.signal.aborted
          ? `Looking up ${n.name} took too long. Check your signal and tap it again, or find it under “Browse the register instead”. (timed out after ${PICK_TIMEOUT_MS / 1000}s)`
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

  // Leaving the screen must take any in-flight lookup with it, or its alert
  // arrives on whatever screen the observer went to next.
  useEffect(
    () => () => {
      pickReq.current?.abort();
      pickReq.current = null;
    },
    [],
  );

  /** Map markers and list rows are built from one array, so a tap on either
   *  lands in the same selection and neither can show what the other cannot. */
  const mapUnits = useMemo<MapUnit[]>(
    () =>
      nearby.map((n) => ({
        puCode: n.puCode,
        name: n.name,
        lat: n.lat,
        lng: n.lng,
        tier: n.tier,
        // The area travels whole or not at all. The map decides for itself
        // whether it is small enough to be worth drawing.
        envelope: n.envelope,
      })),
    [nearby],
  );

  /**
   * The circle to draw. Normally the envelope search, which is also the wider of
   * the two and therefore the one that frames every result — but if only the
   * register lookup answered, the ring drops to what IT searched rather than
   * standing at four times the radius anything was actually queried at.
   */
  const ringM = searched?.envelopeM ?? searched?.registerM ?? DISCOVERY_RADIUS_M;

  /** The nearby row the current selection came from, when it came from GPS. */
  const pickedRow = useMemo(
    () => (unit ? (nearby.find((n) => n.puCode === unit.pu_code) ?? null) : null),
    [unit, nearby],
  );

  /**
   * How far is too far to file from — measured at the fence that actually
   * applies, and at the WIDEST plausible one whenever the tier was never
   * confirmed. Never at the narrow 200m fence on a row that cannot tell an
   * official coordinate from a crowd-mapped one.
   */
  const tooFar =
    pickedRow != null &&
    pickedRow.distanceM >
      (pickedRow.tierConfirmed ? FAR_ENOUGH_TO_WARN_M[pickedRow.tier] : UNCONFIRMED_FENCE_M);

  /**
   * The OTHER refusal — the one an approx unit actually faces, and the one the
   * distance above cannot see.
   *
   * `tooFar` measures the observer against the PIN. An approx unit is not gated
   * on its pin at all: submissions.js skips the geofence branch (`pu.lat` is
   * null by definition) and hard-403s `too_far_from_unit` when the submit fix
   * is further than `radius * 1.5 + 2000` from the ENVELOPE's centre — a place
   * that, on a unit the register also placed, is a median 2,533m from the pin.
   * So this is measured from `fenceEnvelope`, never from `lat`/`lng`.
   *
   * Measured against the discovery fix, which is the only position the screen
   * has before the camera; the server will re-measure the submit fix. The two
   * are metres apart in practice and this warning is deliberately the earlier,
   * cheaper one — the alternative is finding out after two photos and a full
   * tally.
   */
  const envelopeGate = (() => {
    const e = pickedRow?.fenceEnvelope;
    if (!e || !fix) return null;
    const limitM = Math.round(envelopeHardLimitM(e.radiusM));
    const centreM = Math.round(haversineM(fix.lat, fix.lng, e.lat, e.lng));
    return centreM > limitM ? { centreM, limitM, radiusM: e.radiusM } : null;
  })();

  /**
   * Leaving the unit step. The unit's state locks the picker, so the race is
   * chosen there — but when exactly one race is open here and the observer has
   * not asked to browse, that single race is auto-selected and the picker is
   * skipped, straight to the camera. That is the common path today (one green
   * race at an Osun unit); everything else opens the picker.
   */
  const continueFromUnit = () => {
    tap();
    if (!unit) return;
    if (contests.length === 0) {
      Alert.alert(
        'Election list not loaded',
        'Hawkeye could not load which elections are running — check your connection and reopen this screen. (no /api/contests response)',
      );
      return;
    }
    // Nothing Hawkeye covers runs in this state at all — not merely "not open
    // yet", but out of scope. Mapping stays possible; reporting does not.
    if (racesIn(unit.state, contests).length === 0) {
      Alert.alert(
        `No active election in ${unit.state}`,
        `Hawkeye is covering the ${contests[0].election}. Nothing is open for reporting at ${unit.name} yet — but you can still map polling units anywhere in Nigeria.`,
      );
      return;
    }
    if (skipPicker) {
      selectRace(openRacesHere[0]);
      setStep('votes');
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

  const onSubmit = async () => {
    tap();
    if (!unit || !contest || !sheet || !venue) return;
    setBusy(true);
    setLine('Getting your location…');
    try {
      // Bounded, accuracy-aware fix — the server rejects accuracy >100m, and an
      // unbounded High wait indoors can hang the submit button indefinitely.
      //
      // Same rule as discovery: name the actual obstacle. A filled-in result
      // sheet is the worst possible moment to tell someone their permission is
      // broken when it is not — they will go turn on a setting that is already
      // on and lose the fix they were seconds away from getting.
      const got = await trySubmitFix();
      if (!got.ok) {
        const d = describeFixFailure(got);
        setLine(`${d.lead}. (${d.code})`);
        setBusy(false);
        return;
      }
      const fix = got.fix;
      setLine('Signing and submitting…');
      const r = await submitResult({
        puCode: unit.pu_code,
        contest: contest.code,
        votes,
        sheet,
        venue,
        fix,
        sheetSerial: sheetSerial.trim() || undefined,
        // No dryRun: closed races are unselectable in this flow, so every submit
        // here is a real report. Rehearsal now lives entirely in the practice
        // section (submit.ts still carries the dryRun field for it).
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
      <SafeAreaView className="flex-1 items-center justify-center bg-surface px-8">
        <Feather name="lock" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-ink">
          Sign in to report a result
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
        // Fresh mount per step: without the key, the venue step inherits the
        // sheet step's internal preview/busy state (same element position).
        key={step}
        title={isSheet ? 'Photo 1 of 2 — the result sheet' : 'Photo 2 of 2 — the surroundings'}
        frameGuide={isSheet}
        venueGuide={isSheet ? undefined : '📸 VENUE PHOTO — aim at the polling unit itself: the building, booth, banner or the crowd. This is NOT the results sheet.'}
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
            // TIER A: let the sheet name its own unit. The EC8A header carries
            // the delimitation code and readSheet already returns the full
            // recognised text — it was only ever keeping the party counts.
            // Resolution refuses ambiguous repairs (see lib/pu-code.ts), and
            // only a HIGH-confidence read is allowed to select: a wrong unit is
            // worse than a slower one. Never overrides a unit already chosen.
            if (shot.read?.text && !unit) void resolveUnitFromSheet(shot.read.text);
            setStep(retaking ? 'review' : 'venue');
          } else {
            setVenue(shot);
            // Evidence is safe from here — attribution follows, away from the crowd.
            setStep(retaking ? 'review' : 'unit');
          }
          setRetaking(false);
        }}
        onCancel={() => {
          if (retaking) {
            setRetaking(false);
            setStep('review');
          } else if (isSheet) {
            // The sheet is the FIRST step now, so there is no earlier screen to
            // fall back to — backing out of the camera leaves the report.
            router.back();
          } else {
            setStep('sheet');
          }
        }}
      />
    );
  }

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
        <Text className="pl-3 text-lg font-bold text-ink">Report a result</Text>
      </View>

      {step !== 'done' ? (
        <View className="flex-row px-4 pt-3">
          {steps.map((s, i) => {
            const idx = steps.findIndex((x) => x.key === step);
            const on = i <= idx;
            return (
              <View key={s.key} className="mr-1 flex-1">
                <View className={`h-1.5 rounded-full ${on ? 'bg-hawk-leaf' : 'bg-card'}`} />
                <Text className={`pt-1 text-center text-[10px] font-semibold ${on ? 'text-hawk-leaf' : 'text-faint'}`}>
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'padding'} className="flex-1">
        {step === 'unit' ? (
          /* keyboardShouldPersistTaps: the search field lives on this step, so
             with the keyboard up a first tap on a state/LGA/ward chip was spent
             DISMISSING the keyboard and never reached the chip — "state
             selection doesn't respond". The votes step already had this. */
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
            <Text className="pb-1 text-xl font-bold text-ink">
              {contests.length
                ? contests[0].election
                : contestsFailed
                  ? 'Election details unavailable'
                  : 'Loading election…'}
            </Text>
            {/* A dead end needs a way out. Reporting does not depend on this
                list — the unit steps below work regardless — so say that, and
                offer the retry rather than leaving a spinner to be waited on. */}
            {contestsFailed ? (
              <Pressable onPress={loadContests} className="mb-2 self-start active:opacity-70">
                <Text className="text-sm font-bold text-hawk-gold">
                  Couldn’t reach the server — tap to retry
                </Text>
              </Pressable>
            ) : null}
            <Text className="pb-3 text-sm text-muted">
              Report from the unit you are standing at.
            </Text>

            {/* GPS FIRST. An observer at their unit knows where they are, not
                their ward's spelling in the register — the drill-down is the
                fallback for units without coordinates, exactly as on the web. */}
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
                  {/* The lookup runs on arrival, so this is the RETRY once it
                      has. A control still reading "Find units near me" after a
                      search reads as work the observer has yet to do.
                      Keyed on a FINISHED search (rows, or a message saying why
                      there are none) rather than on autoNearRan, which flips
                      when the search STARTS — so the button offered to search
                      "again" before it had ever succeeded once. */}
                  <Text className="pl-2 text-base font-bold text-hawk-gold">
                    {nearby.length || nearLine ? 'Search near me again' : 'Find units near me'}
                  </Text>
                </>
              )}
            </Pressable>

            {nearLine ? (
              <Text className="pt-3 text-sm font-semibold text-warn-ink">{nearLine}</Text>
            ) : null}

            {/* TIER A: the sheet named a unit. Offered above the nearby list
                because it is the most specific answer available — it came off
                the form in the observer's hand — but it is still only an offer. */}
            {!unit && sheetGuess ? (
              <View className="mt-3 rounded-2xl border-2 border-hawk-green bg-card p-4">
                <Text className="pb-1.5 text-base font-bold text-ink">Is this your polling unit?</Text>
                <Text className="text-base font-semibold text-ink">{sheetGuess.name}</Text>
                <Text className="pb-3 text-xs text-muted">
                  {sheetGuess.code}
                  {sheetGuess.where ? ` · ${sheetGuess.where}` : ''} · read from the sheet
                  {sheetGuess.repaired ? ' (one digit corrected)' : ''}
                </Text>
                <View className="flex-row gap-2.5">
                  <Pressable
                    onPress={acceptSheetGuess}
                    className="flex-1 items-center rounded-xl bg-hawk-green py-3 active:opacity-80"
                  >
                    <Text className="text-sm font-bold text-hawk-gold">Yes, use this unit</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setSheetGuess(null); setSheetMiss('Pick your unit below, or search for it.'); }}
                    className="flex-1 items-center rounded-xl border border-line py-3 active:opacity-70"
                  >
                    <Text className="text-sm font-bold text-ink">No, choose another</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {!unit && !sheetGuess && sheetMiss ? (
              <Text className="pt-3 text-sm text-muted">{sheetMiss}</Text>
            ) : null}

            {/* Only for the two failures the settings app is actually the cure
                for. The "Find units near me" button above IS the retry, so a
                timeout needs no new control — just the honest sentence and
                another tap. */}
            {gpsSettings ? (
              <Pressable
                onPress={() => Linking.openSettings()}
                className="mt-2 flex-row items-center self-start rounded-xl border border-line px-3 py-2 active:opacity-70"
              >
                <Feather name="settings" size={14} color={ui.muted} />
                <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
              </Pressable>
            ) : null}

            {/* The register lookup caps its answer, and in a dense ward the
                unit the observer is standing at can be the one past the cap —
                with the list above looking complete. Said once, and only when
                the server itself reports the answer as truncated; both the cap
                and the radius quoted here are its numbers, not ours. */}
            {searched?.capped && nearby.length ? (
              <Text className="pt-1 text-xs text-muted">
                Units already placed by observers are looked up {searched.maxRows} at a time within{' '}
                {searched.registerM}m, and that limit was reached — if yours is not listed, browse
                the register below.
              </Text>
            ) : null}

            {/* The map answers what the list cannot: which of these is the
                building in front of you. Selection is shared both ways — the
                pin the map highlights is the row the list highlights, and a tap
                on either is the same tap. */}
            {/* Gated on `searched` as well as `fix`: the ring is a claim about
                a radius something was queried at, and between the fix landing
                and the lookups answering — or when both of them fail, which
                returns before `searched` is ever set — nothing has been queried
                at any radius. An 800m ring drawn then is an unlabelled empty
                circle whose caption is suppressed for exactly the same reason,
                asserting a search that never happened. */}
            {fix && searched && mapAvailable() && !searchBusyHiding ? (
              <View className="pt-3">
                <UnitMap
                  center={{ lat: fix.lat, lng: fix.lng }}
                  accuracyM={fix.accuracy}
                  units={mapUnits}
                  // Follow the tap, not the fetch: the register lookup behind a
                  // selection takes a moment, and the map should not sit still
                  // through it.
                  selected={picking ?? unit?.pu_code}
                  onSelect={(code) => {
                    const row = nearby.find((n) => n.puCode === code);
                    if (row) chooseNearby(row);
                  }}
                  radiusM={ringM}
                />
                {/* The ring is one circle and the search was two. Naming it is
                    the difference between evidence and decoration: without this
                    line an empty 800m ring reads as "nothing is near you", when
                    the units it cannot see were only ever searched at the
                    narrower radius /api/polling-units reports for itself. */}
                {searched && ringLine(searched) ? (
                  <Text className="pt-1.5 text-xs text-muted">{ringLine(searched)}</Text>
                ) : null}
              </View>
            ) : null}

            {nearby.length && !searchBusyHiding ? (
              <View className="pt-3">
                {nearby.map((n) => (
                  <NearbyRow
                    key={n.puCode}
                    n={n}
                    selected={unit?.pu_code === n.puCode}
                    loading={picking === n.puCode}
                    onChoose={chooseNearby}
                    onContinue={continueFromUnit}
                  />
                ))}
              </View>
            ) : null}

            {/* Search by name/code, above the cascade — knowing the unit's name
                but not its ward is the case the cascade cannot serve. */}
            <UnitSearch<Unit> onSelect={chooseUnit} onEngaged={setSearchTyping} />
            <Pressable
              onPress={() => setBrowse((b) => !b)}
              className="mt-4 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-70"
            >
              <Feather name={browse ? 'chevron-down' : 'chevron-right'} size={16} color={BRAND.leaf} />
              <Text className="flex-1 pl-2 text-sm font-bold text-hawk-leaf">
                Browse the register instead
              </Text>
              <Text className="text-xs text-faint">state › LGA › ward</Text>
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
                      <UnitRow
                        key={u.pu_code}
                        u={u}
                        sub={`${u.pu_code} · ${u.ward}, ${u.lga}`}
                        selected={unit?.pu_code === u.pu_code}
                        onChoose={chooseUnit}
                        onContinue={continueFromUnit}
                      />
                    ))}
                    {units.length === 0 ? (
                      <Text className="pt-2 text-sm text-muted">No units in the register for this ward yet.</Text>
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
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Text className="pb-2 text-xs text-muted" numberOfLines={1}>
              Selected: {unit.name}
            </Text>
            {/* Discovery reaches further than the geofence does, so a located
                unit can be listed and still be too far to file from. Say it
                here rather than after two photos and a full tally — at the
                tier's own fence, so a crowd-mapped unit is not warned off at
                200m when the server would accept it up to 750m, and at the
                widest fence when the tier was never confirmed (see `tooFar`).
                No threshold is quoted: the applicable one is exactly what an
                unconfirmed row does not know. */}
            {tooFar && pickedRow ? (
              <Text className="pb-2 text-xs font-semibold text-warn-ink">
                You are {pickedRow.distanceM}m away. Filing checks your position against this
                unit&apos;s own coordinates — report from the unit itself.
              </Text>
            ) : null}
            {/* The approx unit's real gate, and it is not the distance above:
                the server measures from the centre of the mapped AREA, so the
                reason has to name that centre or an observer standing beside
                the dot cannot make sense of being refused. Said here, before
                two photos and a full tally are spent on a 403. */}
            {envelopeGate ? (
              <Text className="pb-2 text-xs font-semibold text-warn-ink">
                Hawkeye knows this unit only by a mapped area, and you are {envelopeGate.centreM}m
                from that area&apos;s centre — past the {envelopeGate.limitM}m filing allows, so
                this report would be refused after the photos. Move closer to the unit, or map it
                from where it stands.
              </Text>
            ) : null}
            {/* Only once the contest list is in — before that, "no election
                here" would be the loading state talking. */}
            {contests.length > 0 && applicable.length === 0 ? (
              <Text className="pb-2 text-xs font-semibold text-warn-ink">
                No election is running at this unit yet.
              </Text>
            ) : null}
            <Pressable
              onPress={continueFromUnit}
              className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
            >
              <Text className="text-base font-bold text-hawk-gold">
                {skipPicker ? 'Continue to the figures' : 'Continue — choose the race'}
              </Text>
            </Pressable>
            {/* When exactly one race is open here the button above skips straight
                past the race picker to the figures (the photos are already taken
                by this point). Offer the full 2027 catalogue as a deliberate
                second path, so the auto-skip never hides the other races an
                observer might be looking for. */}
            {openRacesHere.length === 1 ? (
              <Pressable
                className="mt-3 items-center"
                onPress={() => {
                  setWantsPicker(true);
                  setStep('contest');
                }}
              >
                <Text className="text-sm font-semibold text-hawk-leaf">
                  Browse all races instead ›
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {step === 'contest' ? (
          <ScrollView contentContainerClassName="px-4 pb-8 pt-4">
            {unit ? <Crumb label={unit.name} onPress={() => setStep('unit')} /> : null}
            {/* The unit's state is known, so the picker is scoped to it and the
                observer never re-picks a state. Openness comes only from
                `contests` (isRaceOpen inside the picker), never hardcoded. */}
            <Text className="pb-2 text-sm text-muted">
              Reporting at {unit?.name}
              {unit ? `, ${unit.state}` : ''}. Tap an open race to report it. A race that has not
              opened shows when reporting begins — you cannot file it yet, but it is not hidden.
            </Text>
            <ContestPicker
              contests={contests}
              value={race}
              onSelect={selectRace}
              lockedState={unit ? (unit.state as StateName) : undefined}
              allowClosed={false}
            />
          </ScrollView>
        ) : null}

        {step === 'contest' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            <Text className="pb-2 text-xs text-muted" numberOfLines={1}>
              {race ? `Selected: ${race.label}` : 'Choose an open race to continue.'}
            </Text>
            <Pressable
              disabled={!race}
              onPress={() => setStep('votes')}
              className={`items-center rounded-2xl py-4 ${race ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'}`}
            >
              <Text className="text-base font-bold text-hawk-gold">Continue to the figures</Text>
            </Pressable>
          </View>
        ) : null}

        {step === 'votes' ? (
          <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
            <Text className="pb-1 text-xl font-bold text-ink">Votes per party</Text>
            <Text className="pb-3 text-sm text-muted">
              Copy the figures exactly as written on the sheet. Leave blank for parties not listed.
            </Text>
            <TextInput
              className="mb-3 rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder="Search party (APC, PDP, LP…)"
              // ui.faint, not the hardcoded #9db5a7 it was: that string is
              // verbatim the LIGHT palette's faint token, on an input whose
              // background flips with the theme — so on a dark surface the
              // placeholder was being drawn at the light theme's contrast. The
              // other two inputs on this screen carry the same fix.
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
                    <Text className="text-[10px] font-bold text-hawk-leaf">{p.code.slice(0, 3)}</Text>
                  </View>
                )}
                <View className="flex-1 pr-2">
                  <Text className="text-base font-semibold text-ink">{p.code}</Text>
                  <Text className="text-xs text-muted" numberOfLines={1}>{p.name}</Text>
                </View>
                {readCodes.includes(p.code) ? (
                  <View className="mr-2 rounded-full bg-surface px-2 py-0.5">
                    <Text className="text-[9px] font-bold text-hawk-leaf">FROM SHEET</Text>
                  </View>
                ) : null}
                <TextInput
                  className="w-24 rounded-xl bg-surface px-3 py-2 text-center text-lg font-bold text-ink"
                  placeholder="0"
                  placeholderTextColor={ui.faint}
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
              <Text className="text-base font-semibold text-ink">{unit?.name}</Text>
              <Text className="text-xs text-muted">{unit?.pu_code} · {unit?.ward}, {unit?.lga}</Text>
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
                    className="flex-1 overflow-hidden rounded-2xl bg-card active:opacity-80"
                    onPress={() => {
                      setRetaking(true);
                      setStep(i === 0 ? 'sheet' : 'venue');
                    }}
                  >
                    <Image source={{ uri: s.uri }} style={{ width: '100%', height: 110 }} contentFit="cover" />
                    <View className="flex-row items-center justify-between px-3 py-2">
                      <Text className="text-xs font-semibold text-muted">
                        {i === 0 ? 'Result sheet' : 'Venue'}
                      </Text>
                      <Text className="text-xs font-bold text-hawk-leaf">Retake</Text>
                    </View>
                  </Pressable>
                ) : null,
              )}
            </View>
            <View className="mb-3 rounded-2xl bg-card px-4 py-2">
              {votes
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((v) => (
                  <View key={v.party} className="flex-row justify-between py-1.5">
                    <Text className="text-base font-semibold text-ink">{v.party}</Text>
                    <Text className="text-base font-bold text-ink">{v.count.toLocaleString()}</Text>
                  </View>
                ))}
            </View>
            {/* Optional serial — parity with the PWA's #sheet-serial input.
                Sits immediately above the submit CTA so it cannot be missed. */}
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
              Submitting takes a GPS fix at your position, signs the report with this device’s
              key, and files it for review. Your number is never attached — only your observer ID.
            </Text>
          </ScrollView>
        ) : null}

        {/* Pinned CTA — the summary above grows a row per party, and the status
            line rides with the button: on a failed submit the retry must stay
            under the observer's thumb, not be pushed further down the scroll. */}
        {step === 'review' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {line ? <Text className="pb-2 text-sm font-semibold text-warn-ink">{line}</Text> : null}
            <Pressable
              disabled={busy}
              onPress={onSubmit}
              className={`items-center rounded-2xl py-4 ${busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
            >
              {busy ? <ActivityIndicator color={BRAND.gold} /> : (
                <Text className="text-base font-bold text-hawk-gold">Sign &amp; submit</Text>
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
              {/* Queued is the app's caution tone, not a fixed amber-600 with
                  gold on it — that pairing was ~2.4:1 and identical in both
                  themes. bg-warn/text-warn-ink is the same tinted pair every
                  other caution surface in the app uses, and it flips. */}
              {/* TWO endings, two marks. The green check means "this is on the
                  ledger" and only the filed one may wear it; amber-clock is the
                  report still waiting in the outbox. (Rehearsal lives in the
                  practice section now — closed races cannot be reached here.) */}
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
                what makes the ledger checkable by the person who filed it. */}
            {receipt.entryHash ? (
              <View className="mt-6 rounded-2xl bg-hawk-green px-4 py-4">
                <Text className="text-[11px] font-bold uppercase tracking-wider text-hawk-gold">
                  Ledger entry
                </Text>
                <Pressable
                  // bg-white/10, not bg-card/10: this scrim sits on the fixed
                  // brand-green receipt card, which does not flip. --card is dark
                  // in dark mode, so a card-tinted scrim there goes dark-on-dark
                  // and swallows the hash pill. Matches collation.tsx's fix.
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

            {/* THE INDEPENDENT PROOF. The hash above is Hawkeye's word; this is
                the part that is not. The ledger head is signed into Sigstore
                Rekor, a public append-only log we do not run — but only on the
                anchor run, so a report filed minutes ago is not in one yet. The
                component says which of those two is true and links ONLY when an
                anchor covering this entry actually exists. */}
            {receipt.entryHash ? (
              <RekorAnchor entryHash={receipt.entryHash} chain="ledger" />
            ) : null}

            {receipt.result || receipt.locationVerified != null || receipt.ocr ? (
              <View className="mt-3 rounded-2xl bg-card px-4 py-2">
                {receipt.result?.status ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-muted">Status</Text>
                    <Text
                      // Same contrast fault as the amber above, same fix:
                      // red-700 is a fixed #b91c1c and lands ~3.4:1 on the dark
                      // card. text-bad-ink/text-warn-ink follow the theme.
                      className={`text-sm font-bold ${receipt.result.status === 'disputed' ? 'text-bad-ink' : receipt.result.status === 'pending' ? 'text-warn-ink' : 'text-hawk-leaf'}`}
                    >
                      {receipt.result.status.toUpperCase()}
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.confidence != null ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-muted">Confidence</Text>
                    <Text className="text-sm font-bold text-ink">
                      {receipt.result.confidence}%
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.totalReports != null ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-muted">Reports agreeing</Text>
                    <Text className="text-sm font-bold text-ink">
                      {receipt.result.matchingReports ?? 0} of {receipt.result.totalReports}
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.locationStatus || receipt.locationVerified != null ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="pr-3 text-sm text-muted">Location</Text>
                    <View className="flex-1 flex-row items-center justify-end">
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: receiptLocation(receipt).color,
                        }}
                        className="mr-1.5"
                      />
                      <Text className="flex-shrink text-right text-sm font-bold text-ink">
                        {receiptLocation(receipt).label}
                      </Text>
                    </View>
                  </View>
                ) : null}
                {receipt.result?.venueMatches ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="text-sm text-muted">Venue photo matches</Text>
                    <Text className="text-sm font-bold text-ink">
                      {receipt.result.venueMatches}
                    </Text>
                  </View>
                ) : null}
                {/* What the phone read off the sheet versus what was typed —
                    the observer should see the machine's second opinion too. */}
                {receipt.ocr?.total ? (
                  <View className="flex-row items-center justify-between py-1.5">
                    <Text className="pr-3 text-sm text-muted">Read off your photo</Text>
                    <Text className="text-sm font-bold text-ink">
                      {receipt.ocr.matched} of {receipt.ocr.total} counts matched
                    </Text>
                  </View>
                ) : null}
                {receipt.result?.scope ? (
                  <Text className="py-1.5 text-xs text-muted">{receipt.result.scope}</Text>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        ) : null}

        {step === 'done' ? (
          <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
            {/* replace, not push: the finished report flow should not sit under
                the log the observer went to check. */}
            <Pressable className="items-center pb-3" onPress={() => router.replace('/reports-log')}>
              <Text className="text-sm font-semibold text-hawk-leaf">
                {/* A queued report has no ledger entry to look for yet, so it is
                    not sent looking for one. */}
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

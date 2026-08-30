/**
 * PICK ONE RACE OUT OF A COMBINED CONTEST. Native twin of app/race-picker.js.
 *
 * SEN is 109 seats, REP 366, SHA 1,005, LGA 774. The map cannot be the way in
 * at that scale — nobody reliably taps their own federal constituency on a
 * phone showing 366 of them — so those four get state-then-seat instead.
 *
 * Deliberately the same two-step shape as the register cascade in the reporting
 * flow, because an observer has already learned that gesture and this is the
 * same question asked about a different list.
 *
 * DATA — nothing new is fetched. loadSeats() (lib/political.ts) already pulls
 * seat_lgas.json for the seat screens and memoises it for the run; LGA comes
 * from district_index.json, keyed "state|lga".
 *
 * The 40-character and one-line rules are NOT repeated here: this component
 * shows one row per seat with its own subtitle, so the web's clamp/More problem
 * does not arise. What IS shared with the web is the contest list and the
 * destination URLs, so the same tap goes to the same place on both.
 */
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { BASE } from '@/lib/api';
import { loadPolitical, loadSeats, type SeatTable } from '@/lib/political';
import { useUi } from '@/lib/theme';

/**
 * Compare state names by shape, not spelling. The contest catalogue and the
 * register agree on the names but not always on punctuation or case, and a
 * governorship silently tagged "off-cycle" because of a hyphen would be a lie
 * told confidently. Mirrors normRegion in lib/political.ts, which is private
 * to that module.
 */
const normKey = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The four contests decided across many separate races. */
export const COMBINED: Record<
  string,
  { title: string; label: string; plural: string; lgaSource?: true; statesAreRaces?: true }
> = {
  SEN: { title: 'Senate', label: 'senatorial district', plural: 'senatorial districts' },
  REP: { title: 'House of Representatives', label: 'federal constituency', plural: 'federal constituencies' },
  SHA: { title: 'State Houses of Assembly', label: 'state constituency', plural: 'state constituencies' },
  LGA: { title: 'Local Government Chairmanship', label: 'local government area', plural: 'local government areas', lgaSource: true },
  /**
   * GOVERNORSHIP IS ONE STEP: the state IS the race, so the first list is also
   * the last and picking from it navigates.
   *
   * Its states come from the CONTEST, never from the register or a hardcoded
   * 36 — governorships are staggered and the 2027 row lists 28. Offering the
   * other nine would send a reader to a race that is not being held.
   */
  GOV: { title: 'Governorship', label: 'state', plural: 'states', statesAreRaces: true },
};

export function isCombined(code: string | null | undefined): boolean {
  return !!code && Object.prototype.hasOwnProperty.call(COMBINED, code);
}

type Row = { name: string; sub: string };

/** district_index.json is keyed "state|lga", lowercased. Memoised like seats. */
let lgaCache: Promise<Record<string, unknown>> | null = null;
function loadLgas(): Promise<Record<string, unknown>> {
  if (!lgaCache) {
    lgaCache = fetch(`${BASE}/district_index.json`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`district_index.json → HTTP ${r.status}`);
        return (await r.json()) as Record<string, unknown>;
      })
      // Clear on failure so the next open retries rather than replaying one
      // rejection for the life of the app — the same rule loadSeats uses.
      .catch((e) => { lgaCache = null; throw e; });
  }
  return lgaCache;
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function statesOf(code: string, data: SeatTable | Record<string, unknown>): string[] {
  const set = new Set<string>();
  if (COMBINED[code].lgaSource) {
    Object.keys(data).forEach((k) => { const s = k.split('|')[0]; if (s) set.add(titleCase(s)); });
  } else {
    const seats = (data as SeatTable)[code] || {};
    Object.values(seats).forEach((v) => { if (v?.state) set.add(v.state); });
  }
  return [...set].sort();
}

function rowsOf(code: string, data: SeatTable | Record<string, unknown>, state: string): Row[] {
  const out: Row[] = [];
  if (COMBINED[code].lgaSource) {
    Object.keys(data).forEach((k) => {
      const [s, lga] = k.split('|');
      if (lga && s?.toLowerCase() === state.toLowerCase()) out.push({ name: titleCase(lga), sub: '' });
    });
  } else {
    const seats = (data as SeatTable)[code] || {};
    Object.entries(seats).forEach(([key, row]) => {
      if (!row || row.state?.toLowerCase() !== state.toLowerCase()) return;
      // SHA keys are "State|Seat" and carry the bare name in `seat`; SEN and REP
      // key on the name itself. Reading the key blindly would show every SHA row
      // prefixed with its state AND send that whole string as ?seat=.
      const name = row.seat || (key.includes('|') ? key.slice(key.indexOf('|') + 1) : key);
      const bits: string[] = [];
      if (row.wards) bits.push(`${row.wards} ward${row.wards === 1 ? '' : 's'}`);
      if (row.pollingUnits) bits.push(`${row.pollingUnits.toLocaleString()} polling units`);
      out.push({ name, sub: bits.join(' · ') });
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Where a pick lands — the same params app/race.js reads. */
function target(code: string, state: string, pick: string): string {
  const q = `contest=${encodeURIComponent(code)}`;
  // GOV: the state IS the race, so there is no seat to name.
  if (COMBINED[code].statesAreRaces) return `/race?${q}&state=${encodeURIComponent(state)}`;
  if (COMBINED[code].lgaSource) {
    return `/race?${q}&state=${encodeURIComponent(state)}&lga=${encodeURIComponent(pick)}`;
  }
  // SHA needs its state too: assembly seat names repeat across states.
  return `/race?${q}${code === 'SHA' ? `&state=${encodeURIComponent(state)}` : ''}&seat=${encodeURIComponent(pick)}`;
}

/**
 * THE CARD KEYS ITSELF ON THE CONTEST, and that is the fix for the stuck
 * governorship card — it was never a slow fetch.
 *
 * results.tsx renders the picker inside the FlashList's ListHeaderComponent and
 * swaps `code` in place: applyLink() sets the new contest without touching
 * `picking`, so the list is never unmounted. Every piece of the picker's state
 * therefore survived a contest switch, and toggle()'s own guard —
 * `if (!next || data || busy) return` — then refused to recompute because
 * `data` looked populated.
 *
 * So: open the Senate board, expand the picker once, go Home, open
 * Governorship. `data` was still SEN's seat table, `data.__states` undefined,
 * and the list rendered as [] with no error and no spinner — an empty "STATE"
 * heading, exactly what the screenshot showed. Choosing the contest from the
 * in-screen chooser DOES unmount the list, which is why it came right "on
 * another try".
 *
 * The key lives HERE rather than at the two call sites: a key on a caller is
 * one line that the next caller added is free to forget, and it is this
 * component that knows its state belongs to exactly one contest. Resetting in
 * an effect instead would be six setState calls in an effect body — cascading
 * renders, and what react-hooks/set-state-in-effect exists to stop.
 */
export function RacePicker(props: { code: string; states?: string[] }) {
  return <RacePickerFor key={props.code} {...props} />;
}

function RacePickerFor({ code, states: given }: { code: string; states?: string[] }) {
  const ui = useUi();
  const meta = COMBINED[code];
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SeatTable | Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<string | null>(null);
  /** Every state in the register, for tagging the off-cycle governorships. */
  const [universe, setUniverse] = useState<string[] | null>(null);

  // Loaded on FIRST OPEN, not on mount: a reader who came for the board should
  // not pay for a list they never asked to see.
  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || data || busy) return;
    /**
     * GOVERNORSHIP FETCHES NOTHING. Its states arrive as a prop, so the list is
     * DERIVED at render (see `states` below) rather than copied into `data` on
     * open. Copying it was what made the card unable to notice the catalogue
     * landing a moment later: a prop re-renders on its own, a snapshot does not.
     */
    if (meta.statesAreRaces) return;
    setBusy(true);
    setErr(null);
    try {
      const d = meta.lgaSource ? await loadLgas() : await loadSeats();
      // An empty list is a failure, not a result — 36 states and the FCT exist.
      if (!statesOf(code, d).length) throw new Error('no states in the seat table');
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    // `given` is deliberately absent: governorship returns above without
    // reading it, and the list it feeds is derived at render instead.
  }, [open, data, busy, code, meta.lgaSource, meta.statesAreRaces]);

  /**
   * The register's state list, fetched once the card is open and only for
   * governorship. loadPolitical() is module-cached and every other screen has
   * already asked for it, so this is normally free.
   *
   * Deliberately NOT awaited by the list: the contest's own states render
   * immediately and the off-cycle tags fill in behind them. Marking eight extra
   * states is a courtesy and must never be something a reader waits on.
   */
  useEffect(() => {
    if (!open || !meta?.statesAreRaces || universe) return;
    let live = true;
    loadPolitical()
      .then(({ data: pd }) => {
        if (live) setUniverse(Object.keys(pd?.stateStats ?? {}));
      })
      .catch(() => {
        /* the contest's own states are already listed; say nothing */
      });
    return () => {
      live = false;
    };
  }, [open, meta, universe]);

  if (!meta) return null;
  // GOV reads its states straight off the prop — see toggle(). The others need
  // the fetched table, so they stay gated on `data`.
  const states = meta.statesAreRaces
    ? [...(given ?? [])].sort()
    : !data
      ? []
      : statesOf(code, data);

  /**
   * EVERY STATE WITH A GOVERNOR, the eight out-of-cycle ones tagged.
   *
   * A reader in Ekiti scanning a list of 28 does not find their state and
   * learns nothing about why. The destination is already honest — an off-cycle
   * governorship page says so in its own words (lib/political.ts:486), and
   * Osun's is better than honest, because political_data.json carries
   * raceOsun2026 with INEC's declaration — so the omission was the only problem.
   *
   * Derived rather than listed: the universe is the register's own states and
   * "off-cycle" means "not named by the contest", so a state changing cycle
   * needs no edit here. FCT is dropped — it has no governor.
   */
  const stateRows: { name: string; off: boolean }[] = meta.statesAreRaces
    ? (() => {
        const inCycle = new Set(states.map(normKey));
        const all = (universe?.length ? universe : states).filter((s) => normKey(s) !== 'fct');
        return [...all]
          .sort()
          .map((name) => ({ name, off: !inCycle.has(normKey(name)) }));
      })()
    : states.map((name) => ({ name, off: false }));

  const rows = data && state && !meta.statesAreRaces ? rowsOf(code, data, state) : [];

  return (
    <View className="mx-4 mb-3 overflow-hidden rounded-2xl border border-line bg-card">
      <Pressable
        onPress={toggle}
        className="flex-row items-center px-4 py-3.5 active:opacity-80"
        accessibilityRole="button"
        accessibilityLabel={`Find your ${meta.label}`}
      >
        <View className="flex-1">
          <Text className="text-base font-bold text-ink">Find your {meta.label}</Text>
          <Text className="pt-0.5 text-xs text-muted">
            {/* One step means one sentence. For GOV meta.label is "state", so the
                two-step template read "Pick a state, then your state" — naming a
                second step that does not exist. */}
            {meta.statesAreRaces
              ? 'Pick a state to open its race'
              : state
                ? `${state} — pick a ${meta.label}`
                : `Pick a state, then your ${meta.label}`}
          </Text>
        </View>
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={20} color={ui.muted} />
      </Pressable>

      {open ? (
        <View className="border-t border-line px-4 pb-4">
          {busy ? (
            <ActivityIndicator className="py-6" color={ui.tint.good.ink} />
          ) : err ? (
            <Pressable onPress={toggle} className="py-5">
              <Text className="text-sm font-semibold text-bad-ink">
                Could not load the list of {meta.plural}.
              </Text>
              <Text className="pt-1 text-xs text-muted">Tap to try again. ({err})</Text>
            </Pressable>
          ) : !state ? (
            <>
              {/* Only worth a step heading when there IS a second step. On
                  governorship the card title already says "Find your state",
                  so a "STATE" bar under it labels the same thing twice. */}
              {meta.statesAreRaces ? null : (
                <Text className="pb-1 pt-3 text-xs font-bold uppercase tracking-wide text-muted">State</Text>
              )}
              {stateRows.length === 0 ? (
                // Never an empty list under a heading: that is indistinguishable
                // from a list still loading, and it is what the screenshot of
                // the stuck governorship card actually showed.
                <Text className="py-4 text-sm text-muted">Waiting for the list of states.</Text>
              ) : null}
              <ScrollView className="max-h-80" nestedScrollEnabled>
                {stateRows.map((s) => (
                  <Pressable
                    key={s.name}
                    // One step for GOV: the state IS the race, so tapping it
                    // navigates rather than drilling into a seat list.
                    onPress={() =>
                      meta.statesAreRaces ? router.push(target(code, s.name, '') as never) : setState(s.name)
                    }
                    className="flex-row items-center border-b border-line py-3 active:opacity-70"
                  >
                    <View className="flex-1 pr-2">
                      <Text className="text-[15px] text-ink">{s.name}</Text>
                      {s.off ? (
                        // Says which of the two it is, not merely that it differs.
                        <Text className="pt-0.5 text-xs text-muted">
                          Off-cycle — not in the 2027 election
                        </Text>
                      ) : null}
                    </View>
                    <Feather name="chevron-right" size={16} color={ui.faint} />
                  </Pressable>
                ))}
              </ScrollView>
            </>
          ) : (
            <>
              <Pressable onPress={() => setState(null)} className="flex-row items-center py-3 active:opacity-70">
                <Feather name="chevron-left" size={16} color={ui.tint.good.ink} />
                <Text className="pl-1 text-sm font-semibold text-good-ink">All states</Text>
              </Pressable>
              <Text className="pb-1 text-xs font-bold uppercase tracking-wide text-muted">
                {rows.length} {rows.length === 1 ? meta.label : meta.plural} in {state}
              </Text>
              <ScrollView className="max-h-96" nestedScrollEnabled>
                {rows.map((r) => (
                  <Pressable
                    key={r.name}
                    onPress={() => router.push(target(code, state, r.name) as never)}
                    className="flex-row items-center border-b border-line py-3 active:opacity-70"
                  >
                    <View className="flex-1 pr-2">
                      <Text className="text-[15px] text-ink">{r.name}</Text>
                      {r.sub ? <Text className="pt-0.5 text-xs text-muted">{r.sub}</Text> : null}
                    </View>
                    <Feather name="chevron-right" size={16} color={ui.faint} />
                  </Pressable>
                ))}
              </ScrollView>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

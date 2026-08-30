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
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { BASE } from '@/lib/api';
import { loadSeats, type SeatTable } from '@/lib/political';
import { useUi } from '@/lib/theme';

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

export function RacePicker({ code, states: given }: { code: string; states?: string[] }) {
  const ui = useUi();
  const meta = COMBINED[code];
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SeatTable | Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<string | null>(null);

  // Loaded on FIRST OPEN, not on mount: a reader who came for the board should
  // not pay for a list they never asked to see.
  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || data || busy) return;
    // GOVERNORSHIP: the states arrived with the contest, so there is nothing to
    // fetch and nothing to wait for.
    if (meta.statesAreRaces) {
      if (!given?.length) setErr('no governorship races are listed for this election');
      else setData({ __states: given } as never);
      return;
    }
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
  }, [open, data, busy, code, meta.lgaSource, meta.statesAreRaces, given]);

  if (!meta) return null;
  // GOV carries its states directly; the others derive them from the table.
  const states = !data
    ? []
    : meta.statesAreRaces
      ? [...((data as { __states?: string[] }).__states ?? [])].sort()
      : statesOf(code, data);
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
            {state ? `${state} — pick a ${meta.label}` : `Pick a state, then your ${meta.label}`}
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
              <Text className="pb-1 pt-3 text-xs font-bold uppercase tracking-wide text-muted">State</Text>
              <ScrollView className="max-h-80" nestedScrollEnabled>
                {states.map((s) => (
                  <Pressable
                    key={s}
                    // One step for GOV: the state IS the race, so tapping it
                    // navigates rather than drilling into a seat list.
                    onPress={() => (meta.statesAreRaces ? router.push(target(code, s, '') as never) : setState(s))}
                    className="flex-row items-center border-b border-line py-3 active:opacity-70"
                  >
                    <Text className="flex-1 text-[15px] text-ink">{s}</Text>
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

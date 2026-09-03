import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Crumb, Prompt } from '@/components/wizard';
import type { Contest } from '@/lib/api';
import { useUi } from '@/lib/theme';
import {
  ELECTION_TYPES,
  GOVERNORSHIP_STATES,
  STATE_ASSEMBLY,
  STATES,
  isRaceOpen,
  listRaces,
  matchContest,
  raceLabel,
  type ElectionType,
  type ElectionTypeCode,
  type Race,
  type StateName,
} from '@/lib/races';

/**
 * contest-picker — the one shared election-type → … → single-race selector.
 *
 * result/collation/practice all reach a single Race through the same widget, so
 * the three flows cannot drift into three different ideas of what a race is or
 * how "open" reads. It is a BOUNDED BLOCK, not a screen: it renders one stage at
 * a time (type → state → race), leans on wizard.tsx's Prompt/Crumb for the
 * forward instruction and the way back, and never introduces its own ScrollView
 * or navigation — it sits inside each caller's existing ScrollView above their
 * pinned footer.
 *
 * ── The two axes a caller controls ──
 *  - `lockedState`: a result reported AT a polling unit already knows its state,
 *    so the state step is skipped and every count/list is scoped to that state.
 *    Better than the PWA, which asked for a state the unit already implied.
 *  - `allowClosed`: the real reporting flow leaves closed races unselectable;
 *    practice may rehearse ANY race, so it passes true. Either way the
 *    green/closed styling reports REAL openness — in practice that tells the user
 *    a green race is live and a dim one is a rehearsal, rather than hiding the
 *    difference.
 *
 * Openness is never hardcoded: it comes only from the `contests` array the
 * caller fetched from GET /api/contests, matched to a race exactly as
 * races.ts:matchContest does (same code + states[] rule). This picker does no
 * network of its own.
 */

export interface ContestPickerProps {
  /** The GET /api/contests array. The caller fetches; the picker only reads. */
  contests: Contest[];
  /** The currently selected race, or null. Controlled by the caller. */
  value: Race | null;
  /** Called with a fully-resolved Race when the user selects one. */
  onSelect: (race: Race) => void;
  /**
   * When set, the state step is skipped and the whole picker is scoped to this
   * state — for a flow that already knows where it is (a report at a unit).
   */
  lockedState?: StateName;
  /**
   * false (default): closed races are visible but NOT pressable — the real
   * reporting flow. true: closed races are selectable too (practice rehearses
   * any race); the styling still shows real openness so a rehearsal reads as one.
   */
  allowClosed?: boolean;
}

/**
 * Which states a given election type can narrow into. GOV excludes the FCT (it
 * elects no governor), SHA drops the FCT too (it has no State House of Assembly
 * — six Area Councils instead, STATE_ASSEMBLY.FCT.seats === 0). SEN and REP keep
 * the FCT, which has one senatorial "Abuja" and two federal constituencies.
 */
function statesFor(type: ElectionTypeCode): readonly StateName[] {
  if (type === 'GOV') return GOVERNORSHIP_STATES;
  if (type === 'SHA') return STATES.filter((s) => STATE_ASSEMBLY[s].seats > 0);
  return STATES;
}

/** A short "opens …" tag for a closed race, from the contest's opensAt. */
function opensTag(c: Contest | undefined): string {
  if (!c) return 'Not yet scheduled';
  if (!c.opensAt) return 'Not yet open';
  const d = new Date(c.opensAt);
  if (Number.isNaN(d.getTime())) return `Opens ${c.opensAt}`;
  return `Opens ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

export function ContestPicker({
  contests,
  value,
  onSelect,
  lockedState,
  allowClosed = false,
}: ContestPickerProps) {
  const ui = useUi();

  // Stage state. Seeded from `value` so a picker handed an existing selection
  // opens on the matching branch with the right crumbs, rather than back at the
  // type menu. `stateSel` is ignored whenever `lockedState` is set.
  const [typeSel, setTypeSel] = useState<ElectionTypeCode | null>(value?.type ?? null);
  const [stateSel, setStateSel] = useState<StateName | null>(value?.state ?? null);

  /**
   * Per-type open counts and next-open dates, in one memo so the pass over
   * `contests` happens once. Openness comes from races.ts:matchContest /
   * isRaceOpen — the ONE rule, USED rather than re-implemented, so this picker
   * cannot drift from the catalogue's idea of what a contest covers. The bare
   * `c.code === race.contestCode` test that used to live here silently missed
   * every by-election: a SHA by-election is `code: 'SHA_BYE_…'` with `tier:
   * 'SHA'`, and matchContest is what narrows it to its own constituencies/LGAs.
   */
  const { match, isOpen, counts, soonest } = useMemo(() => {
    const match = (race: Race): Contest | undefined => matchContest(race, contests);
    const isOpen = (race: Race) => isRaceOpen(race, contests);
    const counts = { PRES: 0, GOV: 0, SEN: 0, REP: 0, SHA: 0 } as Record<ElectionTypeCode, number>;
    /**
     * THE NEXT DATE ANYTHING IN THIS TIER OPENS.
     *
     * Reporting opens at 08:30 on polling day and not a minute before, so
     * `open` is false for every contest until that morning — which is correct,
     * and which made this screen say "No open races" against all five tiers with
     * five by-elections twenty-four days away. A reader cannot tell that from
     * nothing-at-all, and the by-elections are exactly the races we need people
     * to find NOW, while there is still time to recruit for them.
     *
     * So a tier with nothing open reports when its soonest race opens instead.
     * No arbitrary "within N days" window: the real date is more use than a
     * threshold, and there is nothing to keep in sync.
     */
    const soonest = {} as Record<ElectionTypeCode, string | null>;
    const now = Date.now();
    for (const t of ELECTION_TYPES) {
      const rs = listRaces(t.code, lockedState);
      counts[t.code] = rs.filter(isOpen).length;
      const upcoming = rs
        .map((r) => match(r)?.opensAt)
        .filter((d): d is string => !!d && new Date(d).getTime() > now)
        .sort();
      soonest[t.code] = upcoming[0] ?? null;
    }
    return { match, isOpen, counts, soonest };
  }, [contests, lockedState]);

  const anyOpen = ELECTION_TYPES.some((t) => counts[t.code] > 0);

  /**
   * The "Open races" filter, DEFAULT OFF.
   *
   * It used to default ON as soon as anything was open, to keep the common path
   * short. With exactly one contest configured that collapsed the whole picker
   * to "Governorship", and the app read as though Hawkeye only covers one
   * election — the same complaint the web pickers had (window.HAWKEYE_RACES in
   * app/menu.js is the twin fix). Showing all five, with the closed ones muted
   * and badged "No open races", states the 2027 coverage up front; the toggle is
   * still there for anyone who wants the short list.
   *
   * `anyOpen` is still read here so the toggle only appears when filtering would
   * actually do something.
   */
  const [onlyOpen, setOnlyOpen] = useState(false);

  // `touched` is gone with the auto-default: nothing overrides the user's choice
  // any more, so there is no longer anything to guard against.
  const toggleFilter = () => {
    setOnlyOpen((v) => !v);
    Haptics.selectionAsync();
  };

  const pickType = (code: ElectionTypeCode) => {
    Haptics.selectionAsync();
    setTypeSel(code);
    setStateSel(null);
  };
  const pickState = (s: StateName) => {
    Haptics.selectionAsync();
    setStateSel(s);
  };
  const choose = (race: Race) => {
    Haptics.selectionAsync();
    onSelect(race);
  };

  const type: ElectionType | undefined = ELECTION_TYPES.find((t) => t.code === typeSel);
  const needsState = !!type && type.narrowBy.includes('state');
  const effectiveState = lockedState ?? stateSel;

  // ── Filter toggle — shown only when there is something open to filter to ──
  const filterToggle = anyOpen ? (
    <Pressable
      onPress={toggleFilter}
      className="mb-2 flex-row items-center self-start rounded-full bg-card px-3.5 py-2 active:opacity-70"
    >
      <Feather
        name={onlyOpen ? 'check-square' : 'square'}
        size={15}
        color={onlyOpen ? ui.tint.good.ink : ui.faint}
      />
      <Text className={`pl-2 text-xs font-bold ${onlyOpen ? 'text-good-ink' : 'text-muted'}`}>
        Open races only
      </Text>
    </Pressable>
  ) : null;

  // ── Crumbs — the way back through the stages already chosen ──
  const crumbs = (
    <>
      {type ? (
        <Crumb
          label={type.label}
          onPress={() => {
            setTypeSel(null);
            setStateSel(null);
          }}
        />
      ) : null}
      {type && needsState && !lockedState && stateSel ? (
        <Crumb label={stateSel} onPress={() => setStateSel(null)} />
      ) : null}
    </>
  );

  // ── Stage 1: election type ──
  if (!type) {
    const shown = onlyOpen ? ELECTION_TYPES.filter((t) => counts[t.code] > 0) : ELECTION_TYPES;
    return (
      <View>
        {filterToggle}
        <Prompt>Choose an election</Prompt>
        {shown.map((t) => {
          const open = counts[t.code];
          const next = soonest[t.code];
          // Muted means "nothing to do here". A tier whose next race has a date
          // is NOT nothing — it is the thing to prepare for — so only a tier
          // with neither an open race nor an upcoming one is dimmed.
          const muted = open === 0 && !next;
          return (
            <Pressable
              key={t.code}
              onPress={() => pickType(t.code)}
              className={`mb-2 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80 ${
                muted ? 'opacity-60' : ''
              }`}
            >
              <View className="flex-1 pr-3">
                <Text className="text-base font-bold text-ink">{t.label}</Text>
                <Text className="pt-0.5 text-xs text-muted">
                  {t.seatLabel} · {t.seats} nationwide
                </Text>
              </View>
              {open > 0 ? (
                <View className="mr-1.5 rounded-full bg-good px-2.5 py-1">
                  <Text className="text-[11px] font-bold text-good-ink">{open} open</Text>
                </View>
              ) : next ? (
                <View className="mr-1.5 rounded-full border border-good-ink px-2.5 py-1">
                  <Text className="text-[11px] font-bold text-good-ink">
                    Opens {new Date(next).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </Text>
                </View>
              ) : (
                <Text className="mr-1.5 text-[11px] font-semibold text-faint">No open races</Text>
              )}
              <Feather name="chevron-right" size={18} color={ui.faint} />
            </Pressable>
          );
        })}
      </View>
    );
  }

  // ── Stage 2: state (only for types that narrow by state, and only when the
  // caller has not locked one) ──
  if (needsState && !effectiveState) {
    const options = statesFor(type.code);
    const stateHasOpen = (s: StateName) => listRaces(type.code, s).some(isOpen);
    // A state with no COVERED race is not a browsable option either. Turning off
    // "open races only" is meant to reveal races Hawkeye covers but that are not
    // open yet — not races it does not collect at all.
    const stateHasCovered = (s: StateName) => listRaces(type.code, s).some((r) => !!match(r));
    const shown = options.filter(onlyOpen ? stateHasOpen : stateHasCovered);
    return (
      <View>
        {filterToggle}
        {crumbs}
        <Prompt>Choose a state</Prompt>
        {shown.length === 0 ? (
          <Text className="px-1 py-2 text-sm text-muted">
            No {type.label.toLowerCase()} race is open yet. Turn off “Open races only” to browse the
            full list.
          </Text>
        ) : (
          <View className="flex-row flex-wrap">
            {shown.map((s) => (
              <Pressable
                key={s}
                onPress={() => pickState(s)}
                className="mb-2 mr-2 flex-row items-center rounded-full bg-card px-3.5 py-2 active:opacity-70"
              >
                {/* A green dot marks a state with a live race — the honest cue
                    while browsing the full catalogue with the filter off. */}
                {stateHasOpen(s) ? (
                  <View className="mr-1.5 h-2 w-2 rounded-full bg-good-ink" />
                ) : null}
                <Text className="text-sm font-semibold text-ink">{s}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    );
  }

  // ── Stage 3: the concrete races for this type (+ state). One row for GOV/PRES,
  // a list for SEN/REP/SHA — SHA seats now come from STATE_ASSEMBLY via
  // listRaces('SHA', state), exactly like SEN districts and REP constituencies.
  // FCT never reaches here for SHA (statesFor('SHA') drops it, seats === 0). ──
  const races = listRaces(type.code, effectiveState ?? undefined);
  // NEVER OFFER A RACE NO CONTEST COVERS. listRaces() enumerates the whole
  // constitutional catalogue — all 36 governorships, all 109 districts — while
  // /api/contests says which of them Hawkeye is actually collecting. The 2027
  // governorship runs in 28 states, so the other eight were being offered here
  // and led to a board that could only ever say "Not covered yet": Osun's
  // governorship is off-cycle and was appearing, wrongly, as "Osun Governorship
  // (2027)" — a race that does not exist. Same rule the results screen already
  // applies before offering to re-rank the board.
  const shown = races.filter(onlyOpen ? isOpen : (r) => !!match(r));
  return (
    <View>
      {filterToggle}
      {crumbs}
      <Prompt>{races.length > 1 ? 'Choose the race' : 'Confirm the race'}</Prompt>
      {shown.length === 0 ? (
        <Text className="px-1 py-2 text-sm text-muted">
          No open race here yet. Turn off “Open races only” to see every race Hawkeye covers.
        </Text>
      ) : (
        shown.map((race) => {
          const c = match(race);
          const open = c?.open === true;
          const selectable = allowClosed || open;
          const selected = value?.key === race.key;
          return (
            <Pressable
              key={race.key}
              disabled={!selectable}
              onPress={() => choose(race)}
              className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${
                open ? 'bg-good' : 'bg-card'
              } ${selected ? 'border-2 border-good-ink' : ''} ${
                selectable ? 'active:opacity-80' : 'opacity-60'
              }`}
            >
              <View className="flex-1 pr-3">
                <Text
                  className={`text-sm font-semibold ${open ? 'text-good-ink' : 'text-ink'}`}
                >
                  {raceLabel(race, contests)}
                </Text>
                {!open ? (
                  <Text className="pt-0.5 text-[11px] font-semibold text-faint">
                    {opensTag(c)}
                    {allowClosed ? ' · rehearsal' : ''}
                  </Text>
                ) : null}
              </View>
              {selected ? (
                <Feather name="check-circle" size={20} color={ui.tint.good.ink} />
              ) : !selectable ? (
                <Feather name="lock" size={16} color={ui.faint} />
              ) : (
                <Feather name="circle" size={20} color={open ? ui.tint.good.ink : ui.faint} />
              )}
            </Pressable>
          );
        })
      )}
    </View>
  );
}

export default ContestPicker;

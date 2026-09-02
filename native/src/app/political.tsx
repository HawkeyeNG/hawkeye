import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';

import { InfoDot } from '@/components/info-dot';
import { GovDisclaimer } from '@/components/gov-disclaimer';
import { PartyMark } from '@/components/race';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';
import { humanError } from '@/lib/errors';
import { SeatArch } from '@/components/seat-arch';
import { NigeriaMap, normState } from '@/components/nigeria-map';

import {
  loadPolitical,
  partyColor,
  partyName,
  type Members,
  type Political,
} from '@/lib/political';

// Same base every other call uses — see lib/api.ts. Overridable so the app
// can run against a local backend; production blocks cross-origin calls.
const API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

/**
 * Political Data — who holds power now: the incumbents this election confirms
 * or unseats.
 *
 * The governors card carries BOTH the choropleth the website has and the grouped
 * list (party → its states). They answer different questions and neither
 * replaces the other: the map answers "who governs HERE", which a list of party
 * names cannot, and the list carries the counts a map only implies. The map
 * answers a tap, the way the seat arches do.
 */
/**
 * The order the page reads in: presidency (above), then governors, Senate,
 * House, State Assemblies, LGA chairmen.
 *
 * Object.entries() was used before, so the order was whichever order
 * political_data.json happened to list the chambers in — senate, house,
 * governors, assembly, lga. That put the two national chambers above the
 * governors, and the governing-party-by-state breakdown ended up several
 * screens below the governor count it belongs to.
 *
 * Descending scope, and it is stated HERE rather than fixed in the data,
 * because a JSON key order is not a design decision and nothing stops the next
 * edit from reshuffling it.
 */
const CHAMBER_ORDER = ['governors', 'senate', 'house', 'assembly', 'lga'];

function orderedChambers<T>(chambers: Record<string, T>): [string, T][] {
  const rank = (k: string) => {
    const i = CHAMBER_ORDER.indexOf(k);
    // A chamber added later and not listed sorts LAST rather than vanishing.
    return i === -1 ? CHAMBER_ORDER.length : i;
  };
  return Object.entries(chambers).sort((a, b) => rank(a[0]) - rank(b[0]));
}


/**
 * The governing party for a state the MAP named.
 *
 * The geo file and political_data.json spell several states differently, so the
 * tapped name is matched through normState rather than used as a key — an exact
 * lookup silently returns nothing for exactly the states whose spelling differs,
 * which is the failure mode that leaves a tap looking broken.
 */
function governorParty(governors: Record<string, string> | undefined, picked: string): string | null {
  if (!governors) return null;
  const want = normState(picked);
  for (const [state, party] of Object.entries(governors)) {
    if (normState(state) === want) return party || null;
  }
  return null;
}

/**
 * The governor of a state, by NAME, or null.
 *
 * Sibling of governorParty above and matched to it: the same normState lookup,
 * for the same reason. Null for the FCT, which has no governor, and null for any
 * state the file does not name — publishing less is correct here, because a
 * wrong name on an election product is worse than a blank one.
 */
function governorName(data: Political, picked: string): string | null {
  const names = (data as { governorNames?: Record<string, string> }).governorNames;
  if (!names || !picked) return null;
  const want = normState(picked);
  for (const [state, name] of Object.entries(names)) {
    if (normState(state) === want) return name || null;
  }
  return null;
}

/**
 * One state assembly as /api/political reports it. Wikipedia is the only source
 * for these, so `asOf` is Wikipedia's own date and is shown per row rather than
 * averaged into one claim about all 36.
 */
type ShaState = { seats: number; parties: Record<string, number>; asOf?: string };

export default function PoliticalData() {
  const ui = useUi();
  const [d, setD] = useState<Political | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Members | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The state the reader tapped on the map, in the GEO file's spelling. */
  const [pickedState, setPickedState] = useState<string | null>(null);
  /**
   * Per-state assembly composition, from /api/political — the same live source
   * the website's State Houses of Assembly section uses. NOT in
   * political_data.json: the committed file carries only the 993-seat national
   * total, so without this the assembly card can say how many seats exist and
   * nothing about who holds them.
   *
   * Enrichment, so a failure is silent and the section simply does not appear —
   * the rest of the page renders from the committed JSON as before.
   */
  const [assemblies, setAssemblies] = useState<Record<string, ShaState> | null>(null);
  const [shaOpen, setShaOpen] = useState(false);
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();

  useEffect(() => {
    loadPolitical()
      .then(({ data, logos: l, members: m }) => {
        setD(data);
        setLogos(l);
        setMembers(m);
      })
      .catch((e) => setErr(humanError(e, 'Could not load political data.')));
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/api/political`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (live && j?.ok && j.states && Object.keys(j.states).length) setAssemblies(j.states);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // FCT is in the register with a null party — it has a minister, not a
  // governor. Grouping it under "null" is worse than saying so.
  const byParty = (() => {
    const g: Record<string, string[]> = {};
    const none: string[] = [];
    for (const [state, party] of Object.entries(d?.governors ?? {})) {
      if (party) (g[party] ??= []).push(state);
      else none.push(state);
    }
    return { groups: Object.entries(g).sort((a, b) => b[1].length - a[1].length), none };
  })();

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Political Data" translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        <GovDisclaimer />
        <View className="flex-row items-center pb-3">
          <Text className="flex-1 text-sm text-muted">
            The parties in power now — the incumbents this election confirms or unseats.
          </Text>
          <InfoDot
            title="Reading this page"
            text="Each state is listed with its governing party, its governor and the year of its next election. Figures are compiled from public records and updated as results are declared."
          />
        </View>

        {err ? (
          <Text className="text-sm font-semibold text-warn-ink">Could not load. ({err})</Text>
        ) : !d ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : (
          <>
            {d.president ? (
              <View className="flex-row items-center rounded-2xl bg-card px-4 py-3">
                <PartyMark party={d.president.party} logos={logos} size={26} />
                <View className="flex-1 pl-3">
                  <Text className="text-sm font-bold text-ink">{d.president.name}</Text>
                  <Text className="text-xs text-muted">
                    Governing party:{' '}
                    <Text style={{ color: partyColor(d.president.party) }}>
                      {partyName(d.president.party)}
                    </Text>
                  </Text>
                </View>
              </View>
            ) : null}

            <Pressable
              className="mt-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-80"
              onPress={() => router.push('/candidates')}
            >
              <Feather name="users" size={17} color={ui.tint.good.ink} />
              <Text className="flex-1 pl-3 text-sm font-semibold text-ink">
                The 2027 Presidential Race — Full Profiles
              </Text>
              <Feather name="chevron-right" size={16} color={ui.faint} />
            </Pressable>

            {/* Seat composition per chamber, as a stacked party bar. */}
            {d.composition ? (
              <>
                <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                  Who holds power now
                </Text>
                {orderedChambers(d.composition.chambers).map(([key, ch]) => {
                  // Counts come from our own roster wherever we have one, so the
                  // picture and the names are the same fact counted once. The
                  // committed composition stays the fallback (and is the only
                  // source for governors / assemblies, who are not members).
                  const seats = members?.chambers?.[key];
                  const counts = seats?.withParty ? seats.parties : ch.parties;
                  const parties = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                  const held = parties.reduce((s, [, n]) => s + n, 0);
                  return (
                    <View key={key} className="mb-2 rounded-2xl bg-card px-4 py-3">
                      <View className="flex-row items-baseline">
                        <Text className="flex-1 text-sm font-bold text-ink">{ch.label}</Text>
                        <Text className="text-[11px] text-faint">
                          {held}/{ch.size} attributed
                        </Text>
                      </View>
                      {seats ? (
                        <>
                          <SeatArch parties={counts} size={ch.size} roster={seats} />
                          {/* THE COUNT UNDER THE CHAMBER, as the website has it.
                              "109/109 attributed" sits in the card's top corner
                              as a caveat about our data; this is the plain fact
                              about the chamber, under the picture of it, where a
                              reader looking at 109 dots asks how many there
                              are. */}
                          <Text className="pt-1 text-[11px] font-semibold text-muted">
                            {held} of {ch.size} seats
                          </Text>
                          <Text className="pt-0.5 text-[11px] text-faint">
                            Tap a seat for the {key === 'senate' ? 'Senator' : 'Member'}.
                          </Text>
                        </>
                      ) : null}
                      <View className="mt-2 h-2.5 flex-row overflow-hidden rounded-full bg-surface">
                        {parties.map(([p, n]) => (
                          <View
                            key={p}
                            style={{
                              width: `${(n / ch.size) * 100}%`,
                              backgroundColor: partyColor(p),
                            }}
                          />
                        ))}
                      </View>
                      <View className="flex-row flex-wrap pt-2">
                        {parties.map(([p, n]) => (
                          <View key={p} className="mr-3 flex-row items-center pt-1">
                            <View
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: partyColor(p) }}
                            />
                            <Text className="pl-1 text-[11px] text-muted">
                              {p} {n}
                            </Text>
                          </View>
                        ))}
                      </View>
                      {/* THE PER-STATE BREAKDOWN, folded — the website's State
                          Houses of Assembly section. 993 seats across 36
                          chambers is a number nobody can picture; this is which
                          party holds each one. CLOSED by default: the card above
                          is the answer, this is the working.

                          Only when the live source answered. Wikipedia is the
                          only source for these, so each row keeps the "as of"
                          Wikipedia itself carries — several are years old, and
                          saying so beats implying they are current. */}
                      {key === 'assembly' && assemblies ? (
                        <View className="pt-3">
                          <Pressable
                            onPress={() => setShaOpen((v) => !v)}
                            className="flex-row items-center rounded-xl bg-surface px-3 py-2 active:opacity-80"
                          >
                            <Text className="flex-1 text-xs font-bold text-ink">
                              {Object.keys(assemblies).length} of 36 state assemblies
                            </Text>
                            <Feather
                              name={shaOpen ? 'chevron-up' : 'chevron-down'}
                              size={16}
                              color={ui.faint}
                            />
                          </Pressable>
                          {shaOpen ? (
                            <View className="pt-2">
                              {Object.entries(assemblies)
                                .sort((a, b) => a[0].localeCompare(b[0]))
                                .map(([st, a]) => {
                                  const ranked = Object.entries(a.parties ?? {}).sort((x, y) => y[1] - x[1]);
                                  const top = ranked[0];
                                  return (
                                    <View key={st} className="border-t border-line py-2">
                                      <View className="flex-row items-baseline">
                                        <Text className="flex-1 text-xs font-semibold text-ink">{st}</Text>
                                        {top ? (
                                          <Text className="shrink-0 text-[11px] text-muted">
                                            <Text style={{ color: partyColor(top[0]) }}>{top[0]}</Text>{' '}
                                            {top[1]}/{a.seats}
                                          </Text>
                                        ) : null}
                                      </View>
                                      <View className="mt-1 h-1.5 flex-row overflow-hidden rounded-full bg-card">
                                        {ranked.map(([p, n]) => (
                                          <View
                                            key={p}
                                            style={{
                                              width: `${(n / Math.max(1, a.seats)) * 100}%`,
                                              backgroundColor: partyColor(p),
                                            }}
                                          />
                                        ))}
                                      </View>
                                      {a.asOf ? (
                                        <Text className="pt-0.5 text-[10px] text-faint">as of {a.asOf}</Text>
                                      ) : null}
                                    </View>
                                  );
                                })}
                            </View>
                          ) : null}
                        </View>
                      ) : null}
                      {key === 'governors' ? (
                        <View className="pt-3">
                          {/* THE MAP THE WEBSITE HAS, and it answers a tap.
                              The grouped list below carries the counts; a map
                              answers "who governs HERE", which a list of party
                              names cannot. Reuses components/nigeria-map, which
                              already takes fills + onPress — the same component
                              the incumbency map uses.

                              IT NAMES THE GOVERNOR NOW. This used to say the
                              file held state → party and no names, and that
                              naming a person we do not have is the one thing
                              this page must not do — both true at the time. The
                              names are in political_data.json as of 26 Aug 2026,
                              taken from each state government and the Nigeria
                              Governors Forum and cross-checked, so the rule is
                              satisfied rather than waived. */}
                          <NigeriaMap
                            /* The party emblem inside each state, the same
                               thing the website's map has always drawn. The
                               governors map IS about which party holds what, so
                               the colour alone asked the reader to hold a
                               five-item legend in their head while looking at
                               37 shapes. */
                            badges={(d.governors ?? {}) as Record<string, string>}
                            logos={logos}
                            fills={Object.fromEntries(
                              Object.entries(d.governors ?? {})
                                .filter(([, party]) => !!party)
                                .map(([state, party]) => [normState(state), partyColor(party as string)]),
                            )}
                            onPress={(state) => setPickedState(state)}
                          />
                          {pickedState ? (
                            <View className="mt-2 flex-row items-center rounded-xl bg-surface px-3 py-2">
                              <View className="flex-1">
                                <Text className="text-sm font-bold text-ink">{pickedState}</Text>
                                {/* THE PERSON, under the place. This row reported a
                                    party code and nothing else, because the data
                                    file held no names — the comment above still
                                    said so. It does now, researched from each
                                    state government and the Nigeria Governors
                                    Forum, so the question a reader actually asks
                                    of a governors map can be answered. Absent for
                                    the FCT, which has no governor. */}
                                {governorName(d, pickedState) ? (
                                  <Text className="pt-0.5 text-xs text-muted">
                                    {governorName(d, pickedState)}
                                  </Text>
                                ) : null}
                              </View>
                              {governorParty(d.governors, pickedState) ? (
                                <Text
                                  className="text-xs font-bold"
                                  style={{ color: partyColor(governorParty(d.governors, pickedState)!) }}
                                >
                                  {governorParty(d.governors, pickedState)}
                                </Text>
                              ) : (
                                <Text className="text-xs text-muted">No governor</Text>
                              )}
                            </View>
                          ) : (
                            <Text className="pt-1 text-[11px] text-faint">
                              Tap a state for its governor.
                            </Text>
                          )}
            {/* WHICH PARTY GOVERNS WHERE, directly under the Governors row it
                          breaks down — it used to sit after every chamber, so the
                          reader met "993 State Assembly seats" between the governor
                          count and the list of which states those governors hold. */}
                      {byParty.groups.length ? (
                        <>
                          <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                            Governing party by state
                          </Text>
                          {byParty.groups.map(([party, sts]) => (
                            <View key={party} className="mb-2 rounded-2xl bg-card px-4 py-3">
                              <View className="flex-row items-center">
                                <PartyMark party={party} logos={logos} size={20} />
                                <Text
                                  className="flex-1 pl-2 text-sm font-bold"
                                  style={{ color: partyColor(party) }}
                                >
                                  {partyName(party)}
                                </Text>
                                <Text className="text-xs font-semibold text-muted">
                                  {sts.length} {sts.length === 1 ? 'state' : 'states'}
                                </Text>
                              </View>
                              <Text className="pt-1.5 text-xs text-muted">
                                {sts.sort().join(' · ')}
                              </Text>
                            </View>
                          ))}
                          {byParty.none.length ? (
                            <Text className="pt-1 text-xs text-faint">
                              {byParty.none.join(' · ')} — no governor (administered by a minister).
                            </Text>
                          ) : null}
                        </>
                      ) : null}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
                {d.composition.note ? (
                  <Text className="pt-1 text-xs text-faint">
                    {d.composition.note}
                    {d.composition.asOf ? ` (as of ${d.composition.asOf})` : ''}
                  </Text>
                ) : null}
              </>
            ) : null}


            {d.upcoming ? (
              <>
                <Text className="pb-2 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
                  Upcoming elections
                </Text>
                <View className="overflow-hidden rounded-2xl bg-card">
                  {d.upcoming.elections.map((e, i) => (
                    <View
                      key={e.office}
                      className={`px-4 py-3 ${i > 0 ? 'border-t border-line' : ''}`}
                    >
                      <View className="flex-row items-baseline">
                        <Text className="flex-1 text-sm font-bold text-ink">{e.office}</Text>
                        <Text className="text-xs font-semibold text-good-ink">
                          {e.seats} seat(s)
                        </Text>
                      </View>
                      <Text className="pt-0.5 text-xs text-muted">
                        {e.when} · {e.scope}
                      </Text>
                    </View>
                  ))}
                </View>
                {d.upcoming.note ? (
                  <Text className="pt-2 text-xs text-faint">{d.upcoming.note}</Text>
                ) : null}
              </>
            ) : null}

            {d.note ? (
              <Text className="pt-4 text-xs text-faint">{d.note}</Text>
            ) : null}
          </>
        )}
      </Animated.ScrollView>
    </View>
  );
}

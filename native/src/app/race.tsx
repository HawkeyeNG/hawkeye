import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';

import { GovDisclaimer } from '@/components/gov-disclaimer';
import { RaceActions, RaceView } from '@/components/race';
import { PinnedFooter } from '@/components/pinned-footer';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { api } from '@/lib/api';
import {
  assemblyRace,
  assemblySeats,
  assemblySeatsInLga,
  byElectionRace,
  findRace,
  loadPolitical,
  loadSeats,
  seatRace,
  stateRace,
  type Race,
  type SeatInfo,
} from '@/lib/political';
import { useUi } from '@/lib/theme';

/**
 * One race, by route params. Native twin of app/race.html, and reached the same
 * ways:
 *
 *   /race?key=raceOsun2026            a written race in political_data.json
 *   /race?contest=GOV&state=Kano      a governorship built from the register
 *   /race?contest=SEN&seat=Abia+North a seat, from the national board
 *   /race?contest=REP_BYE_…           a by-election, which names its own seat
 *   /race?contest=SHA&state=…[&seat=|&lga=]   a state constituency
 *
 * The generated forms are why every state, district and constituency has a
 * screen without a file or a data block each: the seat's map, size, holder and
 * date are facts we already have, and the one missing piece — the candidate
 * list — is missing for a reason the screen states plainly. A state that HAS a
 * written race (Osun) resolves to it, so a generated screen never shadows a
 * real one.
 */

/** A tap that named a place rather than a race — see the SHA branch below. */
type Pick = { state: string; seats: SeatInfo[]; why: string };

export default function RaceScreen() {
  const ui = useUi();
  const { key, contest, state, seat, lga } = useLocalSearchParams<{
    key?: string;
    contest?: string;
    state?: string;
    seat?: string;
    lga?: string;
  }>();
  const [race, setRace] = useState<Race | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data, logos: l } = await loadPolitical();
      if (!live) return;
      setLogos(l);
      setPick(null);

      // Contests are the backend's to define; a screen is not the place to
      // decide when an election is. If the catalogue is unreachable the screen
      // still renders — undated, which is the truthful degradation.
      const cs = contest ? await api.contests().catch(() => []) : [];
      if (!live) return;
      const def = cs.find((c) => c.code === contest) ?? null;

      // DISPATCH ON THE TIER, NOT THE CODE. A by-election for a House seat is a
      // House race and builds its screen the same way; only its CONTEST CODE
      // differs, and that difference is load-bearing — `join.contest` is what
      // /api/national is keyed by and what the ledger partitions a race's
      // subchain on, so a by-election filed under `REP` would merge with the
      // 2027 general election for the same seat inside a published anchor.
      //
      // A by-election link needs only ?contest=: the contest names its own seat
      // and state, in the same `constituencies` allowlist the backend gates
      // reports with, so the screen and the gate cannot describe different
      // places.
      const tier = def?.tier || contest;
      const seatName = seat || (def?.constituencies ?? [])[0] || null;
      const stateName = state || (def?.states ?? [])[0] || null;
      const byeSeats = (def?.constituencies ?? []).length > 0;

      if (tier === 'GOV' && stateName) {
        setRace(stateRace(data, stateName, def));
      } else if ((tier === 'SEN' || tier === 'REP') && seatName) {
        // seat_lgas.json is fetched ONLY on a seat screen — 1,480 seats with
        // their LGA membership is ~169 KB that no other screen has a use for.
        const seats = await loadSeats().catch(() => null);
        if (!live) return;
        setRace(seatRace(seats, contest as string, seatName, def, tier));
      } else if (tier === 'SHA' && !byeSeats) {
        /**
         * THE GENERAL STATE-ASSEMBLY CONTEST — 1,005 seats, so it arrives as one
         * of three things and this branch resolves all three:
         *
         *   ?state=X            a picker: every constituency in that state
         *   ?state=X&seat=Y     that seat's screen
         *   ?state=X&lga=Z      from the BOARD, which buckets SHA by LGA. 240 of
         *                       the 768 LGAs elect more than one member, so this
         *                       resolves to a screen when there is one seat and
         *                       to a CHOICE when there are several. Picking the
         *                       first would send a reader to a race they did not
         *                       tap on.
         */
        const seats = await loadSeats().catch(() => null);
        if (!live) return;
        if (stateName && seat) {
          setRace(assemblyRace(seats, stateName, seat, def));
        } else if (stateName && lga) {
          const hits = assemblySeatsInLga(seats, stateName, lga);
          if (hits.length === 1) setRace(assemblyRace(seats, stateName, hits[0].seat ?? '', def));
          else {
            setRace(null);
            setPick({
              state: stateName,
              seats: hits,
              why: `${lga} LGA elects ${hits.length} state members`,
            });
          }
        } else if (stateName) {
          const all = assemblySeats(seats, stateName);
          setRace(null);
          setPick({ state: stateName, seats: all, why: `${all.length} state constituencies` });
        } else {
          setRace(null);
        }
      } else if (tier === 'SHA' && seatName && def) {
        // The seat table HAS a SHA block, built from the catalogue rather than
        // the register (state constituencies are not a register column). It is
        // what turns "1 LGAs" into real ward and polling-unit figures, so this
        // branch fetches it like the others rather than passing null.
        const seats = await loadSeats().catch(() => null);
        if (!live) return;
        setRace(byElectionRace(def, seats, data));
      } else if (contest && state) {
        const hit = findRace(data, contest, state);
        setRace(hit ? hit.race : null);
      } else if (key) {
        setRace((data as Record<string, unknown>)[key] as Race);
      } else {
        // AN UNRECOGNISED ROUTE BUILDS NO SCREEN. This used to fall through to
        // `data['raceOsun2026']`, so anything the branches above did not match
        // silently rendered the Osun governorship: a real page about a different
        // election, with no sign anything had gone wrong. Twin of the same fix
        // in app/race.html.
        setRace(null);
      }
      if (live) setDone(true);
    })().catch((e) => {
      if (live) {
        setErr(e instanceof Error ? e.message : String(e));
        setDone(true);
      }
    });
    return () => {
      live = false;
    };
  }, [key, contest, state, seat, lga]);

  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const title = pick
    ? `${pick.state} State Assembly`
    : race?.office || race?.election || 'Race';

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={title} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{
          paddingTop: headerH + 12,
          paddingHorizontal: 16,
          paddingBottom: 40,
        }}
      >
        <GovDisclaimer />
        {err ? (
          <Text className="text-sm font-semibold text-warn-ink">Could not load. ({err})</Text>
        ) : !done ? (
          <ActivityIndicator className="pt-6" color={ui.tint.good.ink} />
        ) : pick ? (
          /* A TAP THAT NAMED A PLACE, NOT A RACE. The assembly board buckets by
             LGA and a screen is about a SEAT, so where the LGA elects more than
             one member this offers every one of them and picks NONE. */
          <View>
            <Text className="text-xl font-bold text-ink">
              {pick.state} State House of Assembly
            </Text>
            <Text className="pt-1 text-sm text-muted">{pick.why} — choose one.</Text>
            <View className="flex-row flex-wrap pt-3">
              {pick.seats.map((s) => (
                <Pressable
                  key={s.seat}
                  onPress={() =>
                    router.push(
                      `/race?contest=SHA&state=${encodeURIComponent(pick.state)}&seat=${encodeURIComponent(s.seat ?? '')}` as never,
                    )
                  }
                  className="mb-2 mr-2 rounded-full border border-line bg-card px-3 py-1.5 active:opacity-70"
                >
                  <Text className="text-xs font-semibold text-good-ink">{s.seat}</Text>
                </Pressable>
              ))}
            </View>
            {pick.seats.length ? null : (
              <Text className="pt-3 text-sm text-muted">
                Hawkeye has no constituencies recorded for this state yet.
              </Text>
            )}
          </View>
        ) : race ? (
          <RaceView race={race} logos={logos} />
        ) : (
          // A race we have nothing for. Say so, rather than render an empty
          // frame that looks like a page still loading.
          <Text className="pt-4 text-sm text-muted">
            Hawkeye has no page for this race yet. Each race page is published as
            its election nears — about 28 days out.
          </Text>
        )}
      </Animated.ScrollView>
      {/* PINNED, and a SIBLING of the ScrollView above — inside it, it would
          scroll, which is the problem it exists to solve. A race page runs to a
          stat bar, a map, a declared result and up to nineteen candidates; the
          one thing it asks of an observer must not be under all of that.
          Only on a real race: the SHA picker and the absence message are not
          races and have nothing to act on. */}
      {race && !pick ? <PinnedFooter><RaceActions race={race} /></PinnedFooter> : null}
    </View>
  );
}

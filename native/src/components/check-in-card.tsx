import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  checkInAt,
  checkInFailureLine,
  myRooms,
  type CheckInFailure,
  type MyRoom,
} from '@/lib/check-in';
import { t as i18nT } from '@/lib/i18n';

/**
 * "Tell your coordinator you are here" — ONE card, drawn in two places.
 *
 * ON ARRIVAL (components/report-sheet.tsx). The Report sheet is the entry to
 * every report, before any camera, and arrival is when an agent is at the unit
 * with nothing to photograph yet: the result sheet is hours away. So the card
 * sits there for anyone a room has down for a unit, and checks them in at THAT
 * unit — exactly what the web's enterReportFlow() → renderCheckIn() offers
 * above the photos (app.js checkInUnit(): the assigned unit until one is
 * chosen). Flow walkthrough REP-CHK-01 / R-NATIVE-CHECKIN-AFTER-PHOTOS: native
 * used to offer it only after both photos.
 *
 * AT THE UNIT STEP (app/report/result.tsx). Still offered there too, and there
 * it checks in at the CHOSEN unit — the moment the app knows where they really
 * are, which can differ from where a coordinator expected them.
 *
 * WHY NOT A GATE OVER THE CAMERA. The sheet step launches the ML Kit scanner;
 * swapping steps or drawing an overlay under a running native scanner is how a
 * capture gets lost. The card is beside the flow, never in front of it.
 *
 * The rule for WHO sees it is the server's (/api/my/rooms is empty for anyone
 * not on a roster) — see lib/check-in.ts.
 */

/** The unit a room has this observer down for, or null. */
export function assignedUnit(rooms: MyRoom[] | null): { pu_code: string; name: string } | null {
  const a = (rooms ?? []).map((r) => r.assigned).find((x) => x && x.pu_code);
  return a ? { pu_code: a.pu_code, name: a.name || a.pu_code } : null;
}

/** Every room already has a VERIFIED check-in today: nothing left to ask. */
export function checkedInEverywhere(rooms: MyRoom[] | null): boolean {
  return !!rooms && rooms.length > 0 && rooms.every((r) => r.checkedIn && r.checkedIn.standing === 'verified');
}

type CardState = 'idle' | 'working' | 'verified' | 'weak' | { failed: CheckInFailure };

export function CheckInCard({
  rooms,
  unit,
  chosen,
  onRooms,
  className = '',
}: {
  /** /api/my/rooms. `null` (not asked yet) and `[]` (not on a roster) draw nothing. */
  rooms: MyRoom[] | null;
  /** The unit a tap checks in at. */
  unit: { pu_code: string; name: string } | null;
  /**
   * true: the unit the observer CHOSE in the flow (result.tsx's unit step).
   * false: the unit a room has them down for (the arrival card).
   * Only the sentence above the button differs.
   */
  chosen: boolean;
  /** The roster re-read after a check-in landed, for a host that keeps it. */
  onRooms?: (rooms: MyRoom[]) => void;
  className?: string;
}) {
  const [state, setState] = useState<CardState>('idle');
  if (!rooms || rooms.length === 0 || !unit) return null;

  /* A check-in already recorded HERE, but one the location could not stand
     behind, reads as the weak receipt rather than as a fresh button — the same
     thing this card said the moment it happened. A check-in somewhere else
     does not count: they are being offered THIS unit. */
  const weakHere =
    rooms.every((r) => r.checkedIn && r.checkedIn.pu_code === unit.pu_code) && !checkedInEverywhere(rooms);

  const tapCheckIn = async () => {
    setState('working');
    const r = await checkInAt(unit.pu_code);
    if (!r.ok) {
      setState({ failed: r.why });
      return;
    }
    /* SAY WHAT WAS RECORDED, not "done": a check-in the location could not
       stand behind is worth less to the coordinator, and the agent is the only
       person who can still do something about it. */
    setState(r.standing === 'verified' ? 'verified' : 'weak');
    if (onRooms) onRooms(await myRooms());
  };

  const away = rooms.find((r) => r.assigned && r.assigned.pu_code !== unit.pu_code);

  return (
    <View className={`rounded-2xl border border-line bg-card p-3 ${className}`}>
      {state === 'verified' || (state === 'idle' && checkedInEverywhere(rooms)) ? (
        <Text className="text-xs font-semibold text-good-ink">{i18nT('n.app.report.result.checked-in-ok')}</Text>
      ) : state === 'weak' || (state === 'idle' && weakHere) ? (
        <Text className="text-xs font-semibold text-warn-ink">{i18nT('n.app.report.result.checked-in-weak')}</Text>
      ) : (
        <>
          <Text className="pb-1 text-sm font-bold text-ink">{i18nT('observe.check-in-title')}</Text>
          <Text className="pb-2 text-xs text-muted">
            {/* Being sent somewhere else is ORDINARY — agents get moved, gates
                get closed — so this states what will be recorded instead of
                warning them off it. */}
            {!chosen
              ? i18nT('n.components.check-in-card.at-assigned', { unit: unit.name })
              : away
                ? i18nT('n.app.report.result.check-in-different-unit', { unit: away.assigned!.name })
                : i18nT('n.app.report.result.check-in-sub')}
          </Text>
          <Pressable
            disabled={state === 'working'}
            onPress={tapCheckIn}
            accessibilityRole="button"
            /* The only thing on this card there is to DO, so it carries the
               brand CTA surface. bg-hawk-gold is a fixed surface: its label
               must be the fixed hawk ink, because text-ink flips near-white
               and dies in gold. */
            className="items-center rounded-xl bg-hawk-gold py-2.5 active:opacity-80"
          >
            <Text className="text-sm font-bold text-hawk-ink">
              {state === 'working'
                ? i18nT('n.app.report.result.check-in-locating')
                : i18nT('n.app.report.result.check-in')}
            </Text>
          </Pressable>
          {typeof state === 'object' ? (
            <Text className="pt-2 text-xs text-warn-ink">{checkInFailureLine(state.failed)}</Text>
          ) : null}
        </>
      )}
    </View>
  );
}

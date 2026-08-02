/**
 * Bounded GPS — no call site may hang on a fix. Indoors, Android can sit on
 * getCurrentPositionAsync indefinitely; every wait here has a deadline and
 * a degradation path, and callers state how much accuracy they need.
 *
 * AND NO CALL SITE MAY GUESS WHY IT FAILED. The old shape of this module was
 * `Promise<Fix | null>`: permission-not-granted, no last-known position and a
 * GPS timeout all collapsed into the same `null`, so every screen printed the
 * same "Location is off or not permitted" — including to observers who HAD
 * granted permission and were simply standing indoors with a cold GPS. That
 * message sends someone into their system settings to fix a permission that
 * was never broken, and it costs a report. So acquisition now returns a
 * DISCRIMINATED result (`FixResult`) naming which of the four things happened,
 * and `describeFixFailure` supplies the matching sentence.
 */
import * as Location from 'expo-location';

export type Fix = { lat: number; lng: number; accuracy: number };

/**
 * Why a fix could not be taken. These are four different problems with four
 * different fixes for the observer, and must never be reported as one:
 *
 * - `denied`   — the OS permission is not granted. Ask, or send to Settings.
 * - `disabled` — the phone's Location services are switched off entirely.
 *                Permission is irrelevant until that toggle is on.
 * - `timeout`  — permission granted, services on, no satellite lock in the
 *                time allowed. Nothing is misconfigured; retrying by a window
 *                or outdoors usually works.
 * - `error`    — the location provider itself threw. Diagnostic, not advisory.
 */
export type FixFailReason = 'denied' | 'disabled' | 'timeout' | 'error';

export type FixFailure = {
  ok: false;
  reason: FixFailReason;
  /**
   * Whether the OS will still show the permission dialog. Only meaningful for
   * `denied`: false means the observer has permanently declined (or a policy
   * blocks it) and ONLY the system settings screen can grant it now — asking
   * again is a no-op, so the copy must point at Settings instead of at a
   * prompt that will never appear.
   */
  canAskAgain: boolean;
  /** Provider error text, for the parenthesised diagnostic tail only. */
  detail?: string;
};

export type FixResult = { ok: true; fix: Fix } | FixFailure;

/**
 * How far "near me" reaches when discovering polling units, in metres.
 *
 * One number, shared by the screens that ask and the map that draws the ring,
 * so the circle on screen is the same circle the query used. When the two drift
 * apart the map stops being evidence: an observer sees empty space inside the
 * ring and concludes there is no unit nearby, when really the lookup searched a
 * different area than the one it drew.
 *
 * 800m is a walkable radius in a dense ward without pulling in the next one.
 */
export const DISCOVERY_RADIUS_M = 800;

/**
 * How far Map-a-Polling-Unit reaches. Deliberately much wider than reporting.
 *
 * Mapping and reporting ask different questions. Reporting asks "which unit am I
 * STANDING at", so 800m is already generous — a unit 5km away is not one you can
 * see, and offering it invites a report filed against the wrong place. Mapping
 * asks "which unit am I trying to find", carries no submission consequence, and
 * is most useful to someone who does not yet know where their unit is. A wide
 * net there is a feature: on election day it becomes a way to locate your unit
 * rather than a way to mis-file.
 *
 * 5km is also what /api/mapping/nearby defaults to (it clamps at 20km), so this
 * asks the endpoint for exactly what it was built to serve.
 */
export const MAPPING_RADIUS_M = 5000;

/** Sentinel for "the deadline passed", distinguishable from a provider throw. */
const TIMED_OUT = Symbol('timed_out');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    p,
    new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms)),
  ]);
}

const toFix = (l: Location.LocationObject): Fix => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  accuracy: l.coords.accuracy ?? 999,
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Android throws this out of getCurrentPositionAsync when the system location
 * toggle is off, and iOS reports the same condition its own way. It means
 * `disabled`, not `error` — the observer has a switch to flip, not a bug.
 */
function looksServicesDisabled(e: unknown): boolean {
  const s = errText(e).toLowerCase();
  return (
    s.includes('location services are disabled') ||
    s.includes('location provider is unavailable') ||
    s.includes('e_location_services_disabled') ||
    s.includes('e_location_unavailable')
  );
}

/**
 * Gate every acquisition on the two things that make one possible at all,
 * in the order the observer can act on them.
 *
 * SERVICES BEFORE PERMISSION, deliberately: with the system location toggle
 * off, the permission dialog either cannot help or (on iOS) cannot even
 * appear, so prompting first would nag for something that changes nothing and
 * then still fail. Checking services first means the message names the switch
 * that is actually in the way.
 *
 * A throw from the services check is treated as "assume on" — it must never
 * become the reason a phone that could have produced a fix is told location is
 * off, which is the exact class of lie this module exists to stop telling.
 */
async function ensureUsable(mayPrompt: boolean): Promise<FixFailure | null> {
  let servicesOn = true;
  try {
    servicesOn = await Location.hasServicesEnabledAsync();
  } catch {
    servicesOn = true;
  }
  if (!servicesOn) return { ok: false, reason: 'disabled', canAskAgain: true };

  let perm = await Location.getForegroundPermissionsAsync().catch(() => null);
  // Not granted YET is not the same as refused. The old getQuickFix() only
  // ever CHECKED and then failed silently, so an observer who had never been
  // asked was told they had denied it. Ask, when asking can still work.
  if (!perm?.granted && mayPrompt && (perm?.canAskAgain ?? true)) {
    perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
  }
  if (!perm?.granted) {
    return { ok: false, reason: 'denied', canAskAgain: perm?.canAskAgain ?? false };
  }
  return null;
}

/** One bounded attempt. Separates "deadline passed" from "provider threw". */
async function attempt(
  accuracy: Location.LocationAccuracy,
  ms: number,
): Promise<{ fix: Fix } | { fail: FixFailure }> {
  try {
    const l = await withTimeout(Location.getCurrentPositionAsync({ accuracy }), ms);
    if (l === TIMED_OUT) return { fail: { ok: false, reason: 'timeout', canAskAgain: true } };
    return { fix: toFix(l) };
  } catch (e) {
    return {
      fail: looksServicesDisabled(e)
        ? { ok: false, reason: 'disabled', canAskAgain: true }
        : { ok: false, reason: 'error', canAskAgain: true, detail: errText(e) },
    };
  }
}

/**
 * Quick fix for shortlisting and optional stamps: last-known (≤60s old), else
 * Balanced for up to 20s, then one Low-accuracy retry for 10s.
 *
 * THE OLD BUDGET WAS 8 SECONDS, and that was the bug the user actually hit. A
 * cold GPS start indoors routinely needs longer than 8s, so the common outcome
 * was a timeout mislabelled as a permission problem. 20s + a coarse retry is
 * still bounded — nothing here can hang a screen — but it is long enough to
 * succeed where it used to give up, and the second attempt asks for less
 * precision because a 500m fix is ample to shortlist candidate units (the
 * accurate fix is taken again at submit, where the server checks it).
 *
 * Callers MUST show progress across this window; "Getting your location…" is
 * already on screen before the call in every discovery flow.
 */
export async function tryQuickFix(): Promise<FixResult> {
  const blocked = await ensureUsable(true);
  if (blocked) return blocked;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    if (last) return { ok: true, fix: toFix(last) };
  } catch {
    /* fall through — a missing cache is not a failure */
  }
  const first = await attempt(Location.Accuracy.Balanced, 20_000);
  if ('fix' in first) return { ok: true, fix: first.fix };
  // Only a deadline earns a retry. A disabled provider or a throw will not
  // answer differently the second time, and would just spend another 10s of
  // the observer's day saying so.
  if (first.fail.reason !== 'timeout') return first.fail;
  const second = await attempt(Location.Accuracy.Low, 10_000);
  return 'fix' in second ? { ok: true, fix: second.fix } : second.fail;
}

/**
 * Accurate fix for submissions (the server rejects accuracy worse than 100m):
 * High for up to 20s, then Balanced 10s. A recent last-known fix is used only
 * if it is itself accurate — a stale coarse fix would bounce at the server.
 *
 * Budgets unchanged from before the discriminated rewrite: this tier was never
 * the one failing at 8s, and photo/video stamps (capture-camera) sit on it —
 * lengthening it would slow every capture to fix a bug that is not here.
 */
export async function trySubmitFix(): Promise<FixResult> {
  const blocked = await ensureUsable(true);
  if (blocked) return blocked;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 30_000 });
    if (last && (last.coords.accuracy ?? 999) <= 60) return { ok: true, fix: toFix(last) };
  } catch {
    /* fall through */
  }
  const high = await attempt(Location.Accuracy.High, 20_000);
  if ('fix' in high) return { ok: true, fix: high.fix };
  if (high.fail.reason !== 'timeout') return high.fail;
  const balanced = await attempt(Location.Accuracy.Balanced, 10_000);
  return 'fix' in balanced ? { ok: true, fix: balanced.fix } : balanced.fail;
}

/**
 * The OPTIONAL stamp on an incident report: last-known, else one Balanced
 * attempt, ≤8s, and NO permission prompt.
 *
 * Deliberately still the old tight budget, and deliberately not the discovery
 * tier. Nothing is shown when this fails — the report files without coordinates
 * — so a longer wait buys the observer nothing and costs them seconds while
 * something is happening in front of them. It does not prompt either: the
 * dialog would land mid-submit, and the discovery button on the same screen has
 * already asked properly. Absence of a stamp is a supported outcome; a stalled
 * urgent report is not.
 */
export async function getStampFix(): Promise<Fix | null> {
  const blocked = await ensureUsable(false);
  if (blocked) return null;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    if (last) return toFix(last);
  } catch {
    /* fall through */
  }
  const one = await attempt(Location.Accuracy.Balanced, 8_000);
  return 'fix' in one ? one.fix : null;
}

/**
 * Back-compat wrappers, for call sites that only branch on "did I get a fix"
 * and have no failure copy of their own to improve — capture-camera's photo
 * stamp and report/collation both still use getSubmitFix this way.
 *
 * @deprecated for anything that PRINTS on failure. Collapsing four reasons back
 * into one `null` is precisely the bug this module was rewritten to end: the
 * caller then has to invent an explanation, and every screen invented the same
 * wrong one ("Location is off or not permitted", said to people whose location
 * was on and permitted). If you show a message, call `tryQuickFix` /
 * `trySubmitFix` and pass the failure to `describeFixFailure`.
 */
export async function getQuickFix(): Promise<Fix | null> {
  const r = await tryQuickFix();
  return r.ok ? r.fix : null;
}

/** @deprecated for anything that prints on failure — see getQuickFix above. */
export async function getSubmitFix(): Promise<Fix | null> {
  const r = await trySubmitFix();
  return r.ok ? r.fix : null;
}

/**
 * The sentence for a failure, minus whatever fallback the screen offers.
 *
 * Split in two because the lead is a property of the FAILURE and the tail is a
 * property of the SCREEN: discovery screens can offer the register drill-down,
 * practice can offer "practise without a unit", a submit cannot offer anything
 * but a retry. Sharing the lead keeps four screens from drifting into four
 * different explanations of one condition; keeping the tail local keeps them
 * from promising a fallback that screen does not have.
 *
 * `code` is the parenthesised diagnostic these screens already carry on their
 * error lines, so a screenshot from an observer says which branch fired.
 * `settings` marks the two conditions only the OS settings app can fix.
 */
export function describeFixFailure(f: FixFailure): {
  lead: string;
  code: string;
  settings: boolean;
} {
  switch (f.reason) {
    case 'disabled':
      return {
        lead: "Location is turned off on this phone — turn on Location in your phone's settings, then try again",
        code: 'location_services_off',
        settings: true,
      };
    case 'denied':
      return f.canAskAgain
        ? {
            lead: 'Hawkeye needs location permission to find units near you — try again and choose Allow',
            code: 'permission_not_granted',
            settings: false,
          }
        : {
            lead: 'Location permission for Hawkeye is blocked in your phone settings — allow Location for Hawkeye there, then try again',
            code: 'permission_blocked',
            settings: true,
          };
    case 'timeout':
      // Permission IS granted here. Never the word "permitted".
      return {
        lead: 'Could not get a GPS fix — the signal is weak indoors. Move near a window or step outside and try again',
        code: 'gps_timeout',
        settings: false,
      };
    default:
      return {
        lead: 'This phone could not report its location just now — try again',
        code: f.detail ? `location_error / ${f.detail}` : 'location_error',
        settings: false,
      };
  }
}

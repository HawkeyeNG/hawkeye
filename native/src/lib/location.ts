/**
 * Bounded GPS — no call site may hang on a fix. Indoors, Android can sit on
 * getCurrentPositionAsync indefinitely; every wait here has a deadline and
 * a degradation path, and callers state how much accuracy they need.
 */
import * as Location from 'expo-location';

export type Fix = { lat: number; lng: number; accuracy: number };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

const toFix = (l: Location.LocationObject): Fix => ({
  lat: l.coords.latitude,
  lng: l.coords.longitude,
  accuracy: l.coords.accuracy ?? 999,
});

/**
 * Quick fix for optional stamps (incident reports): last-known (≤60s old),
 * else one Balanced attempt, ≤8s total. Never blocks an urgent report.
 */
export async function getQuickFix(): Promise<Fix | null> {
  const perm = await Location.getForegroundPermissionsAsync();
  if (!perm.granted) return null;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 });
    if (last) return toFix(last);
  } catch {
    /* fall through */
  }
  const l = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    8_000,
  ).catch(() => null);
  return l ? toFix(l) : null;
}

/**
 * Accurate fix for submissions (the server rejects accuracy worse than 100m):
 * High for up to 20s, then Balanced 10s. A recent last-known fix is used only
 * if it is itself accurate — a stale coarse fix would bounce at the server.
 */
export async function getSubmitFix(): Promise<Fix | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) return null;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 30_000 });
    if (last && (last.coords.accuracy ?? 999) <= 60) return toFix(last);
  } catch {
    /* fall through */
  }
  const high = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    20_000,
  ).catch(() => null);
  if (high) return toFix(high);
  const balanced = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    10_000,
  ).catch(() => null);
  return balanced ? toFix(balanced) : null;
}

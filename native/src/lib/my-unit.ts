/**
 * "A polling unit was just saved as mine" — from the chooser page to whoever
 * is showing the saved unit.
 *
 * The chooser used to be a modal inside Profile and handed the saved unit back
 * through an `onSaved` prop. It is a route now (/choose-unit), and a route
 * cannot pass a callback. A module-level listener set is the same shape
 * lib/push.ts and lib/tour.ts already use for this kind of one-way signal — no
 * state library, no provider around the app for one row.
 */

/** What the chooser hands back: a register row, of which only these are read. */
export type SavedUnit = {
  pu_code: string;
  name?: string | null;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
};

const listeners = new Set<(unit: SavedUnit) => void>();

/** Subscribe; returns the unsubscribe, so it can be a useEffect's whole body. */
export function onMyUnitSaved(fn: (unit: SavedUnit) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Called by the chooser once POST /api/observers/my-unit has succeeded. */
export function emitMyUnitSaved(unit: SavedUnit): void {
  listeners.forEach((fn) => fn(unit));
}

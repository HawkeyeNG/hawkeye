import { useSyncExternalStore } from 'react';

/**
 * IS THE REPORT SHEET UP? (components/report-sheet.tsx)
 *
 * Read by the Ask Hawkeye bubble (components/ask-fab.tsx). The bubble is mounted
 * in the root layout, ABOVE every screen — so above the open sheet too, where its
 * resting spot landed on the set-aside card's OK and took the tap (measured on the
 * web build at 393x852: the topmost element at OK's centre was the bubble). It
 * steps aside while the sheet is up, as it already does on the /report* screens
 * the sheet leads to.
 *
 * A module store, not context: the sheet lives in the tab layout and the bubble
 * in the root layout, two subtrees with no provider between them worth adding.
 * Same idiom as useOutbox() / useUnread().
 */
let open = false;
const listeners = new Set<() => void>();

export function setReportSheetOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  listeners.forEach((l) => l());
}

export function useReportSheetOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => open,
    () => false, // server snapshot, web export only — the sheet is never open there
  );
}

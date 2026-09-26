/**
 * National Practice Days — GET /api/practice-days (aggregates only).
 *
 * Shared by the home card (components/practice-day-card.tsx) and the results
 * screen (app/practice-day.tsx) so the two read one shape. No strings live
 * here: every word is translated where it is painted.
 */
import { BASE } from '@/lib/api';

export type PracticePhase = 'before' | 'live' | 'after';

export type PracticeDay = {
  date: string;
  startsAt: number;
  endsAt: number;
  phase: PracticePhase;
  resultsUntil: number;
  window: { start: string; end: string };
  timezone: string;
  utcOffset: string;
};

export type PracticeResults = {
  participants: number;
  runs: number;
  tallied: number;
  totals: { party: string; color: string | null; votes: number }[];
  asOf: number;
};

export type PracticeDaysPayload = {
  day: PracticeDay | null;
  results?: PracticeResults | null;
  next: { date: string; startsAt: number; endsAt: number } | null;
  days: { date: string; startsAt: number; endsAt: number; phase: PracticePhase }[];
  now: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isPracticeDate = (d: unknown): d is string => typeof d === 'string' && DATE_RE.test(d);

/** Throws on a network or server failure; an unknown `?day` reads as "no day". */
export async function fetchPracticeDays(date?: string | null): Promise<PracticeDaysPayload> {
  const q = date && isPracticeDate(date) ? `?day=${encodeURIComponent(date)}` : '';
  const res = await fetch(`${BASE}/api/practice-days${q}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return { day: null, next: null, days: [], now: Date.now() };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PracticeDaysPayload;
}

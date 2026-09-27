import { captureInviteLink } from '@/lib/pending-invite';

/**
 * Every link that opens the app passes through here first — cold start and
 * already running, App Link (/open, /join) and hawkeye:// alike. See
 * https://docs.expo.dev/router/advanced/native-intent/.
 *
 * It ROUTES NOTHING: the path goes back exactly as it came. The one thing it
 * does is notice an invitation (`ref` / `r`, and `unit`) on the way past and
 * park it for sign-up (lib/pending-invite.ts). Here rather than in open.tsx
 * because a signed-out reader never gets to see /open — the root layout sends
 * them to welcome — and a signed-out reader is exactly who an invitation is for.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    captureInviteLink(path);
  } catch {
    /* an invitation is never worth a link that fails to open */
  }
  return path;
}

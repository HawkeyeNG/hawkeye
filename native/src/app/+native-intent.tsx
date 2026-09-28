import { captureInviteLink } from '@/lib/pending-invite';
import { webPageRoute } from '@/lib/web-routes';

/**
 * Every link that opens the app passes through here first — cold start and
 * already running, App Link (/open, /join) and hawkeye:// alike. See
 * https://docs.expo.dev/router/advanced/native-intent/.
 *
 * It notices an invitation (`ref` / `r`, and `unit`) on the way past and parks
 * it for sign-up (lib/pending-invite.ts). Here rather than in open.tsx because
 * a signed-out reader never gets to see /open — the root layout sends them to
 * welcome — and a signed-out reader is exactly who an invitation is for.
 *
 * It ROUTES ONLY the group, invite and captain pages (lib/web-routes.ts), and
 * every other path goes back exactly as it came. The one that matters today is
 * `join.html?t=…`: Android claims the `/join` PREFIX, which matches it too, and
 * the router has no `join.html` screen — so that link opened the app on a
 * not-found page. It is the form the website's sign-in round-trip uses, so it
 * is in circulation.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    captureInviteLink(path);
  } catch {
    /* an invitation is never worth a link that fails to open */
  }
  try {
    const to = webPageRoute(path);
    if (to) return to;
  } catch {
    /* a link we cannot read goes through untouched, as before */
  }
  return path;
}

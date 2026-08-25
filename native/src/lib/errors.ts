/**
 * One short sentence for any thrown error, and the raw text never reaches the
 * screen.
 *
 * WHAT THIS IS FOR. Screens were interpolating `e.message` straight into their
 * status lines. On Android a failed fetch does not say "no connection" — it says
 *
 *   fetch failed: java.net.UnknownHostException: Unable to resolve host
 *   "hawkeye.com.ng": No address associated with hostname
 *
 * and that appeared, in full, under "Report a result", to someone standing at a
 * polling unit with bad signal. It is four lines of Java for a fact the reader
 * already knows (their connection is down) and cannot act on any better for
 * having read it.
 *
 * The raw message is not thrown away — it goes to the console, where the person
 * who needs it can find it. It is just not UI.
 *
 * KEEP THE RESULT ONE SENTENCE. That is the whole point; a "helpful" second
 * clause is how the last version grew to four lines. Where a screen needs to
 * suggest what to do next, it does that in its own copy, once, next to the
 * control that does it — not appended to every error.
 */

/** Anything that reads like a lost/refused connection rather than a real fault. */
function isOffline(raw: string): boolean {
  return /UnknownHostException|Unable to resolve host|Network request failed|network error|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|Failed to fetch|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|offline/i
    .test(raw);
}

function isTimeout(raw: string): boolean {
  return /timeout|timed out|ETIMEDOUT|AbortError|aborted/i.test(raw);
}

/**
 * @param e        whatever was caught
 * @param fallback what to say when the cause is not one we recognise — keep it
 *                 specific to the action that failed ("Could not save your
 *                 unit."), because that is the part a generic handler cannot know
 */
export function humanError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  // Diagnosable without being visible. Not console.error: this is an expected
  // condition on a bad line, not a fault, and a red box in the dev client for
  // every dropped request trains people to ignore it.
  if (raw) console.warn('[hawkeye]', raw);

  if (isOffline(raw)) return 'No connection. Check your network and try again.';
  if (isTimeout(raw)) return 'That took too long. Try again.';

  // A server status that came through as a message ("HTTP 503", "503").
  const status = raw.match(/\b(4\d\d|5\d\d)\b/);
  if (status) {
    return status[1].startsWith('5')
      ? 'The server had a problem. Try again shortly.'
      : 'That request was refused. Try again.';
  }
  return fallback;
}

/**
 * True when the failure is a connection problem — for screens that offer a
 * genuinely different route when offline (searching the bundled register rather
 * than looking units up over the network).
 */
export function isOfflineError(e: unknown): boolean {
  return isOffline(e instanceof Error ? e.message : String(e ?? ''));
}

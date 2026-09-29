/**
 * The waiting half of WhatsApp "send us the code" sign-in (lib/auth.ts waStart):
 * poll /wa-status until the observer's message arrives, the code runs out, or
 * the screen stops caring.
 *
 * BOUNDED, the same schedule as the web (app/app.js waPoll):
 *   - the first poll after the server's pollAfterMs, then x1.5 each time up to
 *     10 s (never sooner than the server's retryAfterMs);
 *   - never past the code's life: one last poll lands just after expiresInS,
 *     and whatever it says, a code still pending then is expired;
 *   - pollNow() asks at once — the observer coming back from WhatsApp;
 *   - one request in flight at a time. A pollNow() during one is remembered and
 *     runs the moment it returns, rather than being dropped.
 *
 * A network failure keeps trying on the same schedule; the second in a row says
 * so ('offline') until an answer comes back.
 *
 * Plain closures, not React state, on purpose: the timer, the backoff and the
 * in-flight flag must survive re-renders untouched, and an effect that owned
 * them could cancel its own timer every time the screen re-rendered. The
 * screen holds the returned handle in a ref and calls stop() when it leaves.
 */
import { adoptWaSession, waCancel, waStatus, type WaStatusResult } from '@/lib/auth';

export type WaWait = 'waiting' | 'mismatch' | 'offline' | 'expired';
export type WaProof = { isNew?: boolean; needsUnit?: boolean; hadPassword?: boolean };
export type WaPoller = {
  /** Ask now (the app came back to the foreground). */
  pollNow: () => void;
  /** Stop for good. `cancelOnServer` also kills the code on screen. */
  stop: (cancelOnServer: boolean) => void;
};

const MAX_DELAY_MS = 10_000;

export function startWaPoller(opts: {
  pollToken: string;
  expiresInS: number;
  pollAfterMs: number;
  /** Every change in what the waiting line should say. */
  onWait: (w: WaWait) => void;
  /** The session is stored; the screen takes it from here. */
  onVerified: (proof: WaProof) => void;
}): WaPoller {
  const deadline = Date.now() + opts.expiresInS * 1000;
  let delay = Math.max(500, opts.pollAfterMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  let fails = 0;
  let done = false;
  let verified = false;
  let stopped = false;

  const clear = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    if (done) return;
    const left = deadline - Date.now();
    timer = setTimeout(() => void poll(), Math.max(0, Math.min(ms, left + 250)));
  };
  const expire = () => {
    done = true;
    clear();
    opts.onWait('expired');
  };

  async function poll() {
    timer = null;
    if (done) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    let r: WaStatusResult | null = null;
    try {
      r = await waStatus(opts.pollToken);
    } catch {
      r = null;
    }
    inFlight = false;
    if (done) return; // stopped while the request was out: its answer is nobody's
    if (r?.status === 'verified') {
      done = true;
      verified = true;
      clear();
      // Adopted only now, after the check above: a reply that lands after the
      // observer left must not sign anyone in.
      adoptWaSession(r.session).then(
        (proof) => { if (!stopped) opts.onVerified(proof); },
        () => { if (!stopped) opts.onWait('expired'); },
      );
      return;
    }
    if (r?.status === 'expired' || Date.now() >= deadline) {
      expire();
      return;
    }
    if (r == null || r.status === 'retry') {
      fails += 1;
      if (fails >= 2) opts.onWait('offline');
    } else {
      fails = 0;
      opts.onWait(r.mismatch ? 'mismatch' : 'waiting');
    }
    const floor = r?.status === 'pending' ? r.retryAfterMs : 0;
    delay = Math.min(MAX_DELAY_MS, Math.max(Math.round(delay * 1.5), floor));
    if (again) {
      again = false;
      schedule(0);
      return;
    }
    schedule(delay);
  }

  schedule(delay);
  return {
    pollNow: () => {
      if (done) return;
      if (inFlight) again = true;
      else schedule(0);
    },
    stop: (cancelOnServer) => {
      // Once only, and never for a verified code: that one is already used up.
      const cancel = cancelOnServer && !stopped && !verified;
      stopped = true;
      done = true;
      clear();
      if (cancel) void waCancel(opts.pollToken);
    },
  };
}

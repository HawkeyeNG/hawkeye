/**
 * Reading an invitation out of whatever carried it — the Play Store's install
 * referrer, or a link that opened the app. PURE: no imports, no storage, so
 * tests/native_install_referrer_test.mjs can load this file as it is.
 *
 * WHAT AN INVITATION IS: a referral code, and optionally the sender's polling
 * unit (lib/invite-unit.ts: "bring a second observer to your unit"). The same
 * two things app/referral.js parks on the web, under the same rules:
 *
 *   - the code is the server's alphabet (no 0/O/1/I/L/U); anything outside it
 *     is DROPPED, never mapped to a guess, and fewer than six survivors is no
 *     code at all — "O" must not quietly become "0" and name a stranger;
 *   - the unit is the register's canonical NN-NN-NN-NNN or nothing;
 *   - a unit only ever rides WITH a code.
 *
 * THE PLAY REFERRER. invite.html sends Android to
 *
 *     …details?id=ng.com.hawkeye.observer&referrer=ref%3DCODE%26unit%3DNN-NN-NN-NNN
 *
 * and Play hands the app the decoded value, `ref=CODE&unit=NN-NN-NN-NNN`.
 * Older copies of the page passed the bare code (`&referrer=CODE`), so a bare
 * six-character value is still read as a code. Everything else Play can say —
 * `utm_source=google-play&utm_medium=organic` for an ordinary install — is not
 * an invitation, and must not become one by stripping it down to six letters.
 */
export type Invite = { code: string | null; unit: string | null };

const NONE: Invite = { code: null, unit: null };
const PU_RE = /^\d{2}-\d{2}-\d{2}-\d{3}$/;

/** Twin of app/referral.js normalize() and backend services/referrals.js. */
export function normalizeCode(s: unknown): string | null {
  const c = String(s ?? '').toUpperCase().replace(/[^2-9A-HJKMNP-TV-Z]/g, '').slice(0, 6);
  return c.length === 6 ? c : null;
}

/**
 * A code a person TYPED into sign-up's "Invite code" field. Forgiving of case,
 * spaces and the hyphens people add reading it aloud; strict about everything
 * else. Stricter than normalizeCode on purpose: that one DROPS stray characters,
 * which is right for a link but wrong for typing — "ABCDEOF" with an O for a 0
 * would drop to "ABCDEF", a stranger's code, when the person should be told
 * to check it. Twin of app.js typedInviteCode().
 *
 *   ''    nothing typed — sign up without a code
 *   null  typed, but not a code — say so, send nothing
 */
export function typedInviteCode(s: unknown): string | null {
  const c = String(s ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (!c) return '';
  return /^[2-9A-HJKMNP-TV-Z]{6}$/.test(c) ? c : null;
}

export function normalizeUnit(s: unknown): string | null {
  const u = String(s ?? '').trim();
  return PU_RE.test(u) ? u : null;
}

/**
 * A query string as a map, FIRST value wins (URLSearchParams.get's rule). Hand
 * rolled because React Native's URLSearchParams has not always had get(), and a
 * pair that will not decode is skipped rather than thrown.
 */
export function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const rawK = i < 0 ? pair : pair.slice(0, i);
    const rawV = i < 0 ? '' : pair.slice(i + 1);
    try {
      const k = decodeURIComponent(rawK.replace(/\+/g, ' '));
      const v = decodeURIComponent(rawV.replace(/\+/g, ' '));
      if (!(k in out)) out[k] = v;
    } catch {
      /* malformed escape: this pair says nothing */
    }
  }
  return out;
}

function fromParams(p: Record<string, string>): Invite {
  const code = normalizeCode(p.ref ?? p.r ?? '');
  if (!code) return NONE;
  return { code, unit: normalizeUnit(p.unit) };
}

/** The string getInstallReferrerAsync() resolves with. */
export function parseInstallReferrer(raw: unknown): Invite {
  if (typeof raw !== 'string') return NONE;
  let s = raw.trim();
  if (!s || s.length > 512) return NONE;
  // The bare code the earlier invite.html sent. Exactly six, and then the
  // alphabet check: `ABCDE0` is not a code with its zero dropped.
  if (/^[A-Za-z0-9]{6}$/.test(s)) return { code: normalizeCode(s), unit: null };
  // Still percent-encoded once more than Play normally leaves it.
  if (!s.includes('=') && /%3D/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return NONE;
    }
  }
  return fromParams(parseQuery(s));
}

/**
 * A link that opened the app — `https://hawkeye.com.ng/open?…`, `hawkeye://…`,
 * or whatever Expo Router's redirectSystemPath was handed ("no guarantee that
 * this is a path or a valid URL"). Same `ref` / `r` + `unit` params as the web.
 */
export function parseInviteLink(url: unknown): Invite {
  if (typeof url !== 'string' || url.length > 2048) return NONE;
  const q = url.indexOf('?');
  if (q < 0) return NONE;
  const h = url.indexOf('#', q);
  return fromParams(parseQuery(url.slice(q + 1, h < 0 ? undefined : h)));
}

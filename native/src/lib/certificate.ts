/**
 * The "Hawkeye Observer" certificate — native twin of app/certificate.js
 * (backend services/certificates.js).
 *
 * THE NAME NEVER LEAVES THE PHONE. The server stores no name. The one printed
 * on a certificate is typed on the certificate screen, kept in AsyncStorage and
 * drawn by components/certificate-card.tsx and, for the PDF, by
 * lib/certificate-layout.ts on the phone. No function here takes it.
 *
 * ALL NATIVE. The quiz, the certificate, its PDF (lib/certificate-pdf.ts) and
 * the public check (verifyCode, app/verify-cert.tsx) are screens of this app;
 * nothing in the flow opens a web page.
 *
 * No strings live here: the quiz is KEYS, translated where it is painted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { BASE } from '@/lib/api';
import { getToken, renewSession } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';

export const QUIZ_VERSION = 1;

export type QuizQuestion = { q: string; options: [string, string, string]; answer: number; why: string };

/* THE ANSWER KEY IS A TWIN of backend services/certificates.js QUIZ_ANSWERS and
   app/certificate.js QUIZ; backend/tests/certificates_test.mjs reads all three.
   The keys are shared with the web bundle (cert.*), so both clients ask the
   same questions in the same words. */
export const QUIZ: QuizQuestion[] = [
  { q: 'cert.q1', options: ['cert.q1-a', 'cert.q1-b', 'cert.q1-c'], answer: 1, why: 'cert.q1-why' },
  { q: 'cert.q2', options: ['cert.q2-a', 'cert.q2-b', 'cert.q2-c'], answer: 0, why: 'cert.q2-why' },
  { q: 'cert.q3', options: ['cert.q3-a', 'cert.q3-b', 'cert.q3-c'], answer: 2, why: 'cert.q3-why' },
  { q: 'cert.q4', options: ['cert.q4-a', 'cert.q4-b', 'cert.q4-c'], answer: 0, why: 'cert.q4-why' },
  { q: 'cert.q5', options: ['cert.q5-a', 'cert.q5-b', 'cert.q5-c'], answer: 1, why: 'cert.q5-why' },
  { q: 'cert.q6', options: ['cert.q6-a', 'cert.q6-b', 'cert.q6-c'], answer: 2, why: 'cert.q6-why' },
  { q: 'cert.q7', options: ['cert.q7-a', 'cert.q7-b', 'cert.q7-c'], answer: 1, why: 'cert.q7-why' },
];

export type Cert = { code: string; issuedOn: string; verifyUrl: string };
export type CertMine = {
  certified: boolean;
  code: string | null;
  issuedOn: string | null;
  verifyUrl: string | null;
  practised: boolean;
};

/** On this phone only. Never in a request. */
const NAME_KEY = 'hawkeye.certName';
export async function loadCertName(): Promise<string> {
  try { return ((await AsyncStorage.getItem(NAME_KEY)) || '').slice(0, 60); } catch { return ''; }
}
export async function saveCertName(name: string): Promise<void> {
  try {
    const v = name.slice(0, 60);
    if (v) await AsyncStorage.setItem(NAME_KEY, v);
    else await AsyncStorage.removeItem(NAME_KEY);
  } catch { /* this session only */ }
}

type Reply = { status: number; body: Record<string, unknown> | null };

/**
 * Signed in, with this device's id (the practice-run link is by device) and a
 * real deadline. A 401 renews the session once and retries, like authedGet.
 * The body is only ever the quiz answers.
 */
async function call(method: 'GET' | 'POST', path: string, body?: { answers: number[]; version: number }): Promise<Reply | null> {
  const once = async (): Promise<Reply | null> => {
    const token = getToken();
    if (!token) return { status: 401, body: null };
    const id = await getIdentity();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: res.status, body: json };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await once();
  if (first?.status === 401 && (await renewSession())) return once();
  return first;
}

const asCert = (b: Record<string, unknown> | null): Cert | null =>
  b && typeof b.code === 'string' && typeof b.issuedOn === 'string'
    ? { code: b.code, issuedOn: b.issuedOn, verifyUrl: typeof b.verifyUrl === 'string' ? b.verifyUrl : `${BASE}/verify-cert?code=${b.code}` }
    : null;

/** null = could not tell (network, server); 'signed_out' = no session. */
export async function fetchMine(): Promise<CertMine | 'signed_out' | null> {
  const r = await call('GET', '/api/cert/mine');
  if (!r) return null;
  if (r.status === 401) return 'signed_out';
  if (r.status !== 200 || !r.body) return null;
  const c = asCert(r.body);
  return {
    certified: r.body.certified === true && !!c,
    code: c?.code ?? null,
    issuedOn: c?.issuedOn ?? null,
    verifyUrl: c?.verifyUrl ?? null,
    practised: r.body.practised === true,
  };
}

export type IssueResult =
  | { ok: true; cert: Cert }
  | { ok: false; error: 'no_practice' | 'quiz_failed' | 'signed_out' | 'network' };

export async function issueCert(answers: number[]): Promise<IssueResult> {
  const r = await call('POST', '/api/cert/issue', { answers, version: QUIZ_VERSION });
  if (!r) return { ok: false, error: 'network' };
  const c = r.status === 200 ? asCert(r.body) : null;
  if (c) return { ok: true, cert: c };
  if (r.status === 401) return { ok: false, error: 'signed_out' };
  if (r.status === 403) return { ok: false, error: 'no_practice' };
  if (r.status === 400 || r.status === 409) return { ok: false, error: 'quiz_failed' };
  return { ok: false, error: 'network' };
}

/* The public check (backend GET /api/cert/verify, the one app/verify-cert.html
   calls). The alphabet is the code generator's: no 0/1/I/L/O/U. */
const CODE_CHARS = /[^2-9A-HJKMNP-TV-Z]/g;
/** "abcd efgh" -> "ABCDEFGH" (at most 8 of the code's own characters). */
export const normCode = (s: string) => String(s || '').toUpperCase().replace(CODE_CHARS, '').slice(0, 8);
export const prettyCode = (c: string) => (c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

export type VerifyResult =
  | { state: 'valid'; code: string; issuedOn: string }
  | { state: 'invalid' }
  | { state: 'error' };

/**
 * No credentials, like the web page, so the edge may answer it. A malformed
 * code is "not valid" without asking anyone.
 */
export async function verifyCode(raw: string): Promise<VerifyResult> {
  const code = normCode(raw);
  if (code.length !== 8) return { state: 'invalid' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`${BASE}/api/cert/verify?code=${encodeURIComponent(prettyCode(code))}`, {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
    });
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && j && j.valid === true && typeof j.code === 'string' && typeof j.issuedOn === 'string') {
      return { state: 'valid', code: j.code, issuedOn: j.issuedOn };
    }
    if (res.status === 404 || res.status === 400) return { state: 'invalid' };
    return { state: 'error' };
  } catch {
    return { state: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

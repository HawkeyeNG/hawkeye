/**
 * The "Hawkeye Observer" certificate — native twin of app/certificate.js
 * (backend services/certificates.js).
 *
 * THE NAME NEVER LEAVES THE PHONE. The server stores no name. The one printed
 * on a certificate is typed on the certificate screen, kept in AsyncStorage and
 * drawn by components/certificate-card.tsx. No function here takes it, except
 * printUrl(), which puts it in a URL #FRAGMENT for the in-app browser — and a
 * fragment is never sent to any server (the web page also wipes it from the
 * address bar the moment it reads it).
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

/**
 * The web certificate page, for printing or saving as PDF in the in-app
 * browser. The name goes in the #FRAGMENT, never the query string: a fragment
 * is not part of the request, so no server — ours or a proxy's — ever sees it.
 * Built by hand: React Native's URLSearchParams does not implement set().
 */
export function printUrl(cert: Cert, name: string, lang: string): string {
  const parts = [`code=${encodeURIComponent(cert.code)}`];
  const n = name.trim().slice(0, 60);
  if (n) parts.push(`name=${encodeURIComponent(n)}`);
  parts.push(`lang=${encodeURIComponent(lang)}`);
  return `${BASE}/certificate.html#${parts.join('&')}`;
}

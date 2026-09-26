/**
 * Crash and error reports (Sentry, EU region, project hawkeye-native).
 *
 * The same privacy rules as the website's app/monitor.js: every event is scrubbed
 * ON THE PHONE before it is sent — phone numbers, e-mail addresses, long tokens,
 * keys and hashes, and URL query strings are removed; the user, headers and
 * cookies are dropped; typed-input and console breadcrumbs are discarded. No
 * tracing, no replay, no release-health sessions. The project also refuses to
 * store IP addresses and scrubs sensitive fields server-side.
 */
import * as Sentry from '@sentry/react-native';

const DSN = 'https://fc73e9700b95c2a1d46e000df06ed3c7@o4512140316508160.ingest.de.sentry.io/4512148251869264';

const PHONE = /(?:\+?234|\b0)\s?[789][01]\d(?:[\s-]?\d){7}\b/g;
// Bounded parts (RFC 5321 limits): unbounded ones went quadratic on long text with no '@'.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
const LONG = /\b[A-Za-z0-9_-]{24,}\b/g; // tokens, keys, hashes
const QUERY = /(https?:\/\/[^\s?#"']*|\.html|\/)[?#][^\s"')]*/g;

export function clean(s: string): string {
  return s.replace(QUERY, '$1').replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]').replace(LONG, '[redacted]');
}

// Sentry's own ids (and native debug images) are long hex strings that LONG would destroy.
const KEEP = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'sdk', 'debug_meta',
  'release', 'dist']);

function walk(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return clean(v);
  if (!v || typeof v !== 'object' || depth > 8) return v;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEEP.has(k)) o[k] = walk(o[k], depth + 1);
  return o;
}

export function scrubEvent<T extends Sentry.ErrorEvent>(ev: T): T {
  delete ev.user;
  // iOS reports the phone's own name ("Ade's iPhone") here.
  if (ev.contexts?.device) delete ev.contexts.device.name;
  if (ev.request) {
    delete ev.request.headers; delete ev.request.cookies;
    delete ev.request.query_string; delete ev.request.data;
  }
  return walk(ev, 0) as T;
}

export function scrubCrumb(b: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (b.category === 'ui.input' || b.category === 'console') return null;
  return walk(b, 0) as Sentry.Breadcrumb;
}

Sentry.init({
  dsn: DSN,
  enabled: !__DEV__,
  environment: 'native',
  sendDefaultPii: false,
  tracesSampleRate: 0,
  enableAutoSessionTracking: false,
  attachScreenshot: false,
  attachViewHierarchy: false,
  maxBreadcrumbs: 30,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubCrumb,
});

export { Sentry };

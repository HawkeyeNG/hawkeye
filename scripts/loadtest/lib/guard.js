// PRODUCTION GUARD. Every scenario imports this and calls initGuard() at module
// load (init context: hostname rules) and setupGuard() in setup() (the server's
// own claim about itself, via /api/health). Two independent checks, because a
// hostname check alone is defeated by pointing BASE_URL at an IP.
//
// Rules:
//   - hawkeye.com.ng or any subdomain except staging.hawkeye.com.ng = PRODUCTION.
//   - A server whose /api/health says env=production = PRODUCTION, whatever it
//     is called.
//   - Production needs I_KNOW_THIS_IS_PROD=<exact host> (run.sh sets it only
//     for --i-know-this-is-prod), and then ONLY the read scenario may run.
//   - Write and auth scenarios also refuse a server that says SMS OTP or its own
//     WhatsApp sender is live. The auth scenario additionally refuses unless the
//     OTP comes back as devOtp (console provider, non-production only).
import http from 'k6/http';
import exec from 'k6/execution';

const PROD_RE = /(^|\.)hawkeye\.com\.ng$/i;
const STAGING_RE = /^staging\.hawkeye\.com\.ng$/i;

export const BASE_URL = String(__ENV.BASE_URL || '').replace(/\/+$/, '');

export function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

export const HOST = hostOf(BASE_URL);
export const PROD_NAMED = PROD_RE.test(HOST) && !STAGING_RE.test(HOST);
export const PROD_ACK = HOST !== '' && String(__ENV.I_KNOW_THIS_IS_PROD || '').toLowerCase() === HOST;

// kind: 'read' | 'write' | 'auth'
export function initGuard(kind) {
  if (!BASE_URL || !HOST) {
    throw new Error('BASE_URL is required, e.g. BASE_URL=https://staging.hawkeye.com.ng');
  }
  if (PROD_NAMED) {
    if (!PROD_ACK) {
      throw new Error(`REFUSED: ${HOST} is PRODUCTION. Point BASE_URL at staging. `
        + '(A read-only smoke against prod needs run.sh --i-know-this-is-prod.)');
    }
    if (kind !== 'read') {
      throw new Error(`REFUSED: only the read scenario may ever run against production (${HOST}).`);
    }
    if (__ENV.ORIGIN_AUTH) {
      throw new Error('REFUSED: ORIGIN_AUTH must never be sent to production (it would bypass the edge).');
    }
  }
  return { prodNamed: PROD_NAMED };
}

export function setupGuard(kind, headers = {}) {
  // responseType 'text' overrides a scenario's discardResponseBodies (the read
  // scenario sets it), without which r.json() below always failed and the read
  // scenario aborted in setup against every server, staging included.
  const r = http.get(`${BASE_URL}/api/health`, { headers, tags: { name: 'guard_health' }, responseType: 'text' });
  if (r.status !== 200) exec.test.abort(`guard: /api/health returned HTTP ${r.status}`);
  let h;
  try { h = r.json(); } catch (_) { exec.test.abort('guard: /api/health is not JSON'); }
  const prod = PROD_NAMED || String(h.env) === 'production';
  if (prod && !PROD_ACK) {
    exec.test.abort(`REFUSED: ${HOST} reports env=${h.env}. It is production; use staging.`);
  }
  if (prod && kind !== 'read') exec.test.abort('REFUSED: production accepts only the read scenario.');
  if (kind !== 'read') {
    if (h.smsOtp) exec.test.abort('REFUSED: server reports smsOtp=true, so a real SMS could be sent.');
    if (h.waCloud) exec.test.abort('REFUSED: server reports waCloud=true, so a real WhatsApp could be sent.');
  }
  return { prod, env: h.env, health: h };
}

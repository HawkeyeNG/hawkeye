/**
 * The Osun register, shipped inside the app.
 *
 * Native twin of the web's offline-first polling-unit search. On the web the
 * register arrives as a static file the service worker caches; there is no
 * service worker here, so it is bundled instead — which is strictly better:
 * it works on a phone that has never had a usable connection.
 *
 * WHY IT MATTERS: unit search was network-only on native. Every keystroke past
 * three characters was a round trip (~1.2 s measured against production), and
 * on a polling-unit network on election day it simply fails. The register does
 * not change during an election, so asking a server for it is avoidable work.
 *
 * Rows keep the exact shape `/api/register/search` returns, so callers take the
 * result unchanged.
 */

export type RegisterRow = {
  pu_code: string;
  name: string;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
  [k: string]: unknown;
};

let flat: RegisterRow[] | null = null;
let warming = false;

/**
 * Parse the bundle once, off the interaction path.
 *
 * The require() is deliberately inline rather than a top-level import: Metro
 * evaluates a module on first require, so an import here would parse ~1.7 MB of
 * JSON during app startup for every screen, whether or not anyone searches.
 * The setTimeout keeps that parse off the frame that mounts the search box —
 * it lands while the keyboard is still animating otherwise, and drops frames.
 */
export function warmRegister(): void {
  if (flat || warming) return;
  warming = true;
  setTimeout(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      const bundle: Record<string, any> = require('@/lib/register-osun.json');
      const rows: RegisterRow[] = [];
      for (const st of Object.keys(bundle)) {
        if (st === 'states' || st === 'generated') continue;
        const lgas = bundle[st];
        if (!lgas || typeof lgas !== 'object') continue;
        for (const lga of Object.keys(lgas)) {
          for (const ward of Object.keys(lgas[lga])) {
            const units = lgas[lga][ward];
            if (Array.isArray(units)) rows.push(...units);
          }
        }
      }
      flat = rows;
    } catch {
      flat = []; // tried and failed; never retry-loop
    } finally {
      warming = false;
    }
  }, 0);
}

/** True once the register can answer without waiting on anything. */
export function registerReady(): boolean {
  return Array.isArray(flat) && flat.length > 0;
}

const LOCAL_MAX = 50;

/**
 * Search the bundled register. SYNCHRONOUS and non-blocking by design: it reads
 * what is already parsed and returns null if it cannot answer, so a caller
 * always has the network to fall back to. The web version originally awaited
 * the bundle and made the FIRST search slower than the request it replaced —
 * don't reintroduce that here.
 */
export function localSearch(
  term: string,
  opts: { state?: string | null; lga?: string | null } = {},
): { units: RegisterRow[]; truncated: boolean } | null {
  // Only Osun is bundled; a search scoped elsewhere must go to the server.
  if (opts.state && opts.state !== 'Osun') return null;
  if (!flat || !flat.length) return null;
  const t = term.toLowerCase();
  const hits: RegisterRow[] = [];
  for (const u of flat) {
    if (opts.lga && u.lga !== opts.lga) continue;
    if (`${u.name} ${u.pu_code} ${u.ward ?? ''}`.toLowerCase().includes(t)) {
      hits.push(u);
      if (hits.length > LOCAL_MAX) break;
    }
  }
  return { units: hits.slice(0, LOCAL_MAX), truncated: hits.length > LOCAL_MAX };
}

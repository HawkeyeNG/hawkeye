/**
 * Make every `const BASE = 'https://hawkeye.com.ng'` overridable by
 * EXPO_PUBLIC_API_BASE.
 *
 *   node scripts/patch-api-base.mjs
 *
 * Each lib file declares its own BASE by existing convention rather than
 * importing one, which is fine on a device but meant the browser override had
 * to be applied in five places — and missing one leaves a single call still
 * pointing at production, which then fails CORS and looks like a bug in
 * whatever feature made that call.
 *
 * Idempotent: files already carrying the override are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'src');
const NOTE = '// Overridable so the app can run in a desktop browser against a local\n'
  + '// backend; production blocks cross-origin calls. See lib/api.ts.\n';
const NEW = "const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';";
const OLD = "const BASE = 'https://hawkeye.com.ng';";

/**
 * The whole of src/, not just lib/.
 *
 * Seven screens under src/app/ declare their OWN `const BASE` — practice.tsx,
 * results.tsx, profile.tsx and others — so patching lib/ alone left most of the
 * app still calling production. In a browser those calls fail CORS and surface
 * as "network error, try again", which is indistinguishable from the network
 * being down and sends you looking in the wrong place entirely.
 *
 * The match is the exact declaration, so share links and
 * WebBrowser.openBrowserAsync('https://hawkeye.com.ng/...') are untouched —
 * those SHOULD always point at the real site.
 */
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  return /\.tsx?$/.test(e.name) ? [p] : [];
});

let changed = 0;
for (const p of walk(root)) {
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(OLD)) continue;
  fs.writeFileSync(p, src.replace(OLD, NOTE + NEW));
  console.log(`  patched ${path.relative(root, p)}`);
  changed++;
}
console.log(changed ? `${changed} file(s) patched` : 'nothing to patch — all already overridable');

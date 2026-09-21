/**
 * DOES THE BUNDLE TELL THE APP THE MAP IS USABLE?
 *
 * components/unit-map.tsx hides the map when `extra.mapsKeyPresent === false`,
 * and that flag comes from app.config.js, which only reads the production key
 * when APP_VARIANT=production. build_play_aab.sh used to set that as a prefix
 * on `expo prebuild` alone — so prebuild wrote a perfectly good key into
 * AndroidManifest while gradle, re-evaluating the same config without the
 * variable, embedded mapsKeyPresent:false. Manifest right, app blind.
 *
 * The old gate greped the manifest, which is the artifact that was CORRECT on
 * every broken build. This checks the one the app actually reads.
 *
 * Run from native/. Exits non-zero with a sentence naming the cause.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/* Expo loads .env / .env.local itself; plain node does not, so a good build
   would fail this gate for the wrong reason without it. */
for (const file of ['.env.local', '.env']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

if (process.env.APP_VARIANT !== 'production') {
  console.error('::error::APP_VARIANT is not "production" in this environment, so '
    + 'app.config.js will read the DEV Maps key. Export it for the whole build, not '
    + 'as a prefix on one command.');
  process.exit(1);
}

const base = require_('../app.json').expo;
const cfg = require_('../app.config.js')({ config: base });
const present = cfg?.extra?.mapsKeyPresent;

if (present !== true) {
  console.error(`::error::extra.mapsKeyPresent is ${present}, so unit-map.tsx would hide the `
    + 'map behind "This build has no Google Maps key" — on a build whose manifest may well '
    + 'carry a working key. Set GOOGLE_MAPS_API_KEY_PROD (repository secret, or '
    + 'native/.env.local) and keep APP_VARIANT=production exported.');
  process.exit(1);
}

console.log('  maps flag : extra.mapsKeyPresent = true');

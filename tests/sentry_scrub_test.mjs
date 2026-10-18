// WHAT LEAVES THE PHONE IN A CRASH REPORT (pre-election review).
//
// app/monitor.js scrubs every Sentry event on the device. Its phone pattern
// caught 0803… and +234 803… but let through the other ways Nigerian numbers
// are written — 803-123-4567, the bare ten digits, +234-803…, +234 (0) 803… —
// and nothing removed a GPS fix quoted in an error message, i.e. where an
// observer was standing.
//
// The SHIPPED monitor.js runs in a vm realm with a stub Sentry SDK; the event
// goes through the beforeSend it registers, exactly as on a phone. CONTROL:
// ordinary error text (versions, timings, counts, ids) comes through intact.
//
//   node tests/sentry_scrub_test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { H, tally } from './helpers/harness.mjs';

const { check, finish } = tally();

let opts = null;
const sandbox = {
  addEventListener() {}, removeEventListener() {},
  location: { hostname: 'hawkeye.com.ng' },
  requestIdleCallback: (f) => f(),
  document: {
    readyState: 'complete',
    createElement: () => ({}),
    head: { appendChild: (s) => { sandbox.window.Sentry = { init: (o) => { opts = o; }, captureException() {} }; s.onload(); } },
  },
  JSON, console,
};
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(`${H}/app/monitor.js`, 'utf8'), sandbox);
check('monitor.js initialises Sentry', !!opts);
if (!opts) finish();
const scrub = (msg) => opts.beforeSend({ exception: { values: [{ type: 'Error', value: msg }] } }).exception.values[0].value;

for (const n of ['08031234567', '+234 803 123 4567', '2348031234567', '0803-123-4567',
  '803-123-4567', '8031234567', '+234-803-123-4567', '+234 (0) 803 123 4567', '0803  123 4567']) {
  const out = scrub(`call failed for ${n} now`);
  check(`phone "${n}" is removed`, out, (v) => !/\d{3}/.test(v));
}
for (const c of ['lat 6.524379, lng 3.379206', 'fix (-12.345678,7.123456)']) {
  const out = scrub(`no unit near ${c}`);
  check(`GPS fix "${c}" is removed`, out, (v) => !/\d\.\d{4}/.test(v));
}
for (const s of ['SDK 11.0.0 took 12.5 ms', 'parties 18 of 18 loaded, retry 3', 'epoch 1729000000123', 'unit 30-05-07-001']) {
  check(`CONTROL: "${s}" is left alone`, scrub(s), s);
}

finish();

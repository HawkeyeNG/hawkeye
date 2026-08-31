/**
 * The version bump edits two files in two different formats with two regexes.
 * A regex that matches nothing returns the source unchanged; a regex that
 * matches the WRONG number changes something else and still looks like success.
 * Both failures are invisible until Play rejects the bundle, forty minutes into
 * a build. So: exercise read and write against the real files, and include a
 * control that proves the test can actually fail.
 *
 *   node tests/play_next_version_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS } from '../scripts/play_next_version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

for (const [key, app] of Object.entries(APPS)) {
  console.log(`\n${key} — ${app.file}`);
  const src = fs.readFileSync(path.join(root, app.file), 'utf8');

  const current = app.read(src);
  ok(Number.isInteger(current) && current > 0, `reads a real versionCode (got ${current})`);

  const target = current + 41;             // a number that appears nowhere else
  const out = app.write(src, target);
  ok(out !== src, 'write actually changes the file');
  ok(app.read(out) === target, `write then read round-trips (${current} -> ${target})`);

  // Changing the version must not disturb anything else in the file. Gradle in
  // particular has versionName right beside versionCode, and app.json has other
  // numeric fields; a sloppy regex eats one of them.
  const diff = src.split('\n').filter((l, i) => l !== out.split('\n')[i]);
  ok(diff.length === 1, `exactly one line changed (changed ${diff.length})`);
  console.log(`        ${diff[0]?.trim()}`);

  if (key === 'lite') {
    const name = /versionName\s+"([^"]+)"/.exec(out)?.[1];
    ok(name === /versionName\s+"([^"]+)"/.exec(src)?.[1], `versionName untouched (${name})`);
  }
  if (key === 'native') {
    const before = JSON.parse(src).expo;
    const after = JSON.parse(out).expo;
    ok(after.version === before.version, `expo.version untouched (${after.version})`);
    ok(JSON.stringify({ ...after, android: null }) === JSON.stringify({ ...before, android: null }),
      'nothing outside expo.android changed');
  }
}

// CONTROL — the checks above must be capable of failing. A file with no
// versionCode at all has to be caught, not silently accepted.
console.log('\ncontrol — a file with no versionCode must not pass');
const bogus = '{ "expo": { "android": { "package": "x" } } }';
let caught = false;
try {
  const n = APPS.native.read(bogus);
  caught = !Number.isInteger(n);
} catch { caught = true; }
ok(caught, 'missing versionCode is detected rather than read as a number');
const unchanged = APPS.lite.write('nothing here', 9);
ok(unchanged === 'nothing here', 'a write that matches nothing returns the source unchanged (so the caller can detect it)');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

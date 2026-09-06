/**
 * In UPLOAD_MODE=direct the dhashes are null. Nothing may read them.
 *
 *   node tests/direct-null-dhash.test.mjs
 *
 * WHY THIS EXISTS. The first version of the direct-upload branch wrapped only
 * the two dhashHex() calls in `if (!DIRECT)` and left FOUR consumers reading the
 * nulls. hammingDistance() and dhashBandTokens() both do BigInt('0x' + value),
 * which does not return a falsy result on null — it THROWS
 * `SyntaxError: Cannot convert 0xnull to a BigInt`. Every direct-mode submission
 * would have returned 500 from the outer catch, AFTER both photos were already
 * committed to the bucket and BEFORE the ledger append, so the observer's signed
 * report would have been recorded nowhere. node --check passes on it, all other
 * tests pass on it, and proxy mode is completely unaffected — so nothing else in
 * the suite can see it.
 *
 * Two halves:
 *   1. the runtime fact — these functions throw on null, they do not degrade;
 *   2. the structural rule — in submissions.js every read of imageDhash /
 *      venueImageDhash sits inside a `!DIRECT` guard or has a null check.
 *
 * The structural half carries a control: the same scan is run against a mutated
 * copy with a guard removed, and MUST report a violation. Without that, a scan
 * that silently matches nothing would pass forever.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hammingDistance, dhashBandTokens } from '../backend/src/services/images.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'backend', 'src', 'routes', 'submissions.js');

// ---- 1. the runtime fact ---------------------------------------------------
{
  for (const [label, fn] of [
    ['hammingDistance(null, null)', () => hammingDistance(null, null)],
    ['hammingDistance(hex, null)', () => hammingDistance('0123456789abcdef', null)],
    ['dhashBandTokens(null, 4)', () => dhashBandTokens(null, 4)],
  ]) {
    assert.throws(fn, /BigInt/, `${label} should throw, not return a falsy value`);
  }
  // Control: with real values they must work, or "throws" proves nothing.
  assert.strictEqual(hammingDistance('0123456789abcdef', '0123456789abcdee'), 1);
  assert.ok(dhashBandTokens('0123456789abcdef', 4).length > 0);
  console.log('  PASS  null dhashes THROW at every consumer (and real ones still work)');
}

// ---- 2. the structural rule ------------------------------------------------
/**
 * Report every line that reads a dhash variable while not inside a `!DIRECT`
 * guard and without a null check. Brace-depth tracking is crude but sufficient:
 * the guards here are plain single-level blocks.
 */
function violations(src) {
  const lines = src.split('\n');
  const out = [];
  let guardDepth = null;
  let depth = 0;
  let inHandler = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("submissionsRouter.post('/submissions'")) inHandler = true;
    if (!inHandler) continue;

    const opensGuard = /if \(!DIRECT\) \{/.test(line) || /\} else \{/.test(line);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    // guardDepth is the depth INSIDE the guarded block, i.e. after this line's
    // braces are applied. Taking it from before the braces made the guard clear
    // itself on the very next line and report a false violation.
    if (opensGuard && guardDepth === null) guardDepth = depth;
    else if (guardDepth !== null && depth < guardDepth) guardDepth = null;

    // A read of a dhash variable, ignoring the assignments themselves.
    const reads = /\b(imageDhash|venueImageDhash)\b/.test(line)
      && !/^\s*(let|const)\s/.test(line)
      && !/^\s*(imageDhash|venueImageDhash)\s*=/.test(line)
      && !/^\s*\/\//.test(line);
    if (!reads) continue;

    const guarded = guardDepth !== null;
    // The DB insert and the bands loop are allowed if they null-check nearby.
    const nullChecked = /if \(!h\) continue/.test(lines[i - 1] || '')
      || /if \(!h\) continue/.test(lines[i + 1] || '')
      || /\[\[0, imageDhash\], \[1, venueImageDhash\]\]/.test(line)
      || /imageSha256, imageDhash, imagePath/.test(line)      // INSERT columns: null is valid
      || /venueImageSha256, venueImageDhash/.test(line);
    if (!guarded && !nullChecked) out.push(`${i + 1}: ${line.trim().slice(0, 88)}`);
  }
  return out;
}

const src = fs.readFileSync(SRC, 'utf8');
const found = violations(src);
if (found.length) {
  console.log('  FAIL  unguarded dhash reads in direct mode:');
  for (const f of found) console.log(`          ${f}`);
}
assert.strictEqual(found.length, 0, 'a dhash is read where it may be null');
console.log('  PASS  every dhash read is guarded or null-checked');

// ---- 3. THE CONTROL: the scan must be able to find a violation -------------
{
  const broken = src.replace(
    /    if \(!DIRECT\) \{\n(      const T = config\.dhashHammingThreshold;)/,
    '    if (true) {\n$1',
  ).replace('if (true) {', '');       // strip the guard line entirely
  const brokenFound = violations(broken);
  assert.ok(
    brokenFound.length > 0,
    'CONTROL FAILED: removing a guard produced no violation — the scan is blind',
  );
  console.log(`  PASS  control: removing a guard is detected (${brokenFound.length} violation(s))`);
}

console.log('\ndirect-null-dhash: all checks passed');

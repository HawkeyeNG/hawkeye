/**
 * Validate the R2 credentials by SHAPE, not by length.
 *
 *   node scripts/r2_check_env.mjs
 *
 * Written because a length check let a placeholder through: S3_ENDPOINT was
 * still the literal "https://<account-id>.r2.cloudflarestorage.com" from the
 * setup instructions, and at 45 characters that looked like a plausible value.
 * The failure surfaced as an opaque "TypeError: Invalid URL" from deep inside
 * presignPut. Checking the shape says which field is wrong, and why.
 *
 * Prints no secrets — only which fields are wrong.
 */
const RULES = [
  ['S3_ENDPOINT', (v) => {
    if (/[<>]/.test(v)) return 'still contains a <placeholder> — substitute your Cloudflare Account ID';
    if (!/^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com\/?$/.test(v)) {
      return 'expected https://<32-hex-account-id>.r2.cloudflarestorage.com';
    }
    try { new URL(v); } catch { return 'not a parseable URL'; }
    return null;
  }],
  ['S3_BUCKET', (v) => (/^[a-z0-9][a-z0-9-]{2,62}$/.test(v) ? null : 'expected a lowercase bucket name')],
  ['S3_REGION', (v) => (v === 'auto' ? null : `expected "auto" for R2, got "${v}"`)],
  ['S3_ACCESS_KEY_ID', (v) => (/^[0-9a-f]{32}$/.test(v) ? null : 'expected 32 hex characters')],
  ['S3_SECRET_ACCESS_KEY', (v) => (/^[0-9a-f]{64}$/.test(v) ? null : 'expected 64 hex characters')],
  ['BLOB_DRIVER', (v) => (['fs', 's3'].includes(v) ? null : 'expected fs or s3')],
  ['UPLOAD_MODE', (v) => (['proxy', 'direct'].includes(v) ? null : 'expected proxy or direct')],
];

let bad = 0;
console.log('field                     verdict');
for (const [name, rule] of RULES) {
  const v = (process.env[name] || '').trim();
  if (!v) { console.log(`  ${name.padEnd(24)} MISSING`); bad++; continue; }
  const err = rule(v);
  console.log(`  ${name.padEnd(24)} ${err ? 'BAD  — ' + err : 'ok'}`);
  if (err) bad++;
}

// CONTROL: the validator must be able to fail. If a deliberately wrong value
// passes, these checks prove nothing.
const control = RULES.find(([n]) => n === 'S3_ENDPOINT')[1]('https://<account-id>.r2.cloudflarestorage.com');
console.log(`\ncontrol (a known-bad endpoint must be rejected): ${control ? 'ok — rejected' : 'FAILED — validator is blind'}`);

console.log(`\n${bad ? `${bad} field(s) need fixing` : 'all fields look right'}`);
process.exit(bad || !control ? 1 : 0);

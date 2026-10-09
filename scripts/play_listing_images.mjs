#!/usr/bin/env node
/**
 * Replace a Play listing's PHONE SCREENSHOTS with a committed set.
 *
 *   node scripts/play_listing_images.mjs --app native|lite --dir store/screenshots/native-play [--dry-run] [--send-for-review]
 *
 * Runs in CI only (.github/workflows/play-listing.yml): the org forbids
 * service-account keys, so the access token comes from Workload Identity
 * Federation in PLAY_ACCESS_TOKEN — the same path play_promote.mjs uses.
 *
 * Checked BEFORE anything is sent: 2–8 PNGs, every one 9:16 or 16:9 and at
 * least 320 px, read from their own headers. The default listing language is
 * read from the app, not assumed (native is en-GB, Lite en-US).
 *
 * Commit: staged (changesNotSentForReview) where Play allows it; where the app
 * sends changes for review automatically, only with --send-for-review, which
 * submits EVERY pending change — check Publishing overview first, as for
 * play_promote.mjs. --dry-run deletes the edit and changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGES } from './play_promote.mjs';

const die = (m) => { console.error(`\x1b[31mFAIL: ${m}\x1b[0m`); process.exit(1); };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : null; };
const appKey = opt('app');
const dir = opt('dir');
const dryRun = argv.includes('--dry-run');
const sendForReview = argv.includes('--send-for-review');
const pkg = PACKAGES[appKey];
if (!pkg) die(`--app must be one of: ${Object.keys(PACKAGES).join(', ')}`);
if (!dir || !fs.existsSync(dir)) die(`--dir ${dir} does not exist`);
const token = process.env.PLAY_ACCESS_TOKEN;
if (!token) die('PLAY_ACCESS_TOKEN is not set (run after the auth step)');

// ---- local checks, before any request
const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
if (files.length < 2 || files.length > 8) die(`Play takes 2–8 phone screenshots; ${dir} has ${files.length}`);
for (const f of files) {
  const b = fs.readFileSync(path.join(dir, f));
  if (b.readUInt32BE(0) !== 0x89504e47) die(`${f} is not a PNG`);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const r = Math.max(w, h) / Math.min(w, h);
  if (Math.min(w, h) < 320 || Math.abs(r - 16 / 9) > 0.01) die(`${f} is ${w}x${h}; Play wants 9:16 (or 16:9), min 320 px`);
  console.log(`  ok   ${f}  ${w}x${h}  ${Math.round(b.length / 1024)} KB`);
}

const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}`;
const UP = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${pkg}`;
const call = async (method, p, body, soft = false, base = API, type = 'application/json') => {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': type } : {}) },
    body: body ? (type === 'application/json' ? JSON.stringify(body) : body) : undefined,
  });
  const t = await r.text();
  if (!r.ok && !soft) die(`${method} ${p} -> ${r.status}\n       ${t.slice(0, 500)}`);
  return soft ? { ok: r.ok, status: r.status, text: t } : (t ? JSON.parse(t) : {});
};

console.log(`  app        : ${appKey} (${pkg})`);
const edit = await call('POST', '/edits');
const E = `/edits/${edit.id}`;
const lang = (await call('GET', `${E}/details`)).defaultLanguage;
console.log(`  edit       : ${edit.id}${dryRun ? '  (dry run, will be deleted)' : ''}`);
console.log(`  language   : ${lang}`);
const before = (await call('GET', `${E}/listings/${lang}/phoneScreenshots`)).images || [];
console.log(`  now        : ${before.length} phone screenshot(s)`);
if (dryRun) {
  await call('DELETE', E, null, true);
  console.log(`  DRY RUN: would replace ${before.length} with ${files.length}. Edit deleted, nothing changed.`);
  process.exit(0);
}
await call('DELETE', `${E}/listings/${lang}/phoneScreenshots`);
for (const f of files) {
  await call('POST', `${E}/listings/${lang}/phoneScreenshots?uploadType=media`, fs.readFileSync(path.join(dir, f)), false, UP, 'image/png');
  console.log(`  uploaded   ${f}`);
}
const after = (await call('GET', `${E}/listings/${lang}/phoneScreenshots`)).images || [];
if (after.length !== files.length) die(`the edit holds ${after.length} screenshots, expected ${files.length}; not committed`);

const commit = `${E}:commit`;
const staged = await call('POST', `${commit}?changesNotSentForReview=true`, null, true);
const autoReview = !staged.ok && staged.status === 400 && /sent for review automatically/i.test(staged.text);
if (!staged.ok && !autoReview) die(`POST ${commit}?changesNotSentForReview=true -> ${staged.status}\n       ${staged.text.slice(0, 500)}`);
if (staged.ok) {
  console.log('\n\x1b[33m  STAGED, NOT SENT FOR REVIEW. Play Console -> Publishing overview: check, then Send for review.\x1b[0m');
} else if (!sendForReview) {
  await call('DELETE', E, null, true);
  die('Play will not stage this edit (the app sends changes for review automatically).\n'
    + '       Nothing was committed. Check Publishing overview, then re-run with send_for_review.');
} else {
  await call('POST', commit);
  console.log('\n\x1b[32m  COMMITTED and SENT FOR REVIEW.\x1b[0m');
}
// Read back from a fresh edit, then throw that edit away.
const check = await call('POST', '/edits');
const live = (await call('GET', `/edits/${check.id}/listings/${lang}/phoneScreenshots`)).images || [];
console.log(`  listing now: ${live.length} phone screenshot(s)`);
await call('DELETE', `/edits/${check.id}`, null, true);

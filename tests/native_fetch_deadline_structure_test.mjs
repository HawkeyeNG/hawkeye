// SPINNERS THAT NEVER ENDED ON A STALLED LINK — the screen-level calls
// (pre-election review, native/).
//
// RN's fetch never times out. These requests each sit behind a busy state that
// ends only when the request settles, and none had a deadline:
//   - app/join/[token].tsx: the invite preview (full-screen spinner) and Join;
//   - lib/check-in.ts: "I'm here" on the result screen (card stays "working");
//   - app/report/incident.tsx: the fallback POST that runs exactly when the
//     XHR upload failed — often by its own 180 s timeout — so the submit
//     spinner stayed up instead of handing the incident to the outbox;
//   - app/profile.tsx authed(): delete-account and change-password. Delete
//     also had no try, so a network error left the confirm sheet spinning.
// Each now goes through lib/deadline.ts fetchWithin (behaviour proven in
// tests/native_submit_deadline_test.mjs and native_session_deadline_test.mjs);
// this pins the call sites, with a mutated-copy CONTROL per rule.
//
//   node tests/native_fetch_deadline_structure_test.mjs
import fs from 'node:fs';
import { H, tally } from './helpers/harness.mjs';

const { check, finish } = tally();
const read = (f) => fs.readFileSync(`${H}/native/src/${f}`, 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RULES = [
  ['app/join/[token].tsx', 'preview and Join use fetchWithin, no bare fetch to /api/join',
    (s) => (code(s).match(/fetchWithin\(`\$\{BASE\}\/api\/join\//g) || []).length === 2 && !/[^.\w]fetch\(`\$\{BASE\}\/api\/join/.test(code(s)),
    (s) => s.replace('fetchWithin(`${BASE}/api/join/', 'fetch(`${BASE}/api/join/')],
  ['lib/check-in.ts', 'check-in POST uses fetchWithin',
    (s) => /fetchWithin\(`\$\{BASE\}\/api\/my\/check-in`/.test(code(s)),
    (s) => s.replace('fetchWithin(`${BASE}/api/my/check-in`', 'fetch(`${BASE}/api/my/check-in`')],
  ['app/report/incident.tsx', 'the fallback incident POST has the upload deadline',
    (s) => /fetchWithin\(`\$\{BASE\}\/api\/incidents`,[\s\S]{0,120}UPLOAD_DEADLINE_MS\)/.test(code(s)),
    (s) => s.replace('fetchWithin(`${BASE}/api/incidents`', 'fetch(`${BASE}/api/incidents`')],
  ['app/profile.tsx', 'authed() uses fetchWithin',
    (s) => /async function authed[\s\S]{0,300}fetchWithin\(`\$\{BASE\}\$\{path\}`/.test(code(s)),
    (s) => s.replace('fetchWithin(`${BASE}${path}`', 'fetch(`${BASE}${path}`')],
  ['app/profile.tsx', 'doDelete clears the busy sheet when the request throws',
    (s) => /const doDelete = async[\s\S]{0,200}try \{[\s\S]{0,120}authed\('\/api\/observers\/delete'[\s\S]{0,80}\} catch \{[\s\S]{0,200}setConfirmBusy\(false\)/.test(code(s)),
    (s) => s.replace(/try \{\n(\s*)\(\{ status \} = await authed\('\/api\/observers\/delete'/, "{\n$1({ status } = await authed('/api/observers/delete'")],
];
for (const [file, label, rule, mutate] of RULES) {
  const s = read(file);
  check(`${file}: ${label}`, rule(s), true);
  check(`CONTROL: ${file}: the old shape is caught`, rule(mutate(s)), false);
}

finish();

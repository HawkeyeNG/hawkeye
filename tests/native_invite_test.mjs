/**
 * THE INVITE SECTION, ON EVERY CLIENT.
 *
 * Hawkeye's binding constraint is not capability, it is how few people are
 * standing at a unit with it — Osun drew twelve organic observers against
 * 3,763 polling units. The only channel that reaches 176,846 is one observer
 * handing it to the next, so the invite has to be on every client's profile,
 * not just the website's.
 *
 * Lite needs no port: its capacitor.config.json sets webDir to ../app, so it
 * ships the same profile.html the website does. That is asserted here, because
 * "Lite already has it" is a claim about a config file and should be checked
 * rather than remembered.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye/';
const read = (f) => fs.readFileSync(ROOT + f, 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ============================================================ Lite, by config
{
  const cfg = JSON.parse(read('mobile/capacitor.config.json'));
  check('Lite bundles the website app directory', cfg.webDir, '../app');
  const profile = read('app/profile.html');
  check('and that directory\'s profile carries the invite', /id="btn-ref-copy"/.test(profile), true);
  check('with both counts, not just signups',
    /people-you-invited/.test(profile) && /p-ref-stat/.test(profile), true);
}

// ==================================================================== native
{
  const p = read('native/src/app/profile.tsx');
  check('native profile imports the referral helper', /from '@\/lib\/referral'/.test(p), true);
  check('and asks for it once, outside the render path', /myReferral\(\)\.then\(setReferral\)/.test(p), true);

  /* ABSENT UNTIL THE CODE ARRIVES. A row reading "…" forever is worse than no
     row, and the request is allowed to fail. */
  check('the section is gated on having a code', /\{referral \? \(/.test(p), true);

  /* The identity-hash row already owns `copied`. One boolean between the two
     would make BOTH rows say "Copied" when either is tapped. */
  check('the invite row has its own copied flag', /refCopied/.test(p), true);
  check('and it did not steal the identity row\'s',
    (p.match(/const \[copied, setCopied\]/g) || []).length, 1);

  check('it copies the URL, not the bare code',
    /Clipboard\.setStringAsync\(referral\.url\)/.test(p), true);

  const lib = read('native/src/lib/referral.ts');
  check('the link points at invite.html, which routes to the right store',
    /invite\.html\?r=/.test(lib), true);
  check('a failed lookup returns null rather than throwing',
    /catch \{\s*return null;\s*\}/.test(lib), true);
  check('it does NOT ride on /me', !/observers\/me/.test(lib) && /observers\/referral/.test(lib), true);
}

// ========================================================== the words, x4
{
  const USED = ['profile.invite', 'profile.your-invite-link', 'profile.people-you-invited',
    'profile.signed-up', 'profile.observed', 'profile.none-yet', 'n.app.profile.copied'];
  const cat = Object.fromEntries(['en', 'ha', 'ig', 'yo']
    .map((l) => [l, JSON.parse(read(`native/src/lib/i18n/${l}.json`))]));
  const missing = [];
  for (const k of USED) {
    for (const l of ['en', 'ha', 'ig', 'yo']) {
      if (!cat[l][k] || !String(cat[l][k]).trim()) missing.push(`${k}/${l}`);
    }
  }
  check('every invite string is translated in all four', missing, []);
  /* CONTROL: present is not the same as translated. A key copied across
     untouched would pass the check above and ship English to a Hausa reader. */
  const english = USED.filter((k) => cat.ha[k] === cat.en[k]);
  check('CONTROL none of them is still the English text', english, []);

  // Both clients must say the SAME words: two descriptions of one thing in one
  // product is how a reader decides they are looking at different products.
  const web = JSON.parse(read('app/i18n/ha.json'));
  const drift = USED.filter((k) => web[k] && cat.ha[k] && web[k] !== cat.ha[k]);
  check('and the app says what the website says', drift, []);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll passed — the invite is on every client');
process.exit(fail ? 1 : 0);

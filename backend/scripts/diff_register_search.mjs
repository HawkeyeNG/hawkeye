#!/usr/bin/env node
/**
 * Step 3 of docs/PU-SEARCH-2027.md — the correctness gate for offline search.
 *
 * Runs a query corpus through BOTH search paths and fails on any difference:
 *   offline  app/register-store.js against a state pack, in a real browser
 *   online   GET /api/register/search against the same database
 *
 * The two must return the same page, not merely the same rows. An observer who
 * loses signal mid-search must not watch the list reshuffle underneath them —
 * that is the failure the whole pack design exists to prevent, and it is the
 * reason the fold lives in the database (name_fold/ward_fold) as well as in the
 * client, and the reason both sides break name ties on pu_code.
 *
 * The corpus is built FROM the register, so the queries look like the ones
 * observers actually type: whole names, first words, ward names, codes and code
 * prefixes, plus punctuation and casing variants where a fold divergence shows.
 *
 * Needs both servers up:
 *   node src/server.js                          # the API, port 8430
 *   (cd ../app && python3 -m http.server 8199)  # the packs + register-store.js
 *   node scripts/build_register_packs.mjs       # generate the packs first
 *
 *   node scripts/diff_register_search.mjs            # every state
 *   node scripts/diff_register_search.mjs --state Osun
 *   node scripts/diff_register_search.mjs --queries 200
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const Database = require('better-sqlite3');
// Playwright is a dev dependency of audit/, the only place this repo already
// keeps a browser. This script is a developer gate, never shipped.
const { chromium } = require(path.join(REPO, 'audit', 'node_modules', 'playwright'));

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
};
const ONE_STATE = argOf('--state', null);
const PER_STATE = Number(argOf('--queries', 500));
const API = argOf('--api', 'http://localhost:8430/api/register/search');
const APP = argOf('--app', 'http://localhost:8199/bench.html');
const TOP = 10;

const db = new Database(path.join(REPO, 'backend', 'storage', 'hawkeye.db'), { readonly: true });

const states = db
  .prepare('SELECT DISTINCT state, substr(pu_code,1,2) AS code FROM polling_units ORDER BY code')
  .all()
  .filter((s) => !ONE_STATE || s.state === ONE_STATE);

if (!states.length) {
  console.error(ONE_STATE ? `no such state: ${ONE_STATE}` : 'no states in the register');
  process.exit(2);
}

/** Queries drawn from the register itself, so they resemble real ones. */
function corpusFor(state) {
  const rows = db.prepare('SELECT pu_code,name,ward FROM polling_units WHERE state = ?').all(state);
  const q = new Set();
  const pick = (n) => rows[Math.floor((n * 7919) % rows.length)];
  for (let i = 0; i < Math.ceil(PER_STATE / 6); i++) {
    const r = pick(i);
    q.add(r.name.slice(0, 12));
    q.add(r.name.split(/\s+/)[0]);
    const words = r.name.split(/\s+/).filter((w) => w.length > 3);
    if (words.length > 1) q.add(words.slice(0, 2).join(' '));
    q.add(r.pu_code);
    q.add(r.pu_code.slice(0, 8));
    q.add(r.ward.slice(0, 10));
  }
  for (const t of ['primary school', 'open space', 'town hall', 'market', 'village square',
                   'central', 'community', 'baptist', 'grammar', 'health', 'palace', 'mosque',
                   'church', 'motor park', 'junction', 'pri sch', 'sch.', 'st.', 'l.a',
                   'ST PETERS', 'st peters', "st peter's", 'st.peters', 'odo oro', 'a/c']) q.add(t);
  return [...q].filter((s) => s && s.trim().length >= 3).slice(0, PER_STATE);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(APP, { waitUntil: 'networkidle' });

  let totalQ = 0, totalSame = 0;
  const failures = [];

  for (const { state, code } of states) {
    const corpus = corpusFor(state);
    await page.evaluate(
      (c) => window.registerStore.loadState(c).then(() => window.registerStore.searchReady(c)),
      code,
    );
    const offline = await page.evaluate(
      ([c, qs, top]) => qs.map((q) => {
        const r = window.registerStore.search(c, q, { limit: top });
        return r ? r.units.map((u) => u.pu_code) : [];
      }),
      [code, corpus, TOP],
    );

    let same = 0;
    const bad = [];
    for (let i = 0; i < corpus.length; i++) {
      const res = await fetch(
        `${API}?q=${encodeURIComponent(corpus[i])}&state=${encodeURIComponent(state)}&limit=${TOP}`,
      );
      const online = ((await res.json()).units || []).map((u) => u.pu_code);
      if (online.join(',') === offline[i].join(',')) same++;
      else if (bad.length < 5) bad.push({ q: corpus[i], offline: offline[i], online });
    }

    totalQ += corpus.length;
    totalSame += same;
    const ok = same === corpus.length;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${state.padEnd(12)} ${same}/${corpus.length}`);
    if (!ok) failures.push({ state, bad });
  }

  console.log(`\n${totalSame}/${totalQ} identical top-${TOP} across ${states.length} state(s)`);
  for (const f of failures) {
    console.log(`\n--- ${f.state} ---`);
    for (const b of f.bad) {
      console.log(`q=${JSON.stringify(b.q)}`);
      console.log(`   offline: ${b.offline.join(' ') || '(none)'}`);
      console.log(`   online : ${b.online.join(' ') || '(none)'}`);
    }
  }
  if (pageErrors.length) {
    console.log('\npage errors:');
    pageErrors.slice(0, 5).forEach((e) => console.log('  ' + e));
  }
  await browser.close();
  process.exit(failures.length || pageErrors.length ? 1 : 0);
})();

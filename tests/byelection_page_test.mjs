/**
 * Every by-election has a page, and it is ITS OWN page.
 *
 * race.html used to dispatch on the literal strings 'GOV' | 'SEN' | 'REP', so a
 * by-election code matched nothing and fell through to `data['raceOsun2026']` —
 * rendering the Osun governorship, a real page about a different election, with
 * nothing on screen to say so. The control at the bottom is what makes this test
 * mean something: it asserts the Osun page still renders, so "no Osun" here is a
 * statement about the by-election and not about a broken fixture.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    return json({ contest: url.split('/').pop(), level: 'lga', scope: null, subunits: [], regions: [], national: [], unitsReporting: 0, inDispute: 0, updatedAt: Date.now() });
  }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];

/**
 * WAIT FOR A SIGNAL, NOT A DURATION. The first version of this slept 600ms and
 * reported the Gombe page as blank — it renders, it just takes one more network
 * hop than the others (contests, then seat_lgas, then lga_geo). A fixed sleep
 * turns "slower" into "broken", which is the same mistake as reading a spinner
 * as a failure.
 */
async function open(qs, { expectMap = true } = {}) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  p.on('pageerror', (e) => errs.push(`${qs}: ${e}`));
  await p.goto(`${base}/race.html?${qs}`, { waitUntil: 'networkidle' });
  await p
    .waitForFunction(
      (wantMap) => {
        const main = document.getElementById('race-main');
        if (!main || !main.textContent.trim()) return false;
        return wantMap ? document.querySelectorAll('.race-map path').length > 0 : true;
      },
      expectMap,
      { timeout: 8000 },
    )
    .catch(() => {});
  const out = await p.evaluate(() => ({
    title: document.querySelector('.race-office, h1, h2')?.textContent?.trim() ?? null,
    body: document.getElementById('race-main')?.textContent ?? '',
    shapes: document.querySelectorAll('.race-map path').length,
    titles: [...document.querySelectorAll('.race-map path title')].map((t) => t.textContent),
  }));
  await p.close();
  return out;
}

console.log('=== the Gombe House by-election ===');
let r = await open('contest=REP_BYE_GOMBE_2026');
check('has its own page, not Osun', r.body, (t) => !/Osun/i.test(t));
check('titled for the seat', r.title, (t) => /Gombe\/Kwami\/Funakaye/.test(String(t)));
check('and draws its 3 member LGAs', r.shapes, 3);
check('named Funakaye, Gombe and Kwami', [...r.titles].sort(), ['Funakaye', 'Gombe', 'Kwami']);

console.log('\n=== the Delta state-assembly by-election ===');
r = await open('contest=SHA_BYE_DELTA_UDU_2026');
check('has its own page, not Osun', r.body, (t) => !/Osun/i.test(t));
check('titled for the seat', r.title, (t) => /Udu/.test(String(t)));
/**
 * THE MAP IS DRAWN IN WARDS NOW, not as one LGA blob - the ward maps landed
 * after this test was written and it went on asserting the old picture. A
 * by-election is fought ward by ward and an observer picks a unit inside one,
 * so the ward cut is the useful one.
 *
 * ALL TEN OF THEM, pinned by name.
 *
 * This asserted ">= 8" while two wards were unmapped: the register calls them
 * "Udu Iii" and "Udu Iv", the boundary file calls the same two places
 * "Ogbe Udu" and "Emadadja", and no spelling rule can bridge that - so the
 * automatic crosswalk refused them and the page drew eight, 34 of 265 units
 * invisible. They are paired by hand now, from the polling units' own names and
 * from where those units sit (see backend/src/data/ward_crosswalk_manual.json).
 *
 * The gap is closed, so the test stops tolerating it and pins the complete set.
 * A count alone would not: "10 shapes" stays true if the crosswalk ever pairs a
 * ward to the WRONG polygon, which is the failure that actually matters here.
 */
check('drawn in wards, not one LGA blob', r.shapes, 10);
check('all ten of Udu\'s wards are on the map', [...r.titles].sort(), [
  'Aladja', 'Ekete', 'Opete Assagba Edjophe', 'Orhuwhurun', 'Ovwian I', 'Ovwian Ii',
  'Udu I', 'Udu Ii', 'Udu Iii', 'Udu Iv',
]);
check('no region is drawn twice', new Set(r.titles).size, r.titles.length);

console.log('\n=== the Kano state-assembly by-election ===');
r = await open('contest=SHA_BYE_KANO_DAWAKINKUDU_2026');
check('has its own page, not Osun', r.body, (t) => !/Osun/i.test(t));
// The register spells it "Dawaki Kudu"; lga_geo.json spells it "Dawakin Kudu".
// Without the stem match this page draws no map at all.
check('resolves the register spelling to the map spelling', r.titles, (t) => t.length > 0);
// All fifteen of the register's wards resolve here, which is what makes Udu's
// eight a gap in the DATA rather than in the matching rule.
check('draws all fifteen wards', r.shapes, 15);

/**
 * THE BALLOT, ON THE RENDERED PAGE.
 *
 * political.ts and race.js agree on what the ballot IS - the parity test holds
 * that. This asks the different question: does it reach the reader's screen.
 * A rule that builds the right object and a renderer that drops it look
 * identical from the builder's side.
 */
/**
 * BAUCHI'S TWO SEATS ARE NARROWED TO THEIR OWN WARDS.
 *
 * Both sit in an LGA that elects a second member who is NOT voting, and the page
 * used to describe the LGA: 11 wards, ~261 units, and a map painting the sibling
 * seat's wards as though a reader's unit in them were in this race. The contest
 * now names the seat's five wards, so the figures are the seat's.
 *
 * The map draws FOUR of the five in both cases - "Alangawari / Kafin / Larabawa"
 * and "Disina" have no polygon in the ward file - and says four in its own
 * label. That gap is asserted rather than tolerated silently: if a polygon ever
 * arrives this test should be the thing that notices.
 */
console.log('\n=== Bauchi: the seat, not the LGA it sits in ===');
for (const [code, seat, lga, wards, units, drawn] of [
  ['SHA_BYE_BAUCHI_SAKWA_2026', 'Sakwa (Zaki I)', 'Zaki', 5, 100, 4],
  ['SHA_BYE_BAUCHI_DISINA_2026', 'Shira I (Disina)', 'Shira', 5, 95, 4],
]) {
  r = await open(`contest=${code}`);
  check(`${seat} counts its own ${wards} wards`, r.body, (t) => new RegExp(`${wards}\\s*WARDS`, 'i').test(t));
  check(`${seat} counts its own ${units} units`, r.body, (t) => t.includes(`~${units}`));
  check(`${seat} says only it is voting`, r.body,
    (t) => new RegExp(`one of the state constituencies in ${lga} LGA`, 'i').test(t));
  check(`${seat} no longer apologises for a shared register`, r.body,
    (t) => !/cover every seat in the LGA/i.test(t));
  // The map is labelled for the SEAT, not for the LGA its polygons came from.
  check(`${seat} labels its map for the seat`, r.body, (t) => t.includes(`${seat} — ${drawn} wards`));
  check(`${seat} draws ${drawn} regions`, r.shapes, drawn);
  // AND THE POINT OF ALL OF IT: the sibling seat's wards are gone.
  check(`${seat} draws no ward outside the constituency`, [...r.titles], (t) =>
    t.length === drawn && !t.some((w) => /Katagum|Makawa|Bursali|Maiwa|Mainako|Tashena|Shira|Tumfafi|Tsafi|Faggo|Kilbori|Bukul/i.test(w)));
}

console.log('\n=== the ballot reaches the page ===');
r = await open('contest=REP_BYE_GOMBE_2026');
for (const name of ['Yaya Alfa Muhammad', "Kallamu Usman Maijama'a", 'Gaddafi Haruna', 'Abdulkarim Abdulmajib']) {
  check(`Gombe shows ${name}`, r.body, (t) => t.includes(name));
}
check('Gombe calls them candidates', r.body, (t) => /Declared candidates/i.test(t));
check('Gombe no longer says the list is missing', r.body,
  (t) => !/has not published the candidate list/i.test(t));

r = await open('contest=SHA_BYE_KANO_DAWAKINKUDU_2026');
check('Dawakin Kudu heads the list "Parties on the ballot"', r.body,
  (t) => /Parties on the ballot/i.test(t));
check('Dawakin Kudu shows all six parties', r.body,
  (t) => ['Action Democratic Party', 'All Progressives Congress', 'Action Peoples Party',
    'Labour Party', 'Peoples Democratic Party', 'Peoples Redemption Party'].every((x) => t.includes(x)));
check('Dawakin Kudu says the names are not published', r.body,
  (t) => /Candidate name not published/i.test(t));
// CONTROL: a seat with no published ballot must still say so, or the two states
// above prove nothing.
r = await open('contest=SHA_BYE_DELTA_UDU_2026');
check('CONTROL Udu still says the list is missing', r.body,
  (t) => /has not published the candidate list/i.test(t));
check('CONTROL Udu heads no candidate list', r.body,
  (t) => !/Parties on the ballot/i.test(t));

console.log('\n=== an unknown contest builds NO page ===');
r = await open('contest=NOT_A_REAL_CONTEST', { expectMap: false });
check('and does not quietly render a different race', r.body, (t) => !/Osun/i.test(t));

console.log('\n=== control: the pages this used to fall through to still work ===');
r = await open('race=raceOsun2026');
check('the Osun page still renders', r.body, (t) => /Osun/i.test(t));
r = await open('contest=GOV&state=Bauchi');
check('a generated governorship still renders its LGAs', r.shapes, (n) => n === 20);
r = await open('contest=REP&seat=Gombe%2FKwami%2FFunakaye');
check('the 2027 general seat page still renders', r.shapes, 3);

check('no page errors anywhere', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

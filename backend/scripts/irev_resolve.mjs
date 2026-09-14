/**
 * Find the IReV election ids for our races, and record them.
 *
 *   node scripts/irev_resolve.mjs list <YYYY-MM-DD> [CODE]   # look, write nothing
 *   node scripts/irev_resolve.mjs due [--days N]             # our calendar -> ids
 *   node scripts/irev_resolve.mjs status
 *   node scripts/irev_resolve.mjs confirm <irev_id> [note]   # a human agrees
 *
 * `due` is what a timer calls. Everything it writes is UNCONFIRMED; confirming
 * is deliberately a separate act, because the expensive mistake is not a missing
 * id but a plausible wrong one.
 */
import { db, contests } from '../src/db.js';
import { resolveBase, fetchCatalogue, electionsOn, record, CODE_MAP } from '../src/services/irevResolve.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => rest.filter((x) => !x.startsWith('--'))[n];
const flag = (k, d) => {
  const i = rest.indexOf(`--${k}`);
  return i < 0 ? d : rest[i + 1];
};

const show = (rows) => {
  for (const r of rows) {
    console.log(`  ${r.irev_id}  ${String(r.code).padEnd(9)} ${r.date}  ${r.domain_type || ''}/${r.domain_name || ''}`);
    if (r.full_name) console.log(`     ${r.full_name}`);
  }
};

if (cmd === 'status') {
  const rows = db.prepare('SELECT * FROM irev_elections ORDER BY election_date DESC, code').all();
  if (!rows.length) console.log('nothing resolved yet');
  for (const r of rows) {
    console.log(`  [${r.status}] ${r.irev_id}  ${r.code}  ${r.election_date}  ${r.domain_name || ''}  base=${r.base_url}`);
  }
  process.exit(0);
}

if (cmd === 'confirm') {
  const id = arg(0);
  if (!id) { console.log('need an irev_id'); process.exit(1); }
  const r = db.prepare("UPDATE irev_elections SET status='confirmed', confirmed_at=?, note=?, updated_at=? WHERE irev_id=?")
    .run(Date.now(), arg(1) || null, Date.now(), id);
  console.log(r.changes ? `confirmed ${id}` : `no such row ${id}`);
  process.exit(r.changes ? 0 : 1);
}

const base = await resolveBase();
if (!base) { console.log('FAIL: no IReV base answered — all three are down or moved'); process.exit(1); }
console.log(`base    : ${base}`);
const catalogue = await fetchCatalogue(base);
console.log(`catalogue: ${catalogue.length} elections`);

if (cmd === 'list') {
  const date = arg(0);
  if (!date) { console.log('need a date'); process.exit(1); }
  const rows = electionsOn(catalogue, date, arg(1) || null);
  console.log(`${rows.length} on ${date}${arg(1) ? ' for ' + arg(1) : ''}:`);
  show(rows);
  process.exit(0);
}

if (cmd === 'due') {
  /* Our own calendar decides what to look for — contests.json already carries
     every polling date, so the resolver never needs its own copy to drift. */
  const days = Number(flag('days', 7));
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const due = contests.filter((c) => c.date >= today && c.date <= until);
  console.log(`${due.length} of our contests polling between ${today} and ${until}`);
  let wrote = 0;
  for (const c of due) {
    /* TIER is the type, CODE is the identity (see the contest tier model), so
       the IReV type comes from c.tier — keying on c.code matches nothing,
       because ours reads REP_BYE_GOMBE_2026 and theirs reads REPS. */
    const rows = electionsOn(catalogue, c.date, CODE_MAP[c.tier] ? c.tier : null);
    /* Same type on the same day is COMMON — five by-elections share 19 Sep — so
       the type alone does not identify a race. Narrow by the geography our own
       contest already carries, and say so when it stays ambiguous rather than
       picking one. */
    const places = [...(c.constituencies || []), ...(c.states || [])].map((x) => x.toUpperCase());
    const hit = (r) => places.some((p) => {
      const d = (r.domain_name || '').toUpperCase();
      return d && (d === p || d.includes(p) || p.includes(d));
    });
    const narrowed = places.length ? rows.filter(hit) : rows;
    const chosen = narrowed.length ? narrowed : rows;
    console.log(`\n  ${c.code} (${c.date}) tier=${c.tier} -> ${rows.length} of that type, ${narrowed.length} matching ${places.join('/') || 'anywhere'}`);
    show(chosen);
    if (places.length && narrowed.length !== 1) {
      console.log(`     ** AMBIGUOUS (${narrowed.length} matched) — recorded, but confirm by hand before use`);
    }
    wrote += record(chosen, base);
  }
  console.log(`\nrecorded ${wrote} row(s), all UNCONFIRMED. Confirm before any scan reads them.`);
  process.exit(0);
}

console.log('usage: list <date> [CODE] | due [--days N] | status | confirm <irev_id> [note]');
process.exit(1);

/**
 * NO CLIENT MAY READ AN ENVELOPE ENDPOINT AS IF IT WERE AN ARRAY.
 *
 * This bug shipped three times in one day, in three different shapes, and every
 * time it looked identical from the outside: a lookup that succeeded reported
 * "none found". No error, no empty state, nothing in the console.
 *
 *   /api/polling-units answers { radiusM, maxRows, capped, units: [...] }
 *
 *   app/profile.html          const rows = Array.isArray(r) ? r.slice(0,8) : []
 *   app/app.js                a list guard on the response body
 *   native choose-unit.tsx    (await res.json()) as Row[]
 *
 * Three shapes, one cause: the caller believed the response was the list. So
 * this test is deliberately SHAPE-BLIND. It does not look for a ternary or a
 * cast — it asks a question that no rewrite can dodge:
 *
 *   file F calls endpoint E; E wraps its list in a key;
 *   does F ever read a key off that response at all?
 *
 * A file that never names one cannot be reading the list, whatever it looks
 * like. Both directions are covered: the envelope-as-array bug, and its mirror,
 * a bare-array endpoint read as `r.units`.
 *
 * Two controls run first. An earlier version of this reported a clean bill of
 * health that was produced entirely by a broken regex — the routers are named
 * `pollingUnitsRouter`, not `router`, so it matched nothing and said nothing was
 * wrong. It now has to prove it can see the envelopes we already know about,
 * and prove it flags a file with the key taken out, before its silence counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${extra ? `\n        ${extra}` : ''}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

/* ---------------- 1. what does each endpoint answer? ---------------- */

const ROUTES = path.join(R, 'backend/src/routes');
const server = fs.readFileSync(path.join(R, 'backend/src/server.js'), 'utf8');
const mounts = {};
for (const m of server.matchAll(/app\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*([\w, ()']*?)(\w+Router)\s*\)/g)) mounts[m[3]] = m[1];
for (const m of server.matchAll(/import\s*\{?\s*(\w+Router)\s*\}?\s*from\s*['"`]\.\/routes\/(\w+)\.js['"`]/g)) {
  if (mounts[m[1]]) mounts['file:' + m[2]] = mounts[m[1]];
}

/** Balanced read of res.json's first argument, so a multi-line object literal
 *  is classified from its whole body rather than a fixed-width window. */
function firstArg(src, from) {
  let d = 0, i = from, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0) break; d--; }
    else if (c === ',' && d === 0) break;
  }
  return src.slice(from, i);
}

/* Two separate questions, and running them together is what produced this
   test's first four false alarms:
     (a) IS it an envelope? Only if some top-level key holds a LIST — that is
         the precondition for mistaking it for an array.
     (b) Did the caller READ it as one? Reading ANY top-level key proves that.
   Keying (b) off a whitelist of list-shaped NAMES flagged three files that
   read /api/observers/me's `subscriptions`, which the whitelist didn't know. */
const looksLikeList = (name, valueExpr) =>
  /^\[/.test(valueExpr)
  || /\.(all|map|filter|slice|concat)\s*\(/.test(valueExpr)
  || /^(units|rows|items|results|entries|records|list|history|feed|incidents|flags|collations|cases|discrepancies|anchors|runs|observers|subscriptions|reports|notifications)$/i.test(name);

const endpoints = [];
for (const f of fs.readdirSync(ROUTES).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
  const lines = src.split('\n');
  const prefix = mounts['file:' + f.replace(/\.js$/, '')] || '/api/?';
  const decls = [];
  lines.forEach((l, i) => {
    const m = l.match(/\b\w*[Rr]outer\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]*)['"`]/);
    if (m) decls.push({ verb: m[1].toUpperCase(), route: m[2], start: i });
  });
  decls.forEach((d, i) => {
    const body = lines.slice(d.start, i + 1 < decls.length ? decls[i + 1].start : lines.length).join('\n');
    const keys = new Set();
    let envelope = false, bare = false;
    for (const m of body.matchAll(/res\.json\(/g)) {
      const arg = firstArg(body, m.index + m[0].length).trim();
      if (!arg.startsWith('{')) {
        /* PROVABLY an array, not merely "not an object literal". `res.json(b)`
           where b is a summary object was being filed as a bare array, which
           made the mirror check below flag a caller for reading b.n — correct
           code, wrong premise. A bare variable proves nothing either way. */
        if (/^\[/.test(arg) || /\.(all|map|filter|slice|concat)\s*\(/.test(arg)) bare = true;
        continue;
      }
      let depth = 0, inStr = null, top = '';
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (inStr) { if (c === '\\') j++; else if (c === inStr) inStr = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
        if ('([{'.includes(c)) { depth++; top += ' '; continue; }
        if (')]}'.includes(c)) { depth--; continue; }
        if (depth === 0) top += c;
      }
      for (const k of top.matchAll(/(?:^|,)\s*(\w+)\s*(?::\s*([^,]*))?/g)) {
        const name = k[1];
        if (!name) continue;
        keys.add(name);
        const value = (k[2] || '').trim()
          || (body.match(new RegExp('\\b(?:const|let|var)\\s+' + name + '\\s*=\\s*([^;]{0,160})')) || [, ''])[1];
        if (looksLikeList(name, value)) envelope = true;
      }
    }
    endpoints.push({
      endpoint: ((prefix + d.route).replace(/\/$/, '') || prefix), verb: d.verb,
      file: 'backend/src/routes/' + f, line: d.start + 1, envelope, bare, keys: [...keys],
    });
  });
}

console.log('=== CONTROL: the classifier can see shapes it is known to have ===');
for (const k of ['/api/polling-units', '/api/register/search', '/api/register/units', '/api/mapping/nearby']) {
  const e = endpoints.find((x) => x.endpoint === k && x.verb === 'GET');
  control(`${k} is read as an envelope keyed on units`,
    !(e && e.envelope && e.keys.includes('units')));
}
{
  const parties = endpoints.find((x) => x.endpoint === '/api/parties');
  control('/api/parties is NOT called an envelope (it is a bare array)', !(parties && !parties.envelope));
}
if (fail) {
  console.log('\nFAIL  the classifier is broken — everything below would be a false all-clear.');
  process.exit(1);
}

/* ---------------- 2. client files ---------------- */

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'vendor', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js|mjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};
const files = [...walk(path.join(R, 'app')), ...walk(path.join(R, 'native/src'))]
  .filter((p) => !/tesseract|leaflet|opencv|\.min\./.test(p));

const norm = (e) => e.replace(/:[\w]+/g, ':p').replace(/\/$/, '');
const byEp = new Map(endpoints.map((e) => [norm(e.endpoint), e]));
const matchEp = (w0) => {
  const w = norm(w0);
  if (byEp.has(w)) return byEp.get(w);
  for (const [k, v] of byEp) {
    if (!k.includes(':p')) continue;
    if (new RegExp('^' + k.replace(/:p/g, '[^/]+').replace(/\//g, '\\/') + '$').test(w)) return v;
  }
  return null;
};

/** Does this source ever read one of the response's own keys? */
const readsAKey = (src, keys) => keys.some((k) => new RegExp('(\\.|\\[["\']|\\b)' + k + '\\b').test(src));

const pairs = [];
for (const p of files) {
  const src = fs.readFileSync(p, 'utf8');
  const hits = new Map();
  src.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/['"`](\/api\/[a-zA-Z0-9\-/_${}.]*)/g)) {
      const e = matchEp(m[1].replace(/\$\{[^}]*\}/g, ':p').replace(/\/$/, ''));
      if (e && e.envelope) hits.set(e.endpoint, { e, line: i + 1 });
    }
  });
  for (const [, { e, line }] of hits) {
    pairs.push({ file: p.replace(R + '/', ''), line, e, reads: readsAKey(src, e.keys) });
  }
}

console.log('\n=== every client file that calls an envelope endpoint ===');
const blind = pairs.filter((x) => !x.reads);
for (const b of blind) {
  console.log(`      ${b.file}:${b.line} -> ${b.e.endpoint} — never reads .${b.e.keys.join(' / .')}`);
}
check(`all ${pairs.length} file/endpoint pairs read a key off the response`,
  blind.length === 0, blind.length ? `${blind.length} read the response as if it were the list itself` : '');

/* CONTROL: strip the key out of a file that genuinely reads it, and the same
   check must flag it. Without this, "0 blind" could just mean "inert". */
{
  const real = fs.readFileSync(path.join(R, 'app/profile.html'), 'utf8');
  control('a file with its envelope key removed IS flagged',
    !(readsAKey(real, ['units']) && !readsAKey(real.replace(/\bunits\b/g, 'ZZZ'), ['units'])));
}

/* ---------------- 3. the mirror image ---------------- */

const bareOnly = endpoints.filter((e) => e.verb === 'GET' && e.bare && !e.envelope).map((e) => e.endpoint);
const ENVKEY = /\.\s*(units|items|rows|results|entries|records|list)\b/;
/* BIND THE VARIABLE, don't scan a window. Reading five lines around the fetch
   flagged `verify.entries` — a DIFFERENT endpoint's field, two lines down in the
   same Promise.all. So: name the variable the response lands in, then look for
   an envelope key on THAT name. Where no variable can be named (a destructured
   Promise.all), this stays quiet rather than guessing; the control below still
   proves it fires on the shape it does cover. */
const inverse = [];
for (const p of files) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((l, i) => {
    for (const ep of bareOnly) {
      if (!l.includes(`'${ep}`) && !l.includes(`\`${ep}`) && !l.includes(`"${ep}`)) continue;
      const bind = l.match(/(?:const|let|var)\s+([\w$]+)\s*=[^=]/);
      if (!bind) continue;
      const v = bind[1];
      const win = lines.slice(i, i + 8).join(' ').replace(/\s+/g, ' ');
      const rx = new RegExp('\\b' + v + '\\s*\\.\\s*(units|items|rows|results|entries|records|list)\\b');
      if (rx.test(win)) inverse.push({ file: p.replace(R + '/', ''), line: i + 1, ep, win: win.slice(0, 160) });
    }
  });
}
console.log('\n=== the mirror: a bare-array endpoint read as an envelope ===');
for (const x of inverse) console.log(`      ${x.file}:${x.line} -> ${x.ep}\n        ${x.win}`);
check(`no caller reads an envelope key off one of the ${bareOnly.length} bare-array endpoints`, inverse.length === 0);

/* The control has to run the REAL logic, not a simplified stand-in, or it
   proves nothing about the code above. Same bind-then-match path, on a
   synthetic file holding the bug and on one holding its correct form. */
{
  const synth = (body) => {
    const lines = [`const r = await fetch('${bareOnly[0]}').then((x) => x.json());`, body];
    const bind = lines[0].match(/(?:const|let|var)\s+([\w$]+)\s*=[^=]/);
    const rx = new RegExp('\\b' + bind[1] + '\\s*\\.\\s*(units|items|rows|results|entries|records|list)\\b');
    return rx.test(lines.join(' '));
  };
  control('it fires on a bare-array endpoint read as `r.units`', !synth('const rows = r.units || [];'));
  control('and stays quiet on the correct `r.slice(0, 8)`', synth('const rows = r.slice(0, 8);'));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

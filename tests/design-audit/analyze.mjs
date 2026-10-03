/**
 * Aggregate a surface's results.json into reviewer tables.
 *   node analyze.mjs web [--section axe|targets|clip|overflow|text|states|errors|bounce|h1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib.mjs';
const argv = process.argv.slice(2);
const surface = argv[0] || 'web';
const sec = argv.includes('--section') ? argv[argv.indexOf('--section') + 1] : 'all';
const { results } = JSON.parse(fs.readFileSync(path.join(OUT, surface, 'results.json'), 'utf8'));
const M = results.filter((r) => r.kind === 'matrix' && !r.fatal);
const want = (s) => sec === 'all' || sec === s;
const pr = (...a) => console.log(...a);

if (want('bounce')) {
  pr('\n## bounced (EN)');
  for (const r of M.filter((r) => r.bounced && r.lang === 'en')) pr(r.id, r.vp, r.theme, '->', r.finalUrl);
}
if (want('errors')) {
  pr('\n## page errors (unique)');
  const m = new Map();
  for (const r of results) for (const e of r.errors || []) { const k = e.slice(0, 120); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(r.id); }
  for (const [k, v] of m) pr(`${[...v].length} pages: ${k}  [${[...v].slice(0, 6).join(',')}]`);
  pr('\n## fatal'); for (const r of results.filter((r) => r.fatal)) pr(r.id, r.vp, r.theme, r.lang, r.fatal.slice(0, 160));
}
if (want('axe')) {
  pr('\n## axe by rule');
  const a = {};
  for (const r of M.filter((x) => x.axe)) for (const v of r.axe) {
    const k = v.id; a[k] = a[k] || { impact: v.impact, help: v.help, pages: new Set(), nodes: 0, themes: new Set(), samples: [] };
    a[k].pages.add(r.id); a[k].nodes += v.nodes; a[k].themes.add(r.theme + '@' + r.vp);
    if (a[k].samples.length < 8) a[k].samples.push(`${r.id}/${r.theme}/${r.vp}: ${v.samples.map((s) => s.target + ' :: ' + s.summary).join(' || ').slice(0, 260)}`);
  }
  for (const [k, v] of Object.entries(a).sort((x, y) => y[1].pages.size - x[1].pages.size)) {
    pr(`- ${k} (${v.impact}) ${v.pages.size} pages, ${v.nodes} nodes, ${[...v.themes].join(' ')} — ${v.help}`);
    pr('    pages:', [...v.pages].join(', '));
    for (const s of v.samples.slice(0, 5)) pr('    ', s);
  }
}
if (want('targets')) {
  pr('\n## touch targets <44 (s360 dark en), worst first');
  for (const r of M.filter((r) => r.vp === 's360' && r.theme === 'dark' && r.lang === 'en').sort((a, b) => (b.checks?.smallTargetCount || 0) - (a.checks?.smallTargetCount || 0))) {
    const c = r.checks || {};
    pr(`${r.id}: ${c.smallTargetCount}/${c.targets} (<24: ${c.under24})  ` + (c.smallTargets || []).slice(0, 6).map((t) => `"${t.label.slice(0, 22)}" ${t.w}x${t.h}`).join('; '));
  }
}
if (want('clip')) {
  pr('\n## clipped text by lang (s360+s390, dark)');
  for (const lang of ['en', 'ha', 'ig', 'yo']) {
    const rows = M.filter((r) => r.lang === lang && r.theme === 'dark' && r.vp !== 'd1366' && r.checks?.clipped?.length);
    pr(`-- ${lang}: ${new Set(rows.map((r) => r.id)).size} screens`);
    const seen = new Set();
    for (const r of rows) for (const c of r.checks.clipped) { const k = r.id + c.text; if (seen.has(k)) continue; seen.add(k); pr(`   ${r.id}@${r.vp}: "${c.text}" ${c.need}/${c.have}px  ${c.el.split('>').slice(-2).join('>')}`); }
  }
}
if (want('overflow')) {
  pr('\n## sideways overflow');
  for (const r of M.filter((r) => r.checks?.overflowX)) pr(`${r.id} ${r.vp} ${r.theme} ${r.lang} docW=${r.checks.docW} vw=${r.checks.vw} ` + (r.checks.spill || []).slice(0, 3).map((s) => `${s.el.split('>').slice(-1)}@${s.right} "${s.text}"`).join('; '));
}
if (want('text')) {
  pr('\n## text <12px (s360 dark en)');
  for (const r of M.filter((r) => r.vp === 's360' && r.theme === 'dark' && r.lang === 'en' && r.checks?.tinyText?.length)) {
    pr(`${r.id}: ${r.checks.tinyText.length}  ` + r.checks.tinyText.slice(0, 5).map((t) => `"${t.text.slice(0, 26)}" ${t.px}px`).join('; '));
  }
  pr('\n## font-size histogram (all s360 dark en)');
  const h = {};
  for (const r of M.filter((r) => r.vp === 's360' && r.theme === 'dark' && r.lang === 'en')) for (const [k, v] of Object.entries(r.checks?.fontSizes || {})) h[k] = (h[k] || 0) + v;
  pr(Object.entries(h).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}px:${v}`).join('  '));
}
if (want('h1')) {
  pr('\n## h1 per page (s360 dark en) + page length in screens');
  for (const r of M.filter((r) => r.vp === 's360' && r.theme === 'dark' && r.lang === 'en')) pr(`${r.id}: h1=${JSON.stringify(r.checks?.h1)} screens=${r.screens || 1} fixed=${(r.checks?.fixed || []).map((f) => f.el.split('>').pop() + '@' + f.top + '/' + f.h).join(',')}`);
}
if (want('states')) {
  pr('\n## states');
  for (const r of results.filter((r) => r.kind === 'state')) pr(`${r.id} ${r.state} ${r.theme}: ${r.shot}  bounced=${r.bounced} errs=${(r.errors || []).length}`);
}

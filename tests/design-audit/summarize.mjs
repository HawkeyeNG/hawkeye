/**
 * Print a compact table of a results file.
 *   node summarize.mjs out/web/results-dry.json [--lang en] [--id home] [--kind matrix|state]
 */
import fs from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const { results } = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
for (const x of results) {
  if (arg('lang') && x.lang !== arg('lang')) continue;
  if (arg('id') && x.id !== arg('id')) continue;
  if (arg('kind') && x.kind !== arg('kind')) continue;
  if (x.fatal) { console.log(x.id, x.vp, x.theme, x.lang, 'FATAL', x.fatal); continue; }
  const c = x.checks || {};
  console.log([
    x.id, x.vp, x.theme, x.lang, x.state || '', x.bounced ? 'BOUNCED->' + x.finalUrl : '', `${x.loadMs}ms`,
    c.overflowX ? 'OVERFLOW-X' : '', `clip:${(c.clipped || []).length}`, `small:${c.smallTargetCount}/${c.targets}`, `u24:${c.under24}`,
    `tiny:${(c.tinyText || []).length}`, `scr:${x.screens || 1}`,
    'fixed:' + (c.fixed || []).map((f) => f.el.split('>').pop().slice(0, 24) + '@' + f.top + '/' + f.h).join(','),
    x.axe ? 'axe:' + x.axe.map((a) => a.id + '×' + a.nodes).join(',') : '',
    x.errors.length ? 'err:' + x.errors.length : '',
  ].filter(Boolean).join('  '));
}

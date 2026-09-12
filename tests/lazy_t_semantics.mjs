/* The proxy's semantics, not its wiring: a list of objects must still map,
   spread, find and read as an array after lazyT wraps it. */
const t = (k) => 'HA:' + k;
function lazyT(entries) {
  return new Proxy(entries, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v === 'string') return v.startsWith('n.') ? t(v) : v;
      if (v !== null && typeof v === 'object') return lazyT(v);
      return v;
    },
  });
}
const F = lazyT([
  { key: 'all', label: 'n.filter.all' },
  { key: 'report', label: 'n.filter.reports' },
]);
const out = [];
out.push(['isArray', Array.isArray(F), true]);
out.push(['length', F.length, 2]);
out.push(['map label', F.map((f) => f.label).join('|'), 'HA:n.filter.all|HA:n.filter.reports']);
out.push(['map key', F.map((f) => f.key).join('|'), 'all|report']);
out.push(['find', F.find((f) => f.key === 'report').label, 'HA:n.filter.reports']);
out.push(['spread', [...F].length, 2]);
out.push(['for-of', (() => { let s = ''; for (const f of F) s += f.label + ';'; return s; })(), 'HA:n.filter.all;HA:n.filter.reports;']);
const N = lazyT({ state: { one: 'n.unit.state', many: 'states' }, plain: 'Everything' });
out.push(['nested', N.state.one, 'HA:n.unit.state']);
out.push(['nested plain', N.state.many, 'states']);
out.push(['non-key string', N.plain, 'Everything']);
out.push(['tuple', lazyT([['open', 'n.g.open', 'x']])[0][1], 'HA:n.g.open']);
let bad = 0;
for (const [name, got, want] of out) {
  if (got === want) console.log('PASS  ' + name);
  else { console.log('FAIL  ' + name + '  got ' + JSON.stringify(got) + '  want ' + JSON.stringify(want)); bad++; }
}
process.exit(bad ? 1 : 0);

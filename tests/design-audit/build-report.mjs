/**
 * Build the deliverables from the capture + the reviewer's findings:
 *   out/REPORT.md                       short summary (top 10 + PDF path)
 *   out/report.html                     the full report (source of the PDF)
 *   <pdf>                               --pdf /mnt/c/Users/HP/Downloads/Hawkeye-Design-Audit-2026-10.pdf
 *
 *   node build-report.mjs [--pdf PATH] [--findings out/findings.json]
 *
 * findings.json = { top10: [ids], items: [{ id, priority: P1|P2|P3, surfaces: [web|lite|native],
 *   screen, title, problem, change, effort: S|M|L, evidence: [{ img, caption, crop?: [x,y,w,h] }], metric? }] }
 * `img` is relative to out/. Crops are in screenshot pixels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, OUT, log } from './lib.mjs';
import { SURFACES } from './inventory.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const PDF = arg('pdf', '/mnt/c/Users/HP/Downloads/Hawkeye-Design-Audit-2026-10.pdf');
const PDF_WIN = 'C:\\Users\\HP\\Downloads\\' + path.basename(PDF);
const F = JSON.parse(fs.readFileSync(arg('findings', path.join(OUT, 'findings.json')), 'utf8'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
const LABEL = { web: 'Web', lite: 'Lite', native: 'Native' };

// ------------------------------------------------------------- metrics
const R = {};
for (const s of ['web', 'lite', 'native']) {
  const f = path.join(OUT, s, 'results.json');
  R[s] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { results: [] };
}
const LH = fs.existsSync(path.join(OUT, 'lighthouse/summary.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'lighthouse/summary.json'), 'utf8')) : null;
const SAFE = fs.existsSync(path.join(OUT, 'safety.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'safety.json'), 'utf8')) : null;

function stats(surface) {
  const rs = R[surface].results.filter((r) => !r.fatal);
  const matrix = rs.filter((r) => r.kind === 'matrix');
  const shots = rs.reduce((n, r) => n + (r.shot ? 1 : 0) + (r.extra || []).length, 0);
  const screens = [...new Set(matrix.map((r) => r.id))];
  const bounced = [...new Set(matrix.filter((r) => r.bounced && r.lang === 'en').map((r) => r.id))];
  // axe: rule -> pages
  const axe = {};
  for (const r of matrix.filter((x) => x.axe)) for (const v of r.axe) {
    const a = axe[v.id] || (axe[v.id] = { id: v.id, impact: v.impact, help: v.help, pages: new Set(), nodes: 0, themes: new Set() });
    a.pages.add(r.id); a.nodes += v.nodes; a.themes.add(r.theme);
  }
  // per screen at 360 dark EN (phone) or 1366
  const per = screens.map((id) => {
    const at = (vp, theme, lang) => matrix.find((r) => r.id === id && r.vp === vp && r.theme === theme && r.lang === lang);
    const ph = at(surface === 'web' ? 's360' : 's360', 'dark', 'en') || {};
    const c = ph.checks || {};
    const clipLangs = ['en', 'ha', 'ig', 'yo'].filter((l) => ((at('s360', 'dark', l) || {}).checks || {}).clipped?.length);
    const ovLangs = ['en', 'ha', 'ig', 'yo'].filter((l) => ((at('s360', 'dark', l) || {}).checks || {}).overflowX);
    return { id, title: ph.title || id, small: c.smallTargetCount ?? null, targets: c.targets ?? null, u24: c.under24 ?? null, tiny: (c.tinyText || []).length, screensLong: ph.screens || 1, clipLangs, ovLangs, bounced: !!ph.bounced, loadMs: ph.loadMs };
  });
  return { shots, screens, bounced, axe: Object.values(axe).map((a) => ({ ...a, pages: [...a.pages], themes: [...a.themes] })).sort((a, b) => b.pages.length - a.pages.length), per, records: rs.length };
}
const S = { web: stats('web'), lite: stats('lite'), native: stats('native') };
const totalShots = S.web.shots + S.lite.shots + S.native.shots;

// ------------------------------------------------------------- html pieces
const items = F.items;
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
const pri = (p) => `<span class="pri ${p}">${p}</span>`;
const eff = (e) => `<span class="eff">effort ${e}</span>`;
const surf = (ss) => ss.map((s) => `<span class="surf ${s}">${LABEL[s]}</span>`).join('');

const EV_W = 318, EV_GAP = 9;
function evidence(ev, small = false) {
  const list = (ev || []).filter((e) => fs.existsSync(path.join(OUT, e.img)));
  const each = Math.floor((EV_W - (list.length - 1) * EV_GAP) / Math.max(1, list.length));
  return `<div class="ev ${small ? 'small' : ''}">${(ev || []).map((e) => {
    const src = 'file://' + path.join(OUT, e.img);
    if (!fs.existsSync(path.join(OUT, e.img))) return `<figure class="missing"><div>missing: ${esc(e.img)}</div></figure>`;
    if (e.crop) {
      const [x, y, w, h] = e.crop;
      const W = Math.min(e.w || 230, each);
      const k = W / w;
      return `<figure><div class="crop" style="width:${W}px;height:${Math.round(h * k)}px"><img src="${src}" style="width:${Math.round((e.imgW || 720) * k)}px;margin-left:${-Math.round(x * k)}px;margin-top:${-Math.round(y * k)}px"></div><figcaption>${md(e.caption || '')}</figcaption></figure>`;
    }
    return `<figure><img class="full" src="${src}" style="width:${Math.min(e.w || 150, each)}px"><figcaption>${md(e.caption || '')}</figcaption></figure>`;
  }).join('')}</div>`;
}

function itemBlock(i, n) {
  return `<article class="item">
    <header><span class="num">${esc(i.id)}</span>${pri(i.priority)}${surf(i.surfaces)}<span class="scr">${esc(i.screen)}</span>${eff(i.effort)}</header>
    <h3>${md(i.title)}</h3>
    <div class="body${(i.evidence || []).length ? '' : ' noev'}">
      <div class="txt">
        <p><span class="k">Problem</span>${md(i.problem)}</p>
        <p><span class="k">Change</span>${md(i.change)}</p>
        ${i.metric ? `<p class="metric"><span class="k">Measured</span>${md(i.metric)}</p>` : ''}
      </div>
      ${evidence(i.evidence)}
    </div>
  </article>`;
}

const sections = [
  { key: 'cross', title: 'Across all three surfaces', sub: 'System-level issues: the same component looking or behaving differently, shared tokens, shared copy.', filter: (i) => i.surfaces.length > 1 },
  { key: 'web', title: 'Website', sub: 'hawkeye.com.ng in a phone browser and on a laptop.', filter: (i) => i.surfaces.length === 1 && i.surfaces[0] === 'web' },
  { key: 'lite', title: 'Hawkeye Lite', sub: 'Lite runs the website’s pages inside the app shell, so most of its issues are already listed above and marked Lite. This section covers what appears only in Lite.', filter: (i) => i.surfaces.length === 1 && i.surfaces[0] === 'lite' },
  { key: 'native', title: 'Native app', sub: 'The Expo / React Native app.', filter: (i) => i.surfaces.length === 1 && i.surfaces[0] === 'native' },
];
const order = { P1: 0, P2: 1, P3: 2 };
const counts = (f) => ({ P1: items.filter((i) => f(i) && i.priority === 'P1').length, P2: items.filter((i) => f(i) && i.priority === 'P2').length, P3: items.filter((i) => f(i) && i.priority === 'P3').length });

function sheetFor(s) { const f = path.join(OUT, `contact-${s}.png`); return fs.existsSync(f) ? 'file://' + f : null; }

const axeTable = (s) => S[s].axe.length ? `<table class="m"><tr><th>axe rule (WCAG 2.2 AA)</th><th>impact</th><th>pages</th><th>nodes</th><th>themes</th></tr>${S[s].axe.map((a) => `<tr><td><b>${esc(a.id)}</b><br><span class="mut">${esc(a.help)}</span></td><td>${esc(a.impact)}</td><td>${a.pages.length}<br><span class="mut">${esc(a.pages.slice(0, 8).join(', '))}${a.pages.length > 8 ? '…' : ''}</span></td><td>${a.nodes}</td><td>${a.themes.join(' + ')}</td></tr>`).join('')}</table>` : '<p class="mut">No axe violations recorded.</p>';
const perTable = (s) => `<table class="m tight"><tr><th>screen</th><th>targets &lt;44px</th><th>&lt;24px</th><th>text &lt;12px</th><th>screens tall</th><th>clipped text (360)</th><th>sideways scroll (360)</th></tr>${S[s].per.map((p) => `<tr${p.bounced ? ' class="bounced"' : ''}><td>${esc(p.id)}${p.bounced ? ' <span class="flag">bounced</span>' : ''}</td><td>${p.small ?? '–'} / ${p.targets ?? '–'}</td><td>${p.u24 ?? '–'}</td><td>${p.tiny}</td><td>${p.screensLong}</td><td>${p.clipLangs.join(' ') || '–'}</td><td>${p.ovLangs.join(' ') || '–'}</td></tr>`).join('')}</table>`;
const lhTable = LH ? `<table class="m"><tr><th>page</th><th>perf</th><th>a11y</th><th>best pr.</th><th>SEO</th><th>FCP</th><th>LCP</th><th>TBT</th><th>CLS</th><th>weight</th></tr>${LH.pages.map((p) => p.error ? `<tr><td>${esc(p.id)}</td><td colspan="9">${esc(p.error)}</td></tr>` : `<tr><td>${esc(p.id)}</td>${['performance', 'accessibility', 'best-practices', 'seo'].map((k) => `<td class="sc ${p.scores[k] >= 90 ? 'g' : p.scores[k] >= 50 ? 'o' : 'r'}">${p.scores[k]}</td>`).join('')}<td>${esc(p.fcp)}</td><td>${esc(p.lcp)}</td><td>${esc(p.tbt)}</td><td>${esc(p.cls)}</td><td>${esc(p.bytes)}</td></tr>`).join('')}</table><p class="mut">${esc(LH.profile)} · ${esc(LH.at)}</p>` : '<p class="mut">Lighthouse not run.</p>';

const top = F.top10.map((id) => byId[id]).filter(Boolean);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hawkeye design audit — October 2026</title><style>
@font-face { font-family: Inter; src: url('file:///home/elrio/hawkeye/app/fonts/inter-400.woff2'); font-weight: 400; }
@font-face { font-family: Inter; src: url('file:///home/elrio/hawkeye/app/fonts/inter-500.woff2'); font-weight: 500; }
@font-face { font-family: Inter; src: url('file:///home/elrio/hawkeye/app/fonts/inter-600.woff2'); font-weight: 600; }
@font-face { font-family: Inter; src: url('file:///home/elrio/hawkeye/app/fonts/inter-700.woff2'); font-weight: 700; }
:root { --ink: #0c1f16; --green: #004225; --leaf: #1f7a4a; --gold: #c99a06; --paper: #f6f3ea; --line: #d8d1bf; --mut: #5d6b62; --p1: #a12a1c; --p2: #b06d00; --p3: #3d6b52; }
@page { size: A4; margin: 16mm 15mm 16mm 15mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.6pt/1.45 Inter, system-ui, sans-serif; color: var(--ink); background: #fff; }
h1, h2 { font-family: Gloock, Georgia, serif; font-weight: 400; letter-spacing: -0.01em; }
.mono, .num, figcaption, .k, .eff, .mut small { font-family: 'Geist Mono', ui-monospace, monospace; }
code { font-family: 'Geist Mono', ui-monospace, monospace; font-size: 8.4pt; background: #efeadc; padding: 0 3px; border-radius: 2px; }
.cover { height: 263mm; display: flex; flex-direction: column; justify-content: space-between; page-break-after: always; background: var(--paper); margin: -16mm -15mm 0; padding: 26mm 22mm 18mm; border-top: 8mm solid var(--green); }
.cover .kicker { font-family: 'Geist Mono', monospace; letter-spacing: .18em; text-transform: uppercase; font-size: 8.5pt; color: var(--green); }
.cover h1 { font-size: 40pt; line-height: 1.02; margin: 8mm 0 5mm; color: var(--ink); }
.cover .lede { font-size: 12.5pt; line-height: 1.5; max-width: 140mm; color: #24372d; }
.cover .facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin-top: 10mm; }
.cover .facts div { padding: 5mm 4mm 4mm 0; }
.cover .facts b { display: block; font-family: Gloock, serif; font-weight: 400; font-size: 24pt; color: var(--green); }
.cover .facts span { font-family: 'Geist Mono', monospace; font-size: 7.5pt; letter-spacing: .06em; text-transform: uppercase; color: var(--mut); }
.cover .strip { display: flex; gap: 4mm; align-items: flex-end; margin-top: 8mm; }
.cover .strip img { width: 29mm; border: 1px solid var(--line); border-radius: 2mm; }
.cover .foot { display: flex; justify-content: space-between; font-family: 'Geist Mono', monospace; font-size: 7.5pt; color: var(--mut); }
h2 { font-size: 22pt; margin: 0 0 2mm; color: var(--green); }
h2 + .sub { color: var(--mut); margin: 0 0 6mm; font-size: 10pt; }
section { page-break-before: always; }
.top10 { counter-reset: t; list-style: none; padding: 0; margin: 0; }
.top10 li { display: grid; grid-template-columns: 9mm 1fr; gap: 2mm 3mm; padding: 2.6mm 0; border-bottom: 1px solid var(--line); page-break-inside: avoid; }
.top10 li::before { counter-increment: t; content: counter(t, decimal-leading-zero); font-family: Gloock, serif; font-size: 17pt; color: var(--green); line-height: 1; }
.top10 .t { font-weight: 600; font-size: 10.4pt; }
.top10 .meta { margin-top: 1mm; }
.top10 .chg { color: #2b3d33; margin-top: .8mm; }
.pri { display: inline-block; font: 600 7.5pt 'Geist Mono', monospace; color: #fff; padding: .4mm 1.6mm; border-radius: 1mm; margin-right: 1.5mm; vertical-align: 1px; }
.pri.P1 { background: var(--p1); } .pri.P2 { background: var(--p2); } .pri.P3 { background: var(--p3); }
.surf { display: inline-block; font: 600 7.3pt 'Geist Mono', monospace; padding: .3mm 1.5mm; border-radius: 1mm; margin-right: 1mm; border: 1px solid; vertical-align: 1px; }
.surf.web { color: #1d4f8c; border-color: #9fb9da; } .surf.lite { color: #7a4b00; border-color: #e0c48f; } .surf.native { color: #00513a; border-color: #94c7b1; }
.eff { font-size: 7.5pt; color: var(--mut); margin-left: 2mm; }
.scr { font-size: 8.5pt; color: var(--mut); margin-left: 1mm; }
.board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 6mm 0 2mm; }
.board div { border: 1px solid var(--line); border-radius: 2mm; padding: 3mm; background: var(--paper); }
.board b { font-family: Gloock, serif; font-weight: 400; font-size: 13pt; color: var(--green); display: block; margin-bottom: 1mm; }
.board span { font-family: 'Geist Mono', monospace; font-size: 8pt; margin-right: 2mm; }
.method { font-size: 8.8pt; color: #2b3d33; columns: 2; column-gap: 7mm; margin-top: 5mm; }
.method p { margin: 0 0 2mm; break-inside: avoid; }
.prihead { font: 600 8pt 'Geist Mono', monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--mut); border-bottom: 2px solid var(--ink); padding-bottom: 1mm; margin: 6mm 0 1mm; }
.item { border-bottom: 1px solid var(--line); padding: 3.4mm 0 3.6mm; page-break-inside: avoid; }
.item header { font-size: 8.5pt; }
.item .num { font-size: 8pt; color: var(--mut); margin-right: 2mm; }
.item h3 { font-size: 11pt; margin: 1.4mm 0 1.6mm; font-weight: 600; line-height: 1.3; }
.item .body { display: grid; grid-template-columns: 1fr 84mm; gap: 6mm; align-items: start; }
.item .body.noev { grid-template-columns: 1fr; }
.item .txt p { margin: 0 0 1.6mm; }
.k { display: block; font-size: 6.8pt; text-transform: uppercase; letter-spacing: .1em; color: var(--mut); margin-bottom: .4mm; }
.txt p { margin-bottom: 2.2mm !important; }
.metric { color: #3a4c42; }
.ev { display: flex; gap: 9px; flex-wrap: nowrap; width: 84mm; justify-content: flex-start; }
figure { margin: 0; }
figure img.full { display: block; border: 1px solid var(--line); border-radius: 1.5mm; }
.crop { overflow: hidden; border: 1px solid var(--line); border-radius: 1.5mm; }
.crop img { display: block; max-width: none; }
figcaption { font-size: 6.6pt; color: var(--mut); margin-top: .8mm; max-width: 60mm; line-height: 1.3; }
figure.missing div { width: 30mm; height: 40mm; border: 1px dashed var(--line); display: grid; place-items: center; font-size: 6pt; color: var(--mut); }
table.m { width: 100%; border-collapse: collapse; font-size: 7.8pt; margin: 2mm 0 5mm; page-break-inside: auto; }
table.m th { text-align: left; font: 600 7pt 'Geist Mono', monospace; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); border-bottom: 1.5px solid var(--ink); padding: 1mm 1.5mm; }
table.m td { border-bottom: 1px solid #e6e0d0; padding: 1mm 1.5mm; vertical-align: top; }
table.m tr { page-break-inside: avoid; }
table.tight td { padding: .6mm 1.5mm; }
.sc { font-weight: 700; text-align: center; } .sc.g { color: #1f7a4a; } .sc.o { color: #b06d00; } .sc.r { color: var(--p1); }
.mut { color: var(--mut); }
.flag { color: var(--p1); font: 600 7pt 'Geist Mono', monospace; }
.sheet { display: block; max-height: 238mm; max-width: 100%; width: auto; margin: 3mm auto 0; border: 1px solid var(--line); page-break-inside: avoid; }
section h4 + img.sheet { page-break-before: auto; }
h4 { font-size: 10pt; margin: 5mm 0 1mm; }
.note { background: var(--paper); border-left: 3px solid var(--gold); padding: 2.5mm 3.5mm; font-size: 8.6pt; margin: 3mm 0; }
</style></head><body>

<div class="cover">
  <div>
    <div class="kicker">Hawkeye · design audit · ${esc(new Date().toISOString().slice(0, 10))}</div>
    <h1>Three surfaces,<br>one observer,<br>a cheap phone.</h1>
    <p class="lede">${md(F.lede || '')}</p>
    <div class="facts">
      <div><b>${S.web.screens.length + S.lite.screens.length + S.native.screens.length}</b><span>screens reviewed</span></div>
      <div><b>${totalShots.toLocaleString('en')}</b><span>screenshots</span></div>
      <div><b>4</b><span>languages · EN HA IG YO</span></div>
      <div><b>${items.length}</b><span>improvements · ${counts(() => true).P1} P1</span></div>
    </div>
    <div class="strip">${(F.coverShots || []).filter((f) => fs.existsSync(path.join(OUT, f))).map((f) => `<img src="file://${path.join(OUT, f)}">`).join('')}</div>
  </div>
  <div class="foot"><span>Website · Hawkeye Lite · native app</span><span>tests/design-audit/ · read-only against production</span></div>
</div>

<section style="page-break-before: avoid">
  <h2>The ten that matter most</h2>
  <p class="sub">Ranked across all three surfaces by how much each one costs a first-time observer on a low-end phone.</p>
  <ol class="top10">${top.map((i) => `<li><div><div class="t">${md(i.title)}</div><div class="meta">${pri(i.priority)}${surf(i.surfaces)}<span class="scr">${esc(i.screen)}</span>${eff(i.effort)} <span class="mono mut" style="font-size:7pt">→ ${esc(i.id)}</span></div><div class="chg">${md(i.change)}</div></div></li>`).join('')}</ol>
  <div class="board">${sections.map((s) => { const c = counts(s.filter); return `<div><b>${esc(s.title)}</b><span>P1 ${c.P1}</span><span>P2 ${c.P2}</span><span>P3 ${c.P3}</span></div>`; }).join('')}</div>
  <div class="method">${(F.method || []).map((p) => `<p>${md(p)}</p>`).join('')}</div>
</section>

${sections.map((s) => {
  const list = items.filter(s.filter).sort((a, b) => order[a.priority] - order[b.priority]);
  if (!list.length) return '';
  return `<section><h2>${esc(s.title)}</h2><p class="sub">${esc(s.sub)}</p>
  ${['P1', 'P2', 'P3'].map((p) => { const l = list.filter((i) => i.priority === p); return l.length ? `<div class="prihead">${p} — ${{ P1: 'fix before the next Practice Day', P2: 'fix before 16 January 2027', P3: 'polish' }[p]}</div>${l.map(itemBlock).join('')}` : ''; }).join('')}
  </section>`;
}).join('')}

<section><h2>Appendix A — measured on every screen</h2>
<p class="sub">Automated checks on the rendered page (not the source), at 360×740, dark theme, unless noted. A row marked “bounced” redirected somewhere else (usually the sign-in door).</p>
${['web', 'lite', 'native'].map((s) => `<h4>${LABEL[s]} — ${S[s].screens.length} screens, ${S[s].shots.toLocaleString('en')} screenshots</h4>${perTable(s)}`).join('')}
</section>
<section><h2>Appendix B — accessibility (axe-core)</h2>
<p class="sub">axe 4 with WCAG 2.0/2.1/2.2 A and AA rules, on every web and Lite page at 390×844 and 1366×900, light and dark, English.</p>
<h4>Website</h4>${axeTable('web')}<h4>Hawkeye Lite</h4>${axeTable('lite')}
<h2 style="margin-top:8mm">Lighthouse</h2><p class="sub">Key signed-out pages on the live site.</p>${lhTable}
</section>
<section><h2>Appendix C — contact sheets & method</h2>
${['web', 'lite', 'native'].map((s) => sheetFor(s) ? `<div style="page-break-inside:avoid"><h4>${LABEL[s]} — full size: tests/design-audit/out/contact-${s}.png</h4><img class="sheet" src="${sheetFor(s)}"></div>` : '').join('')}
<div class="note">${md(F.harness || '')}</div>
${SAFE ? `<p class="mut mono" style="font-size:7.5pt">Safety log: ${SAFE.passGet} read-only GETs passed to production without credentials; ${SAFE.fixtures} answers from fixtures; ${SAFE.blockedWrites.length} writes blocked; ${SAFE.sentry} Sentry and ${SAFE.beacons} analytics calls blocked; ${SAFE.apk} APK downloads skipped.</p>` : ''}
</section>
</body></html>`;

const htmlFile = path.join(OUT, 'report.html');
fs.writeFileSync(htmlFile, html);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.goto('file://' + htmlFile, { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.pdf({ path: PDF, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font:7px Geist Mono, monospace;color:#7a857e;padding:0 15mm;display:flex;justify-content:space-between"><span>Hawkeye design audit · October 2026</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
await browser.close();
log('wrote', PDF);

// ------------------------------------------------------------- REPORT.md (short, by request: <=150 words)
const mdLines = ['# Hawkeye design audit — October 2026', '', 'Top 10 across web, Lite and native:', ''];
top.forEach((i, n) => mdLines.push(`${n + 1}. **${i.short || i.title}** (${i.priority}, ${i.surfaces.map((s) => LABEL[s]).join('/')})`));
mdLines.push('', `Full report (${items.length} items, P1/P2/P3, screenshots): \`${PDF_WIN}\``, '', 'Contact sheets: `out/contact-web.png`, `out/contact-lite.png`, `out/contact-native.png`.');
fs.writeFileSync(path.join(OUT, 'REPORT.md'), mdLines.join('\n') + '\n');
log('wrote', path.join(OUT, 'REPORT.md'), mdLines.join(' ').split(/\s+/).length, 'words');

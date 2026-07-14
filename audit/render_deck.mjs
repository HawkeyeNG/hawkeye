import { chromium } from 'playwright';
import fs from 'node:fs';
const DL = '/mnt/c/Users/HP/Downloads';
let md = fs.readFileSync(new URL('../Pitch/investor-deck.md', import.meta.url), 'utf8');
const logo = fs.readFileSync(new URL('../design/hawk-mascot.png', import.meta.url).pathname).toString('base64');

// Fill the known ⟨placeholders⟩ for a presentable PDF (source .md keeps its template brackets).
const fills = [
  [/⟨\$?250k⟩/g, '$250k'], [/⟨USD⟩/g, 'USD'], [/⟨contact⟩/g, 'security@hawkeye.com.ng'],
  [/⟨Founder name⟩/g, 'Osaretin Osagie'], [/⟨Sister's name⟩/g, 'Elizabeth Usiagu'],
  [/⟨observer-world credential⟩/g, 'TMG observer coordinator, 2023'],
  [/⟨credential⟩/g, 'application-security engineer'],
  [/⟨Advisor⟩(\*\* \(Election Integrity)/g, 'Hameed Saliu$1'],
  [/⟨Advisor⟩(\*\* \(Security)/g, 'Kingsley Anamelechi$1'],
  [/⟨Coordinator⟩/g, 'Otaru Junior Salau'],
  [/\s*⟨user\/observer[\s\S]*?growth⟩\.?/g, '.'], [/⟨N⟩/g, 'target'],
  [/⟨(1?[0-9]{2},[0-9]{3})⟩/g, '$1'],
];
for (const [re, s] of fills) md = md.replace(re, s);
const leftover = md.match(/⟨[^⟩]*⟩/g) || [];
console.log('remaining placeholders:', leftover.length ? leftover : 'NONE');

// Split into slides on "### N — Title"
const parts = md.split(/\n###\s+/).slice(1);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inl = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

function body(lines) {
  let html = '', i = 0, inList = false;
  const close = () => { if (inList) { html += '</ul>'; inList = false; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^\|(.+)\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      close(); const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      html += '<table><thead><tr>' + row(l).map((c) => `<th>${inl(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2; while (i < lines.length && /^\|(.+)\|\s*$/.test(lines[i])) { html += '<tr>' + row(lines[i]).map((c) => `<td>${inl(c)}</td>`).join('') + '</tr>'; i++; }
      html += '</tbody></table>'; continue;
    }
    let m;
    if ((m = l.match(/^[-*]\s+(.*)/))) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inl(m[1])}</li>`; }
    else if (l.trim() === '') close();
    else if ((m = l.match(/^\*(.+)\*$/))) { close(); html += `<p class="note">${inl(l)}</p>`; }
    else { close(); html += `<p>${inl(l)}</p>`; }
    i++;
  }
  close(); return html;
}

const slides = parts.map((p, idx) => {
  const nl = p.split('\n');
  const title = (nl[0].split('—')[1] || nl[0]).trim();
  const rest = nl.slice(1);
  if (idx === 0) { // title slide
    return `<section class="slide title"><img class="m" src="data:image/png;base64,${logo}"/>
      <div class="hk">HAWKEYE</div><div class="tl">Verifiable elections infrastructure</div>
      <div class="sub">The count at your polling unit — witnessed and unchangeable.</div>
      <div class="foot2">hawkeye.com.ng · seeking $250k seed</div></section>`;
  }
  return `<section class="slide"><div class="kick">${esc(title)}</div><div class="content">${body(rest)}</div>
    <div class="pg">hawkeye.com.ng · ${idx + 1}/${parts.length}</div></section>`;
});

const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: 1280px 720px; margin: 0; }
  * { margin: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #12211a; }
  .slide { width: 1280px; height: 720px; padding: 52px 72px; position: relative; page-break-after: always; overflow: hidden; background: #fff; }
  .kick { font-size: 30px; font-weight: 800; color: #00482b; letter-spacing: .5px; }
  .kick::after { content: ''; display: block; width: 68px; height: 5px; background: #6fe3a5; border-radius: 3px; margin-top: 12px; }
  .content { margin-top: 26px; font-size: 20px; line-height: 1.5; }
  .content p { margin: 0 0 12px; } .content .note { color: #566b60; font-size: 17px; }
  .content ul { margin: 6px 0 12px 22px; } .content li { margin: 6px 0; }
  .content strong { color: #00482b; }
  table { border-collapse: collapse; margin: 10px 0; font-size: 17px; width: 100%; }
  th, td { border: 1px solid #d8e2db; padding: 8px 12px; text-align: left; }
  th { background: #00482b; color: #fff; } .content th strong { color: inherit; } tr:nth-child(even) td { background: #f6f9f7; }
  .pg { position: absolute; right: 40px; bottom: 26px; font-size: 14px; color: #7a9486; font-weight: 700; }
  .slide.title { background: radial-gradient(120% 100% at 15% 20%, #0a4632, #00251a 60%); color: #fff; display: flex; flex-direction: column; justify-content: center; padding-left: 96px; }
  .slide.title .m { width: 150px; height: 150px; margin-bottom: 10px; }
  .slide.title .hk { font-size: 92px; font-weight: 800; letter-spacing: 4px; }
  .slide.title .tl { font-size: 40px; font-weight: 700; color: #6fe3a5; margin-top: 6px; }
  .slide.title .sub { font-size: 26px; color: #cfe6d9; margin-top: 16px; }
  .slide.title .foot2 { position: absolute; bottom: 48px; left: 96px; font-size: 20px; font-weight: 700; }
</style></head><body>${slides.join('')}</body></html>`;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 * (parts.length) }, deviceScaleFactor: 1 });
await p.setContent(doc, { waitUntil: 'networkidle' });
await p.pdf({ path: `${DL}/Hawkeye-Pitch-Deck-clean.pdf`, width: '1280px', height: '720px', printBackground: true });
const kb = Math.round(fs.statSync(`${DL}/Hawkeye-Pitch-Deck-clean.pdf`).size / 1024);
// visual checks: title slide + the competition-table slide
const SC = process.env.SC;
if (SC) {
  await p.screenshot({ path: `${SC}/deck_s1.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } });
  await p.screenshot({ path: `${SC}/deck_s10.png`, clip: { x: 0, y: 9 * 720, width: 1280, height: 720 } });
}
console.log('wrote Hawkeye-Pitch-Deck-clean.pdf', kb + 'KB', slides.length + ' slides');
await b.close();

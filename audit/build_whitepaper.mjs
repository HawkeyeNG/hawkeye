import { chromium } from 'playwright';
import fs from 'node:fs';
const DL = '/mnt/c/Users/HP/Downloads';
let md = fs.readFileSync(new URL('../docs/SECURITY-WHITEPAPER.md', import.meta.url), 'utf8');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const lines = md.split('\n');
let html = '', i = 0, inList = false;
const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
while (i < lines.length) {
  const l = lines[i];
  if (/^\|(.+)\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
    closeList();
    const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = row(l);
    html += '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
    i += 2;
    while (i < lines.length && /^\|(.+)\|\s*$/.test(lines[i])) {
      html += '<tr>' + row(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++;
    }
    html += '</tbody></table>'; continue;
  }
  let m;
  if (l.trim() === '---') { closeList(); html += '<hr />'; }
  else if ((m = l.match(/^(#{1,4})\s+(.*)/))) { closeList(); const n = m[1].length; html += `<h${n}>${inline(m[2])}</h${n}>`; }
  else if ((m = l.match(/^>\s?(.*)/))) { closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
  else if ((m = l.match(/^[-*]\s+(.*)/))) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(m[1])}</li>`; }
  else if (l.trim() === '') { closeList(); }
  else { closeList(); html += `<p>${inline(l)}</p>`; }
  i++;
}
closeList();

const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 16mm 16mm 14mm; }
:root { --green:#00482b; --accent:#008751; --ink:#12211a; --muted:#566b60; --line:#d8e2db; --tint:#eef4f0; }
body { font-family: Georgia,serif; color:var(--ink); font-size:10pt; line-height:1.5; }
h1,h2,h3,h4,th,code { font-family:'Helvetica Neue',Arial,sans-serif; }
h1 { color:var(--green); font-size:20pt; margin:0 0 2px; }
h1 + p em, body > p:first-of-type em { color:var(--muted); }
h2 { color:var(--green); font-size:13pt; margin:16px 0 4px; border-bottom:2px solid var(--line); padding-bottom:3px; }
h3 { font-size:11pt; margin:11px 0 3px; }
h4 { font-size:10pt; margin:9px 0 2px; }
a { color:var(--accent); text-decoration:none; }
code { background:var(--tint); padding:1px 4px; border-radius:3px; font-size:8.5pt; }
blockquote { border-left:3px solid var(--accent); background:var(--tint); margin:8px 0; padding:6px 12px; border-radius:0 5px 5px 0; }
ul { margin:5px 0; padding-left:18px; } li { margin:3px 0; }
table { width:100%; border-collapse:collapse; margin:8px 0; font-size:9pt; }
th,td { border:1px solid var(--line); padding:5px 8px; text-align:left; vertical-align:top; }
th { background:var(--green); color:#fff; }
tr:nth-child(even) td { background:#f6f9f7; }
hr { border:0; border-top:1px solid var(--line); margin:10px 0; }
h2,h3,table,blockquote { break-inside:avoid; }
</style></head><body>${html}</body></html>`;

const br = await chromium.launch();
const p = await br.newPage();
await p.setContent(doc, { waitUntil: 'networkidle' });
await p.pdf({ path: `${DL}/Hawkeye-Security-Whitepaper.pdf`, format: 'A4', printBackground: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font-size:7pt;color:#888;text-align:center;font-family:Arial">Hawkeye Security Whitepaper · hawkeye.com.ng · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
  margin: { top: '12mm', bottom: '14mm', left: '0', right: '0' } });
console.log('wrote Hawkeye-Security-Whitepaper.pdf');
await br.close();

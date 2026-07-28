// Extract the visible <main> content of the static PWA pages into structured
// JSON the native app renders. Extraction beats retyping: the copy stays
// byte-identical to the website's, and re-running this picks up edits.
import fs from 'node:fs';

const APP = '/home/elrio/hawkeye/app';
const PAGES = [
  ['how', 'How Hawkeye Works'],
  ['guide', 'Observer Guide'],
  ['faq', 'FAQ'],
  ['about', 'About & Contact'],
  ['privacy', 'Privacy & Data'],
];

const strip = (h) =>
  h
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&rarr;/g, '→')
    .replace(/&check;/g, '✓')
    .replace(/\s+/g, ' ')
    .trim();

const out = {};
for (const [slug, title] of PAGES) {
  const html = fs.readFileSync(`${APP}/${slug}.html`, 'utf8');
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '';
  const blocks = [];
  const re = /<(h1|h2|h3|p|li|summary)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(main))) {
    const tag = m[1].toLowerCase();
    const text = strip(m[2]);
    if (!text) continue;
    if (tag === 'h1') continue; // the screen header already says it
    const type = tag === 'li' ? 'bullet' : tag === 'p' ? 'text' : 'heading';
    // Merge consecutive bullets into one list block.
    const last = blocks[blocks.length - 1];
    if (type === 'bullet' && last?.type === 'list') last.items.push(text);
    else if (type === 'bullet') blocks.push({ type: 'list', items: [text] });
    else blocks.push({ type, text });
  }
  out[slug] = { title, blocks };
  console.log(slug, blocks.length, 'blocks');
}
fs.writeFileSync('/home/elrio/hawkeye/native/src/lib/pages.json', JSON.stringify(out, null, 1));

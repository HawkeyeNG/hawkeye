/**
 * Load every screen touched today and prove it actually RENDERS.
 *
 *   node check_routes.mjs --token <jwt>
 *
 * A React error boundary in this app renders "This screen hit a problem", and a
 * blank screen renders nothing at all — both look like success to a type
 * checker. tsc cannot catch a JSX restructure that throws at runtime, and a
 * cloud build is far too slow a way to find out. So: open each route, wait for
 * content, and fail loudly on an error boundary, an empty body, or a route that
 * never leaves "Bundling...".
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i > -1 ? argv[i + 1] : d;
};

const BASE = arg('base', 'http://localhost:8092');
const TOKEN = arg('token');
if (!TOKEN) {
  console.error('need --token');
  process.exit(2);
}

/** route -> a phrase that only appears once the screen has really rendered. */
const ROUTES = [
  ['/page?slug=how', 'network of independent witnesses'],
  ['/page?slug=guide', ''],
  ['/page?slug=faq', ''],
  ['/page?slug=about', ''],
  ['/page?slug=privacy', ''],
  ['/terms', 'Terms of Service'],
  ['/integrity', 'Election Integrity'],
  ['/(tabs)/results', ''],
  ['/practice', 'Which Polling Unit'],
  ['/profile', ''],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 440, height: 956 },
  isMobile: true,
  hasTouch: true,
});
await ctx.addInitScript((t) => {
  try {
    localStorage.setItem('hawkeye.auth.token', t);
    localStorage.setItem('hawkeye.auth.observer', '111');
    localStorage.removeItem('hawkeye.auth.optedOut');
  } catch {
    /* storage blocked */
  }
  console.error = () => {};
  console.warn = () => {};
}, TOKEN);

const page = await ctx.newPage();
const text = () =>
  page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const out = [];
    let n;
    while ((n = w.nextNode())) {
      const s = (n.textContent || '').trim();
      if (s) out.push(s);
    }
    return out.join(' | ');
  });

/**
 * Load once, and load AGAIN if the first attempt came back empty.
 *
 * The first route hit after a code change catches Metro mid-rebuild and can
 * return a blank body — which looked exactly like a screen that had stopped
 * rendering, and cost a false alarm. A cold bundle is slow once; a genuinely
 * broken screen is broken twice.
 */
async function load(route) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2500);
    const body = await text();
    if (body.replace(/\|/g, '').trim().length >= 40 && !/^\s*Bundling/i.test(body)) return body;
    if (attempt === 0) await page.waitForTimeout(4000);
    else return body;
  }
  return '';
}

let failures = 0;
for (const [route, needle] of ROUTES) {
  let body = '';
  try {
    body = await load(route);
  } catch (e) {
    console.log(`FAIL  ${route}  (${e.message.split('\n')[0].slice(0, 60)})`);
    failures++;
    continue;
  }

  const problems = [];
  if (/This screen hit a problem/i.test(body)) problems.push('error boundary');
  if (/^\s*Bundling/i.test(body)) problems.push('still bundling');
  if (body.replace(/\|/g, '').trim().length < 40) problems.push('renders (almost) nothing');
  if (needle && !body.includes(needle)) problems.push(`missing "${needle}"`);

  if (problems.length) {
    console.log(`FAIL  ${route}  -> ${problems.join(', ')}`);
    console.log(`      body: ${body.slice(0, 160)}`);
    failures++;
  } else {
    console.log(`ok    ${route}  ${body.slice(0, 70).replace(/\s+/g, ' ')}…`);
  }
}

await browser.close();
console.log(failures ? `\n${failures} route(s) failed` : '\nall routes rendered');
process.exit(failures ? 1 : 0);

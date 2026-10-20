/**
 * /open SHOWS SAFARI'S "OPEN IN APP" BAR (app/open/index.html).
 *
 * A link that reaches /open through a redirect (Brevo click tracking, a social
 * in-app browser) does not trigger iOS Universal Links, so the page carries an
 * apple-itunes-app meta for the NATIVE app, with this URL as app-argument.
 * The tag is written at parse time; run here with a URL holding & and a quote,
 * which must come out escaped (an attribute break would drop the banner).
 *
 *   node tests/open_app_banner_test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { APP, tally } from './helpers/harness.mjs';

const { check, finish } = tally();
const html = fs.readFileSync(`${APP}/open/index.html`, 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
const script = (head.match(/<script>(document\.write\('<meta name="apple-itunes-app"[\s\S]*?)<\/script>/) || [])[1];
check('the banner script is in <head>', !!script, true);

const native = (fs.readFileSync(`${APP}/share.js`, 'utf8').match(/ios: 'https:\/\/apps\.apple\.com\/app\/id(\d+)'/) || [])[1];
const written = [];
vm.runInContext(script || '', vm.createContext({
  document: { write: (s) => written.push(s) },
  location: { href: 'https://hawkeye.com.ng/open?to=practiceday&x="y"' },
}));
const tag = written.join('');
check('it names the NATIVE app (the id share.js uses for iOS)', tag.includes(`app-id=${native},`), true);
check('app-argument is this URL, & and " escaped', tag.includes('app-argument=https://hawkeye.com.ng/open?to=practiceday&amp;x=&quot;y&quot;"'), true);
check('CONTROL the attribute is closed exactly once (no break-out)', (tag.match(/"/g) || []).length, 4);
check('a no-script copy without the argument', /<noscript><meta name="apple-itunes-app" content="app-id=\d+" \/><\/noscript>/.test(head), true);

// /open forwards at once, so the PAGE IT FORWARDS TO must carry the bar: the
// email's "Try a practice run" ends on practice-day.html (iPhone test 20 Oct).
const pd = fs.readFileSync(`${APP}/practice-day.html`, 'utf8');
const pdHead = pd.slice(0, pd.indexOf('</head>'));
check('practice-day.html has a fixed bar for the native app, routing back to practice day',
  pdHead.includes(`<meta name="apple-itunes-app" content="app-id=${native}, app-argument=https://hawkeye.com.ng/open?to=practiceday" />`), true);
check('CONTROL /open still forwards practiceday to practice-day.html', /practiceday: '\.\.\/practice-day\.html'/.test(html), true);
const dl = fs.readFileSync(`${APP}/download.html`, 'utf8');
check('download.html (the email\'s "Get Hawkeye") has the bar for the native app',
  dl.slice(0, dl.indexOf('</head>')).includes(`<meta name="apple-itunes-app" content="app-id=${native}, app-argument=https://hawkeye.com.ng/">`), true);

finish();

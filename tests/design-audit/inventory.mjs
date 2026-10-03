/**
 * ROUTE / SCREEN INVENTORY — every user-facing page or screen on the three surfaces.
 *
 *   web    https://hawkeye.com.ng (live), app/*.html
 *   lite   the same app/ files inside the Capacitor shell (html.native-app + tab bar),
 *          emulated in Chromium the way tests/ui/capture_lite_shots.mjs does
 *   native the Expo / React Native app, rendered through its react-native-web export
 *          (tmp/e2e-native-web) — identical JSX and NativeWind classes
 *
 * OUT OF SCOPE: the admin console (admin.html), reviewer/training tools (review,
 * train*, bench, preview), social-posting/OAuth helpers (post, tiktok, meta).
 *
 * Fields
 *   id      stable key; the same id on two surfaces = the same screen (parity)
 *   area    grouping in the report
 *   auth    'out' = signed out, 'in' = signed in (fixtures.mjs observer #7)
 *   key     Lighthouse runs on it (web, signed out only)
 *   lite    false = not reachable in Lite (website-only page)
 *   actions optional extra states captured after the fold shot
 */
export const WEB = [
  // --- first contact ---------------------------------------------------------
  { id: 'landing', area: 'First contact', title: 'Landing (signed out)', path: '/', auth: 'out', key: true, lite: false, actions: ['menu'] },
  { id: 'download', area: 'First contact', title: 'Get the app', path: '/download.html', auth: 'out', key: true, lite: false },
  { id: 'signup', area: 'Sign-up & sign-in', title: 'Sign-up', path: '/observe.html?intent=observe', auth: 'out', key: true },
  { id: 'signin', area: 'Sign-up & sign-in', title: 'Sign-in', path: '/observe.html?intent=signin', auth: 'out' },
  { id: 'practice', area: 'Practice', title: 'Practice run (start)', path: '/practice.html', auth: 'out', key: true },
  { id: 'practice-day', area: 'Practice', title: 'National Practice Day', path: '/practice-day.html', auth: 'out' },
  // --- signed-in core ----------------------------------------------------------
  { id: 'home', area: 'Home & navigation', title: 'Home (signed in)', path: '/', auth: 'in', actions: ['menu', 'report-sheet'] },
  { id: 'report-result', area: 'Report', title: 'Report a result', path: '/observe.html?intent=observe', auth: 'in' },
  { id: 'report-incident', area: 'Report', title: 'Report an incident', path: '/incidents.html', auth: 'in' },
  { id: 'report-collation', area: 'Report', title: 'Report a collation result', path: '/collation.html', auth: 'in' },
  { id: 'ready', area: 'Report', title: 'Ready for election day', path: '/ready.html', auth: 'in' },
  { id: 'choose-unit', area: 'Report', title: 'Choose my polling unit', path: '/choose-unit.html', auth: 'in' },
  { id: 'map-unit', area: 'Report', title: 'Map a polling unit', path: '/map-unit.html', auth: 'in' },
  { id: 'alerts', area: 'Home & navigation', title: 'Alerts', path: '/notifications.html', auth: 'in' },
  { id: 'profile', area: 'Account', title: 'Profile', path: '/profile.html', auth: 'in' },
  { id: 'groups', area: 'Groups & rooms', title: 'My groups', path: '/my-groups.html', auth: 'in' },
  { id: 'situation-room', area: 'Groups & rooms', title: 'Situation room', path: '/situation-room.html', auth: 'in', lite: false },
  { id: 'captain', area: 'Groups & rooms', title: 'Apply as captain', path: '/captain.html', auth: 'in' },
  { id: 'reports-log', area: 'Live data', title: 'Reports log', path: '/dashboard.html', auth: 'in' },
  // --- live data -----------------------------------------------------------------
  { id: 'results', area: 'Live data', title: 'Results / leaderboard', path: '/results.html', auth: 'out', key: true },
  { id: 'races', area: 'Live data', title: 'All races', path: '/races.html', auth: 'out', key: true },
  { id: 'race-declared', area: 'Live data', title: 'Race page — declared (Osun governorship)', path: '/race.html?contest=GOV&state=Osun', auth: 'out', key: true },
  { id: 'race-upcoming', area: 'Live data', title: 'Race page — upcoming (Presidency 2027)', path: '/race.html?contest=PRES', auth: 'out' },
  { id: 'candidates', area: 'Live data', title: 'Presidency 2027', path: '/candidates.html', auth: 'out' },
  { id: 'osun', area: 'Live data', title: 'Osun 2026', path: '/osun.html', auth: 'out' },
  { id: 'political', area: 'Live data', title: 'Political data (map)', path: '/political.html', auth: 'out' },
  { id: 'coverage', area: 'Live data', title: 'Observer coverage (map)', path: '/coverage.html', auth: 'out' },
  // --- trust & verify ---------------------------------------------------------------
  { id: 'ledger', area: 'Trust & verify', title: 'Verify the ledger', path: '/ledger.html', auth: 'out' },
  { id: 'integrity', area: 'Trust & verify', title: 'Election integrity', path: '/integrity.html', auth: 'out' },
  { id: 'docket', area: 'Trust & verify', title: 'Public docket', path: '/docket.html', auth: 'out' },
  { id: 'case-missing', area: 'Trust & verify', title: 'Docket case — not found (error state)', path: '/case.html?id=1', auth: 'out' },
  { id: 'incident-reports', area: 'Trust & verify', title: 'Incident reports', path: '/incident-reports.html', auth: 'out' },
  { id: 'verify-cert', area: 'Trust & verify', title: 'Verify a certificate', path: '/verify-cert.html', auth: 'out' },
  // --- learn & about -----------------------------------------------------------------
  { id: 'how', area: 'Learn & about', title: 'How Hawkeye works', path: '/how.html', auth: 'out', key: true },
  { id: 'guide', area: 'Learn & about', title: 'Observer guide', path: '/guide.html', auth: 'out' },
  { id: 'faq', area: 'Learn & about', title: 'FAQ', path: '/faq.html', auth: 'out' },
  { id: 'about', area: 'Learn & about', title: 'About & contact', path: '/about.html', auth: 'out' },
  { id: 'support', area: 'Learn & about', title: 'Support Hawkeye', path: '/support.html', auth: 'out' },
  { id: 'stay', area: 'Learn & about', title: 'Stay for the count', path: '/stay.html', auth: 'out', lite: false },
  { id: 'captain-guide', area: 'Learn & about', title: 'Captain guide', path: '/captain-guide.html', auth: 'out' },
  { id: 'press', area: 'Learn & about', title: 'Press kit', path: '/press.html', auth: 'out', lite: false },
  { id: 'privacy', area: 'Learn & about', title: 'Privacy', path: '/privacy.html', auth: 'out' },
  { id: 'terms', area: 'Learn & about', title: 'Terms', path: '/terms.html', auth: 'out' },
  { id: 'not-found', area: 'Learn & about', title: '404', path: '/no-such-page-design-audit', auth: 'out', lite: false },
];

/* Lite: the signed-out app shell opens ONLY the auth funnel + practice
   (authgate.js); everything else is captured signed in, which is how a Lite
   user reaches it. */
const LITE_SIGNED_OUT = new Set(['signup', 'signin', 'practice', 'practice-day']);
export const LITE = WEB.filter((s) => s.lite !== false).map((s) => ({
  ...s, auth: LITE_SIGNED_OUT.has(s.id) ? 'out' : 'in', key: false,
}));

/* Native: expo-router paths in the web export. _layout.tsx bounces a signed-out
   visitor to /welcome from everything but welcome, sign-in and practice. */
export const NATIVE = [
  { id: 'welcome', area: 'First contact', title: 'Welcome', path: '/welcome', auth: 'out' },
  { id: 'signup', area: 'Sign-up & sign-in', title: 'Sign-up', path: '/sign-in?intent=signup', auth: 'out' },
  { id: 'signin', area: 'Sign-up & sign-in', title: 'Sign-in', path: '/sign-in', auth: 'out' },
  { id: 'practice', area: 'Practice', title: 'Practice run (start)', path: '/practice', auth: 'out' },
  { id: 'practice-day', area: 'Practice', title: 'National Practice Day', path: '/practice-day', auth: 'in' },
  { id: 'home', area: 'Home & navigation', title: 'Home (signed in)', path: '/', auth: 'in' },
  { id: 'more', area: 'Home & navigation', title: 'More (menu tab)', path: '/more', auth: 'in' },
  { id: 'alerts', area: 'Home & navigation', title: 'Alerts', path: '/alerts', auth: 'in' },
  { id: 'report-result', area: 'Report', title: 'Report a result', path: '/report/result', auth: 'in' },
  { id: 'report-incident', area: 'Report', title: 'Report an incident', path: '/report/incident', auth: 'in' },
  { id: 'report-collation', area: 'Report', title: 'Report a collation result', path: '/report/collation', auth: 'in' },
  { id: 'ready', area: 'Report', title: 'Ready for election day', path: '/ready', auth: 'in' },
  { id: 'choose-unit', area: 'Report', title: 'Choose my polling unit', path: '/choose-unit', auth: 'in' },
  { id: 'map-unit', area: 'Report', title: 'Map a polling unit', path: '/map-unit', auth: 'in' },
  { id: 'profile', area: 'Account', title: 'Profile', path: '/profile', auth: 'in' },
  { id: 'groups', area: 'Groups & rooms', title: 'My groups', path: '/my-groups', auth: 'in' },
  { id: 'captain', area: 'Groups & rooms', title: 'Apply as captain', path: '/captain', auth: 'in' },
  { id: 'reports-log', area: 'Live data', title: 'Reports log', path: '/reports-log', auth: 'in' },
  { id: 'results', area: 'Live data', title: 'Results / leaderboard', path: '/results', auth: 'in' },
  { id: 'races', area: 'Live data', title: 'All races', path: '/races', auth: 'in' },
  { id: 'race-declared', area: 'Live data', title: 'Race page — declared (Osun governorship)', path: '/race?contest=GOV&state=Osun', auth: 'in' },
  { id: 'race-upcoming', area: 'Live data', title: 'Race page — upcoming (Presidency 2027)', path: '/race?contest=PRES', auth: 'in' },
  { id: 'candidates', area: 'Live data', title: 'Presidency 2027', path: '/candidates', auth: 'in' },
  { id: 'osun', area: 'Live data', title: 'Osun 2026', path: '/osun', auth: 'in' },
  { id: 'political', area: 'Live data', title: 'Political data (map)', path: '/political', auth: 'in' },
  { id: 'coverage', area: 'Live data', title: 'Observer coverage', path: '/coverage', auth: 'in' },
  { id: 'map', area: 'Live data', title: 'Map', path: '/map', auth: 'in' },
  { id: 'ledger', area: 'Trust & verify', title: 'Verify the ledger', path: '/ledger', auth: 'in' },
  { id: 'integrity', area: 'Trust & verify', title: 'Election integrity', path: '/integrity', auth: 'in' },
  { id: 'docket', area: 'Trust & verify', title: 'Public docket', path: '/docket', auth: 'in' },
  { id: 'incident-reports', area: 'Trust & verify', title: 'Incident reports', path: '/incidents', auth: 'in' },
  { id: 'verify-cert', area: 'Trust & verify', title: 'Verify a certificate', path: '/verify-cert', auth: 'in' },
  { id: 'how', area: 'Learn & about', title: 'How Hawkeye works', path: '/page?slug=how', auth: 'in' },
  { id: 'guide', area: 'Learn & about', title: 'Observer guide', path: '/page?slug=guide', auth: 'in' },
  { id: 'faq', area: 'Learn & about', title: 'FAQ', path: '/page?slug=faq', auth: 'in' },
  { id: 'about', area: 'Learn & about', title: 'About & contact', path: '/page?slug=about', auth: 'in' },
  { id: 'support', area: 'Learn & about', title: 'Support Hawkeye', path: '/support', auth: 'in' },
  { id: 'privacy', area: 'Learn & about', title: 'Privacy', path: '/page?slug=privacy', auth: 'in' },
  { id: 'terms', area: 'Learn & about', title: 'Terms', path: '/terms', auth: 'in' },
  { id: 'assistant', area: 'Learn & about', title: 'Ask Hawkeye', path: '/assistant', auth: 'in' },
  { id: 'chat', area: 'Learn & about', title: 'Chat with us', path: '/chat', auth: 'in' },
];

export const SURFACES = {
  web: { screens: WEB, viewports: ['s360', 's390', 'd1366'] },
  lite: { screens: LITE, viewports: ['s360', 's390'] },
  native: { screens: NATIVE, viewports: ['s360', 's390'] },
};

/* Dry run: three screens present on all three surfaces — signed-out form, signed-in home, a data page. */
export const DRY_RUN = ['signup', 'home', 'race-declared'];

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

// Load backend/.env regardless of how the process was started (npm, Passenger,
// systemd). Real environment variables take precedence over the file.
//
// envFileStatus records WHY, because this failing is invisible: the catch below
// swallows everything, and a .env that never loads looks identical to one whose
// values simply lost to the real environment. Surfaced as booleans on
// /api/health so a misconfigured deploy is diagnosable without shell access.
const envPath = path.join(backendRoot, '.env');
export const envFileStatus = { path: envPath, loaded: false, error: null };
try {
  process.loadEnvFile(envPath);
  envFileStatus.loaded = true;
} catch (e) {
  envFileStatus.error = e?.code || e?.name || 'load_failed';
}

const DEV_DEFAULT = 'dev-only-change-me';

function num(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
}

const bool = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);
};

export const config = {
  // APP_ENV first, NODE_ENV only as a fallback.
  //
  // The shared host runs us under CloudLinux's Node.js Selector, which injects
  // its own NODE_ENV from the app's "Application mode" dropdown — that beats
  // anything .env says, so NODE_ENV here was pinned to 'development' and the
  // production guards below (real JWT_SECRET / ORACLE_SECRET / PHONE_SALT, a
  // real SMS provider) were silently switched OFF on the live server.
  //
  // Those assertions are the whole point: an election backend running on
  // jwtSecret = 'dev-only-change-me' would forge any observer session, and
  // nothing would have said so. APP_ENV lets .env assert the security posture
  // without asking the host to change how it runs the process — which is the
  // right split anyway. Express keeps reading NODE_ENV for its own behaviour;
  // that only affects view caching (unused) and its default error handler,
  // which server.js overrides precisely so nothing leaks either way.
  env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
  port: num('PORT', 8430),
  // Open a crowd-arbitration case the moment a high-severity flag lands, instead
  // of waiting for the post-election batch (openCases). Auto-on for mock/test
  // elections so arbitration is demonstrable live; off by default for the real
  // general election, where disputes are batched after polls close.
  docketAutoOpenCases: bool('DOCKET_AUTO_OPEN_CASES', false),

  dbPath: process.env.DB_PATH || path.join(backendRoot, 'storage', 'hawkeye.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(backendRoot, 'storage', 'uploads'),
  // Canonical public origin. Used where we must hand an ABSOLUTE url to someone
  // outside (social platforms fetch our media server-side, so a relative path or
  // a localhost origin silently fails their ingest).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://hawkeye.com.ng').replace(/\/+$/, ''),
  appDir: path.resolve(backendRoot, '..', 'app'),
  dataDir: path.join(backendRoot, 'src', 'data'),
  registerCsvPath:
    process.env.REGISTER_CSV_PATH ||
    path.join(backendRoot, 'storage', 'raw', 'nigeria_polling_units.csv'),
  approxCsvPath:
    process.env.APPROX_CSV_PATH ||
    path.join(backendRoot, 'storage', 'raw', 'approx_locations.csv'),

  // set this AND a matching Cloudflare Transform Rule header to lock the origin
  originAuthSecret: process.env.ORIGIN_AUTH_SECRET || '',
  jwtSecret: process.env.JWT_SECRET || DEV_DEFAULT,
  oracleSecret: process.env.ORACLE_SECRET || DEV_DEFAULT, // signs location attestations
  phoneSalt: process.env.PHONE_SALT || DEV_DEFAULT,       // phones stored as HMAC only

  // OTP delivery: 'console' (dev — logs the code), 'termii' (SMS), or
  // 'telegram' (free Bot API; observers link once via contact-share).
  smsProvider: process.env.SMS_PROVIDER || 'console',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  // command-bot experiments run on a separate test bot until promoted
  telegramTestBotToken: process.env.TELEGRAM_TEST_BOT_TOKEN || '',
  // Master phone (owner): receives a Telegram ping for EVERY site activity
  // (verification/report/mapping/subscription). Must link its Telegram once,
  // like any observer, for the bot to reach it. Empty = disabled.
  masterPhone: process.env.MASTER_PHONE || '',
  // Guards the one-off test-data reset endpoint. Empty = endpoint disabled.
  adminResetSecret: process.env.ADMIN_RESET_SECRET || '',
  // Passphrase for the owner-only review/publish console (review.html). Empty =
  // console API disabled (returns 403).
  adminConsoleSecret: process.env.ADMIN_CONSOLE_SECRET || '',
  // FCM (Android push) service-account credentials. All three unset = push
  // disabled (send is a silent no-op; the app still works). PRIVATE_KEY keeps
  // its literal \n escapes in .env; push.js unescapes them.
  // TikTok Content Posting API (post Hawkeye's own videos). Credential-gated:
  // the routes no-op until a client key/secret from the TikTok developer app are
  // set. Redirect URI must exactly match the one registered in the TikTok portal.
  tiktokClientKey: process.env.TIKTOK_CLIENT_KEY || '',
  tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
  tiktokRedirectUri: process.env.TIKTOK_REDIRECT_URI || 'https://hawkeye.com.ng/api/tiktok/callback',
  // Meta Graph API — post Hawkeye's own content to its Facebook Page + Instagram
  // Business account. Credential-gated: no-op until a Page token is set. The Page
  // token (derived from a long-lived user token) is effectively non-expiring.
  metaAppId: process.env.META_APP_ID || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaPageId: process.env.META_PAGE_ID || '',
  metaPageToken: process.env.META_PAGE_TOKEN || '',
  metaIgUserId: process.env.META_IG_USER_ID || '',
  metaGraphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
  // X (Twitter) — post to Hawkeye's own account via OAuth 1.0a user context. The
  // four creds come from the X developer portal (your own account's Access Token
  // & Secret + the app's API Key/Secret) — no interactive OAuth. Free tier is $0.
  xApiKey: process.env.X_API_KEY || '',
  xApiSecret: process.env.X_API_SECRET || '',
  xAccessToken: process.env.X_ACCESS_TOKEN || '',
  xAccessSecret: process.env.X_ACCESS_SECRET || '',
  fcmProjectId: process.env.FCM_PROJECT_ID || '',
  fcmClientEmail: process.env.FCM_CLIENT_EMAIL || '',
  fcmPrivateKey: process.env.FCM_PRIVATE_KEY || '',
  // Web Push (VAPID) — browser + installed-PWA notifications. Both keys unset =
  // web push is a silent no-op, exactly like FCM above. The public key is served
  // to the browser (safe); the private key never leaves the server. Subject is a
  // mailto:/https: contact required by the Web Push spec.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:info@hawkeye.com.ng',
  // IReV cross-check: the IReV _id of the election being monitored (from
  // GET /api/v1/elections on the IReV API) and which of our contests it maps to.
  // Empty election id = feature idle. Set both when INEC opens the election.
  irevElectionId: process.env.IREV_ELECTION_ID || '',
  irevContest: process.env.IREV_CONTEST || 'PRES',
  termiiApiKey: process.env.TERMII_API_KEY || '',
  // Natural-language results assistant. Two provider paths — set ONE:
  //   ANTHROPIC_API_KEY                  -> Claude (paid, strongest)
  //   ASSISTANT_API_KEY [+ _API_BASE]    -> any OpenAI-compatible provider; default
  //     base is Google Gemini's free tier (also Groq/Mistral/OpenRouter by base URL).
  // Feature is off until a key is set.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  assistantApiKey: process.env.ASSISTANT_API_KEY || '',
  assistantApiBase: process.env.ASSISTANT_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai',
  assistantModel: process.env.ASSISTANT_MODEL
    || (process.env.ANTHROPIC_API_KEY ? 'claude-haiku-4-5-20251001' : 'gemini-2.5-flash-lite'),
  // EC8A vision check (reads counts + judges authenticity). Best-effort, uses the
  // free vision provider. Sample fraction of submissions to stay in free quota at
  // election scale — 1 = every sheet, 0 = off.
  visionSampleRate: num('VISION_SAMPLE_RATE', 1),
  // Dedicated vision provider (OpenAI-compatible). Set these to point EC8A vision
  // at a self-hosted VLM (e.g. Qwen2.5-VL via Ollama/vLLM); if unset, vision falls
  // back to the Gemini provider. Lets on-prem replace the hosted model with no code.
  visionApiKey: process.env.VISION_API_KEY || '',
  visionApiBase: process.env.VISION_API_BASE || '',
  visionModel: process.env.VISION_MODEL || 'qwen2.5-vl',
  termiiSenderId: process.env.TERMII_SENDER_ID || 'N-Alert',
  termiiChannel: process.env.TERMII_CHANNEL || 'dnd',
  termiiBaseUrl: process.env.TERMII_BASE_URL || 'https://api.ng.termii.com',
  // BulkSMSNigeria (bulksmsnigeria.com) — SMS OTP provider. Preferred over
  // Termii when both are configured. Gateway 'otp' is their OTP route (reaches
  // DND-listed numbers, which most Nigerian SIMs are).
  bulksmsNgApiToken: process.env.BULKSMS_NG_API_TOKEN || '',
  bulksmsNgSenderId: process.env.BULKSMS_NG_SENDER_ID || 'Hawkeye',
  bulksmsNgGateway: process.env.BULKSMS_NG_GATEWAY || 'otp',
  // Sendchamp — WhatsApp OTP channel via their Verification API (they generate
  // and deliver the code through a Meta-approved template; we confirm against
  // their reference). Empty key = WhatsApp option simply doesn't function.
  sendchampApiKey: process.env.SENDCHAMP_API_KEY || '',
  sendchampSender: process.env.SENDCHAMP_SENDER || 'Sendchamp',
  // Which SMS provider leads the OTP chain: 'sendchamp' | 'bulksms'. Nigerian
  // sender-ID approval is per-provider and asynchronous — point this at
  // whichever provider currently has an APPROVED sender, no code change needed.
  smsPrimary: process.env.SMS_PRIMARY || 'sendchamp',
  // MASTER SWITCH for the SMS OTP channel. OFF by default: Nigerian carriers
  // silently drop SMS from unapproved sender IDs, and sender-ID approval is a
  // multi-week queue (Sendchamp quoted up to 3 weeks; BulkSMS force-routes every
  // request through its 'direct-refund' gateway and never delivered in live
  // tests). Until a sender is APPROVED, OTP is WhatsApp + Telegram only — most
  // Nigerian users have WhatsApp. Flip to SMS_OTP_ENABLED=true (plus the right
  // SMS_PRIMARY) the day approval lands; no code change, no redeploy of app/.
  smsOtpEnabled: (process.env.SMS_OTP_ENABLED || '').toLowerCase() === 'true',

  // TWO DIFFERENT RADII, DELIBERATELY INDEPENDENT — do not collapse them back
  // into one value, however similar they look sitting next to each other.
  //
  // discoveryRadiusM answers "HELP ME FIND MY UNIT": how far /api/polling-units
  // looks when it lists candidate units for the picker. Set too tight and an
  // observer standing at the gate of their own polling unit is told there is
  // nothing nearby, and falls back to hand-browsing a 176,846-row register.
  // Nothing is asserted by listing a unit, so this number is safe to widen.
  //
  // geofenceRadiusM answers "PROVE YOU WERE THERE": how close a device fix must
  // be to a unit's verified coordinates before routes/submissions.js books the
  // report as location-verified. It is the evidentiary standard behind every
  // result in the ledger, and widening it retroactively weakens what the badge
  // on all of them means.
  //
  // The two pulled in opposite directions while they shared one value: raising
  // discovery to a usable radius silently widened the proof radius on every real
  // election report. Hence the split. A unit found at 480 m and filed from 400 m
  // is correctly listed here and correctly refused by the fence — that is the
  // system working, not an inconsistency to tune away.
  discoveryRadiusM: num('DISCOVERY_RADIUS_M', 500),
  // Row cap on that discovery list — see routes/pollingUnits.js for the register
  // density this was measured against. Env-tunable for the same reason the rest
  // of this file is: a dense-ward surprise on election day should be a config
  // change, not a deploy.
  discoveryMaxRows: num('DISCOVERY_MAX_ROWS', 40),

  geofenceRadiusM: num('GEOFENCE_RADIUS_M', 200),
  maxGpsAccuracyM: num('MAX_GPS_ACCURACY_M', 100),
  // Tier-2 location trust: a non-geocoded unit earns 'provisional' location status
  // once >= minLocationReports independent observers report from within
  // clusterRadiusM of their common median point.
  clusterRadiusM: num('CLUSTER_RADIUS_M', 150),
  minLocationReports: num('MIN_LOCATION_REPORTS', 3),
  mapMinReports: num('MAP_MIN_REPORTS', 3), // fixes needed to promote a crowd coordinate
  // Pre-election mapping tolerance is WIDER than election-day clustering: nobody
  // knows exactly where inside a large estate/compound the booth will stand, so
  // fixes taken around the general area should still agree.
  mapClusterRadiusM: num('MAP_CLUSTER_RADIUS_M', 500),
  // When a unit has NO GRID3 envelope of its own, a mapping fix is still bounded
  // by the WARD's location (the centroid of sibling units that do have one), so a
  // unit can't be mapped from the wrong state. Generous — wards can be large, and
  // this only needs to catch gross errors (e.g. mapping an Osun unit from Abuja).
  wardFallbackRadiusM: num('WARD_FALLBACK_RADIUS_M', 15000),
  // Election-day geofence for crowd-mapped units mirrors that uncertainty — the
  // booth may sit anywhere inside the mapped area, not within 200 m of its median.
  crowdGeofenceRadiusM: num('CROWD_GEOFENCE_RADIUS_M', 750),
  // Anti-sybil: minimum time between result submissions from one device fingerprint.
  minDeviceSubmitSpacingMs: num('MIN_DEVICE_SUBMIT_SPACING_MS', 180000),
  // Venue-photo scene matching (ORB): a pair of venue photos is 'confirmed' as the
  // same physical place when >= sceneMinInliers matched keypoints agree on one
  // RANSAC homography after a Lowe ratio test.
  // Each photo carries its own capture-time GPS fix, signed into the payload.
  // All three fixes (sheet, venue, submission) must agree within this distance —
  // kills "photograph here, submit from there" within the freshness window.
  photoGpsCoherenceM: num('PHOTO_GPS_COHERENCE_M', 750),
  orbFeatures: num('ORB_FEATURES', 500),
  sceneRatio: Number(process.env.SCENE_RATIO || 0.75),
  sceneMinGoodMatches: num('SCENE_MIN_GOOD_MATCHES', 15),
  sceneMinInliers: num('SCENE_MIN_INLIERS', 15),
  // ...and when that share of the good matches are inliers — repetitive structures
  // (windows, blocks, rows of rectangles) can cough up a few coincidental inliers,
  // but only a real same-scene pair aligns most of its matches on one homography.
  sceneInlierShare: Number(process.env.SCENE_INLIER_SHARE || 0.5),
  photoMaxAgeS: num('PHOTO_MAX_AGE_S', 600),
  dhashHammingThreshold: num('DHASH_HAMMING_THRESHOLD', 4),
  minReportsForVerified: num('MIN_REPORTS_FOR_VERIFIED', 3),
  minConfidenceForVerified: num('MIN_CONFIDENCE_FOR_VERIFIED', 66),
  otpTtlS: num('OTP_TTL_S', 600),
};

if (config.env === 'production') {
  const secrets = {
    JWT_SECRET: config.jwtSecret,
    ORACLE_SECRET: config.oracleSecret,
    PHONE_SALT: config.phoneSalt,
  };
  for (const [name, value] of Object.entries(secrets)) {
    if (value === DEV_DEFAULT) throw new Error(`${name} must be set in production`);
  }
  if (config.smsProvider === 'console') {
    throw new Error('SMS_PROVIDER=console is dev-only — configure a real provider (termii) in production');
  }
  if (config.smsProvider === 'termii' && !config.termiiApiKey) {
    throw new Error('TERMII_API_KEY must be set when SMS_PROVIDER=termii');
  }
  if (config.smsProvider === 'bulksms' && !config.bulksmsNgApiToken) {
    throw new Error('BULKSMS_NG_API_TOKEN must be set when SMS_PROVIDER=bulksms');
  }
  if (config.smsProvider === 'telegram' && !config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set when SMS_PROVIDER=telegram');
  }
}

// Shared secret Telegram echoes back on webhook calls (X-Telegram-Bot-Api-Secret-Token).
config.telegramWebhookSecret = config.telegramBotToken
  ? crypto.createHmac('sha256', config.oracleSecret).update(config.telegramBotToken).digest('hex').slice(0, 32)
  : '';
// Test-bot secret is derived from the token ALONE (not oracleSecret) so the
// local setup script can compute the same value the server expects.
config.telegramTestWebhookSecret = config.telegramTestBotToken
  ? crypto.createHmac('sha256', 'hawkeye-tg-test').update(config.telegramTestBotToken).digest('hex').slice(0, 32)
  : '';

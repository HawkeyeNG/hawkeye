import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

// Load backend/.env regardless of how the process was started (npm, Passenger,
// systemd). Real environment variables take precedence over the file.
try {
  process.loadEnvFile(path.join(backendRoot, '.env'));
} catch {
  /* no .env — dev defaults apply */
}

const DEV_DEFAULT = 'dev-only-change-me';

function num(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num('PORT', 8430),

  dbPath: process.env.DB_PATH || path.join(backendRoot, 'storage', 'hawkeye.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(backendRoot, 'storage', 'uploads'),
  appDir: path.resolve(backendRoot, '..', 'app'),
  dataDir: path.join(backendRoot, 'src', 'data'),
  registerCsvPath:
    process.env.REGISTER_CSV_PATH ||
    path.join(backendRoot, 'storage', 'raw', 'nigeria_polling_units.csv'),
  approxCsvPath:
    process.env.APPROX_CSV_PATH ||
    path.join(backendRoot, 'storage', 'raw', 'approx_locations.csv'),

  jwtSecret: process.env.JWT_SECRET || DEV_DEFAULT,
  oracleSecret: process.env.ORACLE_SECRET || DEV_DEFAULT, // signs location attestations
  phoneSalt: process.env.PHONE_SALT || DEV_DEFAULT,       // phones stored as HMAC only

  // OTP delivery: 'console' (dev — logs the code), 'termii' (SMS), or
  // 'telegram' (free Bot API; observers link once via contact-share).
  smsProvider: process.env.SMS_PROVIDER || 'console',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  // Master phone (owner): receives a Telegram ping for EVERY site activity
  // (verification/report/mapping/subscription). Must link its Telegram once,
  // like any observer, for the bot to reach it. Empty = disabled.
  masterPhone: process.env.MASTER_PHONE || '',
  // Guards the one-off test-data reset endpoint. Empty = endpoint disabled.
  adminResetSecret: process.env.ADMIN_RESET_SECRET || '',
  // Passphrase for the owner-only review/publish console (review.html). Empty =
  // console API disabled (returns 403).
  adminConsoleSecret: process.env.ADMIN_CONSOLE_SECRET || '',
  // IReV cross-check: the IReV _id of the election being monitored (from
  // GET /api/v1/elections on the IReV API) and which of our contests it maps to.
  // Empty election id = feature idle. Set both when INEC opens the election.
  irevElectionId: process.env.IREV_ELECTION_ID || '',
  irevContest: process.env.IREV_CONTEST || 'PRES',
  termiiApiKey: process.env.TERMII_API_KEY || '',
  termiiSenderId: process.env.TERMII_SENDER_ID || 'N-Alert',
  termiiChannel: process.env.TERMII_CHANNEL || 'dnd',
  termiiBaseUrl: process.env.TERMII_BASE_URL || 'https://api.ng.termii.com',

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
  if (config.smsProvider === 'telegram' && !config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN must be set when SMS_PROVIDER=telegram');
  }
}

// Shared secret Telegram echoes back on webhook calls (X-Telegram-Bot-Api-Secret-Token).
config.telegramWebhookSecret = config.telegramBotToken
  ? crypto.createHmac('sha256', config.oracleSecret).update(config.telegramBotToken).digest('hex').slice(0, 32)
  : '';

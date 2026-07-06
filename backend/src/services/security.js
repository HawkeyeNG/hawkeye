// Security middleware, dependency-free (shared host: fewer deps = smaller attack
// surface and no native-build risk). Two pieces:
//   securityHeaders — helmet-equivalent header set + CSP tuned to this app
//   makeLimiter     — fixed-window per-IP rate limiter for abuse-prone endpoints

// CSP notes: pages use inline <script>/<style> (static files, no templating — so
// 'unsafe-inline', not nonces). Leaflet is self-hosted; OSM tiles are images;
// opencv.js WASM needs 'wasm-unsafe-eval'. telegram.org hosts the Mini App SDK,
// and Telegram Web (web.telegram.org) embeds the site in an iframe — so
// frame-ancestors allows exactly that origin (no X-Frame-Options: it can't
// express an allow-list and would override this).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://unpkg.com https://telegram.org",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: blob: https://*.openstreetmap.org https://tile.openstreetmap.org",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://web.telegram.org",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The PWA itself needs camera + GPS (same origin); everything else off.
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
}

// Fixed-window in-memory limiter. Adequate for a single-process host; swap for a
// Redis store if the app ever runs multi-instance.
export function makeLimiter({ windowMs, max, name }) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(req.ip, h); }
    h.count++;
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.resetAt - now) / 1000));
      return res.status(429).json({ error: 'rate_limited', scope: name, retryAfterS: Math.ceil((h.resetAt - now) / 1000) });
    }
    next();
  };
}

import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { locationCluster, haversineM } from '../services/geo.js';
import { requireObserver } from './observers.js';
import { tgSendMessage } from '../services/sms.js';
import { notifyMaster } from '../services/notify.js';

export const mappingRouter = Router();

// Telegram ping (best-effort, never blocks the request).
function notifyObservers(observerIds, text) {
  const q = db.prepare(
    'SELECT tl.chat_id FROM telegram_links tl JOIN observers o ON o.phone_hash = tl.phone_hash WHERE o.id = ?',
  );
  for (const id of new Set(observerIds)) {
    const link = q.get(id);
    if (link) tgSendMessage(link.chat_id, text).catch(() => {});
  }
}

// Record one GPS fix for a polling unit (observer physically present, pre-election).
// Resubmitting REPLACES the observer's earlier fix (booth spots are uncertain until
// election day, so corrections must stay possible). When >= mapMinReports observer
// fixes cluster within mapClusterRadiusM, the median becomes the unit's crowd
// coordinate — never overwrites an official/sample fix.
mappingRouter.post('/mappings', requireObserver, (req, res) => {
  const puCode = String(req.body?.puCode || '');
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = Number(req.body?.accuracy);
  const pu = db.prepare('SELECT pu_code, coords_source, approx_lat, approx_lng, approx_radius_m FROM polling_units WHERE pu_code = ?').get(puCode);
  if (!pu) return res.status(404).json({ error: 'unknown_polling_unit' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'gps_required' });
  if (!Number.isFinite(accuracy) || accuracy > config.maxGpsAccuracyM) {
    return res.status(400).json({ error: 'gps_accuracy_too_low', maxAccuracyM: config.maxGpsAccuracyM });
  }
  // Reject fixes implausibly far from where the unit can be (its GRID3 envelope) —
  // stops mapping a unit from the wrong location. No envelope = accept (unknown).
  if (pu.approx_lat != null && haversineM(lat, lng, pu.approx_lat, pu.approx_lng) > pu.approx_radius_m * 1.5 + 2000) {
    return res.status(403).json({ error: 'too_far_from_unit' });
  }
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64) || null;
  const replaced = !!db.prepare('SELECT 1 FROM pu_mappings WHERE pu_code = ? AND observer_id = ?').get(puCode, req.observer.id);
  db.prepare(`
    INSERT INTO pu_mappings (pu_code, observer_id, lat, lng, accuracy, device_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (pu_code, observer_id) DO UPDATE SET
      lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
      device_id = excluded.device_id, created_at = excluded.created_at`)
    .run(puCode, req.observer.id, lat, lng, accuracy, deviceId, Date.now());

  const fixes = db.prepare('SELECT observer_id, lat, lng FROM pu_mappings WHERE pu_code = ?').all(puCode);
  const c = locationCluster(fixes, config.mapClusterRadiusM);
  let mapped = false;
  // promote only if not already officially/sample verified
  if (c.inCluster >= config.mapMinReports && c.share >= 2 / 3 && (pu.coords_source == null || pu.coords_source === 'crowd_mapped' || pu.coords_source === 'geocoded')) {
    db.prepare("UPDATE polling_units SET lat = ?, lng = ?, coords_source = 'crowd_mapped' WHERE pu_code = ?")
      .run(c.centerLat, c.centerLng, puCode);
    mapped = true;
  }

  const unitName = db.prepare('SELECT name FROM polling_units WHERE pu_code = ?').get(puCode)?.name || puCode;
  if (mapped) {
    notifyObservers(fixes.map((f) => f.observer_id),
      `✅ Hawkeye: ${unitName} (${puCode}) is now crowd-confirmed — ${fixes.length} observer fixes agreed. Thank you for mapping it.`);
  } else {
    notifyObservers([req.observer.id],
      `📍 Hawkeye: your ${replaced ? 'updated ' : ''}fix for ${unitName} (${puCode}) is recorded — ${fixes.length} of ${config.mapMinReports} observers needed to confirm.`);
  }
  notifyMaster(`mapping · observer #${req.observer.id} · ${unitName} (${puCode})${mapped ? ' → CONFIRMED' : ` [${fixes.length}/${config.mapMinReports}]`}`);
  res.status(201).json({ ok: true, fixes: fixes.length, needed: config.mapMinReports, mapped, replaced });
});

// Units around a point, for the mapping page's Leaflet view. Returns anything
// with SOME notion of position: confirmed coords (verified/crowd) or a GRID3
// approx envelope. Units with neither can't be drawn — they're found via the
// register browser instead.
mappingRouter.get('/mapping/nearby', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'gps_required' });
  const radiusM = Math.min(Number(req.query.radiusM) || 5000, 20000);
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  const rows = db.prepare(`
    SELECT pu_code, name, ward, lga, state, lat, lng, coords_source, approx_lat, approx_lng, approx_radius_m
    FROM polling_units
    WHERE (lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?)
       OR (lat IS NULL AND approx_lat BETWEEN ? AND ? AND approx_lng BETWEEN ? AND ?)
    LIMIT 400`).all(
    lat - dLat, lat + dLat, lng - dLng, lng + dLng,
    lat - dLat, lat + dLat, lng - dLng, lng + dLng,
  );
  const fixCounts = Object.fromEntries(
    db.prepare('SELECT pu_code, COUNT(*) AS c FROM pu_mappings GROUP BY pu_code').all().map((r) => [r.pu_code, r.c]),
  );
  const units = rows
    .map((u) => {
      const uLat = u.lat ?? u.approx_lat;
      const uLng = u.lng ?? u.approx_lng;
      const d = haversineM(lat, lng, uLat, uLng);
      return {
        puCode: u.pu_code,
        name: u.name,
        ward: u.ward,
        lat: uLat,
        lng: uLng,
        distanceM: Math.round(d),
        // mapped: confirmed coordinate; approx: envelope only — needs mapping
        status: u.lat != null ? (u.coords_source === 'crowd_mapped' ? 'crowd' : 'verified') : 'approx',
        approxRadiusM: u.lat == null ? u.approx_radius_m : null,
        fixes: fixCounts[u.pu_code] || 0,
      };
    })
    .filter((u) => u.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, 200);
  res.json({ units });
});

mappingRouter.get('/mapping/stats', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;
  const verified = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NOT NULL').get().c;
  const crowd = db.prepare("SELECT COUNT(*) AS c FROM polling_units WHERE coords_source = 'crowd_mapped'").get().c;
  const inProgress = db.prepare('SELECT COUNT(DISTINCT pu_code) AS c FROM pu_mappings').get().c;
  res.json({ total, verified, crowdMapped: crowd, unitsWithFixes: inProgress });
});

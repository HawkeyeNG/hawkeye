/**
 * AUDIT INEC AGAINST INEC'S OWN SHEETS.
 *
 * services/irev.js already cross-checks IReV, but only for units where a crowd
 * observer filed something — so with 12 organic observers across Osun's 3,763
 * units it had almost nothing to compare. This does not need observers at all:
 * INEC publishes a photograph of every EC8A, and every EC8A carries its own
 * arithmetic. Their sheets against their own declared total is a check anyone
 * can run, on any election, with no one standing at a polling unit.
 *
 * Four phases, each resumable, because this is ~3,763 sheets at ~3.9 MB and a
 * run WILL be interrupted:
 *
 *   discover  walk 30 LGAs -> 332 wards -> every PU + its document URL
 *   fetch     download each sheet, hash the ORIGINAL bytes, store a derivative
 *   ocr       read the figures (separate script — see audit_ocr.mjs)
 *   report    tally, and say plainly what could not be read
 *
 * PROVENANCE IS THE POINT. The sha256 recorded is of the bytes INEC served,
 * before any resizing of ours — that hash is what makes the archive evidence
 * rather than a claim. The compressed copy exists only so OCR has something
 * cheap to chew on; it is never the artefact of record.
 *
 * Everything lands in its own database (storage/audit-<slug>.db). The
 * production DB is not touched: an audit that could corrupt the live ledger
 * would be a worse risk than the one it exists to catch.
 *
 *   node scripts/audit_irev.mjs discover
 *   node scripts/audit_irev.mjs fetch [--limit N] [--concurrency N]
 *   node scripts/audit_irev.mjs status
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── What is being audited ────────────────────────────────────────────────────
// Osun 2026 by default; every id here comes from IReV's own catalogue
// (GET /elections), so pointing this at another election is three values.
const ELECTION = {
  slug: process.env.AUDIT_SLUG || 'osun2026',
  id: process.env.AUDIT_ELECTION_ID || '6a7f788adcbc755a763f082a',
  stateId: Number(process.env.AUDIT_STATE_ID || 30),
  label: process.env.AUDIT_LABEL || 'Governorship election - 2026-08-15 - OSUN',
};

const BASE = 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1';
const UA = { 'user-agent': 'Mozilla/5.0' };
const DB_PATH = path.join(ROOT, 'storage', `audit-${ELECTION.slug}.db`);
const IMG_DIR = path.join(ROOT, 'storage', `audit-${ELECTION.slug}`, 'sheets');

// Derivative size. 1500px/q76 is the point already calibrated on real 2026 EC8A
// photos — small enough to be practical at this volume, still OCR-legible.
const IMG_WIDTH = 1500;
const IMG_QUALITY = 76;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS units (
    pu_code       TEXT PRIMARY KEY,
    pu_name       TEXT,
    ward          TEXT, ward_id TEXT,
    lga           TEXT, lga_id  TEXT,
    doc_url       TEXT,
    is_zero_pu    INTEGER,
    discovered_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sheets (
    pu_code    TEXT PRIMARY KEY,
    url        TEXT,
    http       INTEGER,
    raw_bytes  INTEGER,
    raw_sha256 TEXT,          -- of INEC'S OWN BYTES. The evidential hash.
    img_w      INTEGER, img_h INTEGER,
    taken_at   TEXT,          -- EXIF capture time: when the sheet was photographed
    camera     TEXT,
    file       TEXT,          -- our compressed derivative, relative to IMG_DIR
    comp_bytes INTEGER,
    fetched_at INTEGER,
    error      TEXT
  );
  CREATE TABLE IF NOT EXISTS wards_done (ward_id TEXT PRIMARY KEY, units INTEGER, done_at INTEGER);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE INDEX IF NOT EXISTS units_lga ON units(lga);
`);
const setMeta = db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
setMeta.run('election_id', ELECTION.id);
setMeta.run('election_label', ELECTION.label);
setMeta.run('state_id', String(ELECTION.stateId));

/** GET JSON, tolerating this host's habit of answering HTML at HTTP 200. */
async function getJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      const t = await r.text();
      if (r.ok && t.trimStart().startsWith('{')) return JSON.parse(t);
    } catch { /* fall through to the backoff */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

// ── discover ─────────────────────────────────────────────────────────────────
async function discover() {
  console.log(`[discover] ${ELECTION.label}`);
  const lgas = (await getJson(`${BASE}/elections/${ELECTION.id}/lga/state/${ELECTION.stateId}`))?.data;
  if (!lgas) { console.error('[discover] could not read the LGA list'); process.exit(1); }

  const wards = [];
  for (const lga of lgas) for (const w of lga.wards || []) wards.push({ lga, ward: w });
  console.log(`[discover] ${lgas.length} LGAs, ${wards.length} wards`);

  const done = new Set(db.prepare('SELECT ward_id FROM wards_done').all().map((r) => r.ward_id));
  const insert = db.prepare(`
    INSERT INTO units (pu_code, pu_name, ward, ward_id, lga, lga_id, doc_url, is_zero_pu, discovered_at)
    VALUES (@pu_code, @pu_name, @ward, @ward_id, @lga, @lga_id, @doc_url, @is_zero_pu, @discovered_at)
    ON CONFLICT(pu_code) DO UPDATE SET
      doc_url = COALESCE(excluded.doc_url, units.doc_url),
      pu_name = COALESCE(excluded.pu_name, units.pu_name)`);
  const markWard = db.prepare('INSERT OR REPLACE INTO wards_done (ward_id, units, done_at) VALUES (?,?,?)');

  let n = 0, skipped = 0, walked = 0;
  for (const { lga, ward } of wards) {
    if (done.has(ward._id)) { skipped++; continue; }
    const pus = (await getJson(`${BASE}/elections/${ELECTION.id}/pus?ward=${ward._id}`))?.data;
    if (!pus) { console.warn(`[discover] ward ${ward.name} unreadable — leaving it unmarked to retry`); continue; }
    const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });
    tx(pus.map((p) => ({
      pu_code: p.pu_code || null,
      pu_name: p.name || p.pu_name || null,
      ward: ward.name || null, ward_id: ward._id,
      lga: lga.name || null, lga_id: lga._id,
      doc_url: p.document?.url || null,
      is_zero_pu: p.is_zero_pu ? 1 : 0,
      discovered_at: Date.now(),
    })).filter((r) => r.pu_code));
    markWard.run(ward._id, pus.length, Date.now());
    done.add(ward._id);
    walked++;
    n += pus.length;
    if (walked % 20 === 0 || walked === wards.length - skipped) {
      const t = db.prepare('SELECT COUNT(*) c, SUM(doc_url IS NOT NULL) d FROM units').get();
      console.log(`[discover] ${walked} wards this run · ${t.c} units · ${t.d ?? 0} with a sheet`);
    }
    await sleep(250);   // a public API we do not own: pace it
  }
  const tot = db.prepare('SELECT COUNT(*) c, SUM(doc_url IS NOT NULL) d FROM units').get();
  console.log(`[discover] done. ${tot.c} units, ${tot.d} with a sheet (skipped ${skipped} wards already walked)`);
}

// ── fetch ────────────────────────────────────────────────────────────────────
async function fetchSheets({ limit, concurrency }) {
  const todo = db.prepare(`
    SELECT u.pu_code, u.doc_url FROM units u
    LEFT JOIN sheets s ON s.pu_code = u.pu_code
    WHERE u.doc_url IS NOT NULL AND (s.pu_code IS NULL OR (s.file IS NULL AND s.error IS NOT NULL))
    ORDER BY u.pu_code
    ${limit ? 'LIMIT ' + Number(limit) : ''}`).all();
  console.log(`[fetch] ${todo.length} sheet(s) outstanding · ${concurrency} at a time`);
  if (!todo.length) return;

  const save = db.prepare(`
    INSERT INTO sheets (pu_code, url, http, raw_bytes, raw_sha256, img_w, img_h, taken_at, camera, file, comp_bytes, fetched_at, error)
    VALUES (@pu_code, @url, @http, @raw_bytes, @raw_sha256, @img_w, @img_h, @taken_at, @camera, @file, @comp_bytes, @fetched_at, @error)
    ON CONFLICT(pu_code) DO UPDATE SET
      http=excluded.http, raw_bytes=excluded.raw_bytes, raw_sha256=excluded.raw_sha256,
      img_w=excluded.img_w, img_h=excluded.img_h, taken_at=excluded.taken_at, camera=excluded.camera,
      file=excluded.file, comp_bytes=excluded.comp_bytes, fetched_at=excluded.fetched_at, error=excluded.error`);

  let done = 0, ok = 0, failed = 0, bytesIn = 0, bytesOut = 0;
  const started = Date.now();

  async function one(row) {
    const rec = {
      pu_code: row.pu_code, url: row.doc_url, http: null, raw_bytes: null, raw_sha256: null,
      img_w: null, img_h: null, taken_at: null, camera: null, file: null, comp_bytes: null,
      fetched_at: Date.now(), error: null,
    };
    try {
      let buf = null;
      for (let i = 0; i < 4 && !buf; i++) {
        const r = await fetch(row.doc_url, { headers: UA });
        rec.http = r.status;
        if (r.ok) buf = Buffer.from(await r.arrayBuffer());
        else await sleep(1200 * (i + 1));
      }
      if (!buf) throw new Error(`http ${rec.http}`);
      rec.raw_bytes = buf.length;
      // Hash BEFORE we touch it. This is the number that says "these are the
      // bytes INEC served", and it is worthless if taken after a resize.
      rec.raw_sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      const img = sharp(buf, { failOn: 'none' });
      const meta = await img.metadata();
      rec.img_w = meta.width ?? null;
      rec.img_h = meta.height ?? null;
      // WHEN THE SHEET WAS PHOTOGRAPHED is itself a signal — a sheet timestamped
      // before polls closed, or days after, is worth a second look regardless of
      // what the figures say.
      if (meta.exif) {
        try {
          const s = meta.exif.toString('latin1');
          rec.taken_at = s.match(/(20\d\d:[01]\d:[0-3]\d [0-2]\d:[0-5]\d:[0-5]\d)/)?.[1] ?? null;
          rec.camera = s.match(/([A-Z][A-Za-z0-9_-]{3,20})\0/)?.[1] ?? null;
        } catch { /* EXIF is a bonus, never a reason to drop the sheet */ }
      }

      const rel = `${row.pu_code.replaceAll('/', '-')}.jpg`;
      const out = await sharp(buf, { failOn: 'none' })
        .rotate()                                   // honour EXIF orientation
        .resize({ width: IMG_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: IMG_QUALITY })
        .toBuffer();
      fs.writeFileSync(path.join(IMG_DIR, rel), out);
      rec.file = rel;
      rec.comp_bytes = out.length;
      bytesIn += buf.length; bytesOut += out.length;
      ok++;
    } catch (e) {
      rec.error = String(e.message || e).slice(0, 200);
      failed++;
    }
    save.run(rec);
    if (++done % 25 === 0 || done === todo.length) {
      const mins = (Date.now() - started) / 60000;
      const rate = done / Math.max(mins, 0.01);
      const left = (todo.length - done) / Math.max(rate, 0.01);
      console.log(
        `[fetch] ${done}/${todo.length} · ok=${ok} failed=${failed} · ` +
        `${(bytesIn / 1e9).toFixed(2)}GB in -> ${(bytesOut / 1e6).toFixed(0)}MB kept · ` +
        `${rate.toFixed(0)}/min · ~${left.toFixed(0)} min left`);
    }
  }

  // A fixed pool rather than Promise.all over everything: 3,700 simultaneous
  // requests would be abusive to a public service and would fail anyway.
  const queue = [...todo];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      await one(row);
      await sleep(120);
    }
  }));
  console.log(`[fetch] finished. ok=${ok} failed=${failed}`);
}

// ── status ───────────────────────────────────────────────────────────────────
function status() {
  const u = db.prepare('SELECT COUNT(*) c, SUM(doc_url IS NOT NULL) d FROM units').get();
  const w = db.prepare('SELECT COUNT(*) c FROM wards_done').get();
  const s = db.prepare(`SELECT COUNT(*) c, SUM(file IS NOT NULL) ok, SUM(error IS NOT NULL) err,
                        SUM(raw_bytes) rawb, SUM(comp_bytes) compb FROM sheets`).get();
  console.log(`election : ${ELECTION.label}`);
  console.log(`wards    : ${w.c} walked`);
  console.log(`units    : ${u.c} discovered · ${u.d ?? 0} have a sheet on IReV · ${(u.c ?? 0) - (u.d ?? 0)} have none`);
  console.log(`sheets   : ${s.ok ?? 0} downloaded · ${s.err ?? 0} failed · ${(u.d ?? 0) - (s.c ?? 0)} not started`);
  if (s.rawb) {
    console.log(`bytes    : ${(s.rawb / 1e9).toFixed(2)} GB served by INEC -> ${(s.compb / 1e6).toFixed(0)} MB kept`);
  }
  const noDoc = db.prepare('SELECT lga, COUNT(*) c FROM units WHERE doc_url IS NULL GROUP BY lga ORDER BY c DESC LIMIT 8').all();
  if (noDoc.length) {
    console.log('\nunits with NO sheet uploaded (top LGAs):');
    for (const r of noDoc) console.log(`  ${String(r.c).padStart(5)}  ${r.lga}`);
  }
}

// ── reconcile ────────────────────────────────────────────────────────────────
/**
 * Join IReV's unit list to OUR register, which is a check in itself: two
 * independently maintained lists of the same 3,763 places either agree or they
 * do not, and either answer is worth knowing before a single figure is read off
 * a sheet. A unit IReV carries that the register does not (or the reverse) is a
 * finding, not a nuisance.
 *
 * It also supplies the LGA and ward names. IReV's own LGA objects carry no
 * `name` field, so discovery stored nulls and "21 units with no sheet" could
 * not say WHERE. Taking those names from our register rather than from IReV is
 * the better answer anyway: the audit should not depend on the body being
 * audited to label its own gaps.
 *
 * Codes differ only in separator — IReV writes 29/15/09/006, the register
 * 29-15-09-006 — so both sides normalise to dashes.
 */
function reconcile() {
  const REG = path.join(ROOT, 'storage', 'hawkeye.db');
  if (!fs.existsSync(REG)) { console.error(`[reconcile] no register at ${REG}`); process.exit(1); }
  const reg = new Database(REG, { readonly: true });
  const state = db.prepare("SELECT v FROM meta WHERE k='state_name'").get()?.v || 'Osun';

  const regRows = reg.prepare('SELECT pu_code, lga, ward, name FROM polling_units WHERE state = ?').all(state);
  const regBy = new Map(regRows.map((r) => [r.pu_code.replaceAll('/', '-'), r]));
  const ourRows = db.prepare('SELECT pu_code, doc_url FROM units').all();

  const upd = db.prepare('UPDATE units SET lga = ?, ward = ?, pu_name = COALESCE(pu_name, ?) WHERE pu_code = ?');
  let filled = 0;
  const onlyIrev = [];
  const tx = db.transaction(() => {
    for (const u of ourRows) {
      const r = regBy.get(u.pu_code.replaceAll('/', '-'));
      if (!r) { onlyIrev.push(u.pu_code); continue; }
      upd.run(r.lga, r.ward, r.name, u.pu_code);
      filled++;
    }
  });
  tx();

  const ourCodes = new Set(ourRows.map((u) => u.pu_code.replaceAll('/', '-')));
  const onlyReg = regRows.map((r) => r.pu_code.replaceAll('/', '-')).filter((c) => !ourCodes.has(c));

  console.log(`[reconcile] register ${state}: ${regRows.length} units · IReV: ${ourRows.length}`);
  console.log(`[reconcile] matched ${filled}`);
  console.log(`[reconcile] on IReV but NOT in our register: ${onlyIrev.length}${onlyIrev.length ? ' -> ' + onlyIrev.slice(0, 10).join(', ') : ''}`);
  console.log(`[reconcile] in our register but NOT on IReV: ${onlyReg.length}${onlyReg.length ? ' -> ' + onlyReg.slice(0, 10).join(', ') : ''}`);

  const gaps = db.prepare(`SELECT lga, COUNT(*) c FROM units WHERE doc_url IS NULL GROUP BY lga ORDER BY c DESC`).all();
  if (gaps.length) {
    console.log('\n[reconcile] units with NO sheet uploaded, by LGA:');
    for (const g of gaps) console.log(`  ${String(g.c).padStart(4)}  ${g.lga ?? '(unknown)'}`);
    const list = db.prepare('SELECT pu_code, lga, ward, pu_name FROM units WHERE doc_url IS NULL ORDER BY lga, ward').all();
    const out = path.join(ROOT, 'storage', `audit-${ELECTION.slug}`, 'no-sheet.json');
    fs.writeFileSync(out, JSON.stringify(list, null, 2));
    console.log(`  written to ${out}`);
  }
}

const cmd = process.argv[2];
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};
if (cmd === 'discover') await discover();
else if (cmd === 'fetch') await fetchSheets({ limit: arg('limit', 0), concurrency: arg('concurrency', 4) });
else if (cmd === 'reconcile') reconcile();
else if (cmd === 'status') status();
else { console.error('usage: audit_irev.mjs discover|fetch|reconcile|status'); process.exit(2); }

// Election-integrity engine. Every automatically-detected anomaly is written to
// the `discrepancies` table (de-duped by type+pu+contest) and surfaced on the
// public /integrity.html dashboard. Checks split into two groups:
//   checkSubmission() — cheap, per-report, runs inside the submission path.
//   runForensics()    — cross-unit statistics, runs on an interval / on demand.
import { db } from '../db.js';
import { notifyMaster } from './notify.js';

const SEV_ICON = { low: 'ℹ️', medium: '⚠️', high: '🚩' };

export function logDiscrepancy({ type, severity = 'medium', puCode = null, contest = null, state = null, submissionId = null, detail = {} }) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO discrepancies (type, severity, pu_code, contest, state, submission_id, detail, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
    .run(type, severity, puCode, contest, state, submissionId, JSON.stringify(detail), Date.now());
  if (info.changes) {
    notifyMaster(`${SEV_ICON[severity] || '⚠️'} discrepancy [${type}] ${puCode || ''} ${contest || ''} — ${detail.summary || ''}`);
    // High-severity flags go straight onto the docket chain and mark the result
    // disputed from this moment (crowd arbitration — docs/CROWD-ARBITRATION.md).
    import('./docket.js')
      .then((d) => d.onFlag({ id: info.lastInsertRowid, type, severity, puCode, contest, detail }))
      .catch((e) => console.error('[docket]', e.message));
  }
  return info.changes > 0;
}

const total = (votes) => votes.reduce((s, v) => s + (Number(v.count) || 0), 0);

// Per-report checks. `votes` = [{party,count}], `pu` = the polling_units row.
export function checkSubmission({ pu, contest, votes, submissionId, sheetSerial }) {
  const t = total(votes);
  const reg = pu.registered_voters;

  // Over-voting: more votes cast than registered voters — impossible, a classic
  // tribunal nullification ground.
  if (reg && t > reg) {
    logDiscrepancy({
      type: 'over_voting', severity: 'high', puCode: pu.pu_code, contest, state: pu.state, submissionId,
      detail: { votes: t, registered: reg, summary: `${t} votes vs ${reg} registered` },
    });
  } else if (reg && t / reg > 0.95) {
    // Implausibly high turnout (>95%) — suspicious, not impossible.
    logDiscrepancy({
      type: 'high_turnout', severity: 'medium', puCode: pu.pu_code, contest, state: pu.state, submissionId,
      detail: { turnout: Math.round((t / reg) * 1000) / 10, summary: `${Math.round((t / reg) * 100)}% turnout` },
    });
  }

  // Near-total dominance by one party at a sizeable unit — ballot-stuffing signature.
  if (t >= 50) {
    const top = votes.reduce((m, v) => (v.count > (m?.count || 0) ? v : m), null);
    if (top && top.count / t >= 0.98) {
      logDiscrepancy({
        type: 'single_party_sweep', severity: 'medium', puCode: pu.pu_code, contest, state: pu.state, submissionId,
        detail: { party: top.party, share: Math.round((top.count / t) * 1000) / 10, summary: `${top.party} ${Math.round((top.count / t) * 100)}% of ${t}` },
      });
    }
  }

  // Reused EC8A serial: same form serial reported at a DIFFERENT unit = forgery.
  if (sheetSerial) {
    const clash = db.prepare(
      'SELECT pu_code FROM submissions WHERE sheet_serial = ? AND pu_code != ? LIMIT 1',
    ).get(sheetSerial, pu.pu_code);
    if (clash) {
      logDiscrepancy({
        type: 'duplicate_serial', severity: 'high', puCode: pu.pu_code, contest, state: pu.state, submissionId,
        detail: { serial: sheetSerial, alsoAt: clash.pu_code, summary: `serial ${sheetSerial} also at ${clash.pu_code}` },
      });
    }
  }
}

// Logged whenever recomputeResult marks a unit 'disputed' (conflicting counts).
export function checkResult({ pu, contest, result }) {
  if (result?.status === 'disputed') {
    logDiscrepancy({
      type: 'disputed_counts', severity: 'medium', puCode: pu.pu_code, contest, state: pu.state,
      detail: { reports: result.totalReports, agreeing: result.matchingReports, summary: `${result.matchingReports}/${result.totalReports} reports agree` },
    });
  }
  if (result?.locationPlausibility === 'inconsistent') {
    logDiscrepancy({
      type: 'location_inconsistent', severity: 'high', puCode: pu.pu_code, contest, state: pu.state,
      detail: { summary: 'GPS cluster far from where this unit can be' },
    });
  }
}

// Cross-unit statistics. Cheap enough to run on an interval. Every flag carries
// the numbers that triggered it — evidence with its reasoning shown, never a verdict.
export function runForensics() {
  const rows = db.prepare(`
    SELECT r.pu_code, r.contest, r.votes_json, p.registered_voters, p.state, p.lga, p.ward
    FROM results r JOIN polling_units p ON p.pu_code = r.pu_code`).all();
  const parsed = rows.map((r) => {
    const votes = JSON.parse(r.votes_json);
    const t = total(votes);
    const top = votes.reduce((m, v) => (v.count > (m?.count || 0) ? v : m), null);
    return { ...r, votes, t, top };
  });

  // 1) turnout per state -> flag units whose turnout is a strong high outlier
  const byState = {};
  for (const r of parsed) {
    if (!r.registered_voters) continue;
    (byState[r.state] ||= []).push({ ...r, turnout: r.t / r.registered_voters });
  }
  for (const [state, units] of Object.entries(byState)) {
    if (units.length < 5) continue;
    const vals = units.map((u) => u.turnout);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    for (const u of units) {
      if (u.turnout > mean + 2.5 * sd && u.turnout > 0.8) {
        logDiscrepancy({
          type: 'turnout_outlier', severity: 'medium', puCode: u.pu_code, contest: u.contest, state,
          detail: { turnout: Math.round(u.turnout * 1000) / 10, stateMean: Math.round(mean * 1000) / 10, summary: `turnout ${Math.round(u.turnout * 100)}% vs ${state} avg ${Math.round(mean * 100)}%` },
        });
      }
    }
  }

  // 2) winner-share outlier: a sizeable unit where the winner's share is a strong
  // high outlier against the same state+contest distribution.
  const shareGroups = {};
  for (const r of parsed) {
    if (r.t >= 100 && r.top) (shareGroups[`${r.state}|${r.contest}`] ||= []).push({ ...r, share: r.top.count / r.t });
  }
  for (const [key, units] of Object.entries(shareGroups)) {
    if (units.length < 8) continue;
    const vals = units.map((u) => u.share);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    for (const u of units) {
      if (u.share > mean + 2.5 * sd && u.share >= 0.9) {
        logDiscrepancy({
          type: 'vote_share_outlier', severity: 'medium', puCode: u.pu_code, contest: u.contest, state: u.state,
          detail: {
            party: u.top.party, share: Math.round(u.share * 1000) / 10, stateMean: Math.round(mean * 1000) / 10, n: units.length,
            summary: `${u.top.party} ${Math.round(u.share * 100)}% of ${u.t} votes vs ${key.split('|')[0]} avg ${Math.round(mean * 100)}% (${units.length} units)`,
          },
        });
      }
    }
  }

  // 3) neighbour divergence: a unit voting wildly unlike the rest of its own ward.
  const wards = {};
  for (const r of parsed) {
    if (r.t >= 50) (wards[`${r.state}|${r.lga}|${r.ward}|${r.contest}`] ||= []).push(r);
  }
  for (const [key, units] of Object.entries(wards)) {
    if (units.length < 4) continue;
    const partyTotals = {};
    for (const u of units) for (const v of u.votes) partyTotals[v.party] = (partyTotals[v.party] || 0) + v.count;
    const wardWinner = Object.entries(partyTotals).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!wardWinner) continue;
    const shares = units.map((u) => ({ u, s: (u.votes.find((v) => v.party === wardWinner)?.count || 0) / u.t }));
    for (const { u, s } of shares) {
      const others = shares.filter((x) => x.u !== u).map((x) => x.s);
      const om = others.reduce((a, b) => a + b, 0) / others.length;
      if (Math.abs(s - om) >= 0.5) {
        logDiscrepancy({
          type: 'neighbour_divergence', severity: 'medium', puCode: u.pu_code, contest: u.contest, state: u.state,
          detail: {
            party: wardWinner, unitShare: Math.round(s * 1000) / 10, wardMean: Math.round(om * 1000) / 10, wardUnits: units.length,
            summary: `${wardWinner} ${Math.round(s * 100)}% here vs ${Math.round(om * 100)}% average across ${units.length - 1} neighbouring unit(s) in the same ward`,
          },
        });
      }
    }
  }

  // 4) fabrication digit tests, per contest (needs volume to mean anything):
  //    first-digit Benford + round-number (trailing 0/5) excess over all party counts.
  const byContest = {};
  for (const r of parsed) for (const v of r.votes) {
    if (v.count >= 10) (byContest[r.contest] ||= []).push(v.count);
  }
  for (const [contest, counts] of Object.entries(byContest)) {
    if (counts.length < 200) continue;
    const first = new Array(10).fill(0);
    let round = 0;
    for (const c of counts) {
      first[Number(String(c)[0])]++;
      if (c % 10 === 0 || c % 10 === 5) round++;
    }
    const mad = [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((s, d) => {
      const obs = (first[d] / counts.length) * 100;
      const exp = Math.log10(1 + 1 / d) * 100;
      return s + Math.abs(obs - exp);
    }, 0) / 9;
    if (mad > 1.5) {
      logDiscrepancy({
        type: 'benford_deviation', severity: 'low', contest, puCode: `digits:${contest}`,
        detail: { mad: Math.round(mad * 100) / 100, n: counts.length, summary: `first-digit distribution departs from Benford (MAD ${mad.toFixed(2)} > 1.5) over ${counts.length} counts — screening signal, not proof` },
      });
    }
    const roundPct = (round / counts.length) * 100;
    if (roundPct > 30) {
      logDiscrepancy({
        type: 'round_number_excess', severity: 'low', contest, puCode: `digits:${contest}`,
        detail: { roundPct: Math.round(roundPct * 10) / 10, n: counts.length, summary: `${Math.round(roundPct)}% of counts end in 0 or 5 (expected ~20%) over ${counts.length} counts — screening signal, not proof` },
      });
    }
  }
}

// ---------- Registration-burst detection (NOTIFY-ONLY, never blocks) ----------
// An influencer post and a bot run look identical here — so this only alerts the
// owner (who can check Cloudflare analytics and decide) and logs a low note.
let lastBurstAlert = 0;
export function noteRegistration() {
  const now = Date.now();
  const w = db.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT device_id) AS d FROM observers WHERE created_at > ?')
    .get(now - 600_000);
  if (w.c >= 30 && now - lastBurstAlert > 1_800_000) {
    lastBurstAlert = now;
    notifyMaster(`⚡ signup burst: ${w.c} new observers in 10 min (${w.d} unique devices). Influencer spike or bot run — check Cloudflare analytics; act only if hostile. Nothing is being blocked.`);
    logDiscrepancy({
      type: 'signup_burst', severity: 'low', puCode: 'burst:' + new Date().toISOString().slice(0, 13),
      detail: { count: w.c, devices: w.d, summary: `${w.c} signups in 10 min (${w.d} devices) — informational` },
    });
  }
}

// ---------- Collation reconciliation (EC8B/C/D vs PU evidence) ----------
const scopeWhere = (r) =>
  r.level === 'ward' ? ['p.state = ? AND p.lga = ? AND p.ward = ?', [r.state, r.lga, r.ward]]
  : r.level === 'lga' ? ['p.state = ? AND p.lga = ?', [r.state, r.lga]]
  : ['p.state = ?', [r.state]];

// Rule 1 — coverage-proof undercount: a collated figure can never be LESS than
// the sum of the verified polling units we already cover in that scope. Even 3
// covered PUs out of 40 can prove subtraction. Re-runs as more PUs verify.
export function checkCollation(report) {
  const [where, args] = scopeWhere(report);
  const rows = db.prepare(`
    SELECT r.votes_json FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
    WHERE r.contest = ? AND r.status = 'verified' AND ${where}`).all(report.contest, ...args);
  if (rows.length) {
    const covered = {};
    for (const r of rows) for (const v of JSON.parse(r.votes_json)) covered[v.party] = (covered[v.party] || 0) + v.count;
    const collated = Object.fromEntries(JSON.parse(report.votes_json).map((v) => [v.party, v.count]));
    // Dedupe key: the UNIQUE(type, pu_code, contest) index needs a non-NULL pu_code
    // or re-scans would insert duplicates — use the scope path as the key.
    const scopeKey = `${report.level}:${[report.state, report.lga, report.ward].filter(Boolean).join('/')}`;
    for (const [party, sum] of Object.entries(covered)) {
      if (sum > 0 && (collated[party] ?? 0) < sum) {
        logDiscrepancy({
          type: 'collation_undercount', severity: 'high', contest: report.contest, state: report.state,
          puCode: scopeKey,
          detail: {
            level: report.level, scope: [report.state, report.lga, report.ward].filter(Boolean).join(' / '),
            party, collated: collated[party] ?? 0, coveredSum: sum, coveredUnits: rows.length,
            summary: `${report.level.toUpperCase()} form shows ${party} ${collated[party] ?? 0}, but ${rows.length} covered unit(s) alone sum to ${sum}`,
          },
        });
      }
    }
  }
  // Rule 2 — full coverage: when EVERY unit in the scope has a verified result,
  // the sums must match the form exactly, in both directions.
  const scopeKey2 = `${report.level}:${[report.state, report.lga, report.ward].filter(Boolean).join('/')}`;
  const totalUnits = db.prepare(`SELECT COUNT(*) AS c FROM polling_units p WHERE ${where}`).get(...args).c;
  if (totalUnits > 0 && rows.length === totalUnits) {
    const covered = {};
    for (const r of rows) for (const v of JSON.parse(r.votes_json)) covered[v.party] = (covered[v.party] || 0) + v.count;
    const collated = Object.fromEntries(JSON.parse(report.votes_json).map((v) => [v.party, v.count]));
    const deltas = [...new Set([...Object.keys(covered), ...Object.keys(collated)])]
      .map((p) => ({ party: p, collated: collated[p] || 0, units: covered[p] || 0 }))
      .filter((d) => d.collated !== d.units);
    if (deltas.length) {
      logDiscrepancy({
        type: 'collation_mismatch', severity: 'high', contest: report.contest, state: report.state,
        puCode: scopeKey2,
        detail: {
          level: report.level, coverage: '100%', deltas,
          summary: `all ${totalUnits} unit(s) verified, yet ${deltas.length} party total(s) differ (e.g. ${deltas[0].party}: form ${deltas[0].collated} vs units ${deltas[0].units})`,
        },
      });
    }
  }

  // OCR corroboration — the typed totals vs digits machine-read from the form photo.
  if (report.ocr_total >= 3 && report.ocr_matched === 0) {
    logDiscrepancy({
      type: 'collation_ocr_mismatch', severity: 'low', contest: report.contest, state: report.state,
      puCode: scopeKey2,
      detail: { level: report.level, summary: `none of ${report.ocr_total} typed totals were read on the form photo` },
    });
  }

  // Chain sums — EC8C vs the ward EC8Bs under it, EC8D vs the LGA EC8Cs under it.
  checkCollationChain(report);

  // Rule 3 — two observers at the same collation point reporting different figures.
  const peers = db.prepare(`
    SELECT DISTINCT votes_json FROM collation_reports
    WHERE contest = ? AND level = ? AND state = ? AND COALESCE(lga,'') = COALESCE(?, '') AND COALESCE(ward,'') = COALESCE(?, '')`)
    .all(report.contest, report.level, report.state, report.lga, report.ward);
  if (peers.length > 1) {
    logDiscrepancy({
      type: 'collation_disputed', severity: 'medium', contest: report.contest, state: report.state,
      puCode: `${report.level}:${[report.state, report.lga, report.ward].filter(Boolean).join('/')}`,
      detail: {
        level: report.level, scope: [report.state, report.lga, report.ward].filter(Boolean).join(' / '),
        versions: peers.length, summary: `${peers.length} conflicting ${report.level.toUpperCase()} reports for the same collation`,
      },
    });
  }
}

// Consensus figures for one collation scope: the most-reported votes_json wins;
// a tie between different versions means no consensus (returns null).
function modeVotes(rows) {
  const freq = new Map();
  for (const r of rows) freq.set(r.votes_json, (freq.get(r.votes_json) || 0) + 1);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) return null;
  return JSON.parse(sorted[0][0]);
}

// EC8B→C→D chain: an LGA form can never show less for a party than the sum of
// the covered ward forms under it (same subset logic as Rule 1); likewise state
// vs LGA forms. Consensus per child scope via modeVotes.
function checkCollationChain(report) {
  if (report.level === 'ward') return;
  const childLevel = report.level === 'lga' ? 'ward' : 'lga';
  const childScopes = report.level === 'lga'
    ? db.prepare(`SELECT DISTINCT ward AS k FROM collation_reports WHERE contest = ? AND level = 'ward' AND state = ? AND lga = ?`)
      .all(report.contest, report.state, report.lga)
    : db.prepare(`SELECT DISTINCT lga AS k FROM collation_reports WHERE contest = ? AND level = 'lga' AND state = ?`)
      .all(report.contest, report.state);
  if (!childScopes.length) return;
  const covered = {};
  let used = 0;
  for (const { k } of childScopes) {
    const rows = report.level === 'lga'
      ? db.prepare(`SELECT votes_json FROM collation_reports WHERE contest = ? AND level = 'ward' AND state = ? AND lga = ? AND ward = ?`)
        .all(report.contest, report.state, report.lga, k)
      : db.prepare(`SELECT votes_json FROM collation_reports WHERE contest = ? AND level = 'lga' AND state = ? AND lga = ?`)
        .all(report.contest, report.state, k);
    const consensus = modeVotes(rows);
    if (!consensus) continue;
    used++;
    for (const v of consensus) covered[v.party] = (covered[v.party] || 0) + v.count;
  }
  if (!used) return;
  const collated = Object.fromEntries(JSON.parse(report.votes_json).map((v) => [v.party, v.count]));
  const scopeKey = `${report.level}:${[report.state, report.lga, report.ward].filter(Boolean).join('/')}`;
  for (const [party, sum] of Object.entries(covered)) {
    if (sum > 0 && (collated[party] ?? 0) < sum) {
      logDiscrepancy({
        type: 'collation_chain_undercount', severity: 'high', contest: report.contest, state: report.state,
        puCode: scopeKey,
        detail: {
          level: report.level, childLevel, childForms: used, party,
          collated: collated[party] ?? 0, coveredSum: sum,
          summary: `${report.level.toUpperCase()} form shows ${party} ${collated[party] ?? 0}, but ${used} covered ${childLevel} form(s) alone sum to ${sum}`,
        },
      });
    }
  }
}

// Re-run rule 1 for every collation report (PU verifications arrive later).
export function recheckCollations() {
  for (const r of db.prepare('SELECT * FROM collation_reports').all()) {
    try { checkCollation(r); } catch { /* next */ }
  }
}

export function collationSummary() {
  const byLevel = Object.fromEntries(
    db.prepare('SELECT level, COUNT(*) AS c FROM collation_reports GROUP BY level').all().map((r) => [r.level, r.c]),
  );
  const flags = Object.fromEntries(
    db.prepare("SELECT type, COUNT(*) AS c FROM discrepancies WHERE type LIKE 'collation_%' GROUP BY type").all().map((r) => [r.type, r.c]),
  );
  return { byLevel, flags };
}

// Digit-distribution screening. Last digit of winning counts should be ~uniform;
// first digit of all counts should follow Benford's law. Departures are screening
// signals (fabricated figures cluster on favourite digits), never proof.
export function benfordSummary() {
  const rows = db.prepare('SELECT votes_json FROM results').all();
  const last = new Array(10).fill(0);
  const first = new Array(10).fill(0);
  let nLast = 0;
  let nFirst = 0;
  for (const r of rows) {
    const votes = JSON.parse(r.votes_json);
    const top = votes.reduce((m, v) => (v.count > (m?.count || 0) ? v : m), null);
    if (top && top.count >= 10) { last[top.count % 10]++; nLast++; }
    for (const v of votes) if (v.count >= 10) { first[Number(String(v.count)[0])]++; nFirst++; }
  }
  const firstDigit = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => ({
    digit: d, observed: first[d],
    expectedPct: Math.round(Math.log10(1 + 1 / d) * 1000) / 10,
  }));
  const mad = nFirst
    ? firstDigit.reduce((s, e) => s + Math.abs((e.observed / nFirst) * 100 - e.expectedPct), 0) / 9
    : 0;
  const verdict = nFirst < 100 ? 'insufficient_data'
    : mad < 0.6 ? 'close_conformity'
    : mad < 1.2 ? 'acceptable_conformity'
    : mad < 1.5 ? 'marginal_conformity'
    : 'nonconformity';
  return {
    n: nLast, nFirst,
    lastDigit: last.map((c, d) => ({ digit: d, observed: c, expectedPct: 10 })),
    firstDigit, mad: Math.round(mad * 100) / 100, verdict,
  };
}

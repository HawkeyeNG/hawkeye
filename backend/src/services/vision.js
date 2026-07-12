// EC8A sheet vision check. Uses the free vision provider (Gemini) to (1) read the
// recorded party scores off the photographed result sheet and (2) judge whether
// the image looks like a genuine filled EC8A form vs a screenshot / digitally
// edited / AI-generated fake. Both outputs are ADVISORY: a mismatch or an
// authenticity doubt is logged to the public discrepancy feed for humans to weigh
// against the other evidence — never an automatic rejection. Best-effort and
// fire-and-forget: silently no-ops with no vision key or on any failure.
import { db } from '../db.js';
import { config } from '../config.js';
import { providerChain, chatComplete } from './assistant.js';
import { logDiscrepancy } from './integrity.js';

export async function analyzeSheet(jpegBuffer, { contest, votes, pu, submissionId }) {
  if (config.visionSampleRate <= 0 || Math.random() > config.visionSampleRate) return;
  // Prefer a dedicated (self-hosted) VLM if configured, else the Gemini provider.
  const providers = [];
  if (config.visionApiKey && config.visionApiBase) providers.push({ name: 'vision', base: config.visionApiBase, key: config.visionApiKey, model: config.visionModel });
  providers.push(...providerChain().filter((p) => p.name.startsWith('gemini')));
  if (!providers.length) return;

  const typed = votes.filter((v) => v.count > 0).map((v) => `${v.party}=${v.count}`).join(', ');
  const prompt = [
    'This image should be a photo of a Nigerian INEC EC8A polling-unit result sheet. Reply with ONLY JSON:',
    '{"authentic":"yes|unclear|no","reason":"<short>","state":"<State name written in the sheet header, empty if unreadable>","puCode":"<polling unit code written on the sheet, empty if unreadable>","counts":[{"party":"<CODE>","count":<integer>}]}',
    'Set authentic="no" if it looks like a screenshot, is digitally edited, appears AI-generated, or is not an EC8A form at all; "unclear" if you cannot tell.',
    'For state and puCode, read them off the sheet header itself; leave them empty rather than guess.',
    'For counts, read the score recorded for each party you can clearly read (integers only); omit any you cannot read. Do not guess.',
    `For reference only, the observer typed: ${typed || '(none)'}.`,
  ].join('\n');
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}` } },
  ];

  let out = null;
  for (const p of providers) {
    try {
      const m = await chatComplete(p, [{ role: 'user', content }], { maxTokens: 400 });
      const jm = /\{[\s\S]*\}/.exec(m.content || '');
      if (jm) { out = JSON.parse(jm[0]); break; }
    } catch { /* next provider/model */ }
  }
  if (!out) return;

  try { db.prepare('UPDATE submissions SET vision_json = ? WHERE id = ?').run(JSON.stringify(out).slice(0, 4000), submissionId); } catch { /* column optional */ }

  if (out.authentic === 'no') {
    logDiscrepancy({
      type: 'sheet_authenticity', severity: 'high', puCode: pu.pu_code, contest, state: pu.state, submissionId,
      detail: { reason: String(out.reason || '').slice(0, 160), summary: `AI vision flags this sheet image as likely not a genuine EC8A — ${String(out.reason || 'see review').slice(0, 120)}` },
    });
  }

  // Region check: the sheet's own header must belong to the claimed unit. A
  // genuine sheet from another state passed off as this PU is stronger fraud
  // evidence than any count mismatch — straight to high (disputed + docket).
  const readState = String(out.state || '').trim().toLowerCase();
  const wantState = String(pu.state || '').trim().toLowerCase();
  if (readState && wantState && !readState.includes(wantState) && !wantState.includes(readState)) {
    logDiscrepancy({
      type: 'sheet_region_mismatch', severity: 'high', puCode: pu.pu_code, contest, state: pu.state, submissionId,
      detail: { readState: String(out.state).slice(0, 60), summary: `Sheet header reads state "${String(out.state).slice(0, 40)}" but this polling unit is in ${pu.state}` },
    });
  }
  const readPu = String(out.puCode || '').replace(/\D/g, '');
  const wantPu = String(pu.pu_code || '').replace(/\D/g, '');
  if (readPu && wantPu && readPu.length === wantPu.length && readPu !== wantPu) {
    logDiscrepancy({
      type: 'sheet_region_mismatch', severity: 'high', puCode: pu.pu_code, contest, state: pu.state, submissionId,
      detail: { readPuCode: String(out.puCode).slice(0, 30), summary: `Sheet header carries PU code ${String(out.puCode).slice(0, 20)} but was submitted for ${pu.pu_code}` },
    });
  }

  if (Array.isArray(out.counts) && out.counts.length) {
    const typedMap = Object.fromEntries(votes.map((v) => [v.party, v.count]));
    const diffs = out.counts
      .filter((c) => c && c.party in typedMap && Number.isInteger(c.count) && c.count !== typedMap[c.party])
      .map((c) => ({ party: c.party, typed: typedMap[c.party], read: c.count }));
    if (diffs.length) {
      // Escalate to high (disputed + docket) when the read contradicts the
      // OUTCOME, not just a digit: the winner changes, or a count is wildly
      // off (≥5× apart and the bigger side ≥50). Small OCR-level differences
      // stay medium/advisory.
      const readMap = Object.fromEntries(out.counts.filter((c) => c && Number.isInteger(c.count)).map((c) => [c.party, c.count]));
      const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0];
      const tw = top(typedMap);
      const rw = top(readMap);
      const winnerFlip = tw && rw && tw[1] > 0 && rw[1] > 0 && tw[0] !== rw[0];
      const wildlyOff = diffs.some((d) => {
        const hi = Math.max(d.typed, d.read);
        const lo = Math.min(d.typed, d.read);
        return hi >= 50 && hi >= 5 * Math.max(1, lo);
      });
      const severity = winnerFlip || wildlyOff ? 'high' : 'medium';
      logDiscrepancy({
        type: 'vision_count_mismatch', severity, puCode: pu.pu_code, contest, state: pu.state, submissionId,
        detail: {
          diffs: diffs.slice(0, 6), winnerFlip: Boolean(winnerFlip), wildlyOff: Boolean(wildlyOff),
          summary: `AI read of the sheet differs from the typed counts for ${diffs.length} part(y/ies) — e.g. ${diffs[0].party}: typed ${diffs[0].typed} vs read ${diffs[0].read}${severity === 'high' ? (winnerFlip ? ' (leader changes)' : ' (wildly off)') : ''}`,
        },
      });
    }
  }
}

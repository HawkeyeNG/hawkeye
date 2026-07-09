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
    '{"authentic":"yes|unclear|no","reason":"<short>","counts":[{"party":"<CODE>","count":<integer>}]}',
    'Set authentic="no" if it looks like a screenshot, is digitally edited, appears AI-generated, or is not an EC8A form at all; "unclear" if you cannot tell.',
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

  if (Array.isArray(out.counts) && out.counts.length) {
    const typedMap = Object.fromEntries(votes.map((v) => [v.party, v.count]));
    const diffs = out.counts
      .filter((c) => c && c.party in typedMap && Number.isInteger(c.count) && c.count !== typedMap[c.party])
      .map((c) => ({ party: c.party, typed: typedMap[c.party], read: c.count }));
    if (diffs.length) {
      logDiscrepancy({
        type: 'vision_count_mismatch', severity: 'medium', puCode: pu.pu_code, contest, state: pu.state, submissionId,
        detail: { diffs: diffs.slice(0, 6), summary: `AI read of the sheet differs from the typed counts for ${diffs.length} part(y/ies) — e.g. ${diffs[0].party}: typed ${diffs[0].typed} vs read ${diffs[0].read}` },
      });
    }
  }
}

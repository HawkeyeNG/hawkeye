// Incident triage + clustering. Two independent halves:
//   triageIncident(id)  — LLM classifies one report for the human reviewer
//                         (advisory: suggested kind, urgency, spam likelihood,
//                         one-line summary). Free provider chain; silently a
//                         no-op when no key is configured. Never auto-publishes,
//                         never auto-rejects.
//   scanIncidentClusters() — pure statistics, no LLM: several reports of the
//                         same kind in the same state within a short window =
//                         a possible emerging hotspot, logged to the public
//                         discrepancy feed and alerted to the owner.
import { db } from '../db.js';
import { providerChain, chatComplete } from './assistant.js';
import { logDiscrepancy } from './integrity.js';
import { notifyMaster } from './notify.js';

const KINDS = 'violence, ballot_snatching, vote_buying, intimidation, bvas_failure, late_materials, obstruction, other';

export async function triageIncident(id) {
  const chain = providerChain();
  if (!chain.length) return;
  const inc = db.prepare('SELECT id, kind, description, state, media_json FROM incidents WHERE id = ?').get(id);
  if (!inc || !(inc.description || '').trim()) return;
  const prompt = [
    'You triage election incident reports for HUMAN review (Nigeria). Respond with ONLY compact JSON:',
    `{"kind":"<one of: ${KINDS}>","urgency":"low|medium|high","spam":"low|medium|high","summary":"<neutral one-line summary, max 120 chars>"}`,
    'urgency=high only for ongoing danger to people. spam=high for gibberish/ads/tests.',
    `Reporter chose kind: ${inc.kind}. State: ${inc.state || 'unknown'}. Media attached: ${JSON.parse(inc.media_json || '[]').length}.`,
    `Report text: """${inc.description.slice(0, 1200)}"""`,
  ].join('\n');
  for (const provider of chain) {
    try {
      const m = await chatComplete(provider, [{ role: 'user', content: prompt }], { maxTokens: 200 });
      const jm = /\{[\s\S]*\}/.exec(m.content || '');
      if (!jm) continue;
      const j = JSON.parse(jm[0]);
      const ai = {
        kind: String(j.kind || '').slice(0, 24),
        urgency: ['low', 'medium', 'high'].includes(j.urgency) ? j.urgency : 'low',
        spam: ['low', 'medium', 'high'].includes(j.spam) ? j.spam : 'low',
        summary: String(j.summary || '').slice(0, 160),
        provider: provider.name, at: Date.now(),
      };
      db.prepare('UPDATE incidents SET ai_json = ? WHERE id = ?').run(JSON.stringify(ai), id);
      if (ai.urgency === 'high') notifyMaster(`🔺 AI triage: incident #${id} flagged HIGH urgency — ${ai.summary}`);
      return;
    } catch { /* fall through to next provider */ }
  }
}

// >=3 reports, same state + kind, inside 6 hours -> hotspot flag (deduped per day).
export function scanIncidentClusters() {
  const since = Date.now() - 6 * 3_600_000;
  const rows = db.prepare(`
    SELECT state, kind, COUNT(*) AS c FROM incidents
    WHERE created_at > ? AND state IS NOT NULL AND status != 'rejected'
    GROUP BY state, kind HAVING c >= 3`).all(since);
  for (const r of rows) {
    logDiscrepancy({
      type: 'incident_cluster', severity: 'medium', state: r.state,
      puCode: `cluster:${r.state}:${r.kind}:${new Date().toISOString().slice(0, 10)}`,
      detail: { kind: r.kind, count: r.c, windowHours: 6, summary: `${r.c} "${r.kind}" reports in ${r.state} within 6h — possible emerging hotspot` },
    });
  }
}

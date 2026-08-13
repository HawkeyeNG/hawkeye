// One clip that covers the whole argument, for sharing into WhatsApp groups
// where nobody will watch six how-tos: how a result is captured, what it is
// stamped with, every way it can get flagged, where it is published, and how a
// stranger can check the lot without trusting us.
//
// Incident reporting is deliberately NOT in here. This clip has one job —
// explain why a result you did not file is still trustworthy — and a second
// feature dilutes it.
//
// The flag names are taken from backend/src/services/integrity.js, not invented:
// over_voting, high_turnout, single_party_sweep, duplicate_serial,
// disputed_counts, location_inconsistent (per report), then turnout_outlier,
// vote_share_outlier, neighbour_divergence, benford_deviation and
// round_number_excess across the whole set. Keep them accurate — this is the
// clip most likely to be forwarded to someone hostile.
//
// Length discipline: the renderer dies past ~1150 frames and length comes
// straight off the voiceover, so each beat gets one short spoken line.
import {
  scr, h1, lede, card, label, btn, ok, cam, chain, warn, miniMap, IC_LOCK,
} from './howto_content.mjs';

// Small inline visuals so this needs no new stylesheet (same trick the Telegram
// clip uses for its channel picker).
const checkRow = (t, bad) => `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;
  border-bottom:1px solid #e7ece9;font-size:23px;color:#1d2a24">
  <span style="width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;
    justify-content:center;font-size:17px;font-weight:800;color:#fff;
    background:${bad ? '#c0392b' : '#1f8a4c'}">${bad ? '!' : '✓'}</span>${t}</div>`;

// First-digit distribution: expected Benford curve behind, observed bars in
// front, with one digit visibly over-represented.
const benfordBars = () => {
  const exp = [30, 18, 12, 10, 8, 7, 6, 5, 4];
  const obs = [22, 15, 11, 9, 26, 6, 5, 4, 3]; // 5 is the spike
  return `<div style="display:flex;align-items:flex-end;gap:7px;height:150px;padding:10px 4px 0">
    ${exp.map((e, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px">
      <div style="width:100%;height:130px;display:flex;align-items:flex-end;position:relative">
        <div style="position:absolute;bottom:0;width:100%;height:${e * 4}px;background:#dfe8e3;border-radius:4px 4px 0 0"></div>
        <div style="position:relative;width:64%;margin:0 auto;height:${obs[i] * 4}px;
          background:${obs[i] > e * 1.6 ? '#c0392b' : '#1f8a4c'};border-radius:4px 4px 0 0"></div>
      </div>
      <span style="font-size:19px;color:#5b6b62">${i + 1}</span>
    </div>`).join('')}
  </div>`;
};

export const CLIPS_OVERVIEW = [
  {
    slug: 'how-hawkeye-works',
    // "Tampering", not "fraud": the app makes alteration DETECTABLE, which is a
    // claim we can stand behind. Saying it detects fraud would overclaim.
    title: 'How Hawkeye makes tampering visible',
    kicker: 'SIGNED · STAMPED · SCREENED · PUBLIC',
    steps: [
      {
        cap: 'Photograph the result sheet at your polling unit. Live capture only — gallery uploads are rejected.',
        vo: 'Photograph the result sheet at your unit. Live capture only.',
        screen: scr('Report a result', h1('Photograph the sheet')
          + lede('Captured in the app and signed on your phone as you shoot.')
          + cam('EC8A result sheet')),
      },
      {
        cap: 'Every report is stamped with where and when it was taken.',
        vo: 'Every report is stamped with where and when it was taken.',
        screen: scr('Report a result', h1('Where and when')
          + lede('Checked against the unit you selected, so a report filed from the wrong place stands out.')
          + miniMap('Ward 5 Primary School')),
      },
      {
        cap: 'Each report is checked the moment it lands — and anything impossible is flagged.',
        vo: 'Each report is checked the moment it lands.',
        screen: scr('Election integrity', h1('Checked on arrival')
          + card(checkRow('More votes than registered voters', true)
            + checkRow('Turnout above 95%', true)
            + checkRow('The same sheet serial twice', true)
            + checkRow('GPS that does not match the unit', true)
            + checkRow('Two reports from one unit that disagree', true))
          + warn('Flagged units are excluded from the tally, not averaged in')),
      },
      {
        cap: "Then every result is screened as a set: Benford's first-digit test, round-number excess, turnout and vote-share outliers, and units that diverge from their neighbours.",
        // "digit outliers", not "digit-outliers": a hyphen between two words is
        // a coin toss with edge-tts, and this clip has already lost one word to
        // an unlucky reading.
        vo: "Every report is screened as a set using Benford's law, digit outliers, and neighbour divergence.",
        screen: scr('Election integrity', h1("Benford's law")
          + lede('Real counts follow a known first-digit curve. Invented ones usually do not.')
          + card(benfordBars())
          + warn('Digit 5 over-represented — screened for review')),
      },
      {
        cap: 'Published reports are chained and anchored to Sigstore Rekor — a public log we do not control.',
        vo: 'Reports are anchored to Sigstore Rekor. A public log we do not control.',
        screen: scr('Verify the ledger', h1('Anchored in the open')
          + lede('Each entry commits to every entry before it, so nothing can be quietly changed later — not by us either.')
          + chain(['4d88b302…', 'b6dd0258…', '8d467af3…'])
          + card(label('Anchored to') + `<div class="ph-lede">${IC_LOCK} Sigstore Rekor · public transparency log</div>`)),
      },
      {
        cap: 'Anyone can recompute the entire chain in their own browser. You do not have to trust us.',
        vo: 'Anyone can recompute the whole chain in their own browser.',
        screen: scr('Verify the ledger', h1('Check it yourself')
          + lede('No account, no permission, no trust required.')
          + btn('Re-verify the entire chain in my browser', { icon: '🔒' })
          + ok('Chain verified', 'Recomputed on this device')),
      },
    ],
  },
];

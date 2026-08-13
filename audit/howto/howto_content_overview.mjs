// One clip that covers the whole argument, for sharing into WhatsApp groups
// where nobody will watch six how-tos: capture, what a report is stamped with,
// where it goes, and why a bad report cannot hide.
//
// Built entirely from howto_content.mjs's existing screen builders — the app
// screens here are the same ones the task-specific clips use, so this stays
// truthful about what the product actually looks like.
//
// Length discipline matters: the renderer dies past ~1150 frames and length is
// driven straight off the voiceover, so six beats are kept to one short spoken
// line each. Do not pad these.
import {
  scr, h1, lede, card, label, btn, ok, cam, chain, results, warn, photoTile, miniMap, IC_LOCK,
} from './howto_content.mjs';

export const CLIPS_OVERVIEW = [
  {
    slug: 'how-hawkeye-works',
    // "Tampering", not "fraud": the app makes alteration DETECTABLE, which is a
    // claim we can stand behind. Saying it detects fraud would overclaim, and
    // this clip is the one most likely to be forwarded out of context.
    title: 'How Hawkeye makes tampering visible',
    kicker: 'SIGNED · STAMPED · PUBLIC',
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
          + lede('The stamp is checked against the unit you selected, so a report filed from the wrong place stands out.')
          + miniMap('Ward 5 Primary School')),
      },
      {
        cap: 'Report incidents the same way — photo or short video, reviewed by a human before publishing.',
        vo: 'Report incidents the same way. A human reviews each one.',
        screen: scr('Report an incident', h1('Incidents too')
          + lede('Vote-buying, intimidation, ballot snatching, BVAS failures.')
          + card(label('Evidence (optional)') + photoTile())
          + warn('Never put yourself at risk to capture evidence.')),
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
        cap: 'When reports from the same unit disagree, that unit is flagged and excluded until it is settled in public.',
        vo: 'When reports from one unit disagree, that unit is flagged, not averaged.',
        screen: scr('Public docket', h1('Disagreement is visible')
          + lede('Disputed units are excluded from the tally and resolved openly.')
          + results([['Party A', '341'], ['Party B', '220']])
          + warn('Disputed — excluded from the tally pending review')),
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

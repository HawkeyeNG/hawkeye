import type { Feather } from '@expo/vector-icons';

/**
 * Structured content for the explainer pages.
 *
 * The first native port extracted the website's prose into flat blocks
 * (scripts/extract_pages.mjs) — correct copy, but it arrived as paragraph after
 * paragraph, which is exactly the "notes feel" this replaces. The HTML's own
 * structure (cards, numbered steps, accordions, rule lists) never survived the
 * strip, so it is re-declared here as typed blocks the renderer can give real
 * native shapes: timelines, expandable layers, tappable actions.
 *
 * Copy stays faithful to app/*.html — tightened, never invented.
 */

export type Icon = keyof typeof Feather.glyphMap;

export type Block =
  /** Big opening statement under the title. */
  | { kind: 'lede'; text: string }
  /** Small uppercase section label. */
  | { kind: 'label'; text: string }
  | { kind: 'para'; text: string }
  /** Tappable card that routes somewhere in the app. */
  | { kind: 'actions'; items: { icon: Icon; title: string; body: string; cta: string; href: string }[] }
  /** Numbered vertical timeline. `start` continues a sequence across sections
   *  (the guide runs 1–7 through "before" and "on election day"). */
  | { kind: 'steps'; start?: number; items: { title: string; body: string; bullets?: string[] }[] }
  /** Expandable layers — the "machinery underneath" pattern. */
  | { kind: 'layers'; items: { icon: Icon; title: string; points: string[] }[] }
  /** Icon-bulleted list; tone drives the icon and colour. */
  | { kind: 'rules'; tone: 'enforced' | 'never' | 'private' | 'public'; title?: string; items: string[] }
  /** Coloured callout for the one thing that must not be missed. */
  | { kind: 'callout'; icon: Icon; title: string; body: string }
  /** Contact rows that open mail/Telegram natively. */
  | { kind: 'contacts'; items: { icon: Icon; label: string; value: string; url: string }[] };

export type Page = {
  title: string;
  /** One-line subtitle in the collapsing header. */
  kicker: string;
  /**
   * Jump chips, in order; each maps to a 'label' block of the same text —
   * byte-identical, since the scroll anchors are keyed by the string itself.
   * Written in Title Case: the in-page label renders ALL-CAPS, but the chip
   * renders the string as authored.
   */
  sections: string[];
  blocks: Block[];
};

export const PAGES: Record<string, Page> = {
  how: {
    title: 'How Hawkeye Works',
    kicker: 'Trust, earned by agreement',
    sections: ['Take Part', 'Becoming Trusted', 'The Machinery'],
    blocks: [
      {
        kind: 'lede',
        text: 'Hawkeye turns thousands of ordinary phones into a network of independent witnesses. No single report is trusted on its own — trust is earned when separate people, provably at the same place, say the same thing.',
      },
      { kind: 'label', text: 'Take Part' },
      {
        kind: 'actions',
        items: [
          {
            icon: 'camera',
            title: 'Observe Your Polling Unit',
            body: 'Photograph the announced EC8A sheet and the venue on election day. Your report is signed on your device and recorded permanently.',
            cta: 'Start observing',
            href: '/report/result',
          },
          {
            icon: 'bell',
            title: 'Follow Races & Get Alerts',
            body: 'Watch the leaderboard live, and subscribe to alerts for the presidential race, your state, district or constituency.',
            cta: 'Follow a race',
            href: '/(tabs)/results',
          },
          {
            icon: 'map-pin',
            title: 'Map Your Unit Before Election Day',
            body: 'Most polling units have no verified GPS location. Stand at yours and pin it before the vote.',
            cta: 'Map a unit',
            href: '/map-unit',
          },
        ],
      },
      { kind: 'label', text: 'Becoming Trusted' },
      {
        kind: 'steps',
        items: [
          {
            title: 'Photograph the Evidence',
            body: 'Two live photos — the EC8A sheet and the venue — each GPS-stamped the moment it is taken. Gallery uploads are impossible.',
          },
          {
            title: 'Sign on Your Device',
            body: 'Counts, photo fingerprints and location are signed with a key that never leaves your phone, then chained onto a public ledger. Nothing can be edited or quietly deleted afterwards.',
          },
          {
            title: 'Independent Agreement',
            body: 'A count is marked verified only when separate observers at the same unit report matching numbers — backed by GPS, matching venue photos, and the digits read from the sheet itself.',
          },
        ],
      },
      { kind: 'label', text: 'The Machinery' },
      { kind: 'para', text: 'Tap a layer to see how it works.' },
      {
        kind: 'layers',
        items: [
          {
            icon: 'user-check',
            title: 'One Person, One Identity',
            points: [
              'A verified phone number is one observer identity. Numbers are stored only as one-way hashes — never readable, never published.',
              'Every phone also carries a device fingerprint. One device can report each race once, no matter how many SIM cards or accounts it holds.',
            ],
          },
          {
            icon: 'map-pin',
            title: 'Location That Proves Itself',
            points: [
              'Units with a confirmed location are geofenced: reports are accepted only from people standing there.',
              'Units without one accept reports, but the count stays visibly location-unverified until at least three independent GPS positions cluster at the same spot.',
              'Before election day, volunteers crowd-map units the same way — three agreeing fixes confirm a location in advance.',
              'Every unit also has an approximate area from open geographic data; reports far outside it are rejected outright.',
            ],
          },
          {
            icon: 'camera',
            title: "Evidence That Can't Be Recycled",
            points: [
              'Photos are captured live in the app — the EC8A sheet is auto-detected, flattened and quality-checked for blur and glare.',
              'Each photo is GPS-stamped at capture; sheet, venue and submission positions must agree, and photos expire within minutes.',
              "Re-submitting someone else's photo — or a near-identical copy — is detected and rejected by image fingerprinting.",
              'Venue photos from different observers are feature-matched to confirm they stood at the same physical place.',
              'The typed counts are cross-checked against the digits machine-read from the sheet photograph itself.',
            ],
          },
          {
            icon: 'link',
            title: 'A Ledger Nobody Can Quietly Edit',
            points: [
              "Each report is signed on the observer's phone, then chained to the previous entry by cryptographic hash.",
              'Changing or removing any past entry breaks the chain publicly. Anyone can re-verify the whole chain on their own phone.',
            ],
          },
          {
            icon: 'bar-chart-2',
            title: 'From Reports to the Leaderboard',
            points: [
              'Matching counts push a unit’s confidence up; conflicting counts mark it disputed — visibly, never silently resolved.',
              'Each report is tagged to its races automatically — state, senatorial district and federal constituency come from the official register.',
              'The leaderboard rolls verified units up per race, with grey regions still awaiting reports.',
            ],
          },
        ],
      },
      {
        kind: 'callout',
        icon: 'shield',
        title: 'Verify It Yourself',
        body: 'You never have to take our word for any of this — recompute the entire hash chain on your own phone.',
      },
    ],
  },

  guide: {
    title: 'Observer Guide',
    kicker: 'Before, during and after the count',
    sections: ['Before Election Day', 'On Election Day', 'The Rules', 'If Something Goes Wrong'],
    blocks: [
      {
        kind: 'lede',
        text: 'Everything you need to do — before, during and after the count at your polling unit.',
      },
      { kind: 'label', text: 'Before Election Day' },
      {
        kind: 'steps',
        items: [
          {
            title: 'Verify Your Phone',
            body: 'Enter your Nigerian mobile number and confirm the one-time code. Do this days ahead — not in the queue.',
          },
          {
            title: 'Map Your Polling Unit',
            body: 'Visit your unit and capture its GPS position while standing there. Once a few people do this, the unit is geofenced for election day.',
          },
          {
            title: 'Do a Dry Run',
            body: 'Run a practice report on Wi-Fi, grant camera and location permission, and charge enough to last through the evening count.',
          },
        ],
      },
      { kind: 'label', text: 'On Election Day' },
      {
        kind: 'steps',
        start: 4,
        items: [
          {
            title: 'Stay for the Count',
            body: 'Voting ends, then the presiding officer counts ballots publicly and fills in the EC8A sheet. The announcement is the moment that matters.',
          },
          {
            title: 'Photograph the EC8A Sheet',
            body: 'Point the camera at the whole sheet — it captures when steady.',
            bullets: [
              'Good light, no glare, no fingers over the figures column.',
              'If the app warns the photo is blurry or washed out, retake it.',
            ],
          },
          {
            title: 'Photograph the Venue',
            body: 'A separate photo of the building, banner or surroundings. This confirms different observers stood at the same place.',
          },
          {
            title: 'Enter the Counts and Submit Immediately',
            body: 'Type each party’s announced figure exactly, then sign and submit while still at the unit. Photos expire if you wait.',
            bullets: [
              'Several elections may be counted at your unit the same day — submit one report per election, each with its own photos.',
            ],
          },
        ],
      },
      { kind: 'label', text: 'The Rules' },
      {
        kind: 'rules',
        tone: 'enforced',
        title: 'The App Enforces These',
        items: [
          'Live photos only; no gallery uploads, no screenshots.',
          'One report per election per polling unit per observer — and one per election per device, regardless of how many SIMs it holds.',
          'Reports are permanent. Nothing can be edited or deleted after signing.',
          'Geofenced units only accept reports from people standing there.',
        ],
      },
      { kind: 'label', text: 'If Something Goes Wrong' },
      {
        kind: 'layers',
        items: [
          {
            icon: 'help-circle',
            title: 'Troubleshooting',
            points: [
              'GPS too weak — step into open sky, away from roofing, and retry.',
              'No code arrived — reopen the bot link and share your contact; the number must match the one you typed.',
              'Photos too old — retake both photos and submit straight away.',
              'Session expired — verify your phone again; your identity and past reports are unchanged.',
            ],
          },
        ],
      },
      {
        kind: 'callout',
        icon: 'play-circle',
        title: 'Rehearse It First',
        body: 'The practice run walks the exact steps — photos, counts, review, submit — without publishing anything.',
      },
    ],
  },

  about: {
    title: 'About Hawkeye',
    kicker: 'Independent. Nonpartisan.',
    sections: ['Why It Exists', 'What We Are Not', 'Who Runs It', 'Contact'],
    blocks: [
      {
        kind: 'lede',
        text: 'An independent, nonpartisan record of what was announced at each polling unit — documented, verified and published by ordinary Nigerians.',
      },
      { kind: 'label', text: 'Why It Exists' },
      {
        kind: 'para',
        text: 'Elections are won at the polling unit, then at collation. When numbers can change on the way up, trust collapses. So every report is photographed, signed on the observer’s own phone, and chained on a public ledger.',
      },
      { kind: 'label', text: 'What We Are Not' },
      {
        kind: 'callout',
        icon: 'alert-circle',
        title: 'Hawkeye Does Not Declare Winners',
        body: 'Its tallies are not official results — those come only from INEC. It is a record built to aid scrutiny, unaffiliated with INEC, any party, candidate or campaign.',
      },
      { kind: 'label', text: 'Who Runs It' },
      {
        kind: 'para',
        text: 'Built and operated by IniXien, LLC (© 2026). Observers’ reports, and the ledger they form, stay open for anyone to read and verify.',
      },
      {
        kind: 'actions',
        items: [
          {
            icon: 'camera',
            title: 'Become an Observer',
            body: 'Verify your number once, then report from the unit where you watch the count.',
            cta: 'Start',
            href: '/report/result',
          },
          {
            icon: 'shield',
            title: 'Verify the Ledger',
            body: 'Recompute the whole chain on your own phone. Trust nobody, including us.',
            cta: 'Open',
            href: '/ledger',
          },
          {
            icon: 'heart',
            title: 'Support Hawkeye',
            body: 'Founder-funded, no political money or advertisers. Crowd support keeps it running and independent.',
            cta: 'Donate',
            href: '/support',
          },
        ],
      },
      { kind: 'label', text: 'Contact' },
      {
        kind: 'contacts',
        items: [
          {
            icon: 'mail',
            label: 'Email',
            value: 'info@hawkeye.com.ng',
            url: 'mailto:info@hawkeye.com.ng',
          },
          {
            icon: 'send',
            label: 'Telegram',
            value: '@HawkEyeNGBot',
            url: 'https://t.me/HawkEyeNGBot',
          },
        ],
      },
      {
        kind: 'para',
        text: 'For data access or deletion requests, see Privacy & Data.',
      },
    ],
  },

  privacy: {
    title: 'Privacy & Data',
    kicker: 'What we keep, and what we never do',
    sections: ['What We Collect', 'Public vs Private', 'What We Never Do', 'Your Rights'],
    blocks: [
      {
        kind: 'lede',
        text: 'Built to protect the people who use it. Exactly what we keep, what becomes public, and what never leaves your phone.',
      },
      { kind: 'label', text: 'What We Collect' },
      {
        kind: 'layers',
        items: [
          {
            icon: 'hash',
            title: 'Your Number — as a Hash',
            points: [
              'One-way, never reversible. We cannot see it, show it, or hand it over.',
              'It exists so one number equals one observer.',
            ],
          },
          {
            icon: 'file-text',
            title: 'Your Reports',
            points: [
              'The counts, two live photos, and where each was taken.',
            ],
          },
          {
            icon: 'smartphone',
            title: 'A Device Fingerprint',
            points: [
              'Hashed, so one phone cannot report the same race twice.',
            ],
          },
          {
            icon: 'send',
            title: 'Your Telegram Link',
            points: [
              'The chat ID only, so the bot can reach you.',
              'We never read your messages or contacts.',
            ],
          },
        ],
      },
      { kind: 'label', text: 'Public vs Private' },
      {
        kind: 'rules',
        tone: 'public',
        title: 'Public, by Design',
        items: [
          'Your counts, photos and their locations — on a tamper-evident ledger, never edited or deleted. That permanence is what makes them worth anything.',
          'Tied to an anonymous observer ID, never to you.',
          'Incident media appears only after human review.',
        ],
      },
      {
        kind: 'rules',
        tone: 'private',
        title: 'Never Published',
        items: [
          'Your actual number — only the hash exists.',
          'Your identity — no report is linked to your name or number.',
          'One-time codes — they expire in minutes and are deleted on use.',
        ],
      },
      { kind: 'label', text: 'What We Never Do' },
      {
        kind: 'rules',
        tone: 'never',
        items: [
          'Sell, rent or share your data.',
          'Run ads or third-party trackers.',
          'Use tracking cookies — only a sign-in token and your keys, kept on your device.',
        ],
      },
      {
        kind: 'callout',
        icon: 'lock',
        title: 'Security',
        body: 'All traffic is encrypted. Phone numbers are HMAC-hashed, reports are signed on your own device with a key that never leaves it, and access is rate-limited and bot-screened.',
      },
      { kind: 'label', text: 'Your Rights' },
      {
        kind: 'para',
        text: 'You can delete your observer ID yourself at any time from your profile. This removes your signing key, device link, Telegram link and alert subscriptions.',
      },
      {
        kind: 'rules',
        tone: 'public',
        title: 'Two Things Remain, by Design',
        items: [
          'Public ledger entries — permanent and anonymous; that permanence is what makes them trustworthy.',
          "The one-way hash of your number, kept so a deleted identity can't be reused to file duplicate reports. Re-registering the same number restores your original observer ID.",
        ],
      },
      {
        kind: 'contacts',
        items: [
          {
            icon: 'mail',
            label: 'Data requests (NDPA)',
            value: 'info@hawkeye.com.ng',
            url: 'mailto:info@hawkeye.com.ng',
          },
        ],
      },
    ],
  },
};

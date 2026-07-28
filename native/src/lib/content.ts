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
  /** Jump chips, in order; each maps to a 'label' block of the same text. */
  sections: string[];
  blocks: Block[];
};

export const PAGES: Record<string, Page> = {
  how: {
    title: 'How Hawkeye Works',
    kicker: 'Trust, earned by agreement',
    sections: ['Take part', 'Becoming trusted', 'The machinery'],
    blocks: [
      {
        kind: 'lede',
        text: 'Hawkeye turns thousands of ordinary phones into a network of independent witnesses. No single report is trusted on its own — trust is earned when separate people, provably at the same place, say the same thing.',
      },
      { kind: 'label', text: 'Take part' },
      {
        kind: 'actions',
        items: [
          {
            icon: 'camera',
            title: 'Observe your polling unit',
            body: 'Photograph the announced EC8A sheet and the venue on election day. Your report is signed on your device and recorded permanently.',
            cta: 'Start observing',
            href: '/report/result',
          },
          {
            icon: 'bell',
            title: 'Follow races & get alerts',
            body: 'Watch the leaderboard live, and subscribe to alerts for the presidential race, your state, district or constituency.',
            cta: 'Follow a race',
            href: '/(tabs)/results',
          },
          {
            icon: 'map-pin',
            title: 'Map your unit before election day',
            body: 'Most polling units have no verified GPS location. Stand at yours and pin it before the vote.',
            cta: 'Map a unit',
            href: '/map-unit',
          },
        ],
      },
      { kind: 'label', text: 'Becoming trusted' },
      {
        kind: 'steps',
        items: [
          {
            title: 'Photograph the evidence',
            body: 'Two live photos — the EC8A sheet and the venue — each GPS-stamped the moment it is taken. Gallery uploads are impossible.',
          },
          {
            title: 'Sign on your device',
            body: 'Counts, photo fingerprints and location are signed with a key that never leaves your phone, then chained onto a public ledger. Nothing can be edited or quietly deleted afterwards.',
          },
          {
            title: 'Independent agreement',
            body: 'A count is marked verified only when separate observers at the same unit report matching numbers — backed by GPS, matching venue photos, and the digits read from the sheet itself.',
          },
        ],
      },
      { kind: 'label', text: 'The machinery' },
      { kind: 'para', text: 'Tap a layer to see how it works.' },
      {
        kind: 'layers',
        items: [
          {
            icon: 'user-check',
            title: 'One person, one identity',
            points: [
              'A verified phone number is one observer identity. Numbers are stored only as one-way hashes — never readable, never published.',
              'Every phone also carries a device fingerprint. One device can report each race once, no matter how many SIM cards or accounts it holds.',
            ],
          },
          {
            icon: 'map-pin',
            title: 'Location that proves itself',
            points: [
              'Units with a confirmed location are geofenced: reports are accepted only from people standing there.',
              'Units without one accept reports, but the count stays visibly location-unverified until at least three independent GPS positions cluster at the same spot.',
              'Before election day, volunteers crowd-map units the same way — three agreeing fixes confirm a location in advance.',
              'Every unit also has an approximate area from open geographic data; reports far outside it are rejected outright.',
            ],
          },
          {
            icon: 'camera',
            title: "Evidence that can't be recycled",
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
            title: 'A ledger nobody can quietly edit',
            points: [
              "Each report is signed on the observer's phone, then chained to the previous entry by cryptographic hash.",
              'Changing or removing any past entry breaks the chain publicly. Anyone can re-verify the whole chain on their own phone.',
            ],
          },
          {
            icon: 'bar-chart-2',
            title: 'From reports to the leaderboard',
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
        title: 'Verify it yourself',
        body: 'You never have to take our word for any of this — recompute the entire hash chain on your own phone.',
      },
    ],
  },

  guide: {
    title: 'Observer Guide',
    kicker: 'Before, during and after the count',
    sections: ['Before election day', 'On election day', 'The rules', 'If something goes wrong'],
    blocks: [
      {
        kind: 'lede',
        text: 'Everything you need to do — before, during and after the count at your polling unit.',
      },
      { kind: 'label', text: 'Before election day' },
      {
        kind: 'steps',
        items: [
          {
            title: 'Verify your phone',
            body: 'Enter your Nigerian mobile number and confirm the one-time code. Do this days ahead — not in the queue.',
          },
          {
            title: 'Map your polling unit',
            body: 'Visit your unit and capture its GPS position while standing there. Once a few people do this, the unit is geofenced for election day.',
          },
          {
            title: 'Do a dry run',
            body: 'Run a practice report on Wi-Fi, grant camera and location permission, and charge enough to last through the evening count.',
          },
        ],
      },
      { kind: 'label', text: 'On election day' },
      {
        kind: 'steps',
        start: 4,
        items: [
          {
            title: 'Stay for the count',
            body: 'Voting ends, then the presiding officer counts ballots publicly and fills in the EC8A sheet. The announcement is the moment that matters.',
          },
          {
            title: 'Photograph the EC8A sheet',
            body: 'Point the camera at the whole sheet — it captures when steady.',
            bullets: [
              'Good light, no glare, no fingers over the figures column.',
              'If the app warns the photo is blurry or washed out, retake it.',
            ],
          },
          {
            title: 'Photograph the venue',
            body: 'A separate photo of the building, banner or surroundings. This confirms different observers stood at the same place.',
          },
          {
            title: 'Enter the counts and submit immediately',
            body: 'Type each party’s announced figure exactly, then sign and submit while still at the unit. Photos expire if you wait.',
            bullets: [
              'Several elections may be counted at your unit the same day — submit one report per election, each with its own photos.',
            ],
          },
        ],
      },
      { kind: 'label', text: 'The rules' },
      {
        kind: 'rules',
        tone: 'enforced',
        title: 'The app enforces these',
        items: [
          'Live photos only; no gallery uploads, no screenshots.',
          'One report per election per polling unit per observer — and one per election per device, regardless of how many SIMs it holds.',
          'Reports are permanent. Nothing can be edited or deleted after signing.',
          'Geofenced units only accept reports from people standing there.',
        ],
      },
      { kind: 'label', text: 'If something goes wrong' },
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
        title: 'Rehearse it first',
        body: 'The practice run walks the exact steps — photos, counts, review, submit — without publishing anything.',
      },
    ],
  },

  about: {
    title: 'About Hawkeye',
    kicker: 'Independent. Nonpartisan.',
    sections: ['Why it exists', 'What we are not', 'Who runs it', 'Contact'],
    blocks: [
      {
        kind: 'lede',
        text: 'An independent, nonpartisan transparency platform that lets ordinary Nigerians document, verify and publish the results announced at their polling units — so anyone can check the numbers.',
      },
      { kind: 'label', text: 'Why it exists' },
      {
        kind: 'para',
        text: 'Elections are won and lost at the polling unit, and then at collation. When results can be altered on the way up, trust collapses. Hawkeye puts a network of independent witnesses on the ground: every report is photographed, signed on the observer’s own phone, and recorded on a public, tamper-evident ledger.',
      },
      { kind: 'label', text: 'What we are not' },
      {
        kind: 'callout',
        icon: 'alert-circle',
        title: 'Hawkeye does not declare winners',
        body: 'Its tallies are not official results. It is a public, independent record of what was announced, built to aid scrutiny. Official results are declared by INEC. Hawkeye is not affiliated with INEC, any political party, candidate or campaign.',
      },
      { kind: 'label', text: 'Who runs it' },
      {
        kind: 'para',
        text: 'Hawkeye is built and operated by IniXien, LLC. The platform, its software and its content are © 2026 IniXien, LLC. Reports submitted by observers, and the public ledger they form, remain open for anyone to read and verify.',
      },
      {
        kind: 'actions',
        items: [
          {
            icon: 'camera',
            title: 'Become an observer',
            body: 'Verify your number once, then report from the unit where you watch the count.',
            cta: 'Start',
            href: '/report/result',
          },
          {
            icon: 'shield',
            title: 'Verify the ledger',
            body: 'Recompute the whole chain on your own phone. Trust nobody, including us.',
            cta: 'Open',
            href: '/ledger',
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
    sections: ['What we collect', 'Public vs private', 'What we never do', 'Your rights'],
    blocks: [
      {
        kind: 'lede',
        text: 'Hawkeye is built to protect the people who use it. This is exactly what we collect, why, what becomes public, and what stays private.',
      },
      { kind: 'label', text: 'What we collect' },
      {
        kind: 'layers',
        items: [
          {
            icon: 'hash',
            title: 'Your phone number — as a hash',
            points: [
              'Stored only as a one-way cryptographic hash. We never keep or display the actual number; it exists so one number equals one observer identity.',
            ],
          },
          {
            icon: 'file-text',
            title: 'Your reports',
            points: [
              'The counts you enter and two live photos (the result sheet and the venue), each stamped with the GPS location where it was taken.',
            ],
          },
          {
            icon: 'smartphone',
            title: 'A device fingerprint',
            points: [
              "A hash of your device's characteristics, to stop one phone filing multiple reports for the same race.",
            ],
          },
          {
            icon: 'send',
            title: 'Your Telegram link',
            points: [
              'If you verify or subscribe via Telegram, we store the chat ID so the bot can send your code and alerts. We never read your Telegram messages or contacts.',
            ],
          },
        ],
      },
      { kind: 'label', text: 'Public vs private' },
      {
        kind: 'rules',
        tone: 'public',
        title: 'Public, by design',
        items: [
          'Your submitted counts, photos and their locations — published on a tamper-evident ledger and never edited or deleted. That permanence is what makes them trustworthy.',
          'Reports are tied to an anonymous observer ID, never to you personally.',
          'Incident media is shown publicly only after human review.',
        ],
      },
      {
        kind: 'rules',
        tone: 'private',
        title: 'Never published',
        items: [
          'Your actual phone number — only the hash is stored.',
          'Your identity — reports are not publicly linked to your name or number.',
          'One-time codes, which expire within minutes and are deleted once used.',
        ],
      },
      { kind: 'label', text: 'What we never do' },
      {
        kind: 'rules',
        tone: 'never',
        items: [
          'We do not sell, rent or share your data with anyone.',
          'We run no advertising and no third-party trackers.',
          'We use no tracking cookies — the app keeps only a sign-in token and your keys, on your device.',
        ],
      },
      {
        kind: 'callout',
        icon: 'lock',
        title: 'Security',
        body: 'All traffic is encrypted. Phone numbers are HMAC-hashed, reports are signed on your own device with a key that never leaves it, and access is rate-limited and bot-screened.',
      },
      { kind: 'label', text: 'Your rights' },
      {
        kind: 'para',
        text: 'You can delete your observer ID yourself at any time from your profile. This removes your signing key, device link, Telegram link and alert subscriptions.',
      },
      {
        kind: 'rules',
        tone: 'public',
        title: 'Two things remain, by design',
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

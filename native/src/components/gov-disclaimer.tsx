import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { ModalCard } from '@/components/modal-card';
import { IconLink } from '@/components/icon-link';

/**
 * THIS IS THE ONLY COMPONENT IN THE APP THAT UNDERLINES TEXT — checked, and the
 * reason a rendering fault here reads as "every hyperlink in the app is
 * choppy": the banner is mounted on results, races, integrity, the reports log
 * and More, so one bad rule appears almost everywhere. Content links elsewhere
 * are rows with an external-link glyph, and race sources are bold green; none
 * of them draw a rule.
 *
 * NO UNDERLINES, AND NO RULES EITHER. It took three attempts to get here.
 *
 * First, more leading, on the theory that a tight line box clipped the rule.
 * Wrong, or half of it: iOS draws textDecorationLine tight to the baseline and
 * descenders cross it — the g in "nigeria", the g in "org" — so the rule was
 * punched through, not clipped, and RN exposes no offset or thickness to tune.
 *
 * Second, the rules were redrawn as a border below the line box, where no glyph
 * reaches. Correct, and it looked wrong: under a 12px word in a 20px line box
 * the border sits far enough below to read as a stray line.
 *
 * Third and current: an icon. It says "this opens something" more plainly than
 * a rule did, it tells an external site (external-link) from an in-app panel
 * (chevron-right), and no text renderer can get it wrong. See IconLink.
 *
 * Google Play "Misleading Claims" compliance (Capacitor app rejection,
 * 2026-08-03): an app presenting government-related information must state
 * in-app that it does not represent the government entity and link the official
 * source(s). Twin of the web's .gov-disclaimer (menu.js).
 *
 * One-liner + modal: the Play-critical claim (independent, not affiliated with
 * INEC) stays visible without interaction; the full statement + official links
 * open in a modal, so the banner no longer dominates every screen's layout.
 * Mounted on the government-info surfaces: results, races, integrity, reports
 * log, More.
 */
export function GovDisclaimer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Bright brand gold, not a tinted surface. This is a compliance notice
          that has to be SEEN — on the dark theme a bg-surface chip receded into
          the page, which is the opposite of what a "we are not the government"
          disclaimer is for. Gold also keeps it distinct from the green the rest
          of the app uses for its own actions. Ink is near-black for contrast on
          the gold (white would sit around 1.9:1 and fail badly). */}
      {/* One flowing sentence with "Details" INLINE at its end — not a text
          column beside a right-aligned link, which stretched the card to three
          lines and read as a separate control. */}
      <Pressable onPress={() => setOpen(true)} className="mb-3 rounded-xl bg-hawk-gold px-3.5 py-2">
        {/* One line. The modal carries the full statement, so the bar only has to
            make the claim itself — neither government nor INEC. */}
        {/* flex-row + flex-wrap rather than one Text with numberOfLines={1}:
            the sentence is a compliance statement and must never be truncated,
            so on a narrow screen it wraps instead. chevron-right, not
            external-link — this one opens a panel inside the app. No onPress:
            the whole banner is already the tap target, and nesting a second
            pressable inside it competes for the touch. */}
        <View className="flex-row flex-wrap items-center">
          <Text className="text-xs font-bold leading-5 text-[#2b1f00]">
            Not government or INEC affiliated.{' '}
          </Text>
          <IconLink
            label="Details"
            icon="chevron-right"
            className="text-xs font-bold"
            color="#2b1f00"
            size={12}
          />
        </View>
      </Pressable>

      {/* Through ModalCard so the statement and its official links stay
          reachable on a small screen. This is a Play compliance notice — a
          reader must be able to get to the whole of it and to the INEC links,
          which sit at the BOTTOM of the text. */}
      <ModalCard visible={open} onClose={() => setOpen(false)} title="Not a government service">
        <Text className="pb-3 text-sm leading-5 text-ink">
          Hawkeye is an independent, citizen-run transparency tool. It is not affiliated with,
          endorsed by, or acting on behalf of INEC or any government entity, and it does not
          declare election results. Figures here are unofficial crowd reports. Official results
          and electoral information come from INEC:
        </Text>
        {/* flex-wrap: the two URLs are ~250dp side by side and the card is
            narrower than that at a large font scale, and neither shrinks
            (Yoga defaults flexShrink to 0). These are the Play "Misleading
            Claims" remedy — the worst text in the app to truncate. */}
        <View className="flex-row flex-wrap gap-4">
          <IconLink
            label="inecnigeria.org"
            onPress={() => Linking.openURL('https://www.inecnigeria.org')}
          />
          <IconLink
            label="inecelectionresults.ng"
            onPress={() => Linking.openURL('https://www.inecelectionresults.ng')}
          />
        </View>
      </ModalCard>
    </>
  );
}

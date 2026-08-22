import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { ModalCard } from '@/components/modal-card';
import { RuleLink } from '@/components/rule-link';

/**
 * THIS IS THE ONLY COMPONENT IN THE APP THAT UNDERLINES TEXT — checked, and the
 * reason a rendering fault here reads as "every hyperlink in the app is
 * choppy": the banner is mounted on results, races, integrity, the reports log
 * and More, so one bad rule appears almost everywhere. Content links elsewhere
 * are rows with an external-link glyph, and race sources are bold green; none
 * of them draw a rule.
 *
 * NOTHING HERE USES textDecorationLine ANY MORE, and that took two goes.
 *
 * The first attempt gave the underlined text more leading, on the theory that a
 * tight line box was clipping the rule. That was wrong, or at best half of it:
 * the links read "inecnigeria.org" and "inecelectionresults.ng", and iOS draws
 * its rule tight to the baseline where every descender crosses it — the g in
 * "nigeria", the g in "org" — so the rule was punched through, not clipped.
 * There is no React Native API for underline offset or thickness, so it cannot
 * be tuned.
 *
 * "Details" was then kept as an underlined Text on the grounds that it has no
 * descenders to collide with. It still came out ragged. At 12px bold on iOS
 * textDecorationLine is simply not dependable, so it is a RuleLink too, and
 * every rule in this app is now a border on a View.
 *
 * Any NEW link should be a RuleLink. If one has to sit mid-sentence, put the
 * sentence in a flex-row and wrap, as the banner below does — do not reach back
 * for the underline class.
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
        {/* "Details" is a RuleLink now too. More leading did not save it: the
            word has no descenders, so nothing was punching through it, and it
            still came out ragged — textDecorationLine simply is not dependable
            at 12px bold on iOS, and there is no knob for offset or thickness.
            So the last underline in the app is gone and every rule is a border.

            flex-row + flex-wrap rather than one Text with numberOfLines={1}:
            the sentence is a compliance statement and must never be truncated,
            so on a narrow screen it wraps instead. No onPress on the RuleLink —
            the whole banner is already the tap target, and nesting a second one
            inside it competes for the touch. */}
        <View className="flex-row flex-wrap items-center">
          <Text className="text-xs font-bold leading-5 text-[#2b1f00]">
            Not government or INEC affiliated.{' '}
          </Text>
          <RuleLink label="Details" className="text-xs font-bold leading-5 text-[#2b1f00]" color="#2b1f00" />
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
        {/* RuleLink, not an underlined Text. Both of these end in a descender
            — the g in "nigeria", the g in "org" — and iOS drew its rule through
            them, breaking it into pieces. The border sits below the line box
            where no glyph reaches. */}
        {/* flex-wrap: the two URLs are ~250dp side by side and the card is
            narrower than that at a large font scale, and neither shrinks
            (Yoga defaults flexShrink to 0). These are the Play "Misleading
            Claims" remedy — the worst text in the app to truncate. */}
        <View className="flex-row flex-wrap gap-4">
          <RuleLink
            label="inecnigeria.org"
            onPress={() => Linking.openURL('https://www.inecnigeria.org')}
          />
          <RuleLink
            label="inecelectionresults.ng"
            onPress={() => Linking.openURL('https://www.inecelectionresults.ng')}
          />
        </View>
      </ModalCard>
    </>
  );
}

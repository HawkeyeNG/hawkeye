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
 * WHAT WAS ACTUALLY WRONG: iOS draws textDecorationLine tight to the baseline,
 * and descenders cross it. "inecnigeria.org" has a g in the middle and another
 * in the suffix, and the rule was broken at each one — not clipped, punched
 * through. There is no React Native API for underline offset or thickness, so
 * it cannot be tuned; the rule has to leave the glyphs' path entirely. Those
 * two links are now RuleLink, which draws a border below the line box.
 *
 * "Details" stays an underlined Text because it is INSIDE a flowing sentence —
 * a nested Text cannot carry a View, so a border is not available to it. It
 * survives on two counts: the word has no descenders for a rule to collide
 * with, and leading-5 gives the line box room so the rule is not clipped at its
 * edge either. Any NEW link should be a RuleLink; reach for the inline form
 * only when the link genuinely sits mid-sentence, and keep it descender-free.
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
        {/* leading-5, not leading-4: a 16px line box on a 12px font left the
            rule sitting on the box's edge, where it clipped. 20px gives it room
            inside the line. This is the SECOND of the two things that made
            underlines look ragged on iOS — the other, descenders punching
            through, is why the links below are RuleLinks instead. */}
        <Text className="text-xs leading-5 text-[#2b1f00]" numberOfLines={1}>
          <Text className="font-bold text-[#2b1f00]">Not government or INEC affiliated.</Text>{' '}
          <Text className="font-bold text-[#2b1f00] underline">Details</Text>
        </Text>
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
        <View className="flex-row gap-4">
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

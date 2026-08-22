import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { ModalCard } from '@/components/modal-card';

/**
 * THIS IS THE ONLY COMPONENT IN THE APP THAT UNDERLINES TEXT — checked, and the
 * reason a rendering fault here reads as "every hyperlink in the app is
 * choppy": the banner is mounted on results, races, integrity, the reports log
 * and More, so one bad rule appears almost everywhere. Content links elsewhere
 * are rows with an external-link glyph, and race sources are bold green; none
 * of them draw a rule.
 *
 * Every underlined Text here therefore carries explicit, generous leading. iOS
 * draws the rule a pixel or two below the baseline, and a line box only a
 * little taller than the font leaves nothing for it to sit in — so it lands on
 * the edge and comes out clipped, present under some glyphs and missing under
 * others. Android is unaffected. If a rule ever needs to be added elsewhere,
 * give it the same headroom, or draw it as a border on a View and stop relying
 * on textDecorationLine altogether.
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
        {/* leading-5, not leading-4. iOS draws an underline a pixel or two below
            the baseline, and a 16px line box on a 12px font leaves almost
            nothing under it — so the rule under "Details" landed on the edge of
            the line box and came out clipped and broken-looking, present under
            some glyphs and missing under others. 20px gives the descender and
            the rule room to sit inside the line. Android was unaffected, which
            is why it only showed up on the phone. */}
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
        <View className="flex-row gap-4">
          <Pressable onPress={() => Linking.openURL('https://www.inecnigeria.org')}>
            <Text className="text-sm font-bold leading-6 text-good-ink underline">inecnigeria.org</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL('https://www.inecelectionresults.ng')}>
            <Text className="text-sm font-bold leading-6 text-good-ink underline">inecelectionresults.ng</Text>
          </Pressable>
        </View>
      </ModalCard>
    </>
  );
}

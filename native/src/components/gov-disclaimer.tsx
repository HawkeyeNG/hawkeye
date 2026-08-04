import { useState } from 'react';
import { Linking, Modal, Pressable, Text, View } from 'react-native';

/**
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
        <Text className="text-xs leading-4 text-[#2b1f00]" numberOfLines={1}>
          <Text className="font-bold text-[#2b1f00]">Not government or INEC affiliated.</Text>{' '}
          <Text className="font-bold text-[#2b1f00] underline">Details</Text>
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* Backdrop tap closes; inner Pressable swallows the tap so the card stays. */}
        <Pressable
          onPress={() => setOpen(false)}
          className="flex-1 items-center justify-center bg-black/50 px-6"
        >
          <Pressable onPress={() => {}} className="w-full max-w-md rounded-2xl bg-card p-5">
            <Text className="pb-2 text-lg font-bold text-ink">Not a government service</Text>
            <Text className="pb-3 text-sm leading-5 text-ink">
              Hawkeye is an independent, citizen-run transparency tool. It is not affiliated with,
              endorsed by, or acting on behalf of INEC or any government entity, and it does not
              declare election results. Figures here are unofficial crowd reports. Official results
              and electoral information come from INEC:
            </Text>
            <View className="flex-row gap-4 pb-4">
              <Pressable onPress={() => Linking.openURL('https://www.inecnigeria.org')}>
                <Text className="text-sm font-bold text-good-ink underline">inecnigeria.org</Text>
              </Pressable>
              <Pressable onPress={() => Linking.openURL('https://www.inecelectionresults.ng')}>
                <Text className="text-sm font-bold text-good-ink underline">inecelectionresults.ng</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => setOpen(false)} className="rounded-full bg-good py-3">
              <Text className="text-center text-sm font-bold text-good-ink">Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

import { Linking, Pressable, Text, View } from 'react-native';

/**
 * Google Play "Misleading Claims" compliance (Capacitor app rejection,
 * 2026-08-03): an app presenting government-related information must state
 * in-app that it does not represent the government entity and link the official
 * source(s). Twin of the web's .gov-disclaimer (menu.js). Mounted on the
 * government-info surfaces: results, races, integrity, reports log, More.
 */
export function GovDisclaimer() {
  return (
    <View className="mb-3 rounded-xl border border-line bg-warn px-3.5 py-2.5">
      <Text className="text-xs leading-4 text-ink">
        <Text className="font-bold">Not a government service.</Text> Hawkeye is an independent,
        citizen-run transparency tool — not affiliated with INEC or any government entity, and it
        does not declare election results. Figures here are unofficial crowd reports. Official
        results and electoral information come from INEC:
      </Text>
      <View className="flex-row gap-4 pt-1">
        <Pressable onPress={() => Linking.openURL('https://www.inecnigeria.org')}>
          <Text className="text-xs font-bold text-good-ink underline">inecnigeria.org</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL('https://www.inecelectionresults.ng')}>
          <Text className="text-xs font-bold text-good-ink underline">inecelectionresults.ng</Text>
        </Pressable>
      </View>
    </View>
  );
}

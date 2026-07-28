import { Feather } from '@expo/vector-icons';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';

/**
 * Alerts — placeholder until sign-in lands natively. The feed itself is
 * per-observer (`/api/notifications`, Bearer-gated), so there is nothing
 * public to show; the screen states that honestly instead of faking items.
 */
export default function Alerts() {
  return (
    <SafeAreaView className="flex-1 bg-hawk-mist" edges={['top']}>
      <View className="px-4 pb-2 pt-4">
        <Text className="text-2xl font-bold text-hawk-ink">Alerts</Text>
      </View>
      <View className="mx-4 mt-4 items-center rounded-2xl bg-white px-6 py-10">
        <Feather name="bell" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-base font-semibold text-hawk-ink">
          Sign in to get alerts
        </Text>
        <Text className="pt-1 text-center text-sm text-neutral-500">
          Race updates, docket cases and replies to your reports arrive here once
          the native sign-in flow ships.
        </Text>
      </View>
    </SafeAreaView>
  );
}

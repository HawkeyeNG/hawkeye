import { Text, View } from "react-native";

/** Throwaway: proves NativeWind classes compile end-to-end. Delete once real screens exist. */
export function NwProof() {
  return (
    <View className="mt-4 rounded-2xl bg-hawk-green px-4 py-3">
      <Text className="text-center font-semibold text-hawk-gold">
        NativeWind OK
      </Text>
    </View>
  );
}

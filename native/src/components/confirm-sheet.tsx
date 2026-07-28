import { Feather } from '@expo/vector-icons';
import { Modal, Pressable, Text, View } from 'react-native';

import { BRAND } from '@/lib/api';

/**
 * Two-step confirmation as an in-app sheet rather than a system Alert.
 *
 * Consequential account actions get the same shape everywhere: what happens,
 * spelled out, then a deliberate choice. Cancel sits under the action and is
 * the visually quieter of the two, so the confirming tap is never the reflex
 * one — an Alert's stacked buttons make "OK" exactly that.
 */
export function ConfirmSheet({
  visible,
  icon,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  icon: keyof typeof Feather.glyphMap;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="rounded-t-3xl bg-hawk-mist px-5 pb-8 pt-5">
          <View className="flex-row items-center pb-2">
            <View
              className={`h-10 w-10 items-center justify-center rounded-2xl ${
                danger ? 'bg-red-100' : 'bg-white'
              }`}
            >
              <Feather name={icon} size={19} color={danger ? '#b91c1c' : BRAND.leaf} />
            </View>
            <Text className="flex-1 pl-3 text-lg font-bold text-hawk-ink">{title}</Text>
          </View>
          <Text className="pb-4 text-sm leading-5 text-neutral-600">{body}</Text>

          <Pressable
            disabled={busy}
            onPress={onConfirm}
            className={`items-center rounded-2xl py-3.5 active:opacity-80 ${
              busy ? 'bg-neutral-300' : danger ? 'bg-red-600' : 'bg-hawk-green'
            }`}
          >
            <Text className={`text-base font-bold ${danger ? 'text-white' : 'text-hawk-gold'}`}>
              {confirmLabel}
            </Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={onCancel}
            className="mt-2 items-center rounded-2xl bg-white py-3.5 active:opacity-70"
          >
            <Text className="text-base font-semibold text-neutral-600">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

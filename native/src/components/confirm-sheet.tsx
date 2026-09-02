import Feather from '@expo/vector-icons/Feather';
import { Modal, Pressable, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';

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
  cancelLabel = 'Cancel',
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
  /**
   * `null` drops the second button, turning the sheet into a one-action NOTICE.
   * A refusal has nothing to cancel — offering "Cancel" beside "Choose another
   * unit" asks the reader to distinguish two ways of doing the same thing.
   * Defaults to 'Cancel', so every existing caller is unchanged.
   */
  cancelLabel?: string | null;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ui = useUi();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="rounded-t-3xl bg-surface px-5 pb-8 pt-5">
          <View className="flex-row items-center pb-2">
            <View
              className={`h-10 w-10 items-center justify-center rounded-2xl ${
                danger ? 'bg-bad' : 'bg-card'
              }`}
            >
              <Feather
                name={icon}
                size={19}
                color={danger ? ui.tint.bad.ink : ui.tint.good.ink}
              />
            </View>
            <Text className="flex-1 pl-3 text-lg font-bold text-ink">{title}</Text>
          </View>
          <Text className="pb-4 text-sm leading-5 text-muted">{body}</Text>

          <Pressable
            disabled={busy}
            onPress={onConfirm}
            className={`items-center rounded-2xl py-3.5 active:opacity-80 ${
              busy ? 'bg-disabled' : danger ? 'bg-red-600' : 'bg-hawk-green'
            }`}
          >
            <Text className={`text-base font-bold ${danger ? 'text-white' : 'text-hawk-gold'}`}>
              {confirmLabel}
            </Text>
          </Pressable>
          {cancelLabel === null ? null : (
            <Pressable
              disabled={busy}
              onPress={onCancel}
              className="mt-2 items-center rounded-2xl bg-card py-3.5 active:opacity-70"
            >
              <Text className="text-base font-semibold text-muted">{cancelLabel}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

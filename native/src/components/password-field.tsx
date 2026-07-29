import { Feather } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';

import { BRAND } from '@/lib/api';

/**
 * Password input with a reveal toggle.
 *
 * Typing a password blind on a phone keyboard is where most "wrong password"
 * failures actually come from, so every password field in the app is this one
 * component — sign-in and the profile modal both get the eye, and neither can
 * drift from the other.
 */
export function PasswordField({
  value,
  onChangeText,
  placeholder,
  autoFocus,
  editable = true,
  onSubmitEditing,
  textContentType,
}: {
  value: string;
  onChangeText: (s: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  editable?: boolean;
  onSubmitEditing?: () => void;
  textContentType?: TextInputProps['textContentType'];
}) {
  const [shown, setShown] = useState(false);
  return (
    <View className="flex-row items-center rounded-2xl bg-card pr-2">
      <TextInput
        className="flex-1 px-4 py-3.5 text-base text-ink"
        placeholder={placeholder}
        placeholderTextColor="#9db5a7"
        secureTextEntry={!shown}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType={textContentType}
        autoFocus={autoFocus}
        editable={editable}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmitEditing}
      />
      <Pressable
        hitSlop={10}
        className="h-9 w-9 items-center justify-center"
        onPress={() => setShown((s) => !s)}
        accessibilityLabel={shown ? 'Hide password' : 'Show password'}
      >
        <Feather name={shown ? 'eye-off' : 'eye'} size={17} color={BRAND.leaf} />
      </Pressable>
    </View>
  );
}

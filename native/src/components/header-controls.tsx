/**
 * Language and theme, on the Home header — the web's twin (menu.js builds the
 * same pair beside the hamburger).
 *
 * ONE TAP, NEXT LANGUAGE. The picker is three taps and a dialog to answer a
 * question with four possible values, and the answer is printed on the button
 * itself: a reader can see what they got and tap again. The full picker keeps
 * its place where the choice is being made for the first time — the first-run
 * prompt and the Preferences row — where the languages need naming.
 *
 * THEME CYCLES THROUGH TWO, NOT THREE. 'system' is a real preference and it
 * lives in Preferences; a header control that stepped light -> dark -> system
 * would leave a reader tapping a sun and getting whatever the OS says, which
 * reads as broken. Here it flips the palette in force.
 */
import Feather from '@expo/vector-icons/Feather';
import { Pressable, Text, View } from 'react-native';

import { useI18n, LANGS } from '@/lib/i18n';
import { useThemePref } from '@/lib/theme-pref';
import { useUi } from '@/lib/theme';

export function HeaderControls() {
  const { lang, setLang, t } = useI18n();
  const { scheme, setPref } = useThemePref();
  const ui = useUi();
  const dark = scheme === 'dark';

  return (
    <View className="flex-row items-center" style={{ gap: 8 }}>
      <Pressable
        onPress={() => setLang(LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length])}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${t('n.components.header.language')}: ${lang.toUpperCase()}`}
        /* 36px tall, which is what .lang-btn / .theme-btn measure on the web.
           Lite and native sit side by side on the same phone and this pair was
           visibly the smaller one. It is also the floor for a comfortable tap
           target, which px-2 py-1 was under even with hitSlop covering it. */
        className="h-9 min-w-9 items-center justify-center rounded-lg border border-line px-2.5"
      >
        {/* The code, not a flag: a language is not a country, and three of these
            four are spoken across several. */}
        <Text className="text-sm font-bold tracking-wider text-ink">{lang.toUpperCase()}</Text>
      </Pressable>
      <Pressable
        onPress={() => setPref(dark ? 'light' : 'dark')}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t(dark ? 'n.components.header.to-light' : 'n.components.header.to-dark')}
        className="h-9 w-9 items-center justify-center rounded-lg border border-line"
      >
        <Feather name={dark ? 'sun' : 'moon'} size={18} color={ui.ink} />
      </Pressable>
    </View>
  );
}

/**
 * The language button for the screens BEFORE sign-in — welcome and sign-in
 * (first-time walkthrough #4, 2026-10-03).
 *
 * Neither screen has the Home header, so someone whose phone is set to English
 * but who reads Hausa had no way to change language until they were already
 * inside the app. This is the header's language control on its own: the same
 * one tap per language (HeaderControls), the same code on its face, the same
 * setLang — which remembers the choice, tells the server and counts as the
 * first-run answer, so the prompt after sign-up does not ask again.
 *
 * setLang REMOUNTS the tree (lib/i18n.tsx), so any half-typed state on the
 * screen is lost. The sign-in screen therefore shows it only on its first step,
 * before anything has been typed that matters.
 */
import { Pressable, Text } from 'react-native';

import { LANGS, useI18n } from '@/lib/i18n';

export function LangButton({ tone = 'surface' }: { tone?: 'surface' | 'onGreen' }) {
  const { lang, setLang, t } = useI18n();
  const onGreen = tone === 'onGreen';
  return (
    <Pressable
      onPress={() => setLang(LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length])}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`${t('n.components.header.language')}: ${lang.toUpperCase()}`}
      testID="lang-button"
      /* 36px tall like the header pair (.lang-btn on the web). On the brand
         green the border and text are fixed white, as everything on welcome
         is — a theme colour there turned into a dark plate in dark mode. */
      className={`h-9 min-w-9 items-center justify-center rounded-lg border px-2.5 ${
        onGreen ? 'border-white/30' : 'border-line'
      }`}
    >
      <Text className={`text-sm font-bold tracking-wider ${onGreen ? 'text-white' : 'text-ink'}`}>
        {lang.toUpperCase()}
      </Text>
    </Pressable>
  );
}

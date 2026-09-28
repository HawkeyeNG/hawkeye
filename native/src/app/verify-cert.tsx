import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, Text, TextInput, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { normCode, prettyCode, verifyCode, type VerifyResult } from '@/lib/certificate';
import { dayMonthYear } from '@/lib/dates';
import { t as i18nT, useT } from '@/lib/i18n';
import { useUi } from '@/lib/theme';

type State = 'idle' | 'checking' | VerifyResult['state'];

/**
 * Check a Hawkeye Observer certificate by its code — the native twin of
 * app/verify-cert.html, so the certificate flow never leaves the app.
 *
 * Public and unauthenticated (GET /api/cert/verify). It can only say "valid,
 * issued on <date>" or "not valid": the server stores no names, so there is no
 * holder to show.
 */
export default function VerifyCertScreen() {
  useT();
  const ui = useUi();
  const params = useLocalSearchParams<{ code?: string }>();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [input, setInput] = useState(() => prettyCode(normCode(String(params.code ?? ''))));
  const [state, setState] = useState<State>('idle');
  const [valid, setValid] = useState<{ code: string; issuedOn: string } | null>(null);
  const seq = useRef(0);

  /* The answer is applied only if it is still the latest question asked, so a
     slow reply cannot overwrite a newer one. Always from a promise callback. */
  const run = useCallback((raw: string) => {
    const mine = ++seq.current;
    verifyCode(raw).then((r) => {
      if (mine !== seq.current) return;
      setValid(r.state === 'valid' ? { code: r.code, issuedOn: r.issuedOn } : null);
      setState(r.state);
    });
  }, []);

  const check = () => {
    const code = normCode(input);
    if (code.length === 8) setInput(prettyCode(code));
    setValid(null);
    setState('checking');
    run(code);
  };

  // Opened with a code (from the certificate screen): check it straight away.
  useEffect(() => {
    const c = String(params.code ?? '');
    if (!c) return undefined;
    let alive = true;
    Promise.resolve().then(() => { if (alive) { setState('checking'); run(c); } });
    return () => { alive = false; };
  }, [params.code, run]);

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('n.app.verify-cert.title')} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 48 }}
      >
        <Text className="text-lg font-bold text-ink">{i18nT('cert.verify-title')}</Text>
        <Text className="pb-4 pt-1 text-sm leading-5 text-muted">{i18nT('cert.verify-lede')}</Text>

        <View className="rounded-2xl bg-card px-4 py-4">
          <Text className="pb-1 text-sm font-bold text-ink">{i18nT('cert.verify-label')}</Text>
          <TextInput
            value={input}
            onChangeText={(v) => setInput(v.toUpperCase().slice(0, 12))}
            onSubmitEditing={check}
            maxLength={12}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="search"
            placeholder="ABCD-EFGH"
            placeholderTextColor={ui.faint}
            accessibilityLabel={i18nT('cert.verify-label')}
            className="rounded-xl border-2 border-faint bg-surface px-3 py-3 text-lg font-bold tracking-widest text-ink"
          />
          <Pressable
            onPress={check}
            disabled={state === 'checking'}
            accessibilityRole="button"
            style={{ minHeight: 48 }}
            className={`mt-3 items-center justify-center rounded-full bg-hawk-gold py-3 active:opacity-80 ${state === 'checking' ? 'opacity-60' : ''}`}
          >
            <Text className="text-sm font-bold text-hawk-green">{i18nT('cert.verify-button')}</Text>
          </Pressable>

          {state === 'checking' ? (
            <View className="flex-row items-center pt-4">
              <ActivityIndicator color={ui.tint.good.ink} />
              <Text className="pl-2 text-sm text-muted">{i18nT('cert.verify-checking')}</Text>
            </View>
          ) : null}
          {state === 'valid' && valid ? (
            <View accessibilityLiveRegion="polite" className="mt-4 rounded-xl border-l-4 border-good-ink bg-good px-3 py-3">
              <Text className="text-base font-bold text-good-ink">{i18nT('cert.verify-valid-h')}</Text>
              <Text className="pt-1 text-sm leading-5 text-ink">
                {i18nT('cert.verify-valid-body', { code: valid.code, date: dayMonthYear(valid.issuedOn) })}
              </Text>
            </View>
          ) : null}
          {state === 'invalid' ? (
            <View accessibilityLiveRegion="polite" className="mt-4 rounded-xl border-l-4 border-bad-ink bg-bad px-3 py-3">
              <Text className="text-base font-bold text-bad-ink">{i18nT('cert.verify-invalid-h')}</Text>
              <Text className="pt-1 text-sm leading-5 text-ink">{i18nT('cert.verify-invalid-body')}</Text>
            </View>
          ) : null}
          {state === 'error' ? (
            <Text accessibilityLiveRegion="polite" className="pt-4 text-sm font-semibold text-bad-ink">{i18nT('cert.verify-error')}</Text>
          ) : null}
        </View>

        <Text className="pt-4 text-xs leading-4 text-muted">{i18nT('cert.verify-what')}</Text>
        <Pressable onPress={() => router.push('/certificate' as never)} accessibilityRole="link" className="self-start py-3 active:opacity-70">
          <Text className="text-sm font-semibold text-good-ink">{i18nT('cert.verify-earn')}</Text>
        </Pressable>
      </Animated.ScrollView>
    </View>
  );
}

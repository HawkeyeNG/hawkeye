import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as i18nT } from '@/lib/i18n';

/**
 * The native half of the campaign-invite App Link.
 *
 * The flow this exists for: someone with no app taps an invite in a WhatsApp
 * thread, lands on the website, installs, and TAPS THE SAME LINK AGAIN — the
 * store hands over no referring URL, so the second tap is the only thing that
 * carries the token. Android and iOS give a verified /join/<token> to this
 * route; without it the same URL opens app/join.html on the website, which also
 * works but costs a second sign-in because the browser has no app session.
 *
 * NEVER AUTOMATIC. These links are forwarded to hundreds of people who were not
 * the intended recipient. The tap on the button is the consent, and the list
 * above it is what is being consented to — the same four sentences the web page
 * shows, because two accounts of what joining means is one too many.
 *
 * Sign-in PUSHES rather than replaces: this screen stays underneath, useAuth()
 * republishes when the session lands, and the button becomes Join. Nothing has
 * to carry the token across the hop.
 */
type Invite = { group_id: number; name: string; kind: string; contest: string; scope: string };

export default function JoinGroup() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { token: session } = useAuth();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'gone' | 'joining' | 'done'>('loading');
  const code = String(token || '');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/join/${encodeURIComponent(code)}`);
        if (!live) return;
        if (!r.ok) { setState('gone'); return; }
        setInvite(await r.json());
        setState('ready');
      } catch {
        if (live) setState('gone');
      }
    })();
    return () => { live = false; };
  }, [code]);

  const join = useCallback(async () => {
    if (!session) { router.push('/sign-in'); return; }
    setState('joining');
    try {
      const r = await fetch(`${BASE}/api/join/${encodeURIComponent(code)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      });
      setState(r.ok ? 'done' : 'gone');
    } catch {
      setState('ready');
    }
  }, [code, session]);

  if (state === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-surface">
        <ActivityIndicator />
        <Text className="pt-3 text-sm text-muted">{i18nT('n.app.join.checking')}</Text>
      </View>
    );
  }

  if (state === 'gone') {
    return (
      <View className="flex-1 items-center justify-center bg-surface px-6">
        <Text className="text-center text-lg font-semibold text-ink">{i18nT('n.app.join.expired-title')}</Text>
        <Text className="pt-2 text-center text-sm text-muted">{i18nT('n.app.join.expired-body')}</Text>
      </View>
    );
  }

  if (state === 'done') {
    return (
      <View className="flex-1 items-center justify-center bg-surface px-6">
        <Text className="text-center text-lg font-semibold text-ink">{i18nT('n.app.join.done-title')}</Text>
        <Text className="pt-2 text-center text-sm text-muted">{i18nT('n.app.join.done-body')}</Text>
        <Pressable
          className="mt-6 rounded-xl bg-brand px-6 py-3"
          onPress={() => router.replace('/(tabs)')}
        >
          <Text className="font-semibold text-white">{i18nT('n.app.join.continue')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-surface" contentContainerClassName="px-5 py-8">
      <Text className="text-xl font-bold text-ink">{invite?.name ?? ''}</Text>
      <Text className="pt-1 text-sm text-muted">{i18nT('n.app.join.invited')}</Text>

      <View className="mt-5 gap-3">
        <Text className="text-sm leading-5 text-muted">{i18nT('n.app.join.point-forward')}</Text>
        <Text className="text-sm leading-5 text-muted">{i18nT('n.app.join.point-public')}</Text>
        <Text className="text-sm leading-5 text-muted">{i18nT('n.app.join.point-anywhere')}</Text>
        <Text className="text-sm leading-5 text-muted">{i18nT('n.app.join.point-leave')}</Text>
      </View>

      <Pressable
        className="mt-7 items-center rounded-xl bg-brand px-6 py-4"
        disabled={state === 'joining'}
        onPress={join}
      >
        <Text className="font-semibold text-white">
          {state === 'joining'
            ? i18nT('n.app.join.joining')
            : session ? i18nT('n.app.join.join') : i18nT('n.app.join.sign-in')}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import Feather from '@expo/vector-icons/Feather';

import { BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import { useUi } from '@/lib/theme';
import { SafeScreen } from '@/components/safe-screen';

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
 *
 * WHY IT LOOKED THE WAY IT DID. Every surface here was painted `bg-brand`, and
 * there is no `brand` colour in tailwind.config.js — the class resolved to
 * nothing, so the Join and Continue buttons rendered as bare text on the page
 * background and the whole screen read as an unfinished draft. The tokens are
 * `hawk-green` (a fixed brand surface) and the semantic set; this screen now
 * uses those, sits inside SafeScreen like every other route, and says whose app
 * it is — an invite is often the very first Hawkeye screen a person ever sees.
 */
type Invite = { group_id: number; name: string; kind: string; contest: string; scope: string };

/** One of the four disclosures, with its own icon so the list is scannable. */
function Point({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  const ui = useUi();
  return (
    <View className="flex-row gap-3">
      <Feather name={icon} size={17} color={ui.muted} style={{ marginTop: 2 }} />
      <Text className="flex-1 text-sm leading-5 text-muted">{text}</Text>
    </View>
  );
}

/** The screen's one full-width action. */
function Action({
  label, onPress, busy, tone = 'primary',
}: { label: string; onPress: () => void; busy?: boolean; tone?: 'primary' | 'quiet' }) {
  return (
    <Pressable
      className={`mt-3 flex-row items-center justify-center rounded-2xl px-6 py-4 ${
        busy ? 'bg-disabled' : tone === 'primary' ? 'bg-hawk-green active:opacity-80' : 'border border-line active:opacity-70'
      }`}
      disabled={busy}
      accessibilityRole="button"
      onPress={onPress}
    >
      {busy ? <ActivityIndicator color="#fff" style={{ marginRight: 8 }} /> : null}
      <Text className={`text-base font-semibold ${tone === 'primary' || busy ? 'text-white' : 'text-ink'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

/* Centred single-message states — checking, expired, joined — share a frame.
   Declared at module scope, not inside JoinGroup: a component created during
   render is a new type every render, and React would remount the whole subtree
   each time the join state moved. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <SafeScreen className="flex-1 bg-surface">
      <ScrollView contentContainerClassName="grow justify-center px-6 py-10">{children}</ScrollView>
    </SafeScreen>
  );
}

/* The crest, above every state. An invite is often the first thing a person
   ever sees of Hawkeye, and an unbranded screen asking for a tap that shares
   who you report as is the wrong first impression. */
function Crest() {
  return (
    <View className="items-center pb-6">
      <Image source={require('@/assets/images/crest.png')} style={{ width: 56, height: 56 }} />
    </View>
  );
}

export default function JoinGroup() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { token: session } = useAuth();
  const t = useT();
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

  /**
   * THE ROOM IS NOT IN THE APP YET, so "Continue" opens the group's own page on
   * the website rather than dropping someone on the Home tab with no sign that
   * anything happened. my-groups is the right destination and not the situation
   * room: whoever just accepted an invite is a member, and that page is where
   * their unit, their campaigns and the way out of all of them live — it also
   * carries the button into the room for the managers among them.
   *
   * In-app browser, not the system one: the app's session travels with it, and
   * a member who lands signed-out has been sent to a sign-in form for no
   * reason. When rooms do arrive natively this becomes a router.push and the
   * rest of the screen does not change.
   */
  const openGroups = useCallback(async () => {
    await openBrowserAsync(`${BASE}/my-groups.html`, {
      presentationStyle: WebBrowserPresentationStyle.AUTOMATIC,
    }).catch(() => {});
    router.replace('/(tabs)');
  }, []);

  if (state === 'loading') {
    return (
      <Frame>
        <Crest />
        <ActivityIndicator />
        <Text className="pt-3 text-center text-sm text-muted">{t('n.app.join.checking')}</Text>
      </Frame>
    );
  }

  if (state === 'gone') {
    return (
      <Frame>
        <Crest />
        <Text className="text-center text-xl font-bold text-ink">{t('n.app.join.expired-title')}</Text>
        <Text className="pt-3 text-center text-sm leading-5 text-muted">{t('n.app.join.expired-body')}</Text>
        <Action tone="quiet" label={t('n.app.join.back-home')} onPress={() => router.replace('/(tabs)')} />
      </Frame>
    );
  }

  if (state === 'done') {
    return (
      <Frame>
        <View className="items-center pb-5">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-good">
            <Feather name="check" size={30} color="#fff" />
          </View>
        </View>
        <Text className="text-center text-xl font-bold text-ink">{t('n.app.join.done-title')}</Text>
        <Text className="pt-3 text-center text-sm leading-5 text-muted">{t('n.app.join.done-body')}</Text>
        <View className="pt-5">
          <Action label={t('n.app.join.continue')} onPress={openGroups} />
          <Action tone="quiet" label={t('n.app.join.back-home')} onPress={() => router.replace('/(tabs)')} />
        </View>
      </Frame>
    );
  }

  return (
    <SafeScreen className="flex-1 bg-surface">
      <ScrollView contentContainerClassName="px-6 pb-10 pt-8">
        <Crest />
        <Text className="text-center text-2xl font-bold text-ink">{invite?.name ?? ''}</Text>
        <Text className="pt-2 text-center text-sm leading-5 text-muted">{t('n.app.join.invited')}</Text>
        {invite?.contest ? (
          <Text className="pt-1 text-center text-sm text-muted">
            {[invite.contest, invite.scope].filter(Boolean).join(' · ')}
          </Text>
        ) : null}

        {/* The disclosures, in a card. Loose paragraphs on the page background
            read as small print; the thing being consented to is the content of
            this screen, so it gets the one surface on it. */}
        <View className="mt-7 gap-4 rounded-2xl border border-line bg-card p-5">
          <Point icon="eye" text={t('n.app.join.point-forward')} />
          <Point icon="globe" text={t('n.app.join.point-public')} />
          <Point icon="map-pin" text={t('n.app.join.point-anywhere')} />
          <Point icon="log-out" text={t('n.app.join.point-leave')} />
        </View>

        <Action
          label={state === 'joining' ? t('n.app.join.joining')
            : session ? t('n.app.join.join') : t('n.app.join.sign-in')}
          busy={state === 'joining'}
          onPress={join}
        />
        {/* Declining is a real answer and needs somewhere to go. Without it the
            only way out of a forwarded invite is the system back gesture, which
            reads as "there is no way to say no". */}
        <Action tone="quiet" label={t('n.app.join.not-now')} onPress={() => router.replace('/(tabs)')} />
      </ScrollView>
    </SafeScreen>
  );
}


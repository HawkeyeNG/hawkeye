import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
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
type Invite = { group_id: number; name: string; kind: string; contest: string; scope: string; scope_label?: string };

/**
 * WHAT A NON-OK ANSWER MEANS, the web's four answers (app/join.html). Every
 * one of them — and a dropped connection — used to read "That invitation is no
 * longer valid, ask for a fresh link", which sent someone with a perfectly good
 * link off to ask for a new one because of a passing 500 or a lost signal.
 *   missing  404 — mistyped, or the group was deleted
 *   revoked  410 invite_revoked     expired  410 invite_expired
 *   error    5xx — try again        offline  the request never got through
 */
type Spent = 'missing' | 'revoked' | 'expired' | 'error';
async function spentState(r: Response): Promise<Spent> {
  if (r.status === 404) return 'missing';
  if (r.status === 410) {
    const b = (await r.json().catch(() => null)) as { error?: string } | null;
    return b?.error === 'invite_revoked' ? 'revoked' : 'expired';
  }
  return 'error';
}
const STOPPED: Record<Spent | 'offline' | 'held', [string, string]> = {
  held: ['join.held-title', 'join.held-body'],
  missing: ['join.not-recognised-title', 'join.not-recognised-body'],
  revoked: ['join.withdrawn-title', 'join.fresh-link-body'],
  expired: ['join.expired-title', 'join.fresh-link-body'],
  error: ['join.went-wrong-title', 'join.try-again-moment'],
  offline: ['join.went-wrong-title', 'join.check-connection'],
};

/* THE RACE BY ITS NAME, not its code ("GOV · Lagos") — the web's contest.*
   keys; a by-election code (REP_BYE_GOMBE_2026) reads as its race's
   by-election, the seat itself being in the scope beside it. */
const CONTEST_KEY: Record<string, string> = {
  PRES: 'contest.presidential', SEN: 'contest.senate', REP: 'contest.house-of-representatives',
  GOV: 'contest.governorship', SHA: 'contest.state-house-of-assembly',
};
function contestName(code: string, t: (k: string, p?: Record<string, string>) => string): string {
  if (CONTEST_KEY[code]) return t(CONTEST_KEY[code]);
  const bye = /^([A-Z]+)_BYE_/.exec(code);
  return bye && CONTEST_KEY[bye[1]] ? t('contest.by-election', { v0: t(CONTEST_KEY[bye[1]]), v1: '' }) : code;
}

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
  /* 'held': the server answered 409 — the room's party label is still being
     verified by Hawkeye (or its name names a party it is not verified for), so
     it admits nobody yet. Not 'gone': the link is fine and will work later. */
  const [state, setState] = useState<'loading' | 'ready' | Spent | 'offline' | 'held' | 'joining' | 'done'>('loading');
  /* The line under the Join button when a tap did not go through — a key, so
     it follows a language change. It used to just put the button back with
     nothing said, so the tap looked ignored. */
  const [joinError, setJoinError] = useState<string | null>(null);
  // Bumped by Try again: re-runs the preview below.
  const [attempt, setAttempt] = useState(0);
  const code = String(token || '');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/join/${encodeURIComponent(code)}`);
        if (!live) return;
        if (r.status === 409) { setState('held'); return; }
        if (!r.ok) { const s = await spentState(r); if (live) setState(s); return; }
        setInvite(await r.json());
        setState('ready');
      } catch {
        if (live) setState('offline');
      }
    })();
    return () => { live = false; };
  }, [code, attempt]);

  const join = useCallback(async () => {
    if (!session) { router.push('/sign-in'); return; }
    setJoinError(null);
    setState('joining');
    try {
      const r = await fetch(`${BASE}/api/join/${encodeURIComponent(code)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      });
      if (r.ok) { setState('done'); return; }
      if (r.status === 409) { setState('held'); return; }
      // Withdrawn, expired or unknown since the preview: the invitation is spent.
      if (r.status === 404 || r.status === 410) { setState(await spentState(r)); return; }
      setState('ready');
      setJoinError('join.alert-failed');
    } catch {
      setState('ready');
      setJoinError('join.could-not-join-offline');
    }
  }, [code, session]);

  const retry = useCallback(() => {
    setState('loading');
    setAttempt((a) => a + 1);
  }, []);

  /**
   * "CONTINUE" GOES TO THE APP'S OWN MY GROUPS (app/my-groups.tsx) — where
   * their unit, their campaigns and the way out of all of them live.
   *
   * It used to open the website's my-groups page in an in-app browser tab, on
   * the theory that the session travelled with it. It does not: that tab is a
   * separate, signed-out browser, so every new member was met by the website's
   * sign-in form — and signing in there took this phone's session slot and
   * signed the APP out. REPLACE, so Back from My Groups goes home rather than
   * to a "you are in" screen that has nothing more to do.
   */
  const openGroups = useCallback(() => {
    // Cast: typed routes regenerate on the next `expo start`.
    router.replace('/my-groups' as never);
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

  if (state in STOPPED) {
    const [title, body] = STOPPED[state as keyof typeof STOPPED];
    // Only a failure that was not the link's fault is worth trying again.
    const canRetry = state === 'error' || state === 'offline';
    return (
      <Frame>
        <Crest />
        <Text className="text-center text-xl font-bold text-ink">{t(title)}</Text>
        <Text className="pt-3 text-center text-sm leading-5 text-muted">{t(body)}</Text>
        {canRetry ? <Action label={t('join.try-again')} onPress={retry} /> : null}
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
            {[contestName(invite.contest, t), invite.scope_label || invite.scope].filter(Boolean).join(' · ')}
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
        {joinError ? (
          <Text accessibilityRole="alert" className="pt-3 text-center text-sm leading-5 text-warn-ink">{t(joinError)}</Text>
        ) : null}
        {/* Declining is a real answer and needs somewhere to go. Without it the
            only way out of a forwarded invite is the system back gesture, which
            reads as "there is no way to say no". */}
        <Action tone="quiet" label={t('n.app.join.not-now')} onPress={() => router.replace('/(tabs)')} />
      </ScrollView>
    </SafeScreen>
  );
}


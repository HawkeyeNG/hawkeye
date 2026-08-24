import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as SecureStore from '@/lib/secure-store';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';

import { BRAND } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';
import { useUi } from '@/lib/theme';
import { getIdentity } from '@/lib/identity';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

type Sub = { contest: string; state?: string };

/**
 * FOLLOWING, AT EITHER OF ITS TWO SIZES.
 *
 * A subscription row is `(contest, region)`, and an empty region means every
 * region — so the backend has always supported both "alert me on this seat" and
 * "alert me on the whole election". Only the second was reachable, and it was
 * labelled as though it were the first: a Senate board offered "Follow this
 * race" and quietly signed you up for reports from all 109 districts.
 *
 * Those are different things and want different readers. Most people want their
 * own governor or their own senator; wanting all 36 governorships at once is a
 * party office or a newsroom. So the control now says which one it is, and both
 * are offered where each makes sense — the whole election on a category board,
 * the single seat on that seat's own page.
 *
 * One component for both so the wording, the request and the "already
 * following" rule cannot drift between the two screens. Web twin: app/follow.js.
 */

/**
 * How each contest reads in "Follow all ___ races". Short forms on purpose:
 * "House of Representatives" is the contest's formal name and makes a button
 * that wraps to three lines on a phone.
 */
const CONTEST_PLURAL: Record<string, string> = {
  GOV: 'governorship',
  SEN: 'Senate',
  REP: 'House of Reps',
  SHA: 'State Assembly',
};

/**
 * What is being followed, in words. MUST match app/follow.js:followSubject —
 * the same button on the website should not describe the same subscription
 * differently.
 *
 * The presidency is one national race, so it has no "all of them" reading: an
 * empty region there IS the single race, not a shortcut for many.
 */
export function followSubject(contest: string | null, scope: string): string {
  if (scope) return 'this race';
  if (!contest || contest === 'PRES') return 'this race';
  return `all ${CONTEST_PLURAL[contest] ?? contest} races`;
}

/**
 * @param contest  contest code, or null when nothing is selected — the control
 *                 renders nothing rather than offering to follow an unknown.
 * @param scope    the region to follow: a state, a senatorial district or a
 *                 federal constituency. '' means every region in the contest.
 */
export function FollowRace({ contest, scope }: { contest: string | null; scope: string }) {
  const ui = useUi();
  const auth = useAuth();
  const [subs, setSubs] = useState<Sub[]>([]);
  const [busy, setBusy] = useState(false);

  // Signing out is handled by DERIVING below, not by clearing here. Emptying the
  // list from inside the effect is a setState in an effect body — a second
  // render pass whose only job is to undo what the first one showed, and a
  // window in which a signed-out reader still sees "Following".
  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let live = true;
    authedGet<{ subscriptions?: Sub[] }>('/api/observers/me')
      .then((me) => live && setSubs(me.subscriptions ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [auth.status]);

  /**
   * The subscription that already covers this race, if any. A nationwide row
   * (region '') counts: the backend pings it for every region, so claiming "not
   * following" would be false. Kept as the ROW, not a boolean, because DELETE
   * matches on (contest, region) exactly — unfollowing a nationwide row with
   * this seat's region would delete nothing and silently leave the alerts on.
   */
  const followed = useMemo(() => {
    // Not signed in: whatever was fetched for a previous session is not this
    // reader's, so it says nothing about what they follow.
    if (!contest || auth.status !== 'signedIn') return null;
    return (
      subs.find(
        (s) => s.contest === contest && ((s.state ?? '') === scope || (s.state ?? '') === ''),
      ) ?? null
    );
  }, [subs, contest, scope, auth.status]);
  const following = !!followed;
  /** Following, but through a whole-election row rather than this seat's own. */
  const followsEverywhere = !!followed && (followed.state ?? '') === '' && scope !== '';

  const toggle = useCallback(async () => {
    if (!contest) return;
    if (auth.status !== 'signedIn') {
      router.push('/sign-in');
      return;
    }
    // Unfollow removes the exact row that is doing the following; follow adds
    // one scoped to what this control says it is about.
    const state = following ? (followed?.state ?? '') : scope;
    setBusy(true);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const id = await getIdentity();
      const res = await fetch(`${BASE}/api/subscriptions`, {
        method: following ? 'DELETE' : 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify({ contest, state }),
      });
      if (!res.ok) {
        Alert.alert('Could not update', `Try again. (HTTP ${res.status})`);
        return;
      }
      setSubs((s) =>
        following
          ? s.filter((x) => !(x.contest === contest && (x.state ?? '') === state))
          : [...s, { contest, state }],
      );
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [auth.status, contest, followed, following, scope]);

  if (!contest) return null;

  const subject = followSubject(contest, scope);
  const detail = following
    ? followsEverywhere
      ? `Alerts on — through your subscription to every ${scope ? 'region' : 'race'} in this election`
      : 'Alerts on'
    : `Get alerts on every report${scope ? ` in ${scope}` : ''}`;

  /**
   * SUBSCRIBED, AND IT HAS TO LOOK LIKE A CONTROL.
   *
   * `bg-card` is the same fill every passive panel on the screen uses, so once
   * you were following, the one thing that could undo it was indistinguishable
   * from a status card — and its label said "Following this race", which
   * describes the state and leaves the action to be guessed at.
   *
   * A border in the accessible ink is what the rest of the app's secondary
   * controls wear (see RaceActions), and it separates this from the panels
   * around it without competing with the report CTA — which is still the thing
   * the page is asking for.
   */
  return (
    <Pressable
      disabled={busy}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityState={{ selected: following, busy }}
      accessibilityLabel={following ? `Unfollow ${subject}. Alerts are on.` : `Follow ${subject}`}
      className={`mb-3 flex-row items-center rounded-2xl px-4 py-3 active:opacity-80 ${
        following ? 'border border-good-ink bg-card' : 'bg-hawk-green'
      }`}
    >
      {busy ? (
        <ActivityIndicator color={following ? ui.tint.good.ink : BRAND.gold} />
      ) : (
        <Feather
          name={following ? 'bell' : 'bell-off'}
          size={16}
          color={following ? ui.tint.good.ink : BRAND.gold}
        />
      )}
      {/* STACKED, NOT SIDE BY SIDE. These were two Texts on one row competing
          for width, and the label lost — "Follow this race" once rendered as a
          vertical column of single letters. Labels only got longer with "Follow
          all House of Reps races", so the row is gone: one flexible column
          beside the icon, each line free to wrap on its own. */}
      <View className="flex-1 pl-3">
        {/* THE LABEL IS THE ACTION, NOT THE STATE. "Following this race" told
            you how things were and left what tapping does to be guessed at —
            a reader wanting out had no reason to think the thing announcing
            the subscription was also the way to end it. The state is still
            here: the bell icon, the detail line's "Alerts on", and
            accessibilityState.selected for anyone not seeing either. */}
        <Text className={`text-sm font-bold ${following ? 'text-good-ink' : 'text-hawk-gold'}`}>
          {following ? `Unfollow ${subject}` : `Follow ${subject}`}
        </Text>
        <Text className={`pt-0.5 text-xs ${following ? 'text-faint' : 'text-emerald-200'}`}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

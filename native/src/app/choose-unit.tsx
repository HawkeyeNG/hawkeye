import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { ChooseUnitScreen } from '@/components/choose-unit';
import { authedGet } from '@/lib/auth';
import { emitMyUnitSaved } from '@/lib/my-unit';

/**
 * /choose-unit — "which polling unit is yours", as a page of its own.
 *
 * Two ways in, and they differ only in where the page leads:
 *
 *   /choose-unit?onboard=1   the last step of a NEW sign-up (sign-in.tsx
 *                            REPLACES itself with this). Save or Skip for now →
 *                            the tabs (My Groups when the account is already in
 *                            one, hasGroup below), by replace, so nothing behind
 *                            this page is a finished sign-up step to go Back into.
 *   /choose-unit?current=…   from Profile's "My Polling Unit" row. The close
 *                            cross and Save both go back to Profile, which
 *                            updates its row from emitMyUnitSaved in place.
 *
 * Either may add ?unit=NN-NN-NN-NNN: a unit to open with SELECTED (not saved)
 * — the one a "bring a second observer to your unit" invitation brought. Same
 * parameter as the web's choose-unit.html. Since 1.0.8 sign-in.tsx adds it to
 * the onboard step from the invitation lib/pending-invite.ts parked: Android's
 * Play install referrer, or an /open or hawkeye:// link carrying `unit`. An iOS
 * fresh install has no referrer, so there the reader picks the unit by hand
 * (invite.html prints it for them).
 *
 * It replaced a ModalCard. The sign-up flow used to close that modal and wait
 * 350ms for its fade before navigating (replacing the stack under a fading
 * modal is the mid-dismiss navigation alerts.tsx guards against). There is no
 * modal now, so the navigation is immediate; `leaving` still stops a double
 * tap queueing two of them.
 */
/**
 * IN A GROUP ALREADY? THEN MY GROUPS, NOT HOME (flow walkthrough ONB-11).
 *
 * An organisation-code sign-up is put in the issuer's room by the server — at
 * sign-up, or once the unit is saved (backend routes/groups.js autoJoinOrgRoom)
 * — and Home has no rooms card, so the room they joined was never opened or
 * named. Any membership (or an invitation waiting) sends the end of sign-up to
 * My Groups instead. Bounded at 3 s and silent on failure: no answer is Home,
 * as before. Same rule as the web's choose-unit.html.
 */
async function hasGroup(): Promise<boolean> {
  const ask = authedGet<{ member?: unknown[]; managing?: unknown[] }>('/api/groups', { signOutOn401: false })
    .then((g) => !!((g.member && g.member.length) || (g.managing && g.managing.length)))
    .catch(() => false);
  return Promise.race([ask, new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
}

export default function ChooseUnitRoute() {
  const { onboard, current, unit } = useLocalSearchParams<{ onboard?: string; current?: string; unit?: string }>();
  const isOnboard = onboard === '1';
  const leaving = useRef(false);

  const leave = (to: 'tabs' | 'back') => {
    if (leaving.current) return;
    leaving.current = true;
    if (to === 'tabs' && isOnboard) {
      void hasGroup().then((yes) => router.replace(yes ? ('/my-groups' as never) : '/(tabs)'));
    } else if (to === 'tabs') router.replace('/(tabs)');
    else if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  // Android's back button during onboarding is a skip, not a trip back to the
  // welcome screen under this page with a signed-in session.
  useEffect(() => {
    if (!isOnboard) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      leave('tabs');
      return true;
    });
    return () => sub.remove();
  }, [isOnboard]);

  return (
    <ChooseUnitScreen
      onboard={isOnboard}
      currentCode={typeof current === 'string' && current ? current : null}
      prefillCode={typeof unit === 'string' && unit ? unit : null}
      onSaved={(unit) => {
        emitMyUnitSaved(unit);
        leave(isOnboard ? 'tabs' : 'back');
      }}
      onSkip={() => leave('tabs')}
      onClose={() => leave('back')}
    />
  );
}

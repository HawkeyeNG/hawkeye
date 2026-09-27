import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { BRAND } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as i18nT } from '@/lib/i18n';
import { inviteUnitLink, mySavedUnit, shareInviteUnit } from '@/lib/invite-unit';
import { onMyUnitSaved, type SavedUnit } from '@/lib/my-unit';
import { useUi } from '@/lib/theme';

/**
 * "Bring a second observer to your unit", as a card — on the practice run's
 * completion screen, straight after the preview that says a report turns
 * VERIFIED when a second observer at the same unit matches it.
 *
 * Never after a REAL result: that count is already over.
 *
 * About the SAVED unit, not the practice unit (which may be anywhere the
 * observer happened to rehearse). With none saved, the card offers the chooser
 * instead. Signed out, or if the unit cannot be asked for, it renders nothing:
 * the link carries the reader's own referral code, and a card that might be
 * wrong is worse than none. Classes are ones already used elsewhere — NativeWind
 * drops unknown ones silently.
 */
export function InviteUnitCard() {
  const ui = useUi();
  const auth = useAuth();
  /* undefined = not known (loading, signed out, failed); null = none saved. */
  const [unit, setUnit] = useState<SavedUnit | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let live = true;
    mySavedUnit().then((u) => {
      if (live) setUnit(u);
    });
    return () => {
      live = false;
    };
  }, [auth.status]);
  // Back from the chooser this card offered: show the unit just saved.
  useEffect(() => onMyUnitSaved((u) => setUnit(u)), []);

  if (auth.status !== 'signedIn' || unit === undefined) return null;

  const invite = async () => {
    if (!unit || busy) return;
    setBusy(true);
    setFailed(false);
    const url = await inviteUnitLink(unit.pu_code);
    if (url) await shareInviteUnit(url);
    else setFailed(true);
    setBusy(false);
  };

  const where = unit ? [unit.pu_code, unit.ward, unit.lga, unit.state].filter(Boolean).join(' · ') : '';

  return (
    <View className="mt-6 w-full rounded-2xl bg-card px-4 py-4">
      <View className="flex-row items-center">
        <Feather name="user-plus" size={17} color={ui.tint.good.ink} />
        <Text className="flex-1 pl-2.5 text-base font-bold text-ink">{i18nT('n.invite2.title')}</Text>
      </View>
      <Text className="pt-1.5 text-sm text-muted">{i18nT('n.invite2.why')}</Text>

      {unit ? (
        <>
          {/* Register data, shown as the register has it. */}
          <Text className="pt-3 text-sm font-semibold text-ink" numberOfLines={2}>
            {unit.name || unit.pu_code}
          </Text>
          <Text className="text-[11px] text-muted" numberOfLines={2}>
            {where}
          </Text>
          <Pressable
            onPress={invite}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={i18nT('n.invite2.button')}
            accessibilityState={{ busy }}
            className="mt-3 flex-row items-center justify-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
          >
            {busy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <>
                <Feather name="share-2" size={15} color={BRAND.gold} />
                <Text className="pl-2 text-sm font-bold text-hawk-gold">{i18nT('n.invite2.button')}</Text>
              </>
            )}
          </Pressable>
          {/* A tap that did nothing must say so, with the way out. */}
          {failed ? (
            <Text className="pt-2 text-xs font-semibold text-warn-ink">{i18nT('n.invite2.failed')}</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text className="pt-3 text-sm text-ink">{i18nT('n.invite2.choose-first')}</Text>
          <Pressable
            onPress={() => router.push('/choose-unit' as never)}
            accessibilityRole="button"
            accessibilityLabel={i18nT('profile.choose-your-polling-unit')}
            className="mt-3 flex-row items-center justify-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
          >
            <Feather name="map-pin" size={15} color={BRAND.gold} />
            <Text className="pl-2 text-sm font-bold text-hawk-gold">{i18nT('profile.choose-your-polling-unit')}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

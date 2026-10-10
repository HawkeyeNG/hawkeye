import Feather from '@expo/vector-icons/Feather';
import { useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Linking, Platform, Pressable, Text, View } from 'react-native';

import { NoticeSheet, useNotice } from '@/components/notice-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { BRAND } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';
import { t as i18nT, useT } from '@/lib/i18n';
import { onMyUnitSaved, type SavedUnit } from '@/lib/my-unit';
import { registerForPush } from '@/lib/push';
import { askPhotoLibrary, isSaveToDeviceEnabled, photoLibraryAccess } from '@/lib/save-to-device';
import { useUi } from '@/lib/theme';
import { coordsHeld, holdStateOffline } from '@/lib/register';

/**
 * READY FOR ELECTION DAY — one row per thing that has to be in place before
 * polling day. Native twin of app/ready.html; reached from More → Take part,
 * the Practice Day screen, and the reminder before polling day
 * (lib/web-routes.ts maps ready.html here).
 *
 * THE ROW IS THE BUTTON (owner, 2026-09-30). Each row does the one thing its
 * state calls for, so there is no separate action button to find:
 *
 *   Signed in      signed out → sign-in; signed in → informational, not a button.
 *   Polling unit   the /choose-unit full-screen modal over this page (the same
 *                  route Profile opens); its save lands back here through
 *                  onMyUnitSaved and the row ticks.
 *   Permissions    never asked (or the phone can still ask) → the SYSTEM prompt,
 *                  directly; refused for good → Hawkeye's page in the phone's
 *                  Settings (Linking.openSettings); already allowed → our own
 *                  notice sheet saying so, and nothing else. iOS lists a
 *                  permission in Settings only once the app has asked for it,
 *                  which is why a never-asked permission goes to the prompt and
 *                  never to Settings.
 *
 * NO POP-UP OF OUR OWN BEFORE A PERMISSION PROMPT (owner rule). The only sheet
 * of ours here is the "already allowed" notice, which no prompt follows.
 *
 * Re-checked every time the screen regains focus and every time the app comes
 * back to the foreground, which is exactly the return trip from Settings.
 *
 * An ordinary screen, not a modal: nothing here blocks anything.
 */
type State = 'ready' | 'todo' | 'blocked' | 'unknown';
type Row = {
  id: string;
  title: string;
  state: State;
  note?: string;
  /** What tapping the row does. Absent = informational, not a button. `hint`
   *  is the verb shown at the row's end and read as its accessibility hint. */
  tap?: { hint?: string; run: () => unknown };
};
type Me = { unit?: SavedUnit | null };

const openSettings = () => Linking.openSettings();

export default function ReadyScreen() {
  useT();
  const ui = useUi();
  const auth = useAuth();
  const notice = useNotice();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [cam, requestCam, getCam] = useCameraPermissions();

  const [unit, setUnit] = useState<SavedUnit | null | undefined>(undefined); // undefined = not known
  /** The saved unit's state has its offline near-me list on this phone. null = not checked yet. */
  const [offlineUnits, setOfflineUnits] = useState<boolean | null>(null);
  const [unitFailed, setUnitFailed] = useState(false);
  const [loc, setLoc] = useState<Location.LocationPermissionResponse | null>(null);
  const [locOn, setLocOn] = useState(true);
  const [notif, setNotif] = useState<Notifications.NotificationPermissionsStatus | null>(null);
  const [photos, setPhotos] = useState<'ready' | 'ask' | 'blocked' | 'none'>('none');
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const check = useCallback(async () => {
    void getCam().catch(() => null);
    const [perm, on, n, save] = await Promise.all([
      Location.getForegroundPermissionsAsync().catch(() => null),
      Location.hasServicesEnabledAsync().catch(() => true),
      Notifications.getPermissionsAsync().catch(() => null),
      isSaveToDeviceEnabled().catch(() => false),
    ]);
    const p = save ? await photoLibraryAccess().catch(() => 'none' as const) : 'none';
    if (!alive.current) return;
    setLoc(perm);
    setLocOn(on);
    setNotif(n);
    setPhotos(p);
    if (auth.status !== 'signedIn') {
      setUnit(null);
      return;
    }
    try {
      // signOutOn401 false: a status probe must never end the session.
      const me = await authedGet<Me>('/api/observers/me', { signOutOn401: false });
      if (!alive.current) return;
      setUnit(me.unit ?? null);
      setUnitFailed(false);
    } catch {
      if (alive.current) setUnitFailed(true);
    }
  }, [auth.status, getCam]);

  useFocusEffect(
    useCallback(() => {
      void check();
    }, [check]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });
    return () => sub.remove();
  }, [check]);
  // The chooser announces a save before this screen is back in focus.
  useEffect(() => onMyUnitSaved((u) => setUnit(u)), []);
  // Read from storage, so it answers with no signal. Re-read when a row's
  // action finishes (busy), since tapping this row is what downloads it.
  const unitState = unit?.state ?? null;
  useEffect(() => {
    if (!unitState) return; // the row is not shown without a saved unit
    let on = true;
    coordsHeld(unitState).then((h) => { if (on) setOfflineUnits(h); });
    return () => { on = false; };
  }, [unitState, busy]);

  const run = async (id: string, fn: () => unknown) => {
    if (busy) return;
    setBusy(id);
    try {
      await fn();
    } catch {
      /* the re-check below reports whatever happened */
    } finally {
      if (alive.current) setBusy(null);
      await check();
    }
  };

  const allowHint = i18nT('ready.allow');
  const settingsHint = i18nT('n.components.capture-camera.open-settings');
  const toSettings = { hint: settingsHint, run: openSettings };
  // Already allowed: say so in our own sheet. Title is the row, body one sentence.
  const allowed = (titleKey: string, bodyKey: string) => ({
    run: () => notice.show(i18nT(titleKey), i18nT(bodyKey), 'good'),
  });
  const blockedNote = i18nT('n.app.ready.blocked');
  const rows: Row[] = [];

  // Signed in. A signed-out reader is normally on the welcome screen already
  // (the root layout), but the row still says so rather than assuming.
  const signedIn = auth.status === 'signedIn';
  const toSignIn = { hint: i18nT('index.sign-in'), run: () => router.push('/sign-in' as never) };
  rows.push({
    id: 'signin',
    title: i18nT('ready.signed-in'),
    state: signedIn ? 'ready' : 'todo',
    tap: signedIn ? undefined : toSignIn,
  });

  // Polling unit — the chooser route, a fullScreenModal (app/_layout.tsx) over
  // this page, the same one Profile opens. `current` marks the saved row there.
  const choose = {
    hint: i18nT('ready.choose-unit'),
    run: () =>
      router.push({ pathname: '/choose-unit', params: unit ? { current: unit.pu_code } : {} } as never),
  };
  rows.push(
    !signedIn
      ? { id: 'unit', title: i18nT('ready.unit-chosen'), state: 'todo', note: i18nT('ready.sign-in-first'), tap: toSignIn }
      : unit
        ? { id: 'unit', title: i18nT('ready.unit-chosen'), state: 'ready', note: unit.name || unit.pu_code, tap: choose }
        : unit === null
          ? { id: 'unit', title: i18nT('ready.unit-chosen'), state: 'todo', tap: choose }
          : {
              id: 'unit',
              title: i18nT('ready.unit-chosen'),
              state: 'unknown',
              note: unitFailed ? i18nT('ready.could-not-check') : undefined,
              tap: choose,
            },
  );

  // Camera. canAskAgain is the phone's own word on whether its prompt can
  // still appear (always, until the first answer; Android allows a second).
  rows.push(
    cam?.granted
      ? { id: 'camera', title: i18nT('ready.camera'), state: 'ready', tap: allowed('ready.camera', 'ready.camera-allowed') }
      : cam && !cam.canAskAgain
        ? { id: 'camera', title: i18nT('ready.camera'), state: 'blocked', note: blockedNote, tap: toSettings }
        : {
            id: 'camera',
            title: i18nT('ready.camera'),
            state: cam ? 'todo' : 'unknown',
            tap: { hint: allowHint, run: requestCam },
          },
  );

  // Location — permission first, then the phone's own switch, then precision.
  // Filing needs a precise fix, so "approximate only" is not ready.
  const approximate =
    !!loc?.granted && (loc.ios?.accuracy === 'reduced' || loc.android?.accuracy === 'coarse');
  const askLoc = { hint: allowHint, run: () => Location.requestForegroundPermissionsAsync() };
  rows.push(
    !loc
      ? { id: 'location', title: i18nT('ready.location'), state: 'unknown', tap: askLoc }
      : !loc.granted
        ? loc.canAskAgain
          ? { id: 'location', title: i18nT('ready.location'), state: 'todo', tap: askLoc }
          : { id: 'location', title: i18nT('ready.location'), state: 'blocked', note: blockedNote, tap: toSettings }
        : !locOn
          ? {
              id: 'location',
              title: i18nT('ready.location'),
              state: 'todo',
              note: i18nT('n.app.ready.location-off'),
              // Android shows its own "turn on location" dialog; iOS has no
              // way in but Settings.
              tap:
                Platform.OS === 'android'
                  ? { hint: i18nT('n.app.ready.turn-on'), run: () => Location.enableNetworkProviderAsync() }
                  : toSettings,
            }
          : approximate
            ? {
                id: 'location',
                title: i18nT('ready.location'),
                state: 'todo',
                note: i18nT('ready.approximate'),
                // Android asks again with its own "use precise location" prompt;
                // iOS changes precision only in Settings.
                tap: Platform.OS === 'android' && loc.canAskAgain ? askLoc : toSettings,
              }
            : {
                id: 'location',
                title: i18nT('ready.location'),
                state: 'ready',
                tap: allowed('ready.location', 'ready.location-allowed'),
              },
  );

  // Notifications. registerForPush() makes the Android channel first (Android
  // 13 shows no prompt without one), asks, and registers the token.
  const notifOk =
    notif?.granted ||
    notif?.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    notif?.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;
  rows.push(
    notifOk
      ? {
          id: 'notify',
          title: i18nT('ready.notifications'),
          state: 'ready',
          tap: allowed('ready.notifications', 'ready.notifications-allowed'),
        }
      : notif && !notif.canAskAgain
        ? { id: 'notify', title: i18nT('ready.notifications'), state: 'blocked', note: blockedNote, tap: toSettings }
        : {
            id: 'notify',
            title: i18nT('ready.notifications'),
            state: notif ? 'todo' : 'unknown',
            tap: { hint: allowHint, run: registerForPush },
          },
  );

  // Photo library — only while "save report media to this phone" is on, and
  // only on a build that carries the module.
  if (photos !== 'none') {
    rows.push(
      photos === 'ready'
        ? {
            id: 'photos',
            title: i18nT('n.app.ready.photos'),
            state: 'ready',
            tap: allowed('n.app.ready.photos', 'n.app.ready.photos-allowed'),
          }
        : photos === 'blocked'
          ? { id: 'photos', title: i18nT('n.app.ready.photos'), state: 'blocked', note: blockedNote, tap: toSettings }
          : {
              id: 'photos',
              title: i18nT('n.app.ready.photos'),
              state: 'todo',
              tap: { hint: allowHint, run: askPhotoLibrary },
            },
    );
  }

  // Offline near-me: only once there is a saved unit to say which state.
  if (unitState) {
    rows.push(
      offlineUnits
        ? { id: 'offline-units', title: i18nT('nearme.ready-title'), state: 'ready', note: i18nT('nearme.ready-yes', { v0: unitState }) }
        : {
            id: 'offline-units',
            title: i18nT('nearme.ready-title'),
            state: offlineUnits === null ? 'unknown' : 'todo',
            note: offlineUnits === null ? undefined : i18nT('nearme.ready-no'),
            tap: { hint: i18nT('common.try-again'), run: () => holdStateOffline(unitState) },
          },
    );
  }

  const readyCount = rows.filter((r) => r.state === 'ready').length;
  const allReady = readyCount === rows.length;
  const tally = i18nT('ready.n-of-m-ready', { v0: readyCount, v1: rows.length });
  const stateText: Record<State, string> = {
    ready: i18nT('ready.state-ready'),
    todo: i18nT('common.not-yet'),
    blocked: i18nT('ready.state-blocked'),
    unknown: '',
  };
  // Ticks in Hawkeye gold with brand ink on them: a fixed pair that reads the
  // same in both themes (gold on the light card alone would not).
  const MARK: Record<State, { icon: keyof typeof Feather.glyphMap; bg: string; color: string }> = {
    ready: { icon: 'check', bg: 'bg-hawk-gold', color: BRAND.ink },
    todo: { icon: 'alert-circle', bg: 'bg-warn', color: ui.tint.warn.ink },
    blocked: { icon: 'x', bg: 'bg-bad', color: ui.tint.bad.ink },
    unknown: { icon: 'help-circle', bg: 'bg-surface', color: ui.faint },
  };

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('ready.title')} translateY={translateY} onClose={() => router.back()} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
      >
        {/* Summary — the gold-edged card the home screen's Practice Day card
            and My Groups use, so it reads as Hawkeye's in either theme. */}
        <View
          className="mb-4 flex-row items-center rounded-2xl border-l-4 border-hawk-gold bg-card px-4 py-4"
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`${allReady ? i18nT('ready.all-set') : i18nT('ready.lede')} ${tally}`}
        >
          <View
            className={`h-10 w-10 items-center justify-center rounded-full ${allReady ? 'bg-hawk-gold' : 'bg-surface'}`}
          >
            <Feather name={allReady ? 'check' : 'list'} size={20} color={allReady ? BRAND.ink : ui.muted} />
          </View>
          <View className="flex-1 pl-3">
            <Text className="text-base font-bold text-ink">
              {allReady ? i18nT('ready.all-set') : i18nT('ready.lede')}
            </Text>
            <Text className="pt-0.5 text-sm leading-5 text-muted">{tally}</Text>
          </View>
        </View>

        {rows.map((r) => {
          const m = MARK[r.state];
          const note = r.note || stateText[r.state];
          const label = [r.title, stateText[r.state], r.note].filter(Boolean).join(', ');
          const body = (
            <>
              <View className={`h-9 w-9 items-center justify-center rounded-full ${m.bg}`}>
                <Feather name={m.icon} size={18} color={m.color} />
              </View>
              <View className="flex-1 px-3">
                <Text className="text-base font-bold text-ink">{r.title}</Text>
                {note ? <Text className="pt-0.5 text-sm leading-5 text-muted">{note}</Text> : null}
              </View>
            </>
          );
          if (!r.tap) {
            return (
              <View
                key={r.id}
                className="mb-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5"
                accessible
                accessibilityLabel={label}
              >
                {body}
              </View>
            );
          }
          const tap = r.tap;
          // The verb shows only while there is something to do; a ready row
          // keeps its chevron and says "already allowed" when tapped.
          const verb = r.state !== 'ready' ? tap.hint : undefined;
          return (
            <Pressable
              key={r.id}
              disabled={busy !== null}
              onPress={() => void run(r.id, tap.run)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={tap.hint}
              accessibilityState={{ disabled: busy !== null, busy: busy === r.id }}
              className={`mb-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5 active:opacity-70 ${busy === r.id ? 'opacity-60' : ''}`}
            >
              {body}
              {verb ? <Text className="pr-1 text-sm font-bold text-ink">{verb}</Text> : null}
              <Feather name="chevron-right" size={20} color={ui.faint} />
            </Pressable>
          );
        })}
      </Animated.ScrollView>
      <NoticeSheet {...notice.props} />
    </View>
  );
}

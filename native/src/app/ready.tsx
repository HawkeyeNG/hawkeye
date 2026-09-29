import Feather from '@expo/vector-icons/Feather';
import { useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Linking, Platform, Pressable, Text, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { authedGet, useAuth } from '@/lib/auth';
import { t as i18nT, useT } from '@/lib/i18n';
import { onMyUnitSaved, type SavedUnit } from '@/lib/my-unit';
import { registerForPush } from '@/lib/push';
import { askPhotoLibrary, isSaveToDeviceEnabled, photoLibraryAccess } from '@/lib/save-to-device';
import { useUi } from '@/lib/theme';

/**
 * READY FOR ELECTION DAY — one row per thing that has to be in place before
 * polling day, each with its state and ONE action. Native twin of
 * app/ready.html; reached from More → Take part, the Practice Day screen, and
 * the reminder before polling day (lib/web-routes.ts maps ready.html here).
 *
 * NO POP-UP OF OUR OWN BEFORE A PERMISSION PROMPT (owner rule). "Allow" asks
 * the phone directly and the system prompt is the only dialog anyone sees. A
 * permission the phone will no longer ask about gets "Open Settings" instead —
 * asking again would do nothing, which reads as a dead button.
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
  action?: { label: string; run: () => unknown };
};
type Me = { unit?: SavedUnit | null };

const openSettings = () => {
  void Linking.openSettings();
};

export default function ReadyScreen() {
  useT();
  const ui = useUi();
  const auth = useAuth();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [cam, requestCam, getCam] = useCameraPermissions();

  const [unit, setUnit] = useState<SavedUnit | null | undefined>(undefined); // undefined = not known
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

  const allow = i18nT('ready.allow');
  const settings = { label: i18nT('n.components.capture-camera.open-settings'), run: openSettings };
  const blockedNote = i18nT('n.app.ready.blocked');
  const rows: Row[] = [];

  // Signed in. A signed-out reader is normally on the welcome screen already
  // (the root layout), but the row still says so rather than assuming.
  const signedIn = auth.status === 'signedIn';
  rows.push({
    id: 'signin',
    title: i18nT('ready.signed-in'),
    state: signedIn ? 'ready' : 'todo',
    action: signedIn ? undefined : { label: i18nT('index.sign-in'), run: () => router.push('/sign-in' as never) },
  });

  // Polling unit — the chooser page, the same one Profile opens.
  const choose = { label: i18nT('ready.choose-unit'), run: () => router.push('/choose-unit' as never) };
  rows.push(
    !signedIn
      ? { id: 'unit', title: i18nT('ready.unit-chosen'), state: 'todo', note: i18nT('ready.sign-in-first') }
      : unit
        ? { id: 'unit', title: i18nT('ready.unit-chosen'), state: 'ready', note: unit.name || unit.pu_code }
        : unit === null
          ? { id: 'unit', title: i18nT('ready.unit-chosen'), state: 'todo', action: choose }
          : {
              id: 'unit',
              title: i18nT('ready.unit-chosen'),
              state: 'unknown',
              note: unitFailed ? i18nT('ready.could-not-check') : undefined,
              action: unitFailed ? choose : undefined,
            },
  );

  // Camera.
  rows.push(
    cam?.granted
      ? { id: 'camera', title: i18nT('ready.camera'), state: 'ready' }
      : cam && !cam.canAskAgain
        ? { id: 'camera', title: i18nT('ready.camera'), state: 'blocked', note: blockedNote, action: settings }
        : {
            id: 'camera',
            title: i18nT('ready.camera'),
            state: cam ? 'todo' : 'unknown',
            action: { label: allow, run: requestCam },
          },
  );

  // Location — permission first, then the phone's own switch, then precision.
  // Filing needs a precise fix, so "approximate only" is not ready.
  const approximate =
    !!loc?.granted && (loc.ios?.accuracy === 'reduced' || loc.android?.accuracy === 'coarse');
  const askLoc = () => Location.requestForegroundPermissionsAsync();
  rows.push(
    !loc
      ? { id: 'location', title: i18nT('ready.location'), state: 'unknown', action: { label: allow, run: askLoc } }
      : !loc.granted
        ? loc.canAskAgain
          ? { id: 'location', title: i18nT('ready.location'), state: 'todo', action: { label: allow, run: askLoc } }
          : { id: 'location', title: i18nT('ready.location'), state: 'blocked', note: blockedNote, action: settings }
        : !locOn
          ? {
              id: 'location',
              title: i18nT('ready.location'),
              state: 'todo',
              note: i18nT('n.app.ready.location-off'),
              // Android shows its own "turn on location" dialog; iOS has no
              // way in but Settings.
              action:
                Platform.OS === 'android'
                  ? { label: i18nT('n.app.ready.turn-on'), run: () => Location.enableNetworkProviderAsync() }
                  : settings,
            }
          : approximate
            ? {
                id: 'location',
                title: i18nT('ready.location'),
                state: 'todo',
                note: i18nT('ready.approximate'),
                // Android asks again with its own "use precise location" prompt;
                // iOS changes precision only in Settings.
                action: Platform.OS === 'android' && loc.canAskAgain ? { label: allow, run: askLoc } : settings,
              }
            : { id: 'location', title: i18nT('ready.location'), state: 'ready' },
  );

  // Notifications. registerForPush() makes the Android channel first (Android
  // 13 shows no prompt without one), asks, and registers the token.
  const notifOk =
    notif?.granted ||
    notif?.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    notif?.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;
  rows.push(
    notifOk
      ? { id: 'notify', title: i18nT('ready.notifications'), state: 'ready' }
      : notif && !notif.canAskAgain
        ? { id: 'notify', title: i18nT('ready.notifications'), state: 'blocked', note: blockedNote, action: settings }
        : {
            id: 'notify',
            title: i18nT('ready.notifications'),
            state: notif ? 'todo' : 'unknown',
            action: { label: allow, run: registerForPush },
          },
  );

  // Photo library — only while "save report media to this phone" is on, and
  // only on a build that carries the module.
  if (photos !== 'none') {
    rows.push(
      photos === 'ready'
        ? { id: 'photos', title: i18nT('n.app.ready.photos'), state: 'ready' }
        : photos === 'blocked'
          ? { id: 'photos', title: i18nT('n.app.ready.photos'), state: 'blocked', note: blockedNote, action: settings }
          : { id: 'photos', title: i18nT('n.app.ready.photos'), state: 'todo', action: { label: allow, run: askPhotoLibrary } },
    );
  }

  const allReady = rows.every((r) => r.state === 'ready');
  const stateText: Record<State, string> = {
    ready: i18nT('ready.state-ready'),
    todo: i18nT('common.not-yet'),
    blocked: i18nT('ready.state-blocked'),
    unknown: '',
  };
  const MARK: Record<State, { icon: keyof typeof Feather.glyphMap; bg: string; color: string }> = {
    ready: { icon: 'check', bg: 'bg-good', color: ui.tint.good.ink },
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
        <Text className="pb-4 text-sm leading-5 text-muted">{i18nT('ready.lede')}</Text>

        {allReady ? (
          <View className="mb-3 flex-row items-center rounded-2xl bg-good px-4 py-3" accessibilityRole="summary">
            <Feather name="check-circle" size={18} color={ui.tint.good.ink} />
            <Text className="flex-1 pl-2 text-sm font-bold text-ink">{i18nT('ready.all-set')}</Text>
          </View>
        ) : null}

        {rows.map((r) => {
          const m = MARK[r.state];
          const note = r.note || stateText[r.state];
          return (
            <View
              key={r.id}
              className="mb-3 flex-row items-center rounded-2xl bg-card px-4 py-3.5"
              accessible={!r.action}
              accessibilityLabel={[r.title, stateText[r.state], r.note].filter(Boolean).join(', ')}
            >
              <View className={`h-9 w-9 items-center justify-center rounded-full ${m.bg}`}>
                <Feather name={m.icon} size={18} color={m.color} />
              </View>
              <View className="flex-1 px-3">
                <Text className="text-base font-bold text-ink">{r.title}</Text>
                {note ? <Text className="pt-0.5 text-sm leading-5 text-muted">{note}</Text> : null}
              </View>
              {r.action ? (
                <Pressable
                  disabled={busy !== null}
                  onPress={() => void run(r.id, r.action!.run)}
                  accessibilityRole="button"
                  accessibilityLabel={`${r.action.label}: ${r.title}`}
                  className={`rounded-full px-4 py-2 active:opacity-80 ${busy === r.id ? 'bg-disabled' : 'bg-hawk-green'}`}
                >
                  <Text className="text-sm font-bold text-hawk-gold">{r.action.label}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </Animated.ScrollView>
    </View>
  );
}

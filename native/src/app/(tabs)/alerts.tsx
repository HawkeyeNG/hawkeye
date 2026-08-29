import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScrollList } from '@/hooks/use-hide-on-scroll';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';
import { authedGet, useAuth } from '@/lib/auth';
import { markRead, openNotificationTarget, refreshUnread, setUnread, useUnread } from '@/lib/push';
import { humanError } from '@/lib/errors';

type Notification = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  read: 0 | 1;
  created_at: number;
};

/**
 * Past this many characters the body will not fit the single line the row
 * shows, so the alert gets a "More" affordance and opens in a modal.
 *
 * Deliberately BELOW what actually fits (~45 characters at this width and
 * size): offering More on a message that would just have fitted costs nothing,
 * while the opposite error clips text with no way to reach it — and the row
 * gets narrower still at large accessibility font sizes.
 *
 * Matches app/notifications.html so the same alert cannot be a panel on one
 * client and a row on the other.
 */
const ONE_LINE = 40;

function ago(ts: number) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Alerts — the observer's /api/notifications feed once signed in. */
export default function Alerts() {
  const ui = useUi();
  const auth = useAuth();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScrollList();
  const navigation = useNavigation();
  const unread = useUnread();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState(false);
  // The alert whose full text is on screen; null when the modal is closed.
  const [detail, setDetail] = useState<Notification | null>(null);
  /**
   * A TARGET TO OPEN ONCE THE MODAL HAS FINISHED DISMISSING.
   *
   * Opening it straight from the button froze the app: iOS cannot present a
   * view controller (which is what an in-app browser tab is) while another is
   * still being dismissed, so the browser appeared and vanished immediately and
   * left an orphaned window swallowing every touch — the app looked alive and
   * responded to nothing until it was force-quit.
   *
   * So the tap only RECORDS where to go; the navigation happens after dismissal
   * is genuinely complete. Held in a ref rather than state because the firing
   * path reads and clears it, and a stale closure would fire it twice.
   */
  const pending = useRef<string | null>(null);
  const firePending = useCallback(() => {
    const u = pending.current;
    pending.current = null;          // cleared BEFORE use: idempotent, so the
    if (u) openNotificationTarget(u); // iOS and Android paths cannot double-fire
  }, []);

  // Returns the failure so the caller can decide how loudly to say it: a first
  // load has an empty screen to explain itself in, a pull-to-refresh does not.
  const load = useCallback(async () => {
    if (auth.status !== 'signedIn') return null;
    try {
      const r = await authedGet<{ items: Notification[]; unread: number }>('/api/notifications');
      setItems(r.items);
      setUnread(r.unread);
      setErr(null);
      return null;
    } catch (e) {
      const msg = humanError(e);
      setErr(msg);
      return msg;
    }
  }, [auth.status]);

  useEffect(() => {
    load();
  }, [load]);

  // The badge belongs to this screen's tab, so it is set from here rather than
  // holding a second copy of the count in the layout. The options go through a
  // variable because an object literal would be excess-property-checked against
  // the navigator-agnostic type useNavigation() returns.
  useEffect(() => {
    const options = { tabBarBadge: unread > 0 ? unread : undefined };
    navigation.setOptions(options);
  }, [navigation, unread]);

  const onRefresh = async () => {
    setRefreshing(true);
    const failed = await load();
    setRefreshing(false);
    // Under a full-height list an inline error sits below the fold and is never
    // read. The pull was deliberate, so a failed one gets an answer.
    if (failed && items?.length) {
      Alert.alert('Could not refresh', `Your alerts did not load. (${failed})`);
    }
  };

  // Opening it reads it: the row goes read on screen and the jump happens now,
  // with the receipt catching up behind the new screen. A failed receipt is not
  // worth an interruption — the next load re-reads the server's truth.
  const open = (n: Notification) => {
    if (!n.read) {
      setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, read: 1 } : x)) ?? list);
      setUnread(unread - 1);
      /**
       * A FAILED RECEIPT USED TO VANISH. The row went read on screen, the badge
       * dropped, markRead's rejection was swallowed by `.catch(() => {})`, and
       * the next load quietly restored both — which from the outside is
       * indistinguishable from "tapping does not mark it read". If this ever
       * IS the fault, it now says so and puts the row back rather than leaving
       * the screen disagreeing with the server.
       */
      markRead(n.id).catch((e) => {
        setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, read: 0 } : x)) ?? list);
        refreshUnread();
        Alert.alert('Could not mark that read', humanError(e));
      });
    }
    /**
     * A LONG ALERT OPENS IN PLACE rather than navigating.
     *
     * The row shows one line, so anything longer is readable only here. The
     * modal carries the whole message and, if the alert has a url, offers it as
     * a button — so a long alert is never less reachable than a short one.
     */
    if ((n.body ?? '').length > ONE_LINE) {
      setDetail(n);
      return;
    }
    openNotificationTarget(n.url);
  };

  const markAll = async () => {
    setMarking(true);
    try {
      await markRead('all');
      setItems((list) => list?.map((x) => ({ ...x, read: 1 })) ?? list);
    } catch (e) {
      Alert.alert('Could not mark them read', humanError(e));
    } finally {
      setMarking(false);
    }
  };

  return (
    <View className="flex-1 bg-surface">
      {/* REFRESH, top right. A push can land while this screen is open, and
          tapping a notification now lands here before the feed has been
          re-read — so the alert that sent you is briefly not on the page it
          sent you to. Pull-to-refresh already exists but is not discoverable
          in that moment, and it is unreachable while the list is empty. */}
      <ScreenHeader
        title="Alerts"
        translateY={translateY}
        right="none"
        rightSlot={
          auth.status === 'signedIn' ? (
            <Pressable
              onPress={onRefresh}
              disabled={refreshing}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Refresh alerts"
            >
              {refreshing ? (
                <ActivityIndicator size="small" color={ui.tint.good.ink} />
              ) : (
                <Feather name="refresh-cw" size={19} color={ui.muted} />
              )}
            </Pressable>
          ) : null
        }
      />

      {auth.status !== 'signedIn' ? (
        <View
          className="mx-4 items-center rounded-2xl bg-card px-6 py-10"
          style={{ marginTop: headerH + 16 }}
        >
          <Feather name="bell" size={28} color={ui.tint.good.ink} />
          <Text className="pt-3 text-base font-semibold text-ink">Sign in to get alerts</Text>
          <Text className="pt-1 text-center text-sm text-muted">
            Race updates, docket cases and replies to your reports arrive here.
          </Text>
          <Pressable
            className="mt-4 rounded-2xl bg-hawk-green px-6 py-3 active:opacity-80"
            onPress={() => router.push('/sign-in')}
          >
            <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <FlashList
            data={items ?? []}
            keyExtractor={(n) => String(n.id)}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={ui.tint.good.ink}
              />
            }
            onScroll={onScroll}
            scrollEventThrottle={scrollEventThrottle}
            // headerH + 12 is the house offset (race, profile, integrity,
            // map-unit, more, races, case, osun, assistant, map, political,
            // candidates all use it). This list used bare headerH, so the first
            // alert sat flush against the header's bottom edge with no gap —
            // visible on both platforms. The empty state below already added
            // its own 16, which is why the screen only looked wrong when there
            // were alerts to show.
            contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 12 }}
            ListEmptyComponent={
              items === null && !err ? (
                <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
              ) : err ? (
                <View className="mt-4 items-center rounded-2xl bg-card px-6 py-10">
                  <Feather name="wifi-off" size={26} color={ui.faint} />
                  <Text className="pt-3 text-base font-semibold text-ink">
                    Could Not Load Your Alerts
                  </Text>
                  <Text className="pt-1 text-center text-sm text-muted">
                    Pull down to try again. ({err})
                  </Text>
                </View>
              ) : (
                <View className="mt-4 items-center rounded-2xl bg-card px-6 py-10">
                  <Text className="text-base font-semibold text-ink">Nothing Yet</Text>
                  <Text className="pt-1 text-center text-sm text-muted">
                    You are signed in. Updates on races you follow and reports you file land here.
                  </Text>
                </View>
              )
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => open(item)}
                // Unread carries a tinted card, so the tint has to darken with
                // the theme — bg-emerald-50 stayed pale and swallowed text-ink.
                className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 active:opacity-80 ${
                  item.read ? 'bg-card' : 'bg-good'
                }`}
              >
                {/* UNREAD DOT. The tinted card already says "new", but tint is
                    easy to miss at a glance and impossible to see in a
                    screenshot of a single row. Red because that is the colour
                    of the tab badge and the app icon count — three places
                    saying the same thing the same way. Hidden rather than
                    removed so the text does not shift left when a row is read. */}
                <View
                  className="mr-2.5 h-2 w-2 rounded-full"
                  style={{ backgroundColor: item.read ? 'transparent' : '#d93025' }}
                />
                <View className="flex-1 pr-2">
                  <Text className="text-base font-semibold text-ink">{item.title}</Text>
                  {/* ONE LINE, then "More". Six lines meant a 400-character
                      broadcast filled the screen and pushed every other alert
                      out of view — the list stopped being a list. One line is
                      enough to recognise an alert; the rest is a tap away. */}
                  {item.body ? (
                    <View className="flex-row items-baseline">
                      <Text className="flex-1 pt-0.5 text-sm text-muted" numberOfLines={1}>
                        {item.body}
                      </Text>
                      {item.body.length > ONE_LINE ? (
                        <Text className="pl-2 text-xs font-bold text-good-ink">More</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                {/* faint is the app's timestamp colour on a card and stays that
                    on a read row. It cannot survive the unread TINT, though:
                    --faint on --good is 1.88:1 in light mode (pale sage on pale
                    mint) and 3.11:1 in dark — the one row whose age matters most
                    was the one you could not read it on. muted holds 5.67:1 /
                    5.71:1 there, so the tinted row steps up one level. */}
                <Text className={`text-xs ${item.read ? 'text-faint' : 'text-muted'}`}>
                  {ago(item.created_at)}
                </Text>
                {item.url ? (
                  <View className="pl-1">
                    <Feather name="chevron-right" size={16} color={ui.faint} />
                  </View>
                ) : null}
              </Pressable>
            )}
          />

          {/* Sibling of the list, not a row in it: the feed runs to sixty items,
              and marking them read is exactly what someone wants after scrolling
              to the bottom of a backlog they've already read elsewhere. Nothing
              to mark on an empty or unloaded feed, so it isn't there at all. */}
          {items?.length ? (
            <View className="border-t border-line bg-surface px-4 pb-6 pt-3">
              <Pressable
                disabled={unread === 0 || marking}
                onPress={markAll}
                className={`flex-row items-center justify-center rounded-2xl py-3.5 ${
                  unread === 0 || marking ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {marking ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <>
                    <Feather name="check-circle" size={16} color={BRAND.gold} />
                    <Text className="pl-2 text-base font-bold text-hawk-gold">
                      {unread > 0 ? `Mark all read (${unread})` : 'All read'}
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : null}
        </>
      )}

      {/* THE FULL TEXT OF A LONG ALERT. Same treatment as the other modals in
          the app (support, profile): a dimmed backdrop that dismisses on tap,
          an inner card that does not, and a close affordance top-right. */}
      <Modal
        visible={!!detail}
        transparent
        animationType="fade"
        onRequestClose={() => setDetail(null)}
        // iOS fires this once dismissal is actually finished — the only moment
        // it is safe to present the browser. Android does not fire it, hence
        // the timeout fallback on the button; firePending is idempotent so the
        // two paths cannot both act.
        onDismiss={firePending}
      >
        <Pressable
          className="flex-1 items-center justify-center bg-black/60 p-5"
          onPress={() => setDetail(null)}
        >
          {detail ? (
            <Pressable
              className="w-full max-w-[420px] rounded-2xl border border-line bg-card p-5"
              onPress={() => {}}
            >
              <Pressable
                onPress={() => setDetail(null)}
                hitSlop={12}
                className="absolute right-3 top-2.5 z-10"
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Feather name="x" size={20} color={ui.muted} />
              </Pressable>
              <Text className="pr-7 text-lg font-bold text-ink">{detail.title}</Text>
              {/* Scrolls, because the cap is 500 characters and a small screen
                  in a large font will not fit that. */}
              <ScrollView className="mt-2 max-h-80">
                <Text className="text-[15px] leading-6 text-ink">{detail.body}</Text>
              </ScrollView>
              <Text className="pt-3 text-xs text-faint">{ago(detail.created_at)} ago</Text>
              {/* The url is offered, not swallowed: a long alert that also
                  points somewhere must stay as reachable as a short one. */}
              {detail.url ? (
                <Pressable
                  onPress={() => {
                    // Record, close, and let the dismissal finish before
                    // navigating — see `pending` above for what happens if the
                    // browser is presented mid-dismiss.
                    pending.current = detail.url;
                    setDetail(null);
                    // Android has no onDismiss; the fade is 300ms, so this
                    // clears it comfortably. No-op on iOS, where onDismiss has
                    // already fired and emptied the ref.
                    if (Platform.OS !== 'ios') setTimeout(firePending, 350);
                  }}
                  className="mt-3 flex-row items-center justify-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
                >
                  <Feather name="arrow-right" size={16} color={BRAND.gold} />
                  <Text className="pl-2 text-base font-bold text-hawk-gold">Open</Text>
                </Pressable>
              ) : null}
            </Pressable>
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router, useNavigation } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConfirmSheet } from '@/components/confirm-sheet';
import { BRAND } from '@/lib/api';
import { authedGet, signOut, useAuth } from '@/lib/auth';
import { markRead, openNotificationTarget, setUnread, useUnread } from '@/lib/push';

type Notification = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  read: 0 | 1;
  created_at: number;
};

function ago(ts: number) {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Alerts — the observer's /api/notifications feed once signed in. */
export default function Alerts() {
  const auth = useAuth();
  const navigation = useNavigation();
  const unread = useUnread();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

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
      const msg = e instanceof Error ? e.message : String(e);
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
      markRead(n.id).catch(() => {});
    }
    openNotificationTarget(n.url);
  };

  const markAll = async () => {
    setMarking(true);
    try {
      await markRead('all');
      setItems((list) => list?.map((x) => ({ ...x, read: 1 })) ?? list);
    } catch (e) {
      Alert.alert('Could not mark them read', e instanceof Error ? e.message : String(e));
    } finally {
      setMarking(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist" edges={['top']}>
      <ConfirmSheet
        visible={confirmOut}
        icon="log-out"
        title="Sign out?"
        body="You'll need your phone number and a code — or your password — to sign back in on this device. Nothing you have reported is affected."
        confirmLabel="Sign out"
        onConfirm={async () => {
          setConfirmOut(false);
          await signOut();
          router.replace('/welcome');
        }}
        onCancel={() => setConfirmOut(false)}
      />
      <View className="flex-row items-center justify-between px-4 pb-2 pt-4">
        <Text className="text-2xl font-bold text-hawk-ink">Alerts</Text>
        {auth.status === 'signedIn' ? (
          <Pressable hitSlop={8} onPress={() => setConfirmOut(true)}>
            <Text className="text-sm font-semibold text-hawk-leaf">
              Observer #{auth.observerId} · Sign out
            </Text>
          </Pressable>
        ) : null}
      </View>

      {auth.status !== 'signedIn' ? (
        <View className="mx-4 mt-4 items-center rounded-2xl bg-white px-6 py-10">
          <Feather name="bell" size={28} color={BRAND.leaf} />
          <Text className="pt-3 text-base font-semibold text-hawk-ink">Sign in to get alerts</Text>
          <Text className="pt-1 text-center text-sm text-neutral-500">
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
                tintColor={BRAND.leaf}
              />
            }
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
            ListEmptyComponent={
              items === null && !err ? (
                <ActivityIndicator className="pt-8" color={BRAND.leaf} />
              ) : err ? (
                <View className="mt-4 items-center rounded-2xl bg-white px-6 py-10">
                  <Feather name="wifi-off" size={26} color="#9db5a7" />
                  <Text className="pt-3 text-base font-semibold text-hawk-ink">
                    Could not load your alerts
                  </Text>
                  <Text className="pt-1 text-center text-sm text-neutral-500">
                    Pull down to try again. ({err})
                  </Text>
                </View>
              ) : (
                <View className="mt-4 items-center rounded-2xl bg-white px-6 py-10">
                  <Text className="text-base font-semibold text-hawk-ink">Nothing yet</Text>
                  <Text className="pt-1 text-center text-sm text-neutral-500">
                    You are signed in. Updates on races you follow and reports you file land here.
                  </Text>
                </View>
              )
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => open(item)}
                className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 active:opacity-80 ${
                  item.read ? 'bg-white' : 'bg-emerald-50'
                }`}
              >
                <View className="flex-1 pr-2">
                  <Text className="text-base font-semibold text-hawk-ink">{item.title}</Text>
                  {item.body ? (
                    <Text className="pt-0.5 text-sm text-neutral-600" numberOfLines={3}>
                      {item.body}
                    </Text>
                  ) : null}
                </View>
                <Text className="text-xs text-neutral-400">{ago(item.created_at)}</Text>
                {item.url ? (
                  <View className="pl-1">
                    <Feather name="chevron-right" size={16} color="#9db5a7" />
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
            <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
              <Pressable
                disabled={unread === 0 || marking}
                onPress={markAll}
                className={`flex-row items-center justify-center rounded-2xl py-3.5 ${
                  unread === 0 || marking ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
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
    </SafeAreaView>
  );
}

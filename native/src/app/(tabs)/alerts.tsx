import { Feather } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConfirmSheet } from '@/components/confirm-sheet';
import { authedGet, signOut, useAuth } from '@/lib/auth';
import { BRAND } from '@/lib/api';

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
  const [items, setItems] = useState<Notification[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  const load = useCallback(async () => {
    if (auth.status !== 'signedIn') return;
    try {
      const r = await authedGet<{ items: Notification[]; unread: number }>('/api/notifications');
      setItems(r.items);
    } catch {
      /* keep last known list; signed-out transitions re-render anyway */
    }
  }, [auth.status]);

  useEffect(() => {
    load();
  }, [load]);

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
        <FlashList
          data={items ?? []}
          keyExtractor={(n) => String(n.id)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          ListEmptyComponent={
            <View className="mt-4 items-center rounded-2xl bg-white px-6 py-10">
              <Text className="text-base font-semibold text-hawk-ink">Nothing yet</Text>
              <Text className="pt-1 text-center text-sm text-neutral-500">
                You are signed in. Updates on races you follow and reports you file land here.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View
              className={`mb-2 flex-row rounded-2xl px-4 py-3 ${item.read ? 'bg-white' : 'bg-emerald-50'}`}
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
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

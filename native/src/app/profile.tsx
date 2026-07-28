import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';
import { signOut, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';

const BASE = 'https://hawkeye.com.ng';

type Me = {
  observerId: number;
  createdAt: number;
  identityHash: string;
  hasPassword: boolean;
  unit?: { pu_code: string; name?: string; ward?: string; lga?: string; state?: string } | null;
  subscriptions?: { contest: string; state?: string }[];
  reports?: {
    pu_code: string;
    name?: string;
    contest: string;
    lga?: string;
    state?: string;
    created_at: number;
    entry_hash: string;
  }[];
  collation?: {
    level: string;
    contest: string;
    ward?: string;
    lga?: string;
    state?: string;
    created_at: number;
  }[];
  incidents?: { kind: string; status: string; pu_code?: string; state?: string; created_at: number }[];
};

const dt = (t: number) => new Date(t).toLocaleString();

async function authed(path: string, init: RequestInit = {}) {
  const token = await SecureStore.getItemAsync('hawkeye.auth.token');
  const id = await getIdentity();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'x-device-id': id.deviceId,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-3 rounded-2xl bg-white px-4 py-4">
      <Text className="pb-2 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
        {title}
      </Text>
      {children}
    </View>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <Text className="text-sm text-neutral-400">{children}</Text>
);

/**
 * My Profile — native twin of app/profile.html.
 *
 * Everything an observer has done under their identity, plus the two things
 * that are theirs to control: a password (so a new device doesn't need an OTP)
 * and deletion. The phone number is never here — only the one-way hash that
 * appears on the ledger.
 */
export default function Profile() {
  const auth = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (auth.status !== 'signedIn') return;
    try {
      const { status, body } = await authed('/api/observers/me');
      if (status !== 200) {
        setErr(`Could not load your profile. (HTTP ${status})`);
        return;
      }
      setMe(body as unknown as Me);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [auth.status]);

  useEffect(() => {
    load();
  }, [load]);

  const savePassword = async () => {
    setPwMsg(null);
    if (pwNew.length < 8) {
      setPwMsg('Use at least 8 characters.');
      return;
    }
    setPwBusy(true);
    try {
      const { status, body } = await authed('/api/observers/set-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          me?.hasPassword ? { password: pwNew, currentPassword: pwCurrent } : { password: pwNew },
        ),
      });
      if (status !== 200) {
        setPwMsg(String(body.hint ?? body.error ?? `Failed. (HTTP ${status})`));
        return;
      }
      setPwMsg(
        me?.hasPassword
          ? 'Password changed ✓'
          : 'Password set ✓ — you can now sign in with it on any device.',
      );
      setPwNew('');
      setPwCurrent('');
      setMe((m) => (m ? { ...m, hasPassword: true } : m));
    } finally {
      setPwBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete your observer identity?',
      'Your signing key, device binding, Telegram link and subscriptions are wiped. Reports already on the public ledger are permanent and stay. Re-registering the same phone restores the same ID.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const { status } = await authed('/api/observers/delete', { method: 'POST' });
            if (status === 200) {
              await signOut();
              router.replace('/(tabs)');
            } else {
              Alert.alert('Could not delete', `Try again. (HTTP ${status})`);
            }
          },
        },
      ],
    );
  };

  if (auth.status !== 'signedIn') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <Feather name="user" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
          Sign in to see your profile
        </Text>
        <Pressable
          className="mt-4 rounded-2xl bg-hawk-green px-6 py-3"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={() => router.back()}>
          <Text className="text-sm text-neutral-500">Not now</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-white"
        >
          <Feather name="x" size={18} color={BRAND.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-hawk-ink">My Profile</Text>
      </View>

      <ScrollView
        contentContainerClassName="px-4 pb-10 pt-1"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={BRAND.leaf}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {err ? (
          <Text className="pt-3 text-sm font-semibold text-amber-800">{err}</Text>
        ) : !me ? (
          <ActivityIndicator className="pt-8" color={BRAND.leaf} />
        ) : (
          <>
            <Card title="Identity">
              <View className="flex-row justify-between py-0.5">
                <Text className="text-sm text-neutral-500">Observer ID</Text>
                <Text className="text-sm font-bold text-hawk-ink">#{me.observerId}</Text>
              </View>
              <View className="flex-row justify-between py-0.5">
                <Text className="text-sm text-neutral-500">Member since</Text>
                <Text className="text-sm text-hawk-ink">{dt(me.createdAt)}</Text>
              </View>
              <Text className="pt-3 text-xs text-neutral-500">
                Your phone number is never stored or shown — this one-way hash is your public
                identity on the ledger.
              </Text>
              <View className="mt-2 rounded-xl bg-hawk-mist px-3 py-2">
                <Text className="font-mono text-[11px] text-neutral-600">{me.identityHash}</Text>
              </View>
              <Pressable
                className="mt-2 self-start rounded-xl bg-hawk-mist px-4 py-2 active:opacity-70"
                onPress={async () => {
                  await Clipboard.setStringAsync(me.identityHash);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Text className="text-xs font-bold text-hawk-leaf">
                  {copied ? 'Copied ✓' : 'Copy hash'}
                </Text>
              </Pressable>
            </Card>

            <Card title="Password">
              <Text className="text-sm text-neutral-600">
                {me.hasPassword
                  ? 'You have a password — you can sign in on any device without an OTP.'
                  : 'No password yet. Set one to sign in on new devices without waiting for an OTP.'}
              </Text>
              {me.hasPassword ? (
                <TextInput
                  value={pwCurrent}
                  onChangeText={setPwCurrent}
                  secureTextEntry
                  placeholder="Current password"
                  placeholderTextColor="#9ca3af"
                  className="mt-3 rounded-xl bg-hawk-mist px-3 py-3 text-sm text-hawk-ink"
                />
              ) : null}
              <TextInput
                value={pwNew}
                onChangeText={setPwNew}
                secureTextEntry
                placeholder="New password (min 8 characters)"
                placeholderTextColor="#9ca3af"
                className="mt-2 rounded-xl bg-hawk-mist px-3 py-3 text-sm text-hawk-ink"
              />
              {pwMsg ? (
                <Text className="pt-2 text-xs font-semibold text-hawk-leaf">{pwMsg}</Text>
              ) : null}
              <Pressable
                disabled={pwBusy}
                onPress={savePassword}
                className={`mt-3 items-center rounded-2xl py-3 ${
                  pwBusy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {pwBusy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-sm font-bold text-hawk-gold">
                    {me.hasPassword ? 'Change password' : 'Set password'}
                  </Text>
                )}
              </Pressable>
              <Text className="pt-2 text-xs text-neutral-400">
                Forgot it? Sign in again with an OTP, then set a new one here without the old.
              </Text>
            </Card>

            <Card title="My polling unit">
              {me.unit ? (
                <>
                  <Text className="text-sm font-bold text-hawk-ink">
                    {me.unit.name || me.unit.pu_code}
                  </Text>
                  <Text className="text-xs text-neutral-500">
                    {me.unit.pu_code} · {[me.unit.ward, me.unit.lga, me.unit.state]
                      .filter(Boolean)
                      .join(', ')}
                  </Text>
                </>
              ) : (
                <Empty>None saved.</Empty>
              )}
              <Pressable className="pt-2" onPress={() => router.push('/map-unit')}>
                <Text className="text-sm font-bold text-hawk-leaf">
                  Map a polling unit — get alerts for every report there →
                </Text>
              </Pressable>
            </Card>

            <Card title="Followed races">
              {me.subscriptions?.length ? (
                <View className="flex-row flex-wrap">
                  {me.subscriptions.map((s, i) => (
                    <View key={i} className="mb-2 mr-2 rounded-full bg-hawk-mist px-3 py-1.5">
                      <Text className="text-xs font-semibold text-hawk-leaf">
                        {s.contest}
                        {s.state ? ` · ${s.state}` : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Empty>None yet — follow a race from the leaderboard.</Empty>
              )}
            </Card>

            <Card title="My result reports">
              {me.reports?.length ? (
                me.reports.map((r, i) => (
                  <View key={i} className="border-t border-hawk-mist py-2 first:border-t-0">
                    <Text className="text-sm font-bold text-hawk-ink">
                      {r.name || r.pu_code} · {r.contest}
                    </Text>
                    <Text className="text-[11px] text-neutral-500">
                      {r.pu_code} · {[r.lga, r.state].filter(Boolean).join(', ')} ·{' '}
                      {dt(r.created_at)}
                    </Text>
                    <Text className="font-mono text-[10px] text-neutral-400">
                      ledger {String(r.entry_hash).slice(0, 16)}…
                    </Text>
                  </View>
                ))
              ) : (
                <Empty>No result reports yet.</Empty>
              )}
            </Card>

            <Card title="My collation reports">
              {me.collation?.length ? (
                me.collation.map((c, i) => (
                  <View key={i} className="border-t border-hawk-mist py-2 first:border-t-0">
                    <Text className="text-sm font-bold text-hawk-ink">
                      {c.level.toUpperCase()} · {c.contest}
                    </Text>
                    <Text className="text-[11px] text-neutral-500">
                      {[c.ward, c.lga, c.state].filter(Boolean).join(', ')} · {dt(c.created_at)}
                    </Text>
                  </View>
                ))
              ) : (
                <Empty>No collation reports yet.</Empty>
              )}
            </Card>

            <Card title="My incident reports">
              {me.incidents?.length ? (
                me.incidents.map((n, i) => (
                  <View key={i} className="border-t border-hawk-mist py-2 first:border-t-0">
                    <Text className="text-sm font-bold text-hawk-ink">
                      {n.kind} <Text className="text-xs text-neutral-500">({n.status})</Text>
                    </Text>
                    <Text className="text-[11px] text-neutral-500">
                      {[n.pu_code, n.state].filter(Boolean).join(' · ') || 'no location'} ·{' '}
                      {dt(n.created_at)}
                    </Text>
                  </View>
                ))
              ) : (
                <Empty>No incident reports yet.</Empty>
              )}
            </Card>

            <Card title="Session">
              <Pressable
                className="items-center rounded-2xl bg-hawk-mist py-3 active:opacity-70"
                onPress={async () => {
                  await signOut();
                  router.replace('/(tabs)');
                }}
              >
                <Text className="text-sm font-bold text-hawk-leaf">Sign out on this device</Text>
              </Pressable>
            </Card>

            <View className="mt-3 rounded-2xl bg-red-50 px-4 py-4">
              <Text className="pb-2 text-[11px] font-bold uppercase tracking-wider text-red-700/70">
                Delete my identity
              </Text>
              <Text className="text-xs text-neutral-600">
                Wipes your signing key, device binding, Telegram link and subscriptions, and
                deactivates your ID. Ledger reports are public and permanent, so they stay.
                Re-registering the same phone restores the same ID.
              </Text>
              <Pressable
                className="mt-3 items-center rounded-2xl bg-red-600 py-3 active:opacity-80"
                onPress={confirmDelete}
              >
                <Text className="text-sm font-bold text-white">Delete my observer identity</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

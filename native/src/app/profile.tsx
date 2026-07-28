import { Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PasswordField } from '@/components/password-field';
import { BRAND } from '@/lib/api';
import { requestOtp, signOut, useAuth, verifyOtp } from '@/lib/auth';
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

const dt = (t: number) =>
  new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

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

/** Settings-style row: icon, label, value/badge, chevron when it navigates. */
function Row({
  icon,
  label,
  value,
  onPress,
  chevron,
  first,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  first?: boolean;
}) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      className={`flex-row items-center px-4 py-3.5 active:bg-hawk-mist ${
        first ? '' : 'border-t border-hawk-mist'
      }`}
    >
      <Feather name={icon} size={17} color={BRAND.leaf} />
      <Text className="flex-1 pl-3 text-base text-hawk-ink">{label}</Text>
      {value ? (
        <Text className="max-w-[45%] pr-1 text-right text-sm text-neutral-400" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {chevron ? <Feather name="chevron-right" size={16} color="#9db5a7" /> : null}
    </Pressable>
  );
}

type PwMode = 'change' | 'reset-phone' | 'reset-otp' | 'reset-new';

/**
 * My Profile — settings-screen shape: a hero identity card, grouped rows,
 * activity behind accordions, and the two account controls (sign out, delete)
 * at the bottom in that order. Password management lives in a modal with the
 * forgot-password path inside it: a fresh OTP session (<15 min) lets
 * /set-password skip the current password — that IS the reset.
 */
export default function Profile() {
  const auth = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);

  // --- password modal ------------------------------------------------------
  const [pwOpen, setPwOpen] = useState(false);
  const [pwMode, setPwMode] = useState<PwMode>('change');
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [resetPhone, setResetPhone] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

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

  const openPw = () => {
    setPwMode('change');
    setPwCurrent('');
    setPwNew('');
    setPwConfirm('');
    setResetPhone('');
    setResetOtp('');
    setPwMsg(null);
    setPwOpen(true);
  };

  const savePassword = async (withCurrent: boolean) => {
    if (pwNew.length < 8) {
      setPwMsg('Use at least 8 characters.');
      return;
    }
    // Typed twice: a typo in a blind field would otherwise lock this account
    // out of its own password path until an OTP reset.
    if (pwNew !== pwConfirm) {
      setPwMsg('The two new passwords do not match.');
      return;
    }
    setPwBusy(true);
    setPwMsg(null);
    try {
      const { status, body } = await authed('/api/observers/set-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          withCurrent && me?.hasPassword
            ? { password: pwNew, currentPassword: pwCurrent }
            : { password: pwNew },
        ),
      });
      if (status !== 200) {
        setPwMsg(String(body.hint ?? body.error ?? `Failed. (HTTP ${status})`));
        return;
      }
      setMe((m) => (m ? { ...m, hasPassword: true } : m));
      setPwNew('');
      setPwConfirm('');
      setPwCurrent('');
      setPwOpen(false);
      Alert.alert(
        'Password saved',
        'You can now sign in with your phone number and password on any device.',
      );
    } finally {
      setPwBusy(false);
    }
  };

  const sendResetOtp = async () => {
    setPwBusy(true);
    setPwMsg(null);
    try {
      const r = await requestOtp(resetPhone.trim(), 'whatsapp');
      if (r.ok || r.viaSms || r.viaWhatsapp) {
        setPwMode('reset-otp');
        setPwMsg(r.devOtp ? `DEV MODE — your code is ${r.devOtp}` : 'Code sent — check WhatsApp/SMS.');
      } else {
        setPwMsg(r.hint ?? 'Could not send a code — check the number.');
      }
    } catch {
      setPwMsg('Network error — try again.');
    } finally {
      setPwBusy(false);
    }
  };

  const verifyResetOtp = async () => {
    setPwBusy(true);
    setPwMsg(null);
    try {
      // Verifying re-issues this session as a fresh OTP session, which is what
      // lets the next step set a password without the old one.
      const r = await verifyOtp(resetPhone.trim(), resetOtp.trim());
      if (r.ok) {
        setPwMode('reset-new');
        setPwMsg(null);
      } else {
        setPwMsg(
          r.error === 'otp_incorrect'
            ? 'Wrong code — check and retry.'
            : r.hint ?? 'Verification failed — try again.',
        );
      }
    } catch {
      setPwMsg('Network error — try again.');
    } finally {
      setPwBusy(false);
    }
  };

  const doSignOut = async () => {
    await signOut();
    router.replace('/welcome');
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
              router.replace('/welcome');
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

  const acts: { key: string; icon: keyof typeof Feather.glyphMap; label: string; count: number }[] = [
    { key: 'reports', icon: 'file-text', label: 'Result reports', count: me?.reports?.length ?? 0 },
    { key: 'collation', icon: 'layers', label: 'Collation reports', count: me?.collation?.length ?? 0 },
    { key: 'incidents', icon: 'alert-triangle', label: 'Incident reports', count: me?.incidents?.length ?? 0 },
  ];

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
        contentContainerClassName="px-4 pb-10 pt-3"
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
          <Text className="pt-2 text-sm font-semibold text-amber-800">{err}</Text>
        ) : !me ? (
          <ActivityIndicator className="pt-8" color={BRAND.leaf} />
        ) : (
          <>
            {/* Hero identity card */}
            <View className="rounded-2xl bg-hawk-green px-5 py-5">
              <View className="flex-row items-center">
                <View className="h-14 w-14 items-center justify-center rounded-full bg-white/10">
                  <Feather name="user" size={24} color={BRAND.gold} />
                </View>
                <View className="pl-4">
                  <Text className="text-xl font-bold text-white">Observer #{me.observerId}</Text>
                  <Text className="text-xs text-emerald-200">since {dt(me.createdAt)}</Text>
                </View>
              </View>
              <Pressable
                className="mt-4 flex-row items-center rounded-xl bg-white/10 px-3 py-2.5 active:opacity-70"
                onPress={async () => {
                  await Clipboard.setStringAsync(me.identityHash);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Text className="flex-1 pr-2 font-mono text-[11px] text-emerald-100" numberOfLines={1}>
                  {me.identityHash}
                </Text>
                <Feather name={copied ? 'check' : 'copy'} size={15} color={BRAND.gold} />
              </Pressable>
              <Text className="pt-2 text-[11px] text-emerald-200/80">
                Your public identity on the ledger — your phone number is never stored.
              </Text>
            </View>

            {/* Account */}
            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              Account
            </Text>
            <View className="overflow-hidden rounded-2xl bg-white">
              <Row
                first
                icon="key"
                label="Password"
                value={me.hasPassword ? 'Change' : 'Not set'}
                chevron
                onPress={openPw}
              />
              <Row
                icon="map-pin"
                label="My polling unit"
                value={me.unit ? me.unit.name || me.unit.pu_code : 'None saved'}
                chevron
                onPress={() => router.push('/map-unit')}
              />
            </View>
            {me.subscriptions?.length ? (
              <View className="flex-row flex-wrap pt-3">
                {me.subscriptions.map((s, i) => (
                  <View key={i} className="mb-2 mr-2 rounded-full bg-white px-3 py-1.5">
                    <Text className="text-xs font-semibold text-hawk-leaf">
                      {s.contest}
                      {s.state ? ` · ${s.state}` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Activity */}
            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-neutral-400">
              My activity
            </Text>
            <View className="overflow-hidden rounded-2xl bg-white">
              {acts.map((a, i) => (
                <View key={a.key}>
                  <Pressable
                    className={`flex-row items-center px-4 py-3.5 active:bg-hawk-mist ${
                      i > 0 ? 'border-t border-hawk-mist' : ''
                    }`}
                    onPress={() => setOpenSection((o) => (o === a.key ? null : a.key))}
                  >
                    <Feather name={a.icon} size={17} color={BRAND.leaf} />
                    <Text className="flex-1 pl-3 text-base text-hawk-ink">{a.label}</Text>
                    <View className="mr-2 min-w-[24px] items-center rounded-full bg-hawk-mist px-2 py-0.5">
                      <Text className="text-xs font-bold text-hawk-leaf">{a.count}</Text>
                    </View>
                    <Feather
                      name={openSection === a.key ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color="#9db5a7"
                    />
                  </Pressable>
                  {openSection === a.key && a.count === 0 ? (
                    <Text className="px-4 pb-3 text-sm text-neutral-400">Nothing yet.</Text>
                  ) : null}
                  {openSection === 'reports' && a.key === 'reports'
                    ? me.reports?.map((r, j) => (
                        <View key={j} className="border-t border-hawk-mist px-4 py-2.5">
                          <Text className="text-sm font-semibold text-hawk-ink">
                            {r.name || r.pu_code} · {r.contest}
                          </Text>
                          <Text className="text-[11px] text-neutral-500">
                            {[r.lga, r.state].filter(Boolean).join(', ')} · {dt(r.created_at)} ·{' '}
                            ledger {String(r.entry_hash).slice(0, 10)}…
                          </Text>
                        </View>
                      ))
                    : null}
                  {openSection === 'collation' && a.key === 'collation'
                    ? me.collation?.map((c, j) => (
                        <View key={j} className="border-t border-hawk-mist px-4 py-2.5">
                          <Text className="text-sm font-semibold text-hawk-ink">
                            {c.level.toUpperCase()} · {c.contest}
                          </Text>
                          <Text className="text-[11px] text-neutral-500">
                            {[c.ward, c.lga, c.state].filter(Boolean).join(', ')} ·{' '}
                            {dt(c.created_at)}
                          </Text>
                        </View>
                      ))
                    : null}
                  {openSection === 'incidents' && a.key === 'incidents'
                    ? me.incidents?.map((n, j) => (
                        <View key={j} className="border-t border-hawk-mist px-4 py-2.5">
                          <Text className="text-sm font-semibold text-hawk-ink">
                            {n.kind} <Text className="text-xs text-neutral-500">({n.status})</Text>
                          </Text>
                          <Text className="text-[11px] text-neutral-500">
                            {[n.pu_code, n.state].filter(Boolean).join(' · ') || 'no location'} ·{' '}
                            {dt(n.created_at)}
                          </Text>
                        </View>
                      ))
                    : null}
                </View>
              ))}
            </View>

            {/* Sign out ABOVE delete — leaving is routine, deleting is not. */}
            <Pressable
              className="mt-5 flex-row items-center justify-center rounded-2xl bg-white py-3.5 active:opacity-70"
              onPress={doSignOut}
            >
              <Feather name="log-out" size={16} color={BRAND.leaf} />
              <Text className="pl-2 text-base font-bold text-hawk-leaf">Sign out</Text>
            </Pressable>

            <Pressable
              className="mt-3 flex-row items-center justify-center rounded-2xl bg-red-50 py-3.5 active:opacity-70"
              onPress={confirmDelete}
            >
              <Feather name="trash-2" size={16} color="#b91c1c" />
              <Text className="pl-2 text-base font-bold text-red-700">Delete my identity</Text>
            </Pressable>
            <Text className="pt-2 text-center text-[11px] text-neutral-400">
              Deleting wipes your key and subscriptions. Ledger reports are public and permanent.
            </Text>
          </>
        )}
      </ScrollView>

      {/* Password modal — change, or reset via OTP without leaving it. */}
      <Modal visible={pwOpen} animationType="slide" transparent onRequestClose={() => setPwOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          className="flex-1 justify-end bg-black/40"
        >
          <View className="rounded-t-3xl bg-hawk-mist px-5 pb-8 pt-4">
            <View className="flex-row items-center pb-3">
              <Text className="flex-1 text-lg font-bold text-hawk-ink">
                {pwMode === 'change'
                  ? me?.hasPassword
                    ? 'Change password'
                    : 'Set a password'
                  : 'Reset password'}
              </Text>
              <Pressable
                hitSlop={12}
                onPress={() => setPwOpen(false)}
                className="h-8 w-8 items-center justify-center rounded-full bg-white"
              >
                <Feather name="x" size={16} color={BRAND.ink} />
              </Pressable>
            </View>

            {pwMode === 'change' ? (
              <>
                <Text className="pb-3 text-sm text-neutral-600">
                  A password lets you sign in on any device without waiting for a code.
                </Text>
                {me?.hasPassword ? (
                  <View className="mb-2">
                    <PasswordField
                      value={pwCurrent}
                      onChangeText={setPwCurrent}
                      placeholder="Current password"
                      textContentType="password"
                    />
                  </View>
                ) : null}
                <PasswordField
                  value={pwNew}
                  onChangeText={setPwNew}
                  placeholder="New password (min 8 characters)"
                  textContentType="newPassword"
                />
                <View className="pt-2">
                  <PasswordField
                    value={pwConfirm}
                    onChangeText={setPwConfirm}
                    placeholder="Repeat new password"
                    textContentType="newPassword"
                    onSubmitEditing={() => savePassword(true)}
                  />
                </View>
                {pwMsg ? (
                  <Text className="pt-2 text-sm font-semibold text-amber-800">{pwMsg}</Text>
                ) : null}
                <Pressable
                  disabled={pwBusy}
                  onPress={() => savePassword(true)}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">Save password</Text>
                  )}
                </Pressable>
                {me?.hasPassword ? (
                  <Pressable
                    className="mt-3 items-center py-1"
                    onPress={() => {
                      setPwMsg(null);
                      setPwMode('reset-phone');
                    }}
                  >
                    <Text className="text-sm font-semibold text-hawk-leaf">
                      Forgot your current password?
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}

            {pwMode === 'reset-phone' ? (
              <>
                <Text className="pb-3 text-sm text-neutral-600">
                  We&apos;ll send a code to the number on this account to prove it&apos;s you — then
                  you set a new password, no old one needed.
                </Text>
                <TextInput
                  value={resetPhone}
                  onChangeText={setResetPhone}
                  keyboardType="phone-pad"
                  placeholder="Your phone number"
                  placeholderTextColor="#9ca3af"
                  className="rounded-2xl bg-white px-4 py-3.5 text-base text-hawk-ink"
                />
                {pwMsg ? (
                  <Text className="pt-2 text-sm font-semibold text-amber-800">{pwMsg}</Text>
                ) : null}
                <Pressable
                  disabled={pwBusy || resetPhone.trim().length < 10}
                  onPress={sendResetOtp}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy || resetPhone.trim().length < 10
                      ? 'bg-neutral-300'
                      : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">Send code</Text>
                  )}
                </Pressable>
              </>
            ) : null}

            {pwMode === 'reset-otp' ? (
              <>
                <Text className="pb-3 text-sm text-neutral-600">{pwMsg ?? 'Enter the code.'}</Text>
                <TextInput
                  value={resetOtp}
                  onChangeText={setResetOtp}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="······"
                  placeholderTextColor="#9ca3af"
                  className="rounded-2xl bg-white px-4 py-3.5 text-center text-2xl font-bold tracking-[8px] text-hawk-ink"
                />
                <Pressable
                  disabled={pwBusy || resetOtp.trim().length < 6}
                  onPress={verifyResetOtp}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy || resetOtp.trim().length < 6
                      ? 'bg-neutral-300'
                      : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">Verify</Text>
                  )}
                </Pressable>
              </>
            ) : null}

            {pwMode === 'reset-new' ? (
              <>
                <Text className="pb-3 text-sm text-neutral-600">
                  Verified — now choose your new password.
                </Text>
                <PasswordField
                  value={pwNew}
                  onChangeText={setPwNew}
                  placeholder="New password (min 8 characters)"
                  textContentType="newPassword"
                />
                <View className="pt-2">
                  <PasswordField
                    value={pwConfirm}
                    onChangeText={setPwConfirm}
                    placeholder="Repeat new password"
                    textContentType="newPassword"
                    onSubmitEditing={() => savePassword(false)}
                  />
                </View>
                {pwMsg ? (
                  <Text className="pt-2 text-sm font-semibold text-amber-800">{pwMsg}</Text>
                ) : null}
                <Pressable
                  disabled={pwBusy}
                  onPress={() => savePassword(false)}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">Save new password</Text>
                  )}
                </Pressable>
              </>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

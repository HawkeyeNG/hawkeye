import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as SecureStore from '@/lib/secure-store';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmSheet } from '@/components/confirm-sheet';
import { useNotice, NoticeSheet } from '@/components/notice-sheet';
import { PasswordField } from '@/components/password-field';
import { ScreenHeader } from '@/components/screen-header';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { api, BRAND } from '@/lib/api';
import { isBiometricAvailable, isSigningGateEnabled, setSigningGateEnabled } from '@/lib/biometric';
import { pick } from '@/lib/haptics';
import { isSaveToDeviceEnabled, setSaveToDeviceEnabled } from '@/lib/save-to-device';
import { shareHawkeye } from '@/lib/share';
import { onMyUnitSaved } from '@/lib/my-unit';
import { myReferral, type Referral } from '@/lib/referral';
import { inviteUnitUrl, isUnitCode, shareInviteUnit } from '@/lib/invite-unit';
import { useUi } from '@/lib/theme';
import { requestOtp, signOut, useAuth, verifyOwner } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import { humanError } from '@/lib/errors';
import { dayMonthYear } from '@/lib/dates';
import { t as i18nT } from '@/lib/i18n';
import {
  createState,
  listPasskeys,
  passkeyErrorText,
  registerPasskeyHere,
  removePasskey,
  type PasskeyItem,
} from '@/lib/passkeys';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

/** The reset-code routes, worded exactly as the sign-in screen words them —
 *  the same three buttons on two screens must not read differently. */
type ResetChannel = 'whatsapp' | 'telegram' | 'sms';
/** D3: resets nudged to before the election window (sessions held open 9-17 Jan). Module scope keeps render pure. */
const NUDGE_RESETS = Date.now() < Date.parse('2027-01-09T00:00:00+01:00');
const RESET_CHANNEL_LABEL: Record<ResetChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  sms: 'SMS',
};

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
  mappings?: {
    pu_code: string;
    name?: string;
    ward?: string;
    lga?: string;
    state?: string;
    created_at: number;
    source: 'fix' | 'report';
    confirmed: boolean;
    crowd_reports?: number;
  }[];
};

type PracticeRun = {
  id: number;
  pu_name?: string;
  pu_code?: string;
  contest?: string;
  entry_hash: string;
  created_at: number;
  votes: { party: string; count: number }[];
};

const dt = (t: number) => dayMonthYear(new Date(t), true);

/**
 * The saved unit's full identification, as the web profile prints it:
 * code · ward, LGA, state. The code is dropped when it is already standing in
 * as the headline — a register row with no name would otherwise repeat itself.
 */
const unitWhere = (u: NonNullable<Me['unit']>) => {
  const where = [u.ward ? `${u.ward} ward` : null, u.lga, u.state].filter(Boolean).join(', ');
  return [u.name ? u.pu_code : null, where].filter(Boolean).join(' · ');
};

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

/**
 * Settings-style row: icon, label, value/badge, chevron when it navigates.
 * `sub` stacks under the label for rows whose value is too long to survive
 * the right-hand column's one truncated line (a polling unit's full
 * identification, say).
 */
function Row({
  icon,
  label,
  value,
  sub,
  onPress,
  chevron,
  first,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value?: string;
  sub?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  first?: boolean;
}) {
  const ui = useUi();
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      className={`flex-row items-center px-4 py-3.5 active:bg-surface ${
        first ? '' : 'border-t border-line'
      }`}
    >
      <Feather name={icon} size={17} color={ui.tint.good.ink} />
      <View className="flex-1 pl-3">
        <Text className="text-base text-ink">{label}</Text>
        {sub}
      </View>
      {/* muted, not faint: this column carries the row's actual value
          ("Change" / "None saved"), and --faint is only ~3:1 on --card in
          either theme. faint stays for timestamps and chevrons. */}
      {value ? (
        <Text className="max-w-[45%] pr-1 text-right text-sm text-muted" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {chevron ? <Feather name="chevron-right" size={16} color={ui.faint} /> : null}
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
  const ui = useUi();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openSection, setOpenSection] = useState<string | null>(null);
  /* The invite link. null until it arrives, and it may never arrive — the row
     simply stays quiet rather than the screen failing over it. */
  const [referral, setReferral] = useState<Referral | null>(null);
  /* Its OWN flag. `copied` above belongs to the identity-hash row, and one
     boolean between the two would make both say "Copied" on either tap. */
  const [refCopied, setRefCopied] = useState(false);
  const [confirm, setConfirm] = useState<'signout' | 'delete' | null>(null);
  /**
   * Face ID / fingerprint before signing. Two pieces of state, not one: a phone
   * with no sensor (or nothing enrolled) can never satisfy the gate, so the row
   * says so and stays unpressable instead of offering a switch that would do
   * nothing. See lib/biometric.ts.
   */
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  /** Copy report photos and videos to this phone's library. Default on; see
   *  lib/save-to-device.ts. */
  const [saveOn, setSaveOn] = useState(true);
  const notice = useNotice();
  /** Practice runs are per-device, not per-observer — practice never asks
   *  anyone to sign in, so they arrive from their own endpoint. */
  const [practice, setPractice] = useState<PracticeRun[]>([]);
  const [confirmBusy, setConfirmBusy] = useState(false);
  /** Contest code -> human name, from the same public /api/contests every other
   *  screen reads. Everything the profile shows carries only the code. */
  const [races, setRaces] = useState<Record<string, string>>({});

  /**
   * Read the biometric gate's state once. Availability is asked of the OS rather
   * than assumed: a phone with no sensor, or one where nothing is enrolled, can
   * never satisfy the prompt, and offering a switch there would be a control
   * that silently does nothing.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [available, enabled, saving] = await Promise.all([
        isBiometricAvailable(),
        isSigningGateEnabled(),
        isSaveToDeviceEnabled(),
      ]);
      if (!alive) return;
      setBioAvailable(available);
      setBioOn(enabled);
      setSaveOn(saving);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Optimistic: this is a stored preference, not a transaction to confirm. */
  const toggleBio = () => {
    pick();
    const next = !bioOn;
    setBioOn(next);
    void setSigningGateEnabled(next);
  };

  const toggleSave = () => {
    pick();
    const next = !saveOn;
    setSaveOn(next);
    void setSaveToDeviceEnabled(next);
  };

  /**
   * PASSKEYS (lib/passkeys.ts): list, remove, and add one on this phone where
   * a passkey can work. Listing and removing need no native module, so the row
   * also shows on a binary without one (1.0.11 and older, by OTA) when the
   * account already has a passkey made elsewhere — only "Add" needs the module.
   * Inline under the row, not a modal: the add button opens the system's own
   * sheet, and nothing of ours sits in front of it. Twin of profile.html #pk-modal.
   */
  const [pkItems, setPkItems] = useState<PasskeyItem[] | null>(null);
  const [pkCreate, setPkCreate] = useState<'yes' | 'no-lock' | 'no'>('no');
  const [pkOpen, setPkOpen] = useState(false);
  const [pkMsg, setPkMsg] = useState<string | null>(null);
  /** 'add', or the id being removed. */
  const [pkBusy, setPkBusy] = useState<string | null>(null);
  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let alive = true;
    listPasskeys().then((l) => { if (alive && l) setPkItems(l); });
    createState().then((s) => { if (alive) setPkCreate(s); }).catch(() => {});
    return () => { alive = false; };
  }, [auth.status]);
  const pkCount = pkItems?.length ?? 0;
  const showPasskeys = pkCreate === 'yes' || pkCount > 0;

  const onAddPasskey = async () => {
    setPkBusy('add');
    setPkMsg(null);
    try {
      const r = await registerPasskeyHere();
      if (r.ok) {
        setPkItems(r.passkeys);
        setPkMsg(i18nT('passkey.added'));
        return;
      }
      setPkMsg(passkeyErrorText(r.error));
    } catch {
      setPkMsg(passkeyErrorText('network'));
    } finally {
      setPkBusy(null);
    }
  };

  const onRemovePasskey = async (id: string) => {
    setPkBusy(id);
    setPkMsg(null);
    try {
      const r = await removePasskey(id);
      if (r.ok) {
        setPkItems(r.passkeys);
        setPkMsg(i18nT('passkey.removed'));
        return;
      }
      setPkMsg(passkeyErrorText(r.error));
    } catch {
      setPkMsg(passkeyErrorText('network'));
    } finally {
      setPkBusy(null);
    }
  };

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
  /** Only a verified OTP for THIS account's number may open the reset step. */
  const [resetProven, setResetProven] = useState(false);
  /** NO DEFAULT — the observer picks the route, so a reset can never fan out to a
   *  channel they didn't choose. */
  const [resetChannel, setResetChannel] = useState<ResetChannel | null>(null);
  /** SMS only when /api/health says the server can deliver it — same switch the
   *  sign-in screen reads, so the two pickers can never disagree. */
  const [smsOk, setSmsOk] = useState(false);
  /** A WhatsApp code sent TO the observer is PAID: offered only while the
   *  server sends them (WA_PAID_OTP; off by default). The free WhatsApp route
   *  lives on the sign-in screen ("Forgot password?"). */
  const [waPaid, setWaPaid] = useState(false);
  useEffect(() => {
    let alive = true;
    api.smsOtpEnabled().then((ok) => { if (alive) setSmsOk(ok); });
    api.waRoutes().then((r) => { if (alive) setWaPaid(r?.paid === true); });
    return () => { alive = false; };
  }, []);
  const resetChannels: ResetChannel[] = [
    ...(waPaid ? (['whatsapp'] as ResetChannel[]) : []),
    'telegram',
    ...(smsOk ? (['sms'] as ResetChannel[]) : []),
  ];

  const load = useCallback(async () => {
    if (auth.status !== 'signedIn') return;
    try {
      const { status, body } = await authed('/api/observers/me');
      if (status !== 200) {
        setErr(i18nT('n.app.profile.could-not-load-your-profile-http', { v0: status }));
        return;
      }
      setMe(body as unknown as Me);
      setErr(null);
    } catch (e) {
      setErr(humanError(e));
    }
  }, [auth.status]);

  useEffect(() => {
    load();
  }, [load]);

  /* The chooser is its own page now (/choose-unit), so its save cannot reach
     this screen's state through a prop. It announces the unit instead, and the
     row updates in place rather than refetching: a round-trip to
     /api/observers/me would leave the old unit on screen for as long as the
     network takes, right after the reader watched it save. */
  useEffect(() => onMyUnitSaved((u) => setMe((m) => (m ? ({ ...m, unit: u } as Me) : m))), []);

  /* Asked once, and never awaited by anything the screen is waiting for. */
  useEffect(() => {
    myReferral().then(setReferral);
  }, []);

  useEffect(() => {
    getIdentity()
      .then((id) =>
        fetch(`${BASE}/api/practice/mine`, { headers: { 'x-device-id': id.deviceId } })
          .then((r) => (r.ok ? (r.json() as Promise<{ runs: PracticeRun[] }>) : null)),
      )
      .then((d) => setPractice(d?.runs ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .contests()
      .then((list) => setRaces(Object.fromEntries(list.map((c) => [c.code, c.name]))))
      .catch(() => {
        /* names are a courtesy — the rows fall back to the raw code */
      });
  }, []);

  const openPw = () => {
    setPwMode('change');
    setPwCurrent('');
    setPwNew('');
    setPwConfirm('');
    setResetPhone('');
    setResetOtp('');
    setResetChannel(null);
    setResetProven(false);
    setPwMsg(null);
    setPwOpen(true);
  };

  const savePassword = async (withCurrent: boolean) => {
    // Belt and braces: the reset step is only rendered after a proven OTP, but
    // never let a stale mode reach the server without one.
    if (!withCurrent && !resetProven) {
      setPwMsg(i18nT('n.app.profile.verify-the-code-sent-to-your'));
      return;
    }
    if (pwNew.length < 8) {
      setPwMsg(i18nT('n.app.sign-in.use-at-least-8-characters'));
      return;
    }
    // Typed twice: a typo in a blind field would otherwise lock this account
    // out of its own password path until an OTP reset.
    if (pwNew !== pwConfirm) {
      setPwMsg(i18nT('n.app.profile.the-two-new-passwords-do-not'));
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
        setPwMsg(String(body.hint ?? body.error ?? i18nT('n.app.profile.failed-http', { v0: status })));
        return;
      }
      setMe((m) => (m ? { ...m, hasPassword: true } : m));
      setPwNew('');
      setPwConfirm('');
      setPwCurrent('');
      setPwOpen(false);
      notice.show(
        i18nT('n.app.profile.password-saved'),
        i18nT('n.app.profile.you-can-now-sign-in-with'),
        'good',
      );
    } finally {
      setPwBusy(false);
    }
  };

  const sendResetOtp = async () => {
    setPwBusy(true);
    setPwMsg(null);
    try {
      const r = await requestOtp(resetPhone.trim(), resetChannel as ResetChannel);
      const to = resetPhone.trim();
      if (r.telegramLink && !r.viaSms) {
        // Telegram not linked to this number yet (or the chat refused the
        // message): the bot sends the code once the contact is shared there.
        setPwMode('reset-otp');
        setPwMsg(i18nT('n.app.sign-in.open-telegram-tap-start-then-share'));
        WebBrowser.openBrowserAsync(r.telegramLink).catch(() => {});
      } else if (r.ok || r.viaSms || r.viaWhatsapp) {
        setPwMode('reset-otp');
        // Where the code actually went — never "check WhatsApp/SMS" for a
        // code that went to Telegram.
        setPwMsg(
          r.devOtp ? i18nT('n.app.profile.dev-mode-your-code-is', { v0: r.devOtp })
          : r.viaWhatsapp ? i18nT('n.app.sign-in.code-sent-on-whatsapp-to', { v0: to })
          : r.viaSms ? i18nT('n.app.sign-in.code-sent-by-sms-to', { v0: to })
          : r.viaTelegram ? i18nT('n.app.sign-in.code-sent-on-telegram-to', { v0: to })
          : i18nT('n.app.sign-in.code-sent-to', { v0: to }),
        );
      } else {
        setPwMsg(r.hint ?? i18nT('n.app.sign-in.could-not-send-a-code-check'));
      }
    } catch {
      setPwMsg(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setPwBusy(false);
    }
  };

  const verifyResetOtp = async () => {
    setPwBusy(true);
    setPwMsg(null);
    try {
      // verifyOwner, never verifyOtp: the server refuses any number that isn't
      // this observer's, so a mistyped (or someone else's) number can neither
      // reset this password nor drag the session onto another identity.
      const r = await verifyOwner(resetPhone.trim(), resetOtp.trim());
      if (r.ok) {
        setResetProven(true);
        setPwMode('reset-new');
        setPwMsg(null);
      } else {
        setPwMsg(
          r.error === 'not_your_number'
            ? i18nT('n.app.profile.number-not-registered-to-id')
            : r.error === 'otp_incorrect'
              ? i18nT('n.app.profile.wrong-code-check-and-retry')
              : r.error === 'otp_expired'
                ? i18nT('n.app.profile.code-expired-send-new')
                : r.hint ?? i18nT('n.app.sign-in.verification-failed-try-again'),
        );
      }
    } catch {
      setPwMsg(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setPwBusy(false);
    }
  };

  const doSignOut = async () => {
    setConfirmBusy(true);
    await signOut();
    setConfirmBusy(false);
    setConfirm(null);
    router.replace('/welcome');
  };

  const doDelete = async () => {
    setConfirmBusy(true);
    const { status } = await authed('/api/observers/delete', { method: 'POST' });
    setConfirmBusy(false);
    setConfirm(null);
    if (status === 200) {
      await signOut();
      router.replace('/welcome');
    } else {
      notice.show(i18nT('n.app.profile.could-not-delete'), i18nT('n.app.profile.try-again-http', { v0: status }));
    }
  };

  if (auth.status !== 'signedIn') {
    return (
      <View className="flex-1 items-center justify-center bg-surface px-8">
        <Feather name="user" size={28} color={ui.tint.good.ink} />
        <Text className="pt-3 text-center text-base font-semibold text-ink">
          {i18nT('n.app.profile.sign-in-to-see-your-profile')}
        </Text>
        <Pressable
          className="mt-4 rounded-2xl bg-hawk-green px-6 py-3"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-hawk-gold">{i18nT('index.sign-in')}</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={() => router.back()}>
          <Text className="text-sm text-muted">{i18nT('lang.later')}</Text>
        </Pressable>
      </View>
    );
  }

  const savedUnit = me?.unit ?? null;
  const savedUnitWhere = savedUnit ? unitWhere(savedUnit) : '';

  /**
   * Subscriptions, reports and collations all arrive tagged with the backend's
   * contest code — "GOV" on its own told nobody which election it meant. The
   * code only stands in while /api/contests is in flight or unreachable.
   */
  const raceName = (code: string) => races[code] ?? code;

  const acts: { key: string; icon: keyof typeof Feather.glyphMap; label: string; count: number }[] = [
    { key: 'reports', icon: 'file-text', label: i18nT('n.app.profile.result-reports'), count: me?.reports?.length ?? 0 },
    { key: 'collation', icon: 'layers', label: i18nT('n.app.profile.collation-reports'), count: me?.collation?.length ?? 0 },
    { key: 'incidents', icon: 'alert-triangle', label: i18nT('incident-reports.incident-reports'), count: me?.incidents?.length ?? 0 },
    { key: 'mappings', icon: 'map-pin', label: i18nT('n.app.profile.units-mapped'), count: me?.mappings?.length ?? 0 },
    { key: 'practice', icon: 'play-circle', label: i18nT('n.app.profile.practice-runs'), count: practice.length },
  ];

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('profile.my-profile')} translateY={translateY} onClose={() => router.back()} />

      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ui.tint.good.ink}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {err ? (
          <Text className="pt-2 text-sm font-semibold text-warn-ink">{err}</Text>
        ) : !me ? (
          <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
        ) : (
          <>
            {/* Hero identity card. bg-hawk-green is a fixed brand surface, so
                every scrim on it is fixed white at low alpha — bg-card/10 went
                dark-on-dark and disappeared once --card followed the theme. */}
            <View className="rounded-2xl bg-hawk-green px-5 py-5">
              <View className="flex-row items-center">
                <View className="h-14 w-14 items-center justify-center rounded-full bg-white/10">
                  <Feather name="user" size={24} color={BRAND.gold} />
                </View>
                <View className="pl-4">
                  <Text className="text-xl font-bold text-white">{i18nT('n.app.profile.observer-number')}{me.observerId}</Text>
                  <Text className="text-xs text-emerald-200">{i18nT('n.app.profile.since')} {dt(me.createdAt)}</Text>
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
                {i18nT('n.app.profile.your-public-identity-on-the-ledger')}
              </Text>
            </View>

            {/* Account */}
            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
              Account
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              <Row
                first
                icon="key"
                label={i18nT('common.password')}
                value={me.hasPassword ? i18nT('n.app.profile.change') : i18nT('n.app.profile.not-set')}
                chevron
                onPress={openPw}
              />
              {showPasskeys ? (
                <>
                  <Row
                    icon="lock"
                    label={i18nT('passkey.profile-row')}
                    value={pkCount ? i18nT('passkey.count', { n: pkCount }) : i18nT('passkey.count-none')}
                    onPress={() => {
                      setPkMsg(null);
                      setPkOpen((o) => !o);
                    }}
                  />
                  {pkOpen ? (
                    <View className="px-4 pb-4">
                      <Text className="text-xs text-muted">{i18nT('passkey.modal-body')}</Text>
                      {pkCount ? (
                        (pkItems ?? []).map((p) => (
                          <View key={p.id} className="flex-row items-center pt-3">
                            <View className="flex-1 pr-2">
                              <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
                                {p.label ?? ''}
                              </Text>
                              <Text className="text-[11px] text-muted">
                                {[
                                  i18nT('passkey.added-on', { date: dt(p.createdAt) }),
                                  p.lastUsedAt ? i18nT('passkey.last-used', { date: dt(p.lastUsedAt) }) : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </Text>
                            </View>
                            <Pressable
                              disabled={!!pkBusy}
                              onPress={() => void onRemovePasskey(p.id)}
                              accessibilityRole="button"
                              accessibilityLabel={i18nT('passkey.remove-aria', { label: p.label ?? '' })}
                              className="rounded-full bg-bad px-3 py-1.5 active:opacity-70"
                            >
                              {pkBusy === p.id ? (
                                <ActivityIndicator size="small" color={ui.tint.bad.ink} />
                              ) : (
                                <Text className="text-xs font-bold text-bad-ink">{i18nT('passkey.remove')}</Text>
                              )}
                            </Pressable>
                          </View>
                        ))
                      ) : (
                        <Text className="pt-3 text-sm text-muted">{i18nT('passkey.none-yet')}</Text>
                      )}
                      {/* Add: only where this phone can make one. A phone with no
                          lock is told what to set up; an older binary (no module)
                          or a server with passkeys off simply has no button. */}
                      {pkCreate === 'yes' ? (
                        <Pressable
                          disabled={!!pkBusy}
                          onPress={() => void onAddPasskey()}
                          accessibilityRole="button"
                          className={`mt-4 items-center rounded-2xl py-3 ${
                            pkBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                          }`}
                        >
                          {pkBusy === 'add' ? (
                            <ActivityIndicator color={BRAND.gold} />
                          ) : (
                            <Text className="text-sm font-bold text-hawk-gold">{i18nT('passkey.add')}</Text>
                          )}
                        </Pressable>
                      ) : pkCreate === 'no-lock' ? (
                        <Text className="pt-3 text-xs text-muted">{i18nT('n.passkey.needs-lock')}</Text>
                      ) : null}
                      {pkMsg ? (
                        <Text className="pt-2 text-sm text-muted" accessibilityLiveRegion="polite">
                          {pkMsg}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </>
              ) : null}
              {/* Unpressable when the phone cannot satisfy it, rather than a
                  switch that would flip and change nothing. */}
              <Row
                icon="shield"
                label={i18nT('n.app.profile.face-id-or-fingerprint-to-sign')}
                value={bioAvailable ? (bioOn ? 'On' : 'Off') : 'Not Available'}
                onPress={bioAvailable ? toggleBio : undefined}
                sub={
                  <Text className="pt-0.5 text-xs text-muted">
                    {bioAvailable
                      ? i18nT('n.app.profile.asked-once-just-before-a-real')
                      : 'This phone has no fingerprint or face unlock set up.'}
                  </Text>
                }
              />
              <Row
                icon="download"
                label={i18nT('n.app.profile.save-report-photos-and-videos-to')}
                value={saveOn ? 'On' : 'Off'}
                onPress={toggleSave}
                sub={
                  <Text className="pt-0.5 text-xs text-muted">
                    {i18nT('n.app.profile.turn-off-if-your-phone-may')}
                  </Text>
                }
              />
              <Row
                icon="map-pin"
                label={i18nT('index.my-polling-unit')}
                // Right-hand column only carries the empty state; a saved unit
                // needs its whole identification, which lives in `sub`.
                value={savedUnit ? undefined : 'None Saved'}
                sub={
                  savedUnit ? (
                    <>
                      <Text
                        className="pt-0.5 text-sm font-semibold text-ink"
                        numberOfLines={2}
                      >
                        {savedUnit.name || savedUnit.pu_code}
                      </Text>
                      {savedUnitWhere ? (
                        <Text className="text-[11px] text-muted" numberOfLines={2}>
                          {savedUnitWhere}
                        </Text>
                      ) : null}
                    </>
                  ) : null
                }
                chevron
                /* CHOOSE, not map. This used to push /map-unit — a screen whose
                   instruction is "Stand at the polling unit and record one GPS
                   fix" and whose primary button is "I am standing here". Saving
                   was a secondary row on it, so someone who only wanted to say
                   which unit is theirs was handed a surveying tool and told to
                   be standing in the right place. /map-unit is unchanged and
                   still right for contributing a coordinate.
                   A full page, not a sheet: `current` lets it mark the saved
                   row, and its close returns here. Cast: typed routes
                   regenerate on the next `expo start`. */
                onPress={() =>
                  router.push({
                    pathname: '/choose-unit',
                    params: savedUnit ? { current: savedUnit.pu_code } : {},
                  } as never)
                }
              />
              {/* BRING A SECOND OBSERVER TO YOUR UNIT. Directly under the unit
                  it is about, and only once one is saved (and the invite code
                  has arrived): two matching reports verify a unit's count. The
                  link carries the code and this unit's code, nothing else. */}
              {savedUnit && referral && isUnitCode(savedUnit.pu_code) ? (
                <Row
                  icon="user-plus"
                  label={i18nT('n.invite2.button')}
                  sub={<Text className="pt-0.5 text-xs text-muted">{i18nT('n.invite2.why')}</Text>}
                  chevron
                  onPress={() => {
                    void shareInviteUnit(inviteUnitUrl(referral.code, savedUnit.pu_code));
                  }}
                />
              ) : null}
            </View>
            {/* Headed, not bare: these chips used to float under the account
                card as naked codes, and read as noise rather than as the
                alerts the observer had switched on. */}
            {me.subscriptions?.length ? (
              <>
                <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
                  {i18nT('n.app.profile.races-you-follow')}
                </Text>
                <View className="rounded-2xl bg-card px-4 pb-1.5 pt-3.5">
                  <Text className="text-xs text-muted">
                    {i18nT('n.app.profile.you-get-an-alert-on-every')}
                  </Text>
                  <View className="flex-row flex-wrap pt-2.5">
                    {me.subscriptions.map((s, i) => (
                      <View key={i} className="mb-2 mr-2 rounded-full bg-surface px-3 py-1.5">
                        <Text className="text-xs font-semibold text-good-ink">
                          {raceName(s.contest)}
                          {s.state ? ` — ${s.state}` : ''}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              </>
            ) : null}

            {/* Activity */}
            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
              {i18nT('n.app.profile.my-activity')}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              {acts.map((a, i) => (
                <View key={a.key}>
                  <Pressable
                    className={`flex-row items-center px-4 py-3.5 active:bg-surface ${
                      i > 0 ? 'border-t border-line' : ''
                    }`}
                    onPress={() => {
                      pick();
                      setOpenSection((o) => (o === a.key ? null : a.key));
                    }}
                  >
                    <Feather name={a.icon} size={17} color={ui.tint.good.ink} />
                    <Text className="flex-1 pl-3 text-base text-ink">{a.label}</Text>
                    <View className="mr-2 min-w-[24px] items-center rounded-full bg-surface px-2 py-0.5">
                      <Text className="text-xs font-bold text-good-ink">{a.count}</Text>
                    </View>
                    <Feather
                      name={openSection === a.key ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={ui.faint}
                    />
                  </Pressable>
                  {openSection === a.key && a.count === 0 ? (
                    <Text className="px-4 pb-3 text-sm text-muted">{i18nT('n.app.profile.nothing-yet')}</Text>
                  ) : null}
                  {openSection === 'reports' && a.key === 'reports'
                    ? me.reports?.map((r, j) => (
                        <View key={j} className="border-t border-line px-4 py-2.5">
                          <Text className="text-sm font-semibold text-ink">
                            {r.name || r.pu_code} · {raceName(r.contest)}
                          </Text>
                          <Text className="text-[11px] text-muted">
                            {[r.lga, r.state].filter(Boolean).join(', ')} · {dt(r.created_at)} ·{' '}
                            ledger {String(r.entry_hash).slice(0, 10)}…
                          </Text>
                        </View>
                      ))
                    : null}
                  {openSection === 'collation' && a.key === 'collation'
                    ? me.collation?.map((c, j) => (
                        <View key={j} className="border-t border-line px-4 py-2.5">
                          <Text className="text-sm font-semibold text-ink">
                            {c.level.toUpperCase()} · {raceName(c.contest)}
                          </Text>
                          <Text className="text-[11px] text-muted">
                            {[c.ward, c.lga, c.state].filter(Boolean).join(', ')} ·{' '}
                            {dt(c.created_at)}
                          </Text>
                        </View>
                      ))
                    : null}
                  {openSection === 'practice' && a.key === 'practice'
                    ? practice.map((r) => (
                        <View key={r.id} className="border-t border-line px-4 py-2.5">
                          <Text className="text-sm font-semibold text-ink">
                            {r.pu_name || r.pu_code || 'Practice polling unit'}
                          </Text>
                          <Text className="text-[11px] text-muted">
                            {r.votes
                              .filter((v) => v.count > 0)
                              .map((v) => `${v.party} ${v.count}`)
                              .join(' · ') || 'all zero'}{' '}
                            · {dt(r.created_at)}
                          </Text>
                          <Text className="pt-0.5 font-mono text-[10px] text-faint">
                            practice chain {String(r.entry_hash).slice(0, 16)}…
                          </Text>
                        </View>
                      ))
                    : null}
                  {openSection === 'mappings' && a.key === 'mappings'
                    ? me.mappings?.map((m, j) => (
                        <View key={j} className="border-t border-line px-4 py-2.5">
                          <Text className="text-sm font-semibold text-ink">
                            {m.name || m.pu_code}
                          </Text>
                          <Text className="text-[11px] text-muted">
                            {[m.ward, m.lga, m.state].filter(Boolean).join(', ')} · {dt(m.created_at)}
                          </Text>
                          <Text className="pt-0.5 text-[11px] font-semibold text-good-ink">
                            {m.confirmed ? 'Located ✓' : i18nT('n.app.profile.fix-es-so-far', { v0: m.crowd_reports ?? 0 })}
                            {m.source === 'report' ? ' · via your verified report' : ''}
                          </Text>
                        </View>
                      ))
                    : null}
                  {openSection === 'incidents' && a.key === 'incidents'
                    ? me.incidents?.map((n, j) => (
                        <View key={j} className="border-t border-line px-4 py-2.5">
                          <Text className="text-sm font-semibold text-ink">
                            {n.kind} <Text className="text-xs text-muted">({n.status})</Text>
                          </Text>
                          <Text className="text-[11px] text-muted">
                            {[n.pu_code, n.state].filter(Boolean).join(' · ') || 'no location'} ·{' '}
                            {dt(n.created_at)}
                          </Text>
                        </View>
                      ))
                    : null}
                </View>
              ))}
            </View>

            {/* SHARE HAWKEYE. Down with the actions rather than up with the
                account rows: it is not a setting, and it is the one thing on
                this screen an observer might do FOR Hawkeye rather than to
                their own account.

                Its own card because there is exactly one row — the same shape
                the section above uses, so the screen has one list treatment
                instead of a special control at the bottom. The full section,
                with the Telegram bot and the accounts, is on More
                (components/social-row.tsx); this is the one entry that belongs
                on a page about you. */}
            {/* INVITE OTHERS.
                The binding constraint is not capability, it is how few people
                are standing at a unit with this: Osun drew twelve organic
                observers against 3,763 polling units. The only channel that
                reaches 176,846 is one observer handing it to the next, so the
                invite sits on a screen they already visit.

                TWO COUNTS, AND THE SECOND IS THE HONEST ONE. "signed up" is who
                made an account; "observed" is who went on to file an accepted
                result. Only the second would ever be paid on, so both are shown
                from the start — introducing the second one alongside a payout
                is what would read as a bait-and-switch.

                The whole section is absent until the code arrives: a row
                reading "…" forever is worse than no row. */}
            {referral ? (
              <>
                <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
                  {i18nT('profile.invite')}
                </Text>
                <View className="overflow-hidden rounded-2xl bg-card">
                  <Row
                    first
                    icon="link"
                    label={i18nT('profile.your-invite-link')}
                    value={refCopied ? i18nT('n.app.profile.copied') : referral.code}
                    chevron
                    onPress={async () => {
                      /* COPY FIRST, AND ALWAYS SAY SOMETHING. The web twin
                         reached for navigator.share, which on some surfaces
                         succeeds invisibly or throws silently — the row read as
                         a dead button. Copying is the one action that works
                         everywhere and can be confirmed on screen. */
                      await Clipboard.setStringAsync(referral.url);
                      setRefCopied(true);
                      setTimeout(() => setRefCopied(false), 2000);
                    }}
                  />
                  <Row
                    icon="users"
                    label={i18nT('profile.people-you-invited')}
                    value={referral.signedUp
                      ? `${referral.signedUp} ${i18nT('profile.signed-up')} \u00b7 ${referral.qualified} ${i18nT('profile.observed')}`
                      : i18nT('profile.none-yet')}
                  />
                </View>
              </>
            ) : null}

            {/* The Hawkeye Observer certificate (app/certificate.tsx): a practice
                run plus the observer quiz; the screen shows it again once earned. */}
            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
              {i18nT('cert.profile-heading')}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              <Row
                first
                icon="award"
                label={i18nT('cert.profile-row')}
                value={i18nT('cert.profile-row-sub')}
                chevron
                onPress={() => router.push('/certificate' as never)}
              />
            </View>

            <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
              {i18nT('n.app.profile.find-hawkeye')}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              <Row
                first
                icon="share-2"
                label={i18nT('profile.share-hawkeye')}
                value={i18nT('n.app.profile.send-it-on')}
                chevron
                onPress={shareHawkeye}
              />
            </View>

            {/* Delete stays in the scroll, below everything — deleting is not
                routine, and it should stay the harder of the two to reach. */}
            <Pressable
              className="mt-5 flex-row items-center justify-center rounded-2xl bg-bad py-3.5 active:opacity-70"
              onPress={() => setConfirm('delete')}
            >
              <Feather name="trash-2" size={16} color={ui.tint.bad.ink} />
              {/* "Account", not "identity". App Review rejected Hawkeye Lite for
                  having no way to "initiate account deletion" while this exact
                  control sat on its profile screen — a reviewer scanning for the
                  word never matched "identity". The concept keeps its name in the
                  line below; the control says what a reader expects. */}
              <Text className="pl-2 text-base font-bold text-bad-ink">{i18nT('profile.delete-my-account')}</Text>
            </Pressable>
            <Text className="pt-2 text-center text-[11px] text-faint">
              {i18nT('n.app.profile.deletes-your-observer-identity-key-and')}
            </Text>
          </>
        )}
      </Animated.ScrollView>

      {/* Sign out is pinned below the scroll: the four activity accordions
          expand on tap and push everything under them off-screen, so the one
          routine control here has to stay reachable regardless. */}
      {me && !err ? (
        <View
          className="border-t border-line bg-surface px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <Pressable
            className="flex-row items-center justify-center rounded-2xl bg-card py-3.5 active:opacity-70"
            onPress={() => setConfirm('signout')}
          >
            <Feather name="log-out" size={16} color={ui.tint.good.ink} />
            <Text className="pl-2 text-base font-bold text-good-ink">{i18nT('n.app.profile.sign-out')}</Text>
          </Pressable>
        </View>
      ) : null}

      <ConfirmSheet
        visible={confirm === 'signout'}
        icon="log-out"
        title={i18nT('n.app.profile.sign-out-2')}
        body={i18nT('n.app.profile.sign-out-body')}
        confirmLabel={i18nT('n.app.profile.sign-out')}
        busy={confirmBusy}
        onConfirm={doSignOut}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmSheet
        visible={confirm === 'delete'}
        icon="trash-2"
        danger
        title={i18nT('n.app.profile.delete-your-account')}
        body={i18nT('n.app.profile.wipes-your-key-device-telegram-link')}
        confirmLabel={i18nT('profile.delete-my-account')}
        busy={confirmBusy}
        onConfirm={doDelete}
        onCancel={() => setConfirm(null)}
      />

      {/* Password modal — change, or reset via OTP without leaving it. */}
      <Modal visible={pwOpen} animationType="slide" transparent onRequestClose={() => setPwOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
          className="flex-1 justify-end bg-black/40"
        >
          <View className="rounded-t-3xl bg-surface px-5 pb-8 pt-4">
            <View className="flex-row items-center pb-3">
              <Text className="flex-1 text-lg font-bold text-ink">
                {pwMode === 'change'
                  ? me?.hasPassword
                    ? 'Change Password'
                    : 'Set a Password'
                  : 'Reset Password'}
              </Text>
              <Pressable
                hitSlop={12}
                onPress={() => setPwOpen(false)}
                className="h-8 w-8 items-center justify-center rounded-full bg-card"
              >
                <Feather name="x" size={16} color={ui.ink} />
              </Pressable>
            </View>

            {pwMode === 'change' ? (
              <>
                <Text className="pb-3 text-sm text-muted">
                  {i18nT('n.app.profile.a-password-lets-you-sign-in')}
                </Text>
                {me?.hasPassword ? (
                  <View className="mb-2">
                    <PasswordField
                      value={pwCurrent}
                      onChangeText={setPwCurrent}
                      placeholder={i18nT('n.app.profile.current-password')}
                      textContentType="password"
                    />
                  </View>
                ) : null}
                <PasswordField
                  value={pwNew}
                  onChangeText={setPwNew}
                  placeholder={i18nT("n.app.profile.new-password-min-8-characters")}
                  textContentType="newPassword"
                />
                <View className="pt-2">
                  <PasswordField
                    value={pwConfirm}
                    onChangeText={setPwConfirm}
                    placeholder={i18nT('n.app.profile.repeat-new-password')}
                    textContentType="newPassword"
                    onSubmitEditing={() => savePassword(true)}
                  />
                </View>
                {pwMsg ? (
                  <Text className="pt-2 text-sm font-semibold text-warn-ink">{pwMsg}</Text>
                ) : null}
                <Pressable
                  disabled={pwBusy}
                  onPress={() => savePassword(true)}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.profile.save-password')}</Text>
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
                    <Text className="text-sm font-semibold text-good-ink">
                      {i18nT('n.app.profile.forgot-your-current-password')}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}

            {pwMode === 'reset-phone' ? (
              <>
                <Text className="pb-3 text-sm text-muted">
                  {i18nT('n.app.profile.enter-the-number-registered-to-this')}
                </Text>
                {/* D3: before the election window (sessions are held open 9-17 Jan). */}
                {NUDGE_RESETS ? (
                  <Text className="pb-3 text-xs text-muted">{i18nT('auth.reset-before-9-jan')}</Text>
                ) : null}
                <TextInput
                  value={resetPhone}
                  onChangeText={setResetPhone}
                  keyboardType="phone-pad"
                  placeholder={i18nT('n.app.profile.your-phone-number')}
                  placeholderTextColor={ui.faint}
                  className="rounded-2xl bg-card px-4 py-3.5 text-base text-ink"
                />
                {pwMsg ? (
                  <Text className="pt-2 text-sm font-semibold text-warn-ink">{pwMsg}</Text>
                ) : null}
                {/* Pick the route — nothing is pre-selected, so a reset never
                    sends on a channel the observer didn't choose. */}
                <View className="flex-row gap-2 pt-3">
                  {resetChannels.map((c) => (
                    <Pressable
                      key={c}
                      onPress={() => setResetChannel(c)}
                      className={`rounded-full px-4 py-2 ${resetChannel === c ? 'bg-hawk-green' : 'bg-card'}`}
                    >
                      <Text
                        className={`text-sm font-semibold ${resetChannel === c ? 'text-hawk-gold' : 'text-muted'}`}
                      >
                        {RESET_CHANNEL_LABEL[c]}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable
                  disabled={pwBusy || resetPhone.trim().length < 10 || !resetChannel}
                  onPress={sendResetOtp}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy || resetPhone.trim().length < 10 || !resetChannel
                      ? 'bg-disabled'
                      : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.profile.send-code')}</Text>
                  )}
                </Pressable>
              </>
            ) : null}

            {pwMode === 'reset-otp' ? (
              <>
                <Text className="pb-3 text-sm text-muted">{pwMsg ?? i18nT('n.app.profile.enter-the-code')}</Text>
                <TextInput
                  value={resetOtp}
                  onChangeText={setResetOtp}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="······"
                  placeholderTextColor={ui.faint}
                  // No letter spacing: iOS recycles TextInput views and the
                  // kerning outlives this field, spacing out the next
                  // placeholder that lands on it. See the OTP box in sign-in.tsx.
                  className="rounded-2xl bg-card px-4 py-3.5 text-center text-2xl font-bold text-ink"
                />
                <Pressable
                  disabled={pwBusy || resetOtp.trim().length < 6}
                  onPress={verifyResetOtp}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy || resetOtp.trim().length < 6
                      ? 'bg-disabled'
                      : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.profile.verify')}</Text>
                  )}
                </Pressable>
              </>
            ) : null}

            {pwMode === 'reset-new' ? (
              <>
                <Text className="pb-3 text-sm text-muted">
                  {i18nT('n.app.profile.verified-now-choose-your-new-password')}
                </Text>
                <PasswordField
                  value={pwNew}
                  onChangeText={setPwNew}
                  placeholder={i18nT("n.app.profile.new-password-min-8-characters")}
                  textContentType="newPassword"
                />
                <View className="pt-2">
                  <PasswordField
                    value={pwConfirm}
                    onChangeText={setPwConfirm}
                    placeholder={i18nT('n.app.profile.repeat-new-password')}
                    textContentType="newPassword"
                    onSubmitEditing={() => savePassword(false)}
                  />
                </View>
                {pwMsg ? (
                  <Text className="pt-2 text-sm font-semibold text-warn-ink">{pwMsg}</Text>
                ) : null}
                <Pressable
                  disabled={pwBusy}
                  onPress={() => savePassword(false)}
                  className={`mt-4 items-center rounded-2xl py-3.5 ${
                    pwBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pwBusy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.profile.save-new-password')}</Text>
                  )}
                </Pressable>
              </>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <NoticeSheet {...notice.props} />
    </View>
  );
}

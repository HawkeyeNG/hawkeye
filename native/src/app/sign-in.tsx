import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PasswordField } from '@/components/password-field';
import { passwordLogin, requestOtp, verifyOtp, type RegisterResult } from '@/lib/auth';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

type Channel = 'whatsapp' | 'sms' | 'telegram';

/**
 * OTP sign-in — the native twin of observe.html's auth step, keeping the
 * copy discipline the web flow settled on: one concise line per state.
 *
 * The step transition is OPTIMISTIC: tapping "Request code" flips to the OTP
 * screen immediately and the send resolves in the background ("Sending…" →
 * "Code sent on WhatsApp…"). Gating the transition on the network made the
 * button spin for the whole server round-trip, which reads as a slow app —
 * the one thing this rewrite exists to avoid. On failure we return to the
 * phone step with the error line, so nothing is lost.
 */
export default function SignIn() {
  const ui = useUi();
  const [step, setStep] = useState<'phone' | 'otp' | 'password'>('phone');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const otpRef = useRef<TextInput>(null);

  // Resend cooldown — protects the backend's OTP rate limit from tap-spam and
  // gives the first send a fair chance to arrive (NG SMS can take ~30s).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [cooldown > 0]);

  // Warm the server while the user is still typing: the shared host parks the
  // Node worker when idle and the first request pays a ~5s boot. Fire-and-forget.
  useEffect(() => {
    fetch('https://hawkeye.com.ng/api/health').catch(() => {});
  }, []);

  const sentLine = (r: RegisterResult) => {
    if (r.devOtp) return `DEV MODE — your code is ${r.devOtp}`;
    if (r.viaWhatsapp) return `Code sent on WhatsApp to ${phone}.`;
    if (r.viaSms) return `Code sent by SMS to ${phone}.`;
    if (r.viaTelegram) return `Code sent on Telegram to ${phone}.`;
    return `Code sent to ${phone}.`;
  };

  const send = (verb: string) => {
    setLine(`${verb} code to ${phone.trim()}…`);
    setCooldown(30);
    requestOtp(phone.trim(), channel)
      .then((r) => {
        if (r.telegramLink && !r.viaSms) {
          // Telegram needs a one-time bot link — that UI lives on the phone step.
          setStep('phone');
          setTgLink(r.telegramLink);
          setLine('Open Telegram, tap Start, then Share my phone number.');
        } else if (r.ok) {
          setLine(sentLine(r));
        } else {
          setStep('phone');
          setLine(r.hint ?? 'Could not send a code — check the number.');
        }
      })
      .catch(() => {
        setStep('phone');
        setLine('Network error — try again.');
      });
  };

  const onRequest = () => {
    setTgLink(null);
    setStep('otp');
    setTimeout(() => otpRef.current?.focus(), 250);
    send('Sending');
  };

  const onVerify = async () => {
    setBusy(true);
    try {
      const r = await verifyOtp(phone.trim(), otp.trim());
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/(tabs)');
        return;
      }
      setLine(
        r.error === 'otp_incorrect' ? 'Wrong code — check and retry.'
        : r.error === 'otp_expired' ? 'Code expired — request a new one.'
        : r.hint ?? 'Verification failed — try again.',
      );
    } catch {
      setLine('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  const onPasswordLogin = async () => {
    setBusy(true);
    setLine(null);
    try {
      const r = await passwordLogin(phone.trim(), password);
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/(tabs)');
        return;
      }
      // The server's hints are user-ready copy (wrong password / no password
      // on this account / rate-limited) — show them verbatim.
      setLine(r.hint ?? 'Sign-in failed — try again.');
    } catch {
      setLine('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  // Preference order: WhatsApp first (free, near-instant, most reach here),
  // Telegram next, SMS last — it costs per message and is the slowest in NG.
  const CHANNELS: { key: Channel; label: string }[] = [
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'telegram', label: 'Telegram' },
    { key: 'sms', label: 'SMS' },
  ];

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-row items-center px-4 pt-2">
          <Pressable
            hitSlop={12}
            onPress={() => router.back()}
            className="h-9 w-9 items-center justify-center rounded-full bg-card"
          >
            <Feather name="x" size={18} color={ui.ink} />
          </Pressable>
          <Text className="pl-3 text-lg font-bold text-ink">Sign in</Text>
        </View>

        <View className="px-5 pt-6">
          {step === 'phone' ? (
            <>
              <Text className="text-2xl font-bold text-ink">Your phone number</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">
                One code verifies you. Your number is never stored — only a one-way hash.
              </Text>
              <TextInput
                className="rounded-2xl bg-card px-4 py-4 text-lg text-ink"
                placeholder="0803 123 4567"
                placeholderTextColor="#9db5a7"
                keyboardType="phone-pad"
                autoFocus
                value={phone}
                onChangeText={setPhone}
                editable={!busy}
              />
              <View className="flex-row gap-2 pt-3">
                {CHANNELS.map((c) => (
                  <Pressable
                    key={c.key}
                    onPress={() => setChannel(c.key)}
                    className={`rounded-full px-4 py-2 ${
                      channel === c.key ? 'bg-hawk-green' : 'bg-card'
                    }`}
                  >
                    <Text
                      className={`text-sm font-semibold ${
                        channel === c.key ? 'text-hawk-gold' : 'text-muted'
                      }`}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Pressable
                disabled={busy || phone.trim().length < 10}
                onPress={onRequest}
                className={`mt-5 items-center rounded-2xl py-4 ${
                  busy || phone.trim().length < 10 ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Request code</Text>
                )}
              </Pressable>
              <Pressable
                className="mt-4 items-center"
                onPress={() => {
                  setLine(null);
                  setStep('password');
                }}
              >
                <Text className="text-sm font-semibold text-hawk-leaf">
                  Sign in with a password instead
                </Text>
              </Pressable>
            </>
          ) : step === 'password' ? (
            <>
              <Text className="text-2xl font-bold text-ink">Password sign-in</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">
                Phone number and password — no code needed.
              </Text>
              <TextInput
                className="rounded-2xl bg-card px-4 py-4 text-lg text-ink"
                placeholder="0803 123 4567"
                placeholderTextColor="#9db5a7"
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
                editable={!busy}
              />
              <View className="pt-3">
                <PasswordField
                  placeholder="Password"
                  autoFocus
                  value={password}
                  onChangeText={setPassword}
                  editable={!busy}
                  onSubmitEditing={onPasswordLogin}
                  textContentType="password"
                />
              </View>
              <Pressable
                disabled={busy || phone.trim().length < 10 || password.length < 8}
                onPress={onPasswordLogin}
                className={`mt-5 items-center rounded-2xl py-4 ${
                  busy || phone.trim().length < 10 || password.length < 8
                    ? 'bg-disabled'
                    : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
                )}
              </Pressable>
              <Pressable
                className="mt-4 items-center"
                onPress={() => {
                  setLine(null);
                  setStep('phone');
                }}
              >
                <Text className="text-sm font-semibold text-hawk-leaf">
                  Forgot it? Sign in with a code instead
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text className="text-2xl font-bold text-ink">Enter the code</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{line}</Text>
              <TextInput
                ref={otpRef}
                className="rounded-2xl bg-card px-4 py-4 text-center text-2xl font-bold tracking-[8px] text-ink"
                placeholder="······"
                placeholderTextColor="#9db5a7"
                keyboardType="number-pad"
                maxLength={6}
                value={otp}
                onChangeText={setOtp}
                editable={!busy}
              />
              <Pressable
                disabled={busy || otp.trim().length < 6}
                onPress={onVerify}
                className={`mt-5 items-center rounded-2xl py-4 ${
                  busy || otp.trim().length < 6 ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Verify</Text>
                )}
              </Pressable>
              <View className="mt-4 flex-row items-center justify-center gap-6">
                <Pressable disabled={cooldown > 0} onPress={() => send('Re-sending')}>
                  <Text
                    className={`text-sm font-semibold ${cooldown > 0 ? 'text-faint' : 'text-hawk-leaf'}`}
                  >
                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                  </Text>
                </Pressable>
                <Pressable onPress={() => setStep('phone')}>
                  <Text className="text-sm font-semibold text-hawk-leaf">Use a different number</Text>
                </Pressable>
              </View>
            </>
          )}

          {step !== 'otp' && line ? (
            <Text className="pt-3 text-sm text-amber-800">{line}</Text>
          ) : null}
          {tgLink ? (
            <Pressable
              className="mt-3 items-center rounded-2xl bg-card py-3"
              onPress={() => WebBrowser.openBrowserAsync(tgLink)}
            >
              <Text className="text-base font-semibold text-hawk-leaf">Open Telegram</Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

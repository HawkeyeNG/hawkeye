import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
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
import {
  accountHasPassword,
  passwordLogin,
  requestOtp,
  setPassword as savePassword,
  signOut,
  verifyOtp,
  type RegisterResult,
} from '@/lib/auth';
import { BASE, BRAND, api } from '@/lib/api';
import { useUi } from '@/lib/theme';

type Channel = 'whatsapp' | 'telegram' | 'sms';

/**
 * Sign in — password-first, the way a normal app works.
 *
 * DEFAULT is phone + password. A one-time code is no longer a co-equal way in:
 * it is the recovery path (forgot password), the sign-up step that proves the
 * number, and the rescue for accounts that predate passwords. Every OTP route
 * therefore ENDS on the set-password step, so nobody leaves this screen without
 * a password they can use next time.
 *
 * Steps
 *   password      phone + password            (default; also ?intent=signin)
 *   request       phone + channel -> send OTP (?intent=signup, forgot, rescue)
 *   otp           enter the 6-digit code
 *   set-password  choose + confirm a password (mandatory when the account has none)
 *
 * `purpose` is what the OTP is FOR, and it drives every line of copy on the
 * request/set-password steps — the mechanics are identical in all three cases.
 *
 * The request -> otp transition stays OPTIMISTIC (tapping "Send code" flips the
 * step immediately and the send resolves behind it); gating it on the network
 * made the button spin for a whole round-trip, which reads as a slow app. On
 * failure we drop back to the request step with the error line.
 */
type Step = 'password' | 'request' | 'otp' | 'set-password' | 'exists';
/** Why we're sending a code: sign-up proof / forgot-password / no password yet. */
type Purpose = 'signup' | 'reset' | 'no-password';

export default function SignIn() {
  const ui = useUi();
  const { intent } = useLocalSearchParams<{ intent?: string }>();
  const signUpFirst = intent === 'signup';

  const [step, setStep] = useState<Step>(signUpFirst ? 'request' : 'password');
  const [purpose, setPurpose] = useState<Purpose>('signup');
  const [phone, setPhone] = useState('');
  // NO DEFAULT: the user must pick a route, so a mistap can never send on a
  // channel they didn't choose.
  const [channel, setChannel] = useState<Channel | null>(null);
  // Offered only when the SERVER says it can deliver it — see api.smsOtpEnabled.
  const [smsOk, setSmsOk] = useState(false);
  useEffect(() => {
    let alive = true;
    api.smsOtpEnabled().then((ok) => { if (alive) setSmsOk(ok); });
    return () => { alive = false; };
  }, []);
  const [otp, setOtp] = useState('');
  /**
   * How the 'exists' step was reached. BEFORE a code the server refused to send
   * one and nobody is signed in; AFTER a code the phone is proved and the
   * session is live. The pane offers different things in each case, and getting
   * it wrong would put a "Continue to Hawkeye" button in front of someone who
   * is not signed in.
   */
  const [existsAfterOtp, setExistsAfterOtp] = useState(false);
  const [password, setPasswordText] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  /** null = we couldn't check. Only an explicit `false` makes a password mandatory. */
  const [hasPw, setHasPw] = useState<boolean | null>(null);
  /**
   * A number the server has told us DOES have a password, so the blank-password
   * shortcut stops offering itself for it. Each blank submit on such an account
   * spends one of the server's 10 wrong-password tries per hour, and tapping a
   * live button repeatedly is exactly what someone does when nothing happens.
   */
  const [pwRequiredFor, setPwRequiredFor] = useState<string | null>(null);
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
    // Through BASE, not hardcoded: this was the one call that still went to
    // production after every other base was made overridable, so running in a
    // browser warmed the wrong server and failed CORS on the way.
    fetch(`${BASE}/api/health`).catch(() => {});
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
    // Non-null: Send code is disabled until a channel is picked.
    // `signup` lets the server refuse a registered number WITHOUT sending —
    // an OTP costs money and that sign-up has only one possible outcome. Reset
    // and rescue deliberately do not pass it: they need a code on a number that
    // IS registered.
    requestOtp(phone.trim(), channel as Channel, purpose === 'signup' ? 'signup' : undefined)
      .then((r) => {
        if (r.telegramLink && !r.viaSms) {
          // Telegram needs a one-time bot link — that UI lives on the request step.
          setStep('request');
          setTgLink(r.telegramLink);
          setLine('Open Telegram, tap Start, then Share my phone number.');
        } else if (r.ok) {
          setLine(sentLine(r));
        } else if (r.error === 'account_exists') {
          // Nothing was sent. The reader is NOT signed in — they are simply on
          // the wrong door.
          setExistsAfterOtp(false);
          setLine(null);
          setStep('exists');
        } else {
          setStep('request');
          setLine(
            r.error === 'invalid_phone'
              ? 'Enter a Nigerian mobile number, e.g. 08031234567.'
              : r.error === 'too_many_requests'
                ? 'Too many code requests from this network — wait a few minutes.'
                : r.error === 'sms_send_failed'
                  ? 'That code could not be delivered — try another channel below.'
                  : (r.hint ?? 'Could not send a code — check the number.'),
          );
        }
      })
      .catch(() => {
        setStep('request');
        setLine('Network error — try again.');
      });
  };

  /** Enter the code flow for a given reason, keeping whatever number was typed. */
  const startOtp = (why: Purpose) => {
    setPurpose(why);
    setOtp('');
    setTgLink(null);
    setLine(null);
    setStep('request');
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
      if (!r.ok) {
        setLine(
          r.error === 'otp_incorrect' ? 'Wrong code — check and retry.'
          : r.error === 'otp_expired' ? 'Code expired — request a new one.'
          : r.error === 'too_many_attempts' ? 'Too many wrong codes — request a new one.'
          : (r.hint ?? 'Verification failed — try again.'),
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Signed in. Now: does this account still need a password? `no-password`
      // already knows the answer (the server said so), `reset` is here on
      // purpose, and a sign-up on a number that turns out to be an existing
      // password-holder just goes straight in.
      // SIGN-UP ALWAYS ENDS ON THE PASSWORD STEP. Unconditionally, with no
      // status check in front of it.
      //
      // This screen was asking the server whether the account already had a
      // password and skipping the step when it said yes. That is a defensible
      // answer to the wrong question: this is the SIGN-UP page, the password is
      // part of signing up, and every condition put in front of it is another
      // way for a new observer to end up with an account whose only way back in
      // is another one-time code. Two attempts were lost to refining that
      // condition instead of deleting it.
      //
      // Setting a password on a number that already has one is safe and is
      // exactly what the reset flow does: the server accepts a new password
      // alone inside the phone-proof window this OTP just opened. Skipping the
      // check also drops a network round trip from the sign-up path.
      if (purpose === 'signup') {
        // ALREADY AN OBSERVER? Then this was not a sign-up, and quietly
        // creating "a second account" is impossible anyway — a phone number is
        // the identity, so /verify returned the SAME observer row with all its
        // history. Saying so is the honest outcome: the reader gets their
        // account back, not a new one, and is told which door they were in.
        //
        // Only when the account also has a password. An account without one
        // still needs the create-password step below, whatever its age.
        if (r.isNew === false && r.hadPassword) {
          // Reached only when the pre-send refusal did not fire: an older
          // server, or the account gained a password between the two calls.
          setExistsAfterOtp(true);
          setLine(null);
          setStep('exists');
          return;
        }
        setHasPw(false);
        setNewPw('');
        setNewPw2('');
        setLine(null);
        setStep('set-password');
        return;
      }

      const hp = purpose === 'no-password' ? false : await accountHasPassword();
      setHasPw(hp);
      if (hp === false || purpose === 'reset') {
        setNewPw('');
        setNewPw2('');
        setLine(null);
        setStep('set-password');
        return;
      }
      // hp === true, or null because the check itself failed: never strand
      // someone on a password screen over a failed status call.
      router.replace('/(tabs)');
    } catch {
      setLine('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * A blank password is a legitimate submission here, not junk input.
   *
   * Legacy observers predate passwords and have none to type. The only thing
   * that routes them to their rescue is the server's `password_login_unavailable`,
   * and /login returns that BEFORE it looks at the password field at all — so
   * requiring 8 characters first made the rescue reachable only by inventing
   * junk. These are real users of an election tool; "cannot sign in" is the
   * worst outcome this screen has. A valid number alone therefore submits, and
   * the server classifies the account. A password that IS typed still has to
   * meet the server's own minimum of 8, so nothing is loosened for real
   * password logins.
   */
  const phoneReady = phone.trim().length >= 10;
  const blankPw = password.length === 0;
  const loginDisabled =
    busy || !phoneReady || (blankPw ? pwRequiredFor === phone.trim() : password.length < 8);

  const onPasswordLogin = async () => {
    // Also the guard for onSubmitEditing, which fires straight from the keyboard.
    if (loginDisabled) return;
    const typedPhone = phone.trim();
    const wasBlank = blankPw;
    setBusy(true);
    setLine(null);
    try {
      const r = await passwordLogin(typedPhone, password);
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/(tabs)');
        return;
      }
      // An account with no password_hash is an EXISTING observer from before
      // passwords existed. Route them into the code flow rather than showing a
      // dead end — the request step then explains it and set-password closes it.
      if (r.error === 'password_login_unavailable') {
        startOtp('no-password');
        return;
      }
      // A blank submit that comes back `wrong_password` has answered its own
      // question: this account does have one. Say so plainly — the verbatim
      // "Wrong password" hint reads as a bug when the field was empty — and
      // stop the blank shortcut for this number so taps can't burn the lockout.
      if (wasBlank && r.error === 'wrong_password') {
        setPwRequiredFor(typedPhone);
        setLine('This account has a password — type it, or tap “Forgot password?” to get a code.');
        return;
      }
      setLine(
        r.error === 'invalid_phone'
          ? 'Enter a Nigerian mobile number, e.g. 08031234567.'
          // wrong_password / too_many_attempts hints are user-ready copy and
          // both already point at the code path — show them verbatim.
          : (r.hint ?? 'Sign-in failed — try again.'),
      );
    } catch {
      setLine('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  const onSavePassword = async () => {
    if (newPw.length < 8) {
      setLine('Use at least 8 characters.');
      return;
    }
    // Typed twice: a typo in a blind field would otherwise lock this account out
    // of its own password path until another code reset.
    if (newPw !== newPw2) {
      setLine('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setLine(null);
    try {
      const r = await savePassword(newPw);
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/(tabs)');
        return;
      }
      setLine(
        r.error === 'password_too_short' ? 'Use at least 8 characters.'
        : r.error === 'password_too_long' ? 'That password is too long (200 characters max).'
        // The no-current-password window is 15 min from the code — past that the
        // server asks for the old one, which is exactly what they don't have.
        : r.error === 'current_password_wrong' ? 'That took too long — request a new code and try again.'
        : (r.hint ?? 'Could not save that password — try again.'),
      );
    } catch {
      setLine('Network error — try again.');
    } finally {
      setBusy(false);
    }
  };

  /** Only an account we KNOW has no password is forced through this step. */
  const mustSetPassword = hasPw === false;

  const onAbandonPassword = async () => {
    if (!mustSetPassword) {
      router.replace('/(tabs)');
      return;
    }
    await signOut();
    router.replace('/welcome');
  };

  // SMS appears only when /api/health says the server can send it, so the
  // sender-ID approval that turned it on did not need an app release — and a
  // future suspension takes it away the same way. Appended last: it costs per
  // message, so it is the fallback, not the first thing under the thumb.
  const CHANNELS: { key: Channel; label: string }[] = [
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'telegram', label: 'Telegram' },
    ...(smsOk ? [{ key: 'sms' as Channel, label: 'SMS' }] : []),
  ];

  const requestCopy =
    purpose === 'signup'
      ? {
          title: 'Create Your Account',
          body: 'Enter your phone number. We send a code to confirm it, then you choose a password.',
        }
      : purpose === 'reset'
        ? {
            title: 'Reset Your Password',
            body: 'We send a one-time code (OTP) to your number. Enter it and you can choose a new password.',
          }
        : {
            title: 'No Password on This Account',
            body: 'This account has no password yet. Sign in with a code and set one now.',
          };

  const setPwCopy =
    purpose === 'reset'
      ? { title: 'Choose a New Password', body: 'Your number is verified. Pick a new password — at least 8 characters.' }
      : purpose === 'no-password'
        ? { title: 'Set Your Password', body: 'Your number is verified. Choose a password — at least 8 characters — and use it to sign in on any device from now on.' }
        : { title: 'Create Your Password', body: 'Verified. Choose a password — at least 8 characters.' };

  const pwSaveDisabled = busy || newPw.length < 8 || newPw2.length < 8;

  return (
    <SafeAreaView className="flex-1 bg-surface">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        className="flex-1"
      >
        <View className="flex-row items-center px-4 pt-2">
          {/* No escape hatch mid-way through a mandatory password: the only way
              off that step is saving one, or the explicit sign-out link below it. */}
          {step === 'set-password' && mustSetPassword ? (
            <View className="h-9 w-9" />
          ) : (
            <Pressable
              hitSlop={12}
              onPress={() => router.back()}
              className="h-9 w-9 items-center justify-center rounded-full bg-card"
            >
              <Feather name="x" size={18} color={ui.ink} />
            </Pressable>
          )}
          <Text className="pl-3 text-lg font-bold text-ink">
            {step === 'set-password'
              ? 'Your Password'
              : step === 'exists'
                ? 'You Already Have an Account'
                : purpose === 'signup' && step !== 'password'
                  ? 'Create Account'
                  : 'Sign In'}
          </Text>
        </View>

        <View className="px-5 pt-6">
          {step === 'password' ? (
            <>
              <Text className="text-2xl font-bold text-ink">Welcome Back</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">
                Your phone number and password. Your number is never stored — only a one-way hash.
              </Text>
              <TextInput
                className="rounded-2xl bg-card px-4 py-4 text-lg text-ink"
                placeholder="0803 123 4567"
                placeholderTextColor={ui.faint}
                keyboardType="phone-pad"
                autoFocus
                value={phone}
                onChangeText={setPhone}
                editable={!busy}
              />
              <View className="pt-3">
                <PasswordField
                  placeholder="Password"
                  value={password}
                  onChangeText={setPasswordText}
                  editable={!busy}
                  onSubmitEditing={onPasswordLogin}
                  textContentType="password"
                />
              </View>
              {/* The discoverability half of the fix: enabling the button is no
                  use to someone who never thinks to tap it on an empty field. */}
              <Text className="pt-2 text-xs text-muted">
                Joined before Hawkeye had passwords? Leave the password blank and tap Sign in — we
                will send you a code and set one up.
              </Text>
              <Pressable
                disabled={loginDisabled}
                onPress={onPasswordLogin}
                className={`mt-5 items-center rounded-2xl py-4 ${
                  loginDisabled ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
                )}
              </Pressable>
              <Pressable className="mt-4 items-center" onPress={() => startOtp('reset')}>
                <Text className="text-sm font-semibold text-good-ink">Forgot password?</Text>
              </Pressable>
              <Pressable className="mt-5 items-center" onPress={() => startOtp('signup')}>
                <Text className="text-sm text-muted">
                  New here? <Text className="font-semibold text-good-ink">Create an account</Text>
                </Text>
              </Pressable>
            </>
          ) : step === 'request' ? (
            <>
              <Text className="text-2xl font-bold text-ink">{requestCopy.title}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{requestCopy.body}</Text>
              <TextInput
                className="rounded-2xl bg-card px-4 py-4 text-lg text-ink"
                placeholder="0803 123 4567"
                placeholderTextColor={ui.faint}
                keyboardType="phone-pad"
                autoFocus={phone.trim().length === 0}
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
                  <Text className="text-base font-bold text-hawk-gold">Send code</Text>
                )}
              </Pressable>
              <Pressable
                className="mt-4 items-center"
                onPress={() => {
                  setLine(null);
                  setTgLink(null);
                  setStep('password');
                }}
              >
                <Text className="text-sm font-semibold text-good-ink">
                  {purpose === 'signup' ? 'Already have an account? Sign in' : 'Back to password sign-in'}
                </Text>
              </Pressable>
            </>
          ) : step === 'exists' ? (
            <>
              {/* A phone number IS the identity here, so signing up with a
                  registered one never creates a second account. Two ways in:

                  BEFORE a code — the server refused to send one, because an OTP
                  costs money and this sign-up had only one possible outcome.
                  Nobody is signed in, so the offer is the sign-in door.

                  AFTER a code — an older server, or the account gained a
                  password between the two calls. The phone is proved and the
                  session is live, so the offer is to carry on. */}
              <Text className="text-2xl font-bold text-ink">This account already exists</Text>
              <Text className="pb-5 pt-2 text-sm text-muted">
                {existsAfterOtp
                  ? `${phone.trim()} is already registered as an observer, and it already has a password. Nothing new was created — your reports and your observer ID are as you left them.`
                  : `${phone.trim()} is already registered as an observer. Sign in with your password — no code was sent, and nothing new was created.`}
              </Text>

              {existsAfterOtp ? (
                <Pressable
                  onPress={() => router.replace('/(tabs)')}
                  className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
                >
                  <Text className="text-base font-bold text-hawk-gold">Continue to Hawkeye</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => {
                    setPurpose('signup');
                    setPasswordText('');
                    setLine(null);
                    setStep('password');
                  }}
                  className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
                >
                  <Text className="text-base font-bold text-hawk-gold">Sign in instead</Text>
                </Pressable>
              )}

              {/* The reason most people arrive here with a registered number:
                  they could not get in. After a code this window can set a new
                  password directly; before one, it has to send a code first —
                  which is a legitimate send, so `reset` does not pass the
                  sign-up flag and the server will deliver it. */}
              <Pressable
                className="mt-4 items-center"
                onPress={() => {
                  if (existsAfterOtp) {
                    setPurpose('reset');
                    setHasPw(true);
                    setNewPw('');
                    setNewPw2('');
                    setLine(null);
                    setStep('set-password');
                    return;
                  }
                  startOtp('reset');
                }}
              >
                <Text className="text-sm font-semibold text-good-ink">
                  Forgot your password? {existsAfterOtp ? 'Set a new one' : 'Reset it'}
                </Text>
              </Pressable>

              {existsAfterOtp ? (
                <Pressable
                  className="mt-3 items-center"
                  onPress={async () => {
                    // Someone else's number typed by mistake: do not leave that
                    // session signed in on this device.
                    await signOut();
                    setOtp('');
                    setPasswordText('');
                    setLine(null);
                    setStep('password');
                  }}
                >
                  <Text className="text-sm font-semibold text-muted">
                    Not your number? Sign out and start again
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  className="mt-3 items-center"
                  onPress={() => {
                    setPhone('');
                    setLine(null);
                    setStep('request');
                  }}
                >
                  <Text className="text-sm font-semibold text-muted">Use a different number</Text>
                </Pressable>
              )}
            </>
          ) : step === 'otp' ? (
            <>
              <Text className="text-2xl font-bold text-ink">Enter the Code</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{line}</Text>
              <TextInput
                ref={otpRef}
                className="rounded-2xl bg-card px-4 py-4 text-center text-2xl font-bold tracking-[8px] text-ink"
                placeholder="······"
                placeholderTextColor={ui.faint}
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
                    className={`text-sm font-semibold ${cooldown > 0 ? 'text-faint' : 'text-good-ink'}`}
                  >
                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                  </Text>
                </Pressable>
                <Pressable onPress={() => setStep('request')}>
                  <Text className="text-sm font-semibold text-good-ink">Use a different number</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text className="text-2xl font-bold text-ink">{setPwCopy.title}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{setPwCopy.body}</Text>
              <PasswordField
                placeholder="New password (min 8 characters)"
                autoFocus
                value={newPw}
                onChangeText={setNewPw}
                editable={!busy}
                textContentType="newPassword"
              />
              <View className="pt-3">
                <PasswordField
                  placeholder="Repeat new password"
                  value={newPw2}
                  onChangeText={setNewPw2}
                  editable={!busy}
                  onSubmitEditing={onSavePassword}
                  textContentType="newPassword"
                />
              </View>
              <Pressable
                disabled={pwSaveDisabled}
                onPress={onSavePassword}
                className={`mt-5 items-center rounded-2xl py-4 ${
                  pwSaveDisabled ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Save password and continue</Text>
                )}
              </Pressable>
              <Pressable className="mt-4 items-center" onPress={onAbandonPassword}>
                <Text className="text-sm font-semibold text-good-ink">
                  {mustSetPassword ? 'Not now — sign out' : 'Keep my current password'}
                </Text>
              </Pressable>
            </>
          )}

          {step !== 'otp' && line ? (
            <Text className="pt-3 text-sm text-warn-ink">{line}</Text>
          ) : null}
          {tgLink ? (
            <Pressable
              className="mt-3 items-center rounded-2xl bg-card py-3"
              onPress={() => WebBrowser.openBrowserAsync(tgLink)}
            >
              <Text className="text-base font-semibold text-good-ink">Open Telegram</Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

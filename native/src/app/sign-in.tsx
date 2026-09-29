import Feather from '@expo/vector-icons/Feather';
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

import { ConfirmSheet } from '@/components/confirm-sheet';
import { PasswordField } from '@/components/password-field';
import { SignedOutElsewhereNote } from '@/components/signed-out-elsewhere';
import {
  accountHasPassword,
  orgSignup,
  passwordLogin,
  requestOtp,
  setPassword as savePassword,
  signOut,
  verifyOtp,
  type RegisterResult,
} from '@/lib/auth';
import { BASE, BRAND, api } from '@/lib/api';
import { ORG_ERROR_KEYS, authT, codeKind, looksLikeOrgCode, typedOrgCode } from '@/lib/auth-copy';
import { typedInviteCode } from '@/lib/invite-parse';
import { clearInviteUnit, pendingInviteCode, takeInviteUnit } from '@/lib/pending-invite';
import { useUi } from '@/lib/theme';
import { t as i18nT } from '@/lib/i18n';

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
  /**
   * The server CREATED this observer on the verify just made (/verify's isNew).
   * Only an explicit `true`: an older server sends nothing, and an existing
   * account signing up again is not a new observer.
   */
  const [isNewAccount, setIsNewAccount] = useState(false);

  /**
   * "INVITE CODE (OPTIONAL)" — sign-up only. The one route for a referral on an
   * iPhone, which has no install referrer: invite.html prints the code and this
   * is where it is typed. ALWAYS SHOWN on the create-account form — it was once
   * behind a "Have an invite code?" link, and the people with a code are the
   * ones who miss a link. Filled when an invitation is already parked on this
   * phone (Play referrer, or a link that opened the app); empty = no code.
   * Validated before a code is sent — a typo is caught while it is still cheap.
   * The server keeps the rule that matters: it records a code only on a NEW
   * account, first code wins. Twin of app/observe.html #ref-input.
   */
  const [inviteCode, setInviteCode] = useState('');
  const [inviteBad, setInviteBad] = useState(false);
  /** The "is this your number?" sheet before an organisation code is spent. */
  const [orgConfirm, setOrgConfirm] = useState(false);

  /**
   * ONE FIELD, TWO KINDS OF CODE (owner decision, 2026-09-28), told apart by
   * FORMAT: a friend's invite is six characters; a party's or civic partner's
   * organisation code is ORG-XXXX-XXXX-XXXX, and no invite can start "ORG". An
   * ORG- code REPLACES the one-time code (D4): the channel chips go, the button
   * says "Create account", nothing is sent, and /org-signup creates the account
   * on this number. Organisation mode starts at the prefix, so the form does not
   * flip back and forth mid-typing. Twin of app/observe.html #ref-input.
   */
  const kind = codeKind(inviteCode);
  const withOrgCode = purpose === 'signup' && looksLikeOrgCode(inviteCode);
  useEffect(() => {
    let alive = true;
    pendingInviteCode().then((c) => {
      if (!alive || !c) return;
      setInviteCode((typed) => typed || c);
    });
    return () => { alive = false; };
  }, []);

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
    if (r.devOtp) return i18nT('n.app.sign-in.dev-mode-your-code-is', { v0: r.devOtp });
    if (r.viaWhatsapp) return i18nT('n.app.sign-in.code-sent-on-whatsapp-to', { v0: phone });
    if (r.viaSms) return i18nT('n.app.sign-in.code-sent-by-sms-to', { v0: phone });
    if (r.viaTelegram) return i18nT('n.app.sign-in.code-sent-on-telegram-to', { v0: phone });
    return i18nT('n.app.sign-in.code-sent-to', { v0: phone });
  };

  const send = (verb: string) => {
    setLine(i18nT('n.app.sign-in.code-to', { v0: verb, v1: phone.trim() }));
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
          setLine(i18nT('n.app.sign-in.open-telegram-tap-start-then-share'));
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
                  : (r.hint ?? i18nT('n.app.sign-in.could-not-send-a-code-check')),
          );
        }
      })
      .catch(() => {
        setStep('request');
        setLine(i18nT('n.app.sign-in.network-error-try-again'));
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

  /** Sign up with an organisation code: no OTP, then the usual password step. */
  const onOrgSignup = () => {
    if (!typedOrgCode(inviteCode)) {
      setInviteBad(true);
      return;
    }
    setInviteBad(false);
    // No code comes back to prove the number, so the number is the one thing
    // to get right: the organisation code is tied to it for good. The app's
    // own sheet (ConfirmSheet), not a system Alert — rendered at the end.
    setOrgConfirm(true);
  };
  const runOrgSignup = async () => {
    setBusy(true);
    setLine(null);
    try {
      // One field: an organisation code carries no separate invite.
      const r = await orgSignup(phone.trim(), typedOrgCode(inviteCode) || '', { referralCode: null });
      if (!r.ok) {
        const key = r.error ? ORG_ERROR_KEYS[r.error] : undefined;
        setLine(
          key ? authT(key)
          : r.error === 'invalid_phone' ? 'Enter a Nigerian mobile number, e.g. 08031234567.'
          : (r.hint ?? i18nT('n.app.sign-in.verification-failed-try-again')),
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // A new account, like an OTP sign-up: the password step, then the unit.
      setIsNewAccount(r.isNew === true || r.needsUnit === true);
      setHasPw(false);
      setNewPw('');
      setNewPw2('');
      setInviteCode('');
      setStep('set-password');
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
  };

  const onRequest = () => {
    if (withOrgCode) {
      onOrgSignup();
      return;
    }
    // A typed invite code that is not one stops here, before a paid code goes
    // out. Empty is fine: the field is optional.
    if (purpose === 'signup' && typedInviteCode(inviteCode) === null) {
      setInviteBad(true);
      return;
    }
    setInviteBad(false);
    setTgLink(null);
    setStep('otp');
    setTimeout(() => otpRef.current?.focus(), 250);
    send('Sending');
  };

  const onVerify = async () => {
    setBusy(true);
    try {
      // Sign-up sends what the field holds (null when left empty — the person's
      // choice, even over a parked invitation). Reset and rescue send the
      // parked one, as before; the server ignores it for an existing account.
      const r = await verifyOtp(
        phone.trim(),
        otp.trim(),
        purpose === 'signup' ? { referralCode: typedInviteCode(inviteCode) || null } : {},
      );
      if (!r.ok) {
        setLine(
          r.error === 'otp_incorrect' ? 'Wrong code — check and retry.'
          : r.error === 'otp_expired' ? 'Code expired — request a new one.'
          : r.error === 'too_many_attempts' ? 'Too many wrong codes — request a new one.'
          : (r.hint ?? i18nT('n.app.sign-in.verification-failed-try-again')),
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
        // Also a revived deleted account, or any account with no saved unit (/verify needsUnit).
        setIsNewAccount(r.isNew === true || r.needsUnit === true);
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
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
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
        setLine(i18nT('n.app.sign-in.this-account-has-a-password-type'));
        return;
      }
      setLine(
        r.error === 'invalid_phone'
          ? 'Enter a Nigerian mobile number, e.g. 08031234567.'
          // wrong_password / too_many_attempts hints are user-ready copy and
          // both already point at the code path — show them verbatim.
          : (r.hint ?? i18nT('n.app.sign-in.sign-in-failed-try-again')),
      );
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
  };

  const onSavePassword = async () => {
    if (newPw.length < 8) {
      setLine(i18nT('n.app.sign-in.use-at-least-8-characters'));
      return;
    }
    // Typed twice: a typo in a blind field would otherwise lock this account out
    // of its own password path until another code reset.
    if (newPw !== newPw2) {
      setLine(i18nT('n.app.sign-in.the-two-passwords-do-not-match'));
      return;
    }
    setBusy(true);
    setLine(null);
    try {
      const r = await savePassword(newPw);
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // A BRAND-NEW observer is asked for their polling unit once, before the
        // app opens: it is what their alerts and the election-day reminder hang
        // off, and this is the one moment the ask is expected — afterwards it is
        // a Profile row nobody goes looking for. Same step as the web
        // (map-unit.html?onboard=1). Resets and rescues are not sign-ups.
        //
        // A PAGE, not a sheet over this screen: /choose-unit?onboard=1 owns
        // the rest of the sign-up (Save or Skip both land on the tabs). REPLACE
        // so Back can never return to a password step that is already done.
        // There is no modal to fade out any more, so nothing to wait for.
        // Cast: typed routes regenerate on the next `expo start`.
        //
        // INVITED TO A UNIT? Then the chooser opens with it SELECTED, not saved
        // — theirs to confirm or change, as on the web. Taken (read and
        // cleared) here: it is a suggestion for this one step, and the route
        // param carries it from now on. lib/pending-invite.ts.
        if (purpose === 'signup' && isNewAccount) {
          const unit = await takeInviteUnit();
          router.replace(
            (unit ? `/choose-unit?onboard=1&unit=${encodeURIComponent(unit)}` : '/choose-unit?onboard=1') as never,
          );
          return;
        }
        clearInviteUnit();
        router.replace('/(tabs)');
        return;
      }
      setLine(
        r.error === 'password_too_short' ? 'Use at least 8 characters.'
        : r.error === 'password_too_long' ? 'That password is too long (200 characters max).'
        // The no-current-password window is 15 min from the code — past that the
        // server asks for the old one, which is exactly what they don't have.
        : r.error === 'current_password_wrong' ? 'That took too long — request a new code and try again.'
        : (r.hint ?? i18nT('n.app.sign-in.could-not-save-that-password-try')),
      );
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
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

  // TELEGRAM FIRST, WHATSAPP SECOND, SMS LAST (owner decision D2): cheapest
  // first, the same order as the web form (app/observe.html #channel-pick).
  // SMS appears only when /api/health says the server can send it, so the
  // sender-ID approval that turned it on did not need an app release — and a
  // future suspension takes it away the same way. Appended last: it costs per
  // message, so it is the fallback, not the first thing under the thumb.
  const CHANNELS: { key: Channel; label: string }[] = [
    { key: 'telegram', label: 'Telegram' },
    { key: 'whatsapp', label: 'WhatsApp' },
    ...(smsOk ? [{ key: 'sms' as Channel, label: 'SMS' }] : []),
  ];

  const requestCopy =
    purpose === 'signup'
      ? {
          title: i18nT('n.app.sign-in.create-your-account'),
          body: i18nT('n.app.sign-in.enter-your-phone-number-we-send'),
        }
      : purpose === 'reset'
        ? {
            title: i18nT('n.app.sign-in.reset-your-password'),
            body: i18nT('n.app.sign-in.we-send-a-one-time-code'),
          }
        : {
            title: i18nT('n.app.sign-in.no-password-on-this-account'),
            body: i18nT('n.app.sign-in.this-account-has-no-password-yet'),
          };

  const setPwCopy =
    purpose === 'reset'
      ? { title: i18nT('n.app.sign-in.choose-a-new-password'), body: 'Your number is verified. Pick a new password — at least 8 characters.' }
      : purpose === 'no-password'
        ? { title: i18nT('n.app.sign-in.set-your-password'), body: 'Your number is verified. Choose a password — at least 8 characters — and use it to sign in on any device from now on.' }
        : { title: i18nT('n.app.sign-in.create-your-password'), body: 'Verified. Choose a password — at least 8 characters.' };

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
              <SignedOutElsewhereNote />
              <Text className="text-2xl font-bold text-ink">{i18nT('n.app.sign-in.welcome-back')}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">
                {i18nT('n.app.sign-in.your-phone-number-and-password-your')}
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
                  placeholder={i18nT('common.password')}
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
                {i18nT('n.app.sign-in.joined-before-hawkeye-had-passwords-leave')}
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
                  <Text className="text-base font-bold text-hawk-gold">{i18nT('index.sign-in')}</Text>
                )}
              </Pressable>
              <Pressable className="mt-4 items-center" onPress={() => startOtp('reset')}>
                <Text className="text-sm font-semibold text-good-ink">{i18nT('n.app.sign-in.forgot-password')}</Text>
              </Pressable>
              <Pressable className="mt-5 items-center" onPress={() => startOtp('signup')}>
                <Text className="text-sm text-muted">
                  New here? <Text className="font-semibold text-good-ink">{i18nT('index.create-an-account')}</Text>
                </Text>
              </Pressable>
            </>
          ) : step === 'request' ? (
            <>
              <SignedOutElsewhereNote />
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
              {/* No channel with an organisation code: nothing is sent. */}
              <View className="flex-row gap-2 pt-3" style={withOrgCode ? { display: 'none' } : undefined}>
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
              {/* Sign-up only: reset and rescue are for accounts that exist,
                  and a referral or an organisation code can only make a new one.
                  ONE field for both; the line under it names the kind. */}
              {purpose === 'signup' ? (
                <View className="pt-4">
                  <Text className="pb-1 text-sm font-semibold text-muted">
                    {authT('n.auth.code-label')}
                  </Text>
                  <TextInput
                    className="rounded-2xl bg-card px-4 py-3 text-lg text-ink"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    autoComplete="off"
                    maxLength={24}
                    value={inviteCode}
                    onChangeText={(v) => {
                      setInviteCode(v);
                      setInviteBad(false);
                    }}
                    editable={!busy}
                    accessibilityLabel={authT('n.auth.code-label')}
                  />
                  <Text className="pt-1 text-xs text-muted">
                    {kind === 'invite' ? authT('n.auth.code-kind-invite')
                      : kind === 'org' ? authT('n.auth.code-kind-org')
                      : authT('n.auth.code-hint')}
                  </Text>
                  {inviteBad ? (
                    <Text className="pt-1 text-sm text-bad-ink" accessibilityRole="alert">
                      {authT('n.auth.code-invalid')}
                    </Text>
                  ) : null}
                </View>
              ) : null}
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
                  <Text className="text-base font-bold text-hawk-gold">
                    {withOrgCode ? authT('n.auth.org-create-account') : i18nT('n.app.profile.send-code')}
                  </Text>
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
              {/* SIGN-UP ONLY, and the condition is load-bearing rather than
                  tidiness: this `request` step is shared by sign-up, forgot-
                  password and rescue, so an unconditional link would offer
                  "First time?" to someone recovering an account they have had
                  for months. Practice is aimed at the person who has not
                  decided, and this is the step that asks them for a phone
                  number — the last moment before they hand one over.

                  Deliberately not on the password screen: whoever is typing a
                  password already joined, and a third link there competed with
                  "Create an account", which is the action that screen wants.

                  `push`, not `replace`, so closing practice returns to exactly
                  this screen in the mode they left it in. */}
              {purpose === 'signup' ? (
                <Pressable className="mt-4 items-center" onPress={() => router.push('/practice')}>
                  <Text className="text-sm text-muted">
                    First time? <Text className="font-semibold text-good-ink">{i18nT('n.app.sign-in.try-a-practice-run')}</Text>
                  </Text>
                </Pressable>
              ) : null}
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
              <Text className="text-2xl font-bold text-ink">{i18nT('n.app.sign-in.this-account-already-exists')}</Text>
              <Text className="pb-5 pt-2 text-sm text-muted">
                {existsAfterOtp
                  ? i18nT('n.app.sign-in.is-already-registered-as-an-observer', { v0: phone.trim() })
                  : i18nT('n.app.sign-in.is-already-registered-as-an-observer-2', { v0: phone.trim() })}
              </Text>

              {existsAfterOtp ? (
                <Pressable
                  onPress={() => router.replace('/(tabs)')}
                  className="items-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
                >
                  <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.sign-in.continue-to-hawkeye')}</Text>
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
                  <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.sign-in.sign-in-instead')}</Text>
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
                  Forgot your password? {existsAfterOtp ? i18nT('n.app.sign-in.set-a-new-one') : i18nT('n.app.sign-in.reset-it')}
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
                    {i18nT('n.app.sign-in.not-your-number-sign-out-and')}
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
                  <Text className="text-sm font-semibold text-muted">{i18nT('n.app.sign-in.use-a-different-number')}</Text>
                </Pressable>
              )}
            </>
          ) : step === 'otp' ? (
            <>
              <Text className="text-2xl font-bold text-ink">{i18nT('n.app.sign-in.enter-the-code')}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{line}</Text>
              {/* NO letterSpacing (tracking-*) ON ANY TextInput. On iOS a
                  TextInput's native view is recycled once it unmounts, and the
                  kerning this code box used to carry stayed on the view: the
                  NEXT field to get it — "New password" on the step right after
                  this one, later the unit search — drew its placeholder spaced
                  out ("N e w  p a s s w o r d"). Removing the attribute from
                  props does not clear it, so the only safe amount is none.
                  tests/choose_unit_test.mjs guards every TextInput in src. */}
              <TextInput
                ref={otpRef}
                className="rounded-2xl bg-card px-4 py-4 text-center text-2xl font-bold text-ink"
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
                  <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.profile.verify')}</Text>
                )}
              </Pressable>
              <View className="mt-4 flex-row items-center justify-center gap-6">
                <Pressable disabled={cooldown > 0} onPress={() => send('Re-sending')}>
                  <Text
                    className={`text-sm font-semibold ${cooldown > 0 ? 'text-faint' : 'text-good-ink'}`}
                  >
                    {cooldown > 0 ? i18nT('n.app.sign-in.resend-in-s', { v0: cooldown }) : 'Resend code'}
                  </Text>
                </Pressable>
                <Pressable onPress={() => setStep('request')}>
                  <Text className="text-sm font-semibold text-good-ink">{i18nT('n.app.sign-in.use-a-different-number')}</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text className="text-2xl font-bold text-ink">{setPwCopy.title}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{setPwCopy.body}</Text>
              <PasswordField
                placeholder={i18nT("n.app.sign-in.new-password-min-8-characters")}
                autoFocus
                value={newPw}
                onChangeText={setNewPw}
                editable={!busy}
                textContentType="newPassword"
              />
              <View className="pt-3">
                <PasswordField
                  placeholder={i18nT('n.app.profile.repeat-new-password')}
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
                  <Text className="text-base font-bold text-hawk-gold">{i18nT('n.app.sign-in.save-password-and-continue')}</Text>
                )}
              </Pressable>
              <Pressable className="mt-4 items-center" onPress={onAbandonPassword}>
                <Text className="text-sm font-semibold text-good-ink">
                  {mustSetPassword ? i18nT('n.app.sign-in.not-now-sign-out') : i18nT('n.app.sign-in.keep-my-current-password')}
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
              <Text className="text-base font-semibold text-good-ink">{i18nT('n.app.sign-in.open-telegram')}</Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
      <ConfirmSheet
        visible={orgConfirm}
        icon="smartphone"
        title={authT('n.auth.org-confirm-title')}
        body={authT('n.auth.org-confirm-body', { phone: phone.trim() })}
        confirmLabel={authT('n.auth.org-confirm-yes')}
        cancelLabel={authT('n.auth.org-confirm-no')}
        onConfirm={() => {
          setOrgConfirm(false);
          void runOrgSignup();
        }}
        onCancel={() => setOrgConfirm(false)}
      />
    </SafeAreaView>
  );
}

import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConfirmSheet } from '@/components/confirm-sheet';
import { LangButton } from '@/components/lang-button';
import { PasswordField } from '@/components/password-field';
import { SignedOutElsewhereNote } from '@/components/signed-out-elsewhere';
import {
  accountHasPassword,
  adoptWaSession,
  authedGet,
  callCancel,
  callStart,
  callStatus,
  callVerifyEnabled,
  noteReturnAfterSignIn,
  orgSignup,
  passwordLogin,
  peekReturnAfterSignIn,
  requestOtp,
  setPassword as savePassword,
  signOut,
  verifyOtp,
  waStart,
  type RegisterResult,
} from '@/lib/auth';
import { BASE, BRAND, api } from '@/lib/api';
import { ORG_ERROR_KEYS, authT, codeKind, looksLikeOrgCode, typedOrgCode } from '@/lib/auth-copy';
import { typedInviteCode } from '@/lib/invite-parse';
import { clearInviteUnit, pendingInviteCode, takeInviteUnit } from '@/lib/pending-invite';
import { useUi } from '@/lib/theme';
import { t as i18nT } from '@/lib/i18n';
import {
  offerPasskeyLater,
  passkeyErrorText,
  passkeyHereOnDevice,
  passkeysUsable,
  registerPasskeyHere,
  shouldOfferPasskey,
  signInWithPasskey,
} from '@/lib/passkeys';
import { openWhatsApp, startWaPoller, type WaPoller, type WaProof, type WaWait } from '@/lib/wa-signin';

/** 'call' = the free missed call (sign-up only; step 'call-send'). */
type Channel = 'whatsapp' | 'telegram' | 'sms' | 'call';
/** m:ss for the missed-call countdown. */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
/** D3: resets are nudged to before the election window (9 Jan 2027 00:00 WAT). */
const NUDGE_RESETS = Date.now() < Date.parse('2027-01-09T00:00:00+01:00'); // module scope: render stays pure

/**
 * The screen to return to once signed in (ONB-09): a `?next=` on this route,
 * or the one the root layout noted when it bounced a refused session to
 * welcome (lib/auth.ts noteReturnAfterSignIn). An APP PATH only: one leading
 * slash, no scheme, no host, never the auth funnel itself — so it can never be
 * turned into a way out of the app.
 */
function safeNext(raw: unknown): string | null {
  const n = typeof raw === 'string' ? raw : '';
  if (!/^\/(?![/\\])[^\s:]*$/.test(n)) return null;
  if (/^\/(welcome|sign-in)(?:[/?#]|$)/.test(n)) return null;
  return n;
}

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
 *   wa-send       WhatsApp in reverse: the observer sends US a code (free);
 *                 replaces request -> otp for WhatsApp while /api/health says
 *                 `waInbound`, and ends exactly where a verified code does
 *   call-send     MISSED CALL (free, SIGN-UP ONLY): the observer rings our
 *                 number from the phone being verified; our gateway rejects it
 *                 and the server marks the number proved. While /api/health
 *                 says `callVerify`; never on sign-in, a reset or with an ORG
 *                 code. Ends where a verified code does — or on 'exists' when
 *                 the number already has an account (nothing issued).
 *   set-password  choose + confirm a password (mandatory when the account has none)
 *   pk-offer      "Sign in faster next time": after a RETURNING sign-in, an
 *                 inline offer to make a passkey on this phone (lib/passkeys.ts)
 *
 * A PASSKEY is the other way in on the password step: "Sign in with a passkey"
 * goes straight to the system's passkey sheet — shown only where the binary
 * has the module and the server has passkeys on, so 1.0.11 and older (OTA)
 * never see it.
 *
 * `purpose` is what the OTP is FOR, and it drives every line of copy on the
 * request/set-password steps — the mechanics are identical in all three cases.
 *
 * The request -> otp transition stays OPTIMISTIC (tapping "Send code" flips the
 * step immediately and the send resolves behind it); gating it on the network
 * made the button spin for a whole round-trip, which reads as a slow app. On
 * failure we drop back to the request step with the error line.
 */
type Step = 'password' | 'request' | 'otp' | 'wa-send' | 'call-send' | 'set-password' | 'exists' | 'pk-offer';
/** Why we're sending a code: sign-up proof / forgot-password / no password yet. */
type Purpose = 'signup' | 'reset' | 'no-password';

export default function SignIn() {
  const ui = useUi();
  const { intent, next } = useLocalSearchParams<{ intent?: string; next?: string }>();
  const signUpFirst = intent === 'signup';
  // `?next=`, else the screen a refused session bounced from (_layout.tsx).
  const [returnTo] = useState(() => safeNext(next) ?? safeNext(peekReturnAfterSignIn()));
  /**
   * PUSHED OVER AN INVITE (R-NATIVE-SIGNIN-LEAVES-INVITE): join/[token]'s
   * "Sign in to join" pushes this screen and waits underneath — its button
   * turns into Join once the session lands. Every way out of here used to
   * replace the stack with Home (or the unit chooser), burying the invite;
   * leave() pops back onto it instead. Read from the navigator, so it holds
   * whether or not the invite passed a `next`.
   */
  const navigation = useNavigation();
  const inviteBelow = useCallback((): boolean => {
    try {
      const s = navigation.getState() as { index?: number; routes?: { name?: string }[] } | undefined;
      const below = s?.routes?.[(s.index ?? 0) - 1];
      return typeof below?.name === 'string' && below.name.startsWith('join/');
    } catch {
      return false;
    }
  }, [navigation]);
  /** Out of sign-in: back onto the invite, to `next`, or Home. */
  const leave = useCallback(() => {
    noteReturnAfterSignIn(null);   // used once
    if (inviteBelow() && router.canGoBack()) {
      router.back();
      return;
    }
    router.replace((returnTo ?? '/(tabs)') as never);
  }, [inviteBelow, returnTo]);

  const [step, setStep] = useState<Step>(signUpFirst ? 'request' : 'password');
  const [purpose, setPurpose] = useState<Purpose>('signup');
  const [phone, setPhone] = useState('');
  // NO DEFAULT: the user must pick a route, so a mistap can never send on a
  // channel they didn't choose.
  const [channel, setChannel] = useState<Channel | null>(null);
  // Offered only when the SERVER says it can deliver it — see api.smsOtpEnabled.
  const [smsOk, setSmsOk] = useState(false);
  // WhatsApp in reverse (free) — same fail-closed switch; see api.waRoutes.
  const [waOk, setWaOk] = useState(false);
  // A PAID WhatsApp code (WA_PAID_OTP on the server; off by default): only
  // then are "get a code on WhatsApp" fallbacks offered.
  const [waPaid, setWaPaid] = useState(false);
  // The server ANSWERED and runs neither WhatsApp route: no WhatsApp chip.
  const [waNone, setWaNone] = useState(false);
  // The free missed call (sign-up only): /api/health callVerify, fail closed.
  const [callOk, setCallOk] = useState(false);
  /** Passkeys: this binary has the module AND the server has them on (lib/passkeys.ts). */
  const [pkUsable, setPkUsable] = useState(false);
  /** This phone made or used a Hawkeye passkey: the passkey leads the sign-in (D2). */
  const [pkHere, setPkHere] = useState(false);
  useEffect(() => {
    let alive = true;
    api.smsOtpEnabled().then((ok) => { if (alive) setSmsOk(ok); });
    api.waRoutes().then((r) => {
      if (!alive) return;
      setWaOk(r?.free === true);
      setWaPaid(r?.paid === true);
      const none = !!r && !r.free && !r.paid;
      setWaNone(none);
      // No WhatsApp route at all: let go of a WhatsApp pick made meanwhile.
      if (none) setChannel((c) => (c === 'whatsapp' ? null : c));
    });
    passkeysUsable().then((ok) => { if (alive) setPkUsable(ok); }).catch(() => {});
    passkeyHereOnDevice().then((h) => { if (alive) setPkHere(h); }).catch(() => {});
    callVerifyEnabled().then((ok) => { if (alive) setCallOk(ok); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  /** The passkey sheet is up (sign-in or the offer); its own flag, so `busy` keeps meaning the form. */
  const [pkBusy, setPkBusy] = useState(false);
  /** The offer made its passkey: the button becomes Continue. */
  const [pkSaved, setPkSaved] = useState(false);
  const [pkMsg, setPkMsg] = useState<string | null>(null);
  /**
   * The free WhatsApp route for this screen: the code the observer sends us,
   * the link that opens WhatsApp with it typed, our number, and what the
   * waiting line says. The poller itself lives in a ref (lib/wa-signin.ts), so
   * no re-render can restart or cancel its timer.
   */
  const [wa, setWa] = useState<{ code: string; waLink: string; waNumber: string } | null>(null);
  const [waWait, setWaWait] = useState<WaWait | 'verified'>('waiting');
  const waPoller = useRef<WaPoller | null>(null);
  /** The server refused another free code for this number (429): WhatsApp sends the paid one from now on. */
  const [waLimited, setWaLimited] = useState(false);
  /**
   * The free missed call for this screen: our number, the tel: link, and the
   * poll token; the poll runs in the step's own effect (below), so leaving the
   * step by any route stops it and cancels the sign-in on the server.
   */
  const [call, setCall] = useState<{ display: string; tel: string; pollToken: string; deadline: number; firstMs: number } | null>(null);
  const [callWait, setCallWait] = useState<'waiting' | 'offline' | 'expired' | 'verified'>('waiting');
  const [callLeft, setCallLeft] = useState(0);
  /** A minute with nothing: say what explains most misses. */
  const [callSlow, setCallSlow] = useState(false);
  /** The 'exists' step came from a missed call (409 call_signup_only): its own sentence. */
  const [existsViaCall, setExistsViaCall] = useState(false);
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
   * KEYBOARD UP ON A SMALL PHONE (owner, 2026-10-03): the form scrolls, and
   * when the keyboard opens (or the visible height changes under it) the view
   * moves so that Send code sits just above the keyboard — but never so far
   * that the field being typed in leaves the top. 320x568 and 375x667 phones.
   */
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const sendRef = useRef<View>(null);
  const viewH = useRef(0);
  const keepInView = useCallback(() => {
    const sv = scrollRef.current;
    const content = contentRef.current;
    const send = sendRef.current;
    if (!sv || !content || !send || !viewH.current) return;
    send.measureLayout(content, (_x, sy, _w, sh) => {
      const place = (fieldTop: number | null) => {
        let y = sy + sh + 16 - viewH.current; // Send code's bottom at the visible bottom
        if (fieldTop !== null) y = Math.min(y, fieldTop - 12); // the field stays in sight
        sv.scrollTo({ y: Math.max(0, y), animated: true });
      };
      const focused = TextInput.State.currentlyFocusedInput?.() as unknown as View | null;
      if (focused && typeof focused.measureLayout === 'function') {
        focused.measureLayout(content, (_fx, fy) => place(fy), () => place(null));
      } else {
        place(null);
      }
    }, () => {});
  }, []);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => setTimeout(keepInView, 60));
    return () => sub.remove();
  }, [keepInView]);
  /**
   * The server CREATED this observer on the verify just made (/verify's isNew).
   * Only an explicit `true`: an older server sends nothing, and an existing
   * account signing up again is not a new observer.
   */
  const [isNewAccount, setIsNewAccount] = useState(false);
  /** The account was made with an organisation code (its room may already be waiting, ONB-11). */
  const [viaOrg, setViaOrg] = useState(false);

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
  /**
   * WhatsApp runs as the free route (step 'wa-send', the observer sends US the
   * code) unless the server sends paid codes AND the free one is out (cannot
   * receive, or this number hit its hourly limit) — then, as before, the paid
   * code. With paid codes off it is ALWAYS the free route: the server decides,
   * and a 503 says so rather than anything being sent.
   */
  const freeWhatsapp = channel === 'whatsapp' && (!waPaid || (waOk && !waLimited));
  /** The missed-call chip: the server runs it, this is a sign-up, and no ORG code replaces the proof. */
  const callRoute = callOk && purpose === 'signup' && !withOrgCode;
  /**
   * A route that sends nothing TO the observer: the missed call (sign-up only)
   * or WhatsApp in reverse. Neither falls back to a paid code by itself.
   */
  const freeRoute = channel === 'call' || freeWhatsapp;
  const startFree = () => (channel === 'call' ? (callRoute ? startCall() : Promise.resolve()) : startWa());
  // The chip went (a reset, an ORG code, the server switched it off): let go of
  // a pick made on it, so Send code never runs a route that is not on screen.
  useEffect(() => {
    if (!callRoute) setChannel((c) => (c === 'call' ? null : c));
  }, [callRoute]);
  /**
   * "SMS (paid)" while the chips fit ONE line; "SMS" once the row has wrapped
   * (owner, 2026-10-04). Measured as the ROW's height against one chip's: a chip
   * that only MOVES to a second line fires no onLayout on the web build (that
   * watches size, not position), but the row grows. Only ever shortens, so the
   * label cannot flip back and forth; measured again when the errand changes.
   */
  const chipRow = useRef<{ chip: number; row: number }>({ chip: 0, row: 0 });
  const [smsShort, setSmsShort] = useState(false);
  const checkSmsFit = () => {
    const { chip, row } = chipRow.current;
    if (chip > 0 && row > chip * 1.5) setSmsShort(true);
  };
  useEffect(() => {
    setSmsShort(false);
  }, [purpose, callRoute]);
  /**
   * Send code needs a full number, and a route unless an organisation code
   * replaces the code. With no route it LOOKS off (sendLooksOff) but still
   * takes a tap — which sends nothing and shows the one-line prompt
   * (owner, 2026-10-03: the prompt only when it is needed, so the form fits
   * with the keyboard up).
   */
  const sendBlocked = busy || phone.trim().length < 10;
  const sendLooksOff = sendBlocked || (!withOrgCode && !channel);
  const [needChoice, setNeedChoice] = useState(false);
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

  // `via` defaults to the chip; the WhatsApp step's fallbacks name theirs, since
  // a setChannel() in the same tap has not reached this closure yet.
  // `verb` picks one of two WHOLE sentences — never an English word glued into
  // a translated one ("Sending" inside a Hausa line was how this used to read).
  const send = (verb: 'Sending' | 'Re-sending', via: Channel = channel as Channel) => {
    // NEVER WITHOUT A CHANNEL. A request with none used to be served "WhatsApp
    // first" by the server — a paid code nobody chose (2026-10-02). The button
    // is disabled until a chip is picked; this is the backstop.
    if (!via) {
      setStep('request');
      return;
    }
    // A missed call sends no code at all (startCall): it never reaches /register.
    if (via === 'call') {
      setStep('request');
      return;
    }
    setLine(verb === 'Re-sending'
      ? i18nT('n.app.sign-in.resending-code-to', { v0: phone.trim() })
      : i18nT('n.app.sign-in.sending-code-to', { v0: phone.trim() }));
    setCooldown(30);
    // Non-null: Send code is disabled until a channel is picked.
    // `signup` lets the server refuse a registered number WITHOUT sending —
    // an OTP costs money and that sign-up has only one possible outcome. Reset
    // and rescue deliberately do not pass it: they need a code on a number that
    // IS registered.
    requestOtp(phone.trim(), via, purpose === 'signup' ? 'signup' : undefined)
      .then((r) => {
        if (r.telegramLink && !r.viaSms) {
          // Telegram needs a one-time bot link. STAY ON THE CODE STEP: once the
          // number is shared the bot sends the code waiting on the OTP row, so
          // this screen is where it gets typed. Bouncing back to the request step
          // (as this used to) flashed "Enter the code" and then took it away.
          setTgLink(r.telegramLink);
          setLine(i18nT('n.app.sign-in.open-telegram-tap-start-then-share'));
        } else if (r.ok) {
          setLine(sentLine(r));
        } else if (r.error === 'account_exists') {
          // Nothing was sent. The reader is NOT signed in — they are simply on
          // the wrong door.
          setExistsAfterOtp(false);
          setExistsViaCall(false);
          setLine(null);
          setStep('exists');
        } else {
          setStep('request');
          setLine(
            r.error === 'invalid_phone'
              ? i18nT('n.auth.wa-invalid-phone')
              : r.error === 'too_many_requests'
                ? i18nT('n.app.sign-in.too-many-code-requests')
                : r.error === 'sms_send_failed'
                  ? i18nT('n.app.sign-in.code-not-delivered')
                  // Anything else (a 500's internal_error, a code this build
                  // does not know) is the server's trouble, not the number's:
                  // "check the number" made a correct number look wrong (ONB-16).
                  : (r.hint ?? i18nT('n.app.sign-in.server-busy-try-again')),
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

  /**
   * A RETURNING sign-in has landed. Offer a passkey on this phone first when
   * lib/passkeys.ts says it may (never a new account, never within 30 days of
   * "Not now", never once this phone has one, only where one can be made — it
   * answers within 3 s), else straight in. The offer is a step of this screen,
   * inline, not a pop-up. Twin of app/app.js offerPasskeyThen().
   */
  const finishReturning = async () => {
    if (await shouldOfferPasskey(false)) {
      setLine(null);
      setPkMsg(null);
      setPkSaved(false);
      setStep('pk-offer');
      return;
    }
    leave();
  };
  /** The same, from a button that holds no busy state of its own. */
  const continueReturning = async () => {
    setBusy(true);
    try {
      await finishReturning();
    } finally {
      setBusy(false);
    }
  };

  /** "Sign in with a passkey": the system sheet, then the app. A pressed Cancel says nothing. */
  const onPasskeySignIn = async () => {
    if (busy || pkBusy) return;
    setPkBusy(true);
    setLine(null);
    try {
      const r = await signInWithPasskey();
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // A returning sign-in, like the password: no sign-up routing, no offer
        // (this phone has just used a passkey).
        leave();
        return;
      }
      if (r.error !== 'cancelled') setLine(passkeyErrorText(r.error));
    } catch {
      setLine(passkeyErrorText('network'));
    } finally {
      setPkBusy(false);
    }
  };

  /** The offer's button: make a passkey on this phone for the account just signed in. */
  const onAddPasskey = async () => {
    setPkBusy(true);
    setPkMsg(null);
    try {
      const r = await registerPasskeyHere();
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPkSaved(true);
        setPkMsg(i18nT('passkey.saved'));
        return;
      }
      setPkMsg(passkeyErrorText(r.error));
    } catch {
      setPkMsg(passkeyErrorText('network'));
    } finally {
      setPkBusy(false);
    }
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
          : r.error === 'invalid_phone' ? i18nT('n.auth.wa-invalid-phone')
          : (r.hint ?? i18nT('n.app.sign-in.verification-failed-try-again')),
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // A new account, like an OTP sign-up: the password step, then the unit
      // — or the room the code put them in (onSavePassword).
      setIsNewAccount(r.isNew === true || r.needsUnit === true);
      setViaOrg(true);
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
    // No route yet: nothing is sent; the one-line prompt appears (needChoice).
    if (!channel) {
      setNeedChoice(true);
      return;
    }
    setTgLink(null);
    if (freeRoute) {
      void startFree();
      return;
    }
    setStep('otp');
    setTimeout(() => otpRef.current?.focus(), 250);
    send('Sending');
  };

  /**
   * Start (or restart) the free MISSED CALL — sign-up only. The server shows our
   * number; the step's effect polls until the call has been seen, then hands the
   * session to afterProof, the same tail as a typed code (so "Create your
   * password" follows). A server that cannot take calls (503) loses the chip
   * and says so; nothing is sent anywhere.
   */
  const startCall = async () => {
    setBusy(true);
    setLine(null);
    try {
      const r = await callStart(phone.trim(), { referralCode: typedInviteCode(inviteCode) || null });
      if (r.ok) {
        setCall({ display: r.display, tel: r.telLink, pollToken: r.pollToken, deadline: Date.now() + r.expiresInS * 1000, firstMs: r.pollAfterMs });
        setCallWait('waiting');
        setCallSlow(false);
        setCallLeft(r.expiresInS);
        setStep('call-send');
        return;
      }
      if (r.error === 'call_unavailable') {
        setCallOk(false);
        setLine(i18nT('auth.call-unavailable'));
        return;
      }
      setLine(
        r.error === 'too_many_requests' ? i18nT('auth.wa-too-many-free')
        : r.error === 'invalid_phone' ? i18nT('n.auth.wa-invalid-phone')
        : (r.hint ?? i18nT('n.app.sign-in.server-busy-try-again')),
      );
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
  };

  /** The code comes TO the observer (paid): the WhatsApp step's fallbacks, and a server that cannot receive. */
  const paidCode = (via: Channel) => {
    // A paid WhatsApp code only while the server sends them (WA_PAID_OTP).
    if (via === 'whatsapp' && !waPaid) return;
    setChannel(via);
    setLine(null);
    setStep('otp');
    setTimeout(() => otpRef.current?.focus(), 250);
    send('Sending', via);
  };

  /**
   * Start (or restart) WhatsApp in reverse: the server hands over a code, the
   * observer sends it from their own WhatsApp, the poller collects the session
   * and hands it to afterProof — the same tail as a typed code. A server that
   * cannot receive right now (503) gets the paid WhatsApp code instead only
   * while it sends paid codes (waPaid); otherwise the line says WhatsApp is
   * unavailable and nothing is sent. Same validation as a send: onRequest has
   * already checked the invite field, and an ORG- code never reaches here.
   */
  const startWa = async () => {
    setBusy(true);
    setLine(null);
    try {
      // The invite rides as it does on /verify: sign-up sends the field (null
      // when empty), reset and rescue the parked one.
      const r = await waStart(
        phone.trim(),
        purpose === 'signup' ? { referralCode: typedInviteCode(inviteCode) || null } : {},
      );
      if (r.ok) {
        waPoller.current?.stop(true); // "Start again": the old code is done with
        setWa({ code: r.code, waLink: r.waLink, waNumber: r.waNumber });
        setWaWait('waiting');
        setStep('wa-send');
        waPoller.current = startWaPoller({
          pollToken: r.pollToken,
          expiresInS: r.expiresInS,
          pollAfterMs: r.pollAfterMs,
          onWait: setWaWait,
          onVerified: (proof) => {
            waPoller.current = null;
            setWaWait('verified');
            // Through the ref: the render that started this poll is minutes old.
            void afterProofRef.current(proof);
          },
        });
        return;
      }
      if (r.error === 'wa_inbound_unavailable') {
        setWaOk(false);
        // The paid code exactly as before — but only while the server sends
        // them. Otherwise say so; nothing is sent.
        if (waPaid) {
          paidCode('whatsapp');
        } else {
          setStep('request');
          setLine(i18nT('auth.wa-unavailable'));
        }
        return;
      }
      if (r.error === 'too_many_requests') setWaLimited(true);
      setLine(
        r.error === 'too_many_requests' ? (waPaid ? i18nT('n.auth.wa-too-many') : i18nT('auth.wa-too-many-free'))
        : r.error === 'invalid_phone' ? i18nT('n.auth.wa-invalid-phone')
        : i18nT('n.app.sign-in.could-not-send-a-code-check'),
      );
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
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
          r.error === 'otp_incorrect' ? i18nT('n.app.profile.wrong-code-check-and-retry')
          : r.error === 'otp_expired' ? i18nT('n.app.sign-in.code-expired')
          : r.error === 'too_many_attempts' ? i18nT('n.app.sign-in.too-many-wrong-codes')
          : (r.hint ?? i18nT('n.app.sign-in.verification-failed-try-again')),
        );
        return;
      }
      await afterProof(r);
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * THE PHONE IS PROVED — by a typed code (/verify) or by the observer's own
   * WhatsApp message (/wa-status). The session is already stored; this decides
   * where they go next, for the purpose they came in with. ONE tail for both
   * proofs, so the free WhatsApp route cannot drift from the code route.
   * `hadPassword` is the server's hasPassword on arrival (lib/auth.ts).
   */
  const afterProof = async (r: WaProof) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Busy across the password-status round trip below: the WhatsApp route has
    // no button of its own holding it.
    setBusy(true);
    try {
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
          // Reached only when no pre-send refusal fired: the WhatsApp route
          // (/wa-start answers every number alike, by design), an older
          // server, or the account gained a password between the two calls.
          setExistsAfterOtp(true);
          setExistsViaCall(false);
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
      // someone on a password screen over a failed status call. A returning
      // sign-in: the passkey offer may come first.
      await finishReturning();
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
  };
  // The latest afterProof for the WhatsApp poller, whose callback outlives the
  // render that created it. Updated after every commit, never during render.
  const afterProofRef = useRef(afterProof);
  useEffect(() => {
    afterProofRef.current = afterProof;
  });

  /**
   * WHILE THE WHATSAPP STEP IS UP: coming back to the app (from WhatsApp, most
   * likely with the message just sent) asks at once instead of waiting out the
   * backoff. LEAVING IT BY ANY ROUTE — a fallback, "Use a different number",
   * the close button, a proof that moved on — stops the poll and kills the code
   * on screen. Keyed on the step alone, so no re-render can cancel the poll.
   */
  useEffect(() => {
    if (step !== 'wa-send') return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') waPoller.current?.pollNow();
    });
    return () => {
      sub.remove();
      waPoller.current?.stop(true);
      waPoller.current = null;
    };
  }, [step]);

  /**
   * THE MISSED-CALL STEP'S POLL, scoped to the step: first after the server's
   * pollAfterMs, then at its retryAfterMs, never past the expiry, at once when
   * the app comes back (from the dialler, most likely), one poll in flight.
   * LEAVING THE STEP BY ANY ROUTE — "Use a different number", the close
   * button, a proof that moved on — stops it, and cancels the sign-in on the
   * server unless it was spent. Keyed on the step and the sign-in, so no other
   * re-render restarts it. Twin of app/app.js callPoll().
   */
  useEffect(() => {
    if (step !== 'call-send' || !call) return;
    let alive = true;
    let spent = false;
    let busyPoll = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((call.deadline - Date.now()) / 1000));
      setCallLeft(left);
      if (Date.now() - started >= 60_000) setCallSlow(true);
      if (!left && !spent) {
        if (timer) clearTimeout(timer);
        setCallWait('expired');
      }
    }, 1000);
    const schedule = (ms: number) => {
      if (!alive || spent) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), Math.max(0, Math.min(ms, call.deadline - Date.now() + 250)));
    };
    const poll = async () => {
      if (!alive || spent || busyPoll || Date.now() > call.deadline) return;
      busyPoll = true;
      let r: Awaited<ReturnType<typeof callStatus>>;
      try {
        r = await callStatus(call.pollToken, phone.trim());
      } catch {
        r = { status: 'retry' };
      }
      busyPoll = false;
      if (!alive) return;
      if (r.status === 'verified') {
        // ✓ "Number verified" for about a second — the reader has just come
        // back from a call that dropped at once, and needs to see it worked —
        // then the password step. The session is kept at once.
        spent = true;
        if (timer) clearTimeout(timer);
        setCallWait('verified');
        const proof = await adoptWaSession(r.session);
        await new Promise((res) => setTimeout(res, 1000));
        void afterProofRef.current(proof);
        return;
      }
      if (r.status === 'has-account') {
        // Nothing was issued: the same two ways in as a refused code (ONB-04),
        // in the call's own words.
        spent = true;
        setExistsAfterOtp(false);
        setExistsViaCall(true);
        setLine(null);
        setStep('exists');
        return;
      }
      if (r.status === 'expired') {
        spent = true;
        setCallWait('expired');
        return;
      }
      if (r.status === 'retry') {
        fails += 1;
        if (fails >= 2) setCallWait('offline');
        schedule(Math.min(10_000, 3000 * fails));
        return;
      }
      fails = 0;
      setCallWait('waiting');
      schedule(r.retryAfterMs);
    };
    schedule(call.firstMs);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !spent) {
        if (timer) clearTimeout(timer);
        void poll();
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
      sub.remove();
      if (!spent) void callCancel(call.pollToken);
    };
    // `phone` is fixed while this step is up (the field is on another step).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, call]);

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
    busy || pkBusy || !phoneReady || (blankPw ? pwRequiredFor === phone.trim() : password.length < 8);

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
        // /login has no isNew: a password sign-in is always a returning one.
        await finishReturning();
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
          ? i18nT('n.auth.wa-invalid-phone')
          // The server's wrong_password / too_many_attempts hints are ENGLISH
          // (walkthrough #2): the same sentences, in the reader's language —
          // the web's keys, so both clients say it the same way.
          : r.error === 'wrong_password'
            ? i18nT('auth.err.wrong-password')
            : r.error === 'too_many_attempts'
              ? i18nT('auth.err.too-many-passwords')
              : (r.hint ?? i18nT('n.app.sign-in.sign-in-failed-try-again')),
      );
    } catch {
      setLine(i18nT('n.app.sign-in.network-error-try-again'));
    } finally {
      setBusy(false);
    }
  };

  /** Is this account already a member of a room? Any doubt (offline, an error) says no: the chooser, as before. */
  const orgRoomJoined = async (): Promise<boolean> => {
    try {
      const g = await authedGet<{ member?: unknown[] }>('/api/groups', { signOutOn401: false });
      return Array.isArray(g?.member) && g.member.length > 0;
    } catch {
      return false;
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
          // CAME FOR SOMETHING SPECIFIC — an invite under this screen, or a
          // `next` — then that comes first, as the web's NEXT_DEST does
          // (app.js afterVerified): back to it, not into the chooser.
          if (returnTo || inviteBelow()) {
            leave();
            return;
          }
          // AN ORGANISATION CODE'S ROOM (ONB-11). The server puts the agent in
          // its issuer's room at sign-up when there is one room (backend
          // routes/groups.js autoJoinOrgRoom), so they land IN it — My Groups —
          // rather than on the chooser and then a Home that never names it. A
          // room per area waits for the unit, so the chooser stays for that.
          if (viaOrg && (await orgRoomJoined())) {
            router.replace('/my-groups' as never);
            return;
          }
          const unit = await takeInviteUnit();
          router.replace(
            (unit ? `/choose-unit?onboard=1&unit=${encodeURIComponent(unit)}` : '/choose-unit?onboard=1') as never,
          );
          return;
        }
        clearInviteUnit();
        // Not a new account (a reset, a rescue, or an existing number signing
        // up again): a returning sign-in, so the passkey offer may come first.
        await finishReturning();
        return;
      }
      setLine(
        r.error === 'password_too_short' ? i18nT('n.app.sign-in.use-at-least-8-characters')
        : r.error === 'password_too_long' ? i18nT('n.app.sign-in.password-too-long')
        // The no-current-password window is 15 min from the code — past that the
        // server asks for the old one, which is exactly what they don't have.
        : r.error === 'current_password_wrong' ? i18nT('n.app.sign-in.code-window-passed')
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
      await continueReturning();
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
  // WhatsApp goes only when the server has ANSWERED that it runs neither the
  // free route nor paid codes (waNone).
  // Telegram and WhatsApp side by side, equal (D2). SMS is NOT in this row: it
  // costs per code, so it sits below, smaller, labelled as the fallback.
  // SIGN-UP's LINE-UP (owner, 2026-10-04): WhatsApp, Telegram, Call, then SMS
  // (below) — all four on ONE line at 360 px; the reset and the no-password
  // rescue keep Telegram, WhatsApp, SMS. The row still wraps (flex-wrap) on a
  // narrower phone rather than overflowing.
  const WA_CHIP = waNone ? [] : [{ key: 'whatsapp' as Channel, label: 'WhatsApp' }];
  const TG_CHIP = [{ key: 'telegram' as Channel, label: 'Telegram' }];
  const CHANNELS: { key: Channel; label: string }[] = purpose === 'signup'
    ? [...WA_CHIP, ...TG_CHIP, ...(callRoute ? [{ key: 'call' as Channel, label: i18nT('auth.call-chip') }] : [])]
    : [...TG_CHIP, ...WA_CHIP];

  const requestCopy =
    purpose === 'signup'
      ? {
          title: i18nT('n.app.sign-in.create-your-account'),
          // SHORT (owner, 2026-10-03): the form must fit with the keyboard up;
          // the password is asked for on its own step.
          body: i18nT('auth.signup-lede'),
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
      ? { title: i18nT('n.app.sign-in.choose-a-new-password'), body: i18nT('n.app.sign-in.reset-body') }
      : purpose === 'no-password'
        ? { title: i18nT('n.app.sign-in.set-your-password'), body: i18nT('n.app.sign-in.set-body') }
        : { title: i18nT('n.app.sign-in.create-your-password'), body: i18nT('n.app.sign-in.create-body') };

  const pwSaveDisabled = busy || newPw.length < 8 || newPw2.length < 8;

  /** The WhatsApp step's live line. `mismatch`: the code came from another number (dual SIM). */
  const waLine =
    waWait === 'verified' ? i18nT('n.auth.wa-verified')
    : waWait === 'expired' ? i18nT('n.auth.wa-expired')
    : waWait === 'offline' ? i18nT('n.auth.wa-offline')
    : waWait === 'mismatch' ? i18nT('n.auth.wa-mismatch', { phone: phone.trim() })
    : i18nT('n.auth.wa-waiting');
  const waCalm = waWait === 'waiting' || waWait === 'verified';

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
              // On the passkey offer the person is already signed in: closing
              // it goes into the app, never back to a sign-in form.
              onPress={() => (step === 'pk-offer' ? leave() : router.back())}
              className="h-9 w-9 items-center justify-center rounded-full bg-card"
            >
              <Feather name="x" size={18} color={ui.ink} />
            </Pressable>
          )}
          <Text className="pl-3 text-lg font-bold text-ink">
            {step === 'set-password'
              ? i18nT('n.app.sign-in.title-your-password')
              : step === 'pk-offer'
                ? i18nT('n.app.sign-in.title-sign-in')
                : step === 'exists'
                  ? i18nT('n.app.sign-in.title-exists')
                  : purpose === 'signup' && step !== 'password'
                    ? i18nT('n.app.sign-in.title-create-account')
                    : i18nT('n.app.sign-in.title-sign-in')}
          </Text>
          {/* LANGUAGE, on the two first steps only (walkthrough #4). A change
              remounts the screen, so it is offered before a code is on its
              way or a password is half set — never mid-flow. */}
          {step === 'request' || step === 'password' ? (
            <View className="ml-auto">
              <LangButton />
            </View>
          ) : null}
        </View>

        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 }}
          onLayout={(e) => {
            viewH.current = e.nativeEvent.layout.height;
            if (Keyboard.isVisible()) keepInView();
          }}
        >
        <View ref={contentRef} collapsable={false} className="px-5 pt-6">
          {step === 'password' ? (
            <>
              <SignedOutElsewhereNote />
              <Text className="text-2xl font-bold text-ink">{i18nT('n.app.sign-in.welcome-back')}</Text>
              {/* PASSKEY FIRST ON A PHONE THAT HAS ONE (D2): the default, the
                  primary button, above the number and password. Elsewhere it
                  stays right after Sign in (below). */}
              {pkUsable && pkHere ? (
                <Pressable
                  disabled={busy || pkBusy}
                  onPress={() => void onPasskeySignIn()}
                  accessibilityRole="button"
                  className={`mt-4 flex-row items-center justify-center rounded-2xl py-4 ${
                    busy || pkBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                  }`}
                >
                  {pkBusy ? (
                    <ActivityIndicator color={BRAND.gold} accessibilityLabel={i18nT('passkey.signing-in')} />
                  ) : (
                    <>
                      <Feather name="key" size={17} color={BRAND.gold} />
                      <Text className="pl-2 text-base font-bold text-hawk-gold">{i18nT('passkey.signin-button')}</Text>
                    </>
                  )}
                </Pressable>
              ) : null}
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
              {/* PASSKEY: shown only where it can work (lib/passkeys.ts). An
                  ordinary button — pressing it opens the system's own passkey
                  sheet, with nothing of ours in front of it. No phone number
                  needed: the phone offers its Hawkeye passkeys. Twin of
                  observe.html #pk-signin. On a phone that has one it leads instead (above). */}
              {pkUsable && !pkHere ? (
                <>
                  <Pressable
                    disabled={busy || pkBusy}
                    onPress={() => void onPasskeySignIn()}
                    accessibilityRole="button"
                    className={`mt-3 flex-row items-center justify-center rounded-2xl py-4 ${
                      busy || pkBusy ? 'bg-disabled' : 'bg-card active:opacity-80'
                    }`}
                  >
                    {pkBusy ? (
                      <ActivityIndicator color={ui.tint.good.ink} accessibilityLabel={i18nT('passkey.signing-in')} />
                    ) : (
                      <>
                        <Feather name="key" size={17} color={ui.tint.good.ink} />
                        <Text className="pl-2 text-base font-bold text-good-ink">{i18nT('passkey.signin-button')}</Text>
                      </>
                    )}
                  </Pressable>
                  <Text className="pt-2 text-center text-xs text-muted" accessibilityLiveRegion="polite">
                    {pkBusy ? i18nT('passkey.signing-in') : i18nT('passkey.signin-hint')}
                  </Text>
                </>
              ) : null}
              <Pressable className="mt-4 items-center" onPress={() => startOtp('reset')}>
                <Text className="text-sm font-semibold text-good-ink">{i18nT('n.app.sign-in.forgot-password')}</Text>
              </Pressable>
              <Pressable className="mt-5 items-center" onPress={() => startOtp('signup')}>
                <Text className="text-sm text-muted">
                  {i18nT('n.app.sign-in.new-here')} <Text className="font-semibold text-good-ink">{i18nT('index.create-an-account')}</Text>
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
              <View
                className="flex-row flex-wrap gap-2 pt-3"
                style={withOrgCode ? { display: 'none' } : undefined}
                onLayout={(e) => { chipRow.current.row = e.nativeEvent.layout.height; checkSmsFit(); }}
              >
                {CHANNELS.map((c, i) => (
                  <Pressable
                    key={c.key}
                    onLayout={i === 0 ? (e) => { chipRow.current.chip = e.nativeEvent.layout.height; checkSmsFit(); } : undefined}
                    onPress={() => {
                      setChannel(c.key);
                      setNeedChoice(false);
                    }}
                    className={`rounded-full px-3 py-2 ${
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
                {/* SMS LAST, A CHIP LIKE THE OTHERS, LABELLED PAID (owner,
                    2026-10-03): as a small line apart it did not read as
                    pickable at all. "Paid" steers people to the free routes —
                    but only while the row still fits ONE line (owner,
                    2026-10-04): measured (onLayout), plain "SMS" once it wraps.
                    Never pre-selected. */}
                {smsOk ? (
                  <Pressable
                    onPress={() => {
                      setChannel('sms');
                      setNeedChoice(false);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: channel === 'sms' }}
                    className={`rounded-full px-3 py-2 ${channel === 'sms' ? 'bg-hawk-green' : 'bg-card'}`}
                  >
                    <Text className={`text-sm ${channel === 'sms' ? 'font-semibold text-hawk-gold' : 'text-faint'}`}>
                      {smsShort ? i18nT('observe.sms') : i18nT('auth.sms-paid')}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {/* NO DEFAULT ROUTE (owner, 2026-10-02): Send code stays disabled,
                  and this line says why, until a chip is picked — or an
                  organisation code replaces the code. */}
              {needChoice && !withOrgCode && !channel ? (
                <Text className="pt-2 text-sm text-warn-ink" accessibilityRole="alert">{i18nT('auth.choose-route')}</Text>
              ) : null}
              {/* D3: a reset done now, not during the election window (9-17 Jan,
                  when sessions are held open). Shown until 9 Jan 2027. */}
              {purpose === 'reset' && NUDGE_RESETS ? (
                <Text className="pt-2 text-xs text-muted">{i18nT('auth.reset-before-9-jan')}</Text>
              ) : null}
              {/* Sign-up only: reset and rescue are for accounts that exist,
                  and a referral or an organisation code can only make a new one.
                  ONE field for both; the line under it names the kind. */}
              {purpose === 'signup' ? (
                <View className="pt-4">
                  <Text className="pb-1 text-sm font-semibold text-muted">
                    {i18nT('auth.code-label-short')}
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
                    accessibilityLabel={i18nT('auth.code-label-short')}
                  />
                  <Text className="pt-1 text-xs text-muted">
                    {kind === 'invite' ? authT('n.auth.code-kind-invite')
                      : kind === 'org' ? authT('n.auth.code-kind-org')
                      : i18nT('auth.code-hint-short')}
                  </Text>
                  {inviteBad ? (
                    <Text className="pt-1 text-sm text-bad-ink" accessibilityRole="alert">
                      {authT('n.auth.code-invalid')}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {/* Disabled until a channel is picked (an organisation code
                  needs none). It used to fire with no chip, and the server
                  served that as a paid WhatsApp code (2026-10-02). */}
              <View ref={sendRef} collapsable={false}>
              <Pressable
                disabled={sendBlocked}
                onPress={onRequest}
                accessibilityState={{ disabled: sendLooksOff }}
                className={`mt-5 items-center rounded-2xl py-4 ${
                  sendLooksOff ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator
                    color={BRAND.gold}
                    accessibilityLabel={freeWhatsapp && !withOrgCode ? i18nT('n.auth.wa-starting') : undefined}
                  />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">
                    {withOrgCode ? authT('n.auth.org-create-account') : i18nT('n.app.profile.send-code')}
                  </Text>
                )}
              </Pressable>
              </View>
              <Pressable
                className="mt-4 items-center"
                onPress={() => {
                  setLine(null);
                  setTgLink(null);
                  setStep('password');
                }}
              >
                <Text className="text-sm font-semibold text-good-ink">
                  {purpose === 'signup' ? i18nT('n.app.sign-in.have-account-sign-in') : i18nT('n.app.sign-in.back-to-password-sign-in')}
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
                    {i18nT('n.app.sign-in.first-time')} <Text className="font-semibold text-good-ink">{i18nT('n.app.sign-in.try-a-practice-run')}</Text>
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
                  // A missed call only ever CREATES an account (caller ID can
                  // be forged), so nothing was issued — said in its own words.
                  : existsViaCall
                    ? i18nT('auth.call-has-account')
                    : i18nT('n.app.sign-in.is-already-registered-as-an-observer-2', { v0: phone.trim() })}
              </Text>

              {existsAfterOtp ? (
                <Pressable
                  disabled={busy}
                  onPress={() => void continueReturning()}
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
                  {/* Two sentences side by side, each keyed — "Forgot your
                      password?" was an English literal glued to a translated
                      half (ONB-HA-native). */}
                  {i18nT('n.app.sign-in.forgot-your-password')} {existsAfterOtp ? i18nT('n.app.sign-in.set-a-new-one') : i18nT('n.app.sign-in.reset-it')}
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
          ) : step === 'pk-offer' ? (
            <>
              {/* "SIGN IN FASTER NEXT TIME" — after a RETURNING sign-in, inline
                  and skippable, never a pop-up (owner rule): the button goes
                  straight to the system's passkey sheet. The person is already
                  signed in, so every way off this step goes into the app.
                  "Not now" = not asked again on this phone for 30 days.
                  Twin of observe.html #pk-offer. */}
              <Text className="text-2xl font-bold text-ink">{i18nT('passkey.offer-title')}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{i18nT('passkey.offer-body')}</Text>
              <Pressable
                disabled={pkBusy}
                onPress={() => (pkSaved ? leave() : void onAddPasskey())}
                accessibilityRole="button"
                className={`items-center rounded-2xl py-4 ${pkBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
              >
                {pkBusy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">
                    {pkSaved ? i18nT('passkey.continue') : i18nT('passkey.offer-yes')}
                  </Text>
                )}
              </Pressable>
              {pkMsg ? (
                <Text
                  className={`pt-3 text-sm ${pkSaved ? 'text-good-ink' : 'text-warn-ink'}`}
                  accessibilityLiveRegion="polite"
                >
                  {pkMsg}
                </Text>
              ) : null}
              {!pkSaved ? (
                <Pressable
                  className="mt-4 items-center"
                  disabled={pkBusy}
                  onPress={() => {
                    void offerPasskeyLater().finally(() => leave());
                  }}
                >
                  <Text className="text-sm font-semibold text-good-ink">{i18nT('passkey.offer-no')}</Text>
                </Pressable>
              ) : null}
            </>
          ) : step === 'call-send' ? (
            <>
              {/* MISSED CALL (free, sign-up only). Modelled on the WhatsApp
                  step below: our number, big and selectable; Call now (the
                  dialler, tel:); the live line; the countdown; after a minute
                  with nothing, the hint that explains most misses; and the way
                  back. Twin of app/observe.html #call-send. */}
              <Text className="text-2xl font-bold text-ink">{i18nT('auth.call-title')}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">
                {i18nT('auth.call-body', { number: call?.display ?? '', phone: phone.trim() })}
              </Text>
              <View className="items-center rounded-2xl bg-card px-4 py-5">
                <Text
                  selectable
                  className={`text-3xl font-bold ${callWait === 'expired' ? 'text-faint' : 'text-ink'}`}
                >
                  {call?.display}
                </Text>
              </View>
              {/* SAID BEFORE THE TAP (owner's live test, 2026-10-04): the
                  gateway rejects the call at once — no ring, the line just
                  drops — which reads as a failure unless the reader was told. */}
              {callWait === 'waiting' || callWait === 'offline' ? (
                <Text className="pt-4 text-center text-sm text-muted">{i18nT('auth.call-ends-at-once')}</Text>
              ) : null}
              {callWait === 'expired' ? (
                <Pressable
                  disabled={busy}
                  onPress={() => void startCall()}
                  accessibilityRole="button"
                  className={`mt-5 items-center rounded-2xl py-4 ${busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
                >
                  {busy ? (
                    <ActivityIndicator color={BRAND.gold} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">{i18nT('n.auth.wa-again')}</Text>
                  )}
                </Pressable>
              ) : (
                <Pressable
                  disabled={callWait === 'verified'}
                  onPress={() => {
                    // Only a tel: link reaches the OS (lib/auth.ts callStart).
                    // The dialler, not CALL_PHONE: placing the call ourselves
                    // would need a new permission and a store build.
                    if (call) Linking.openURL(call.tel).catch(() => {});
                  }}
                  accessibilityRole="button"
                  className="mt-5 flex-row items-center justify-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
                >
                  <Feather name="phone-call" size={18} color={BRAND.gold} />
                  <Text className="pl-2 text-base font-bold text-hawk-gold">{i18nT('auth.call-now')}</Text>
                </Pressable>
              )}
              {/* Two SIMs: the phone may dial from the other one. */}
              {callWait === 'waiting' || callWait === 'offline' ? (
                <Text className="pt-2 text-center text-xs text-muted">{i18nT('auth.call-dual-sim', { phone: phone.trim() })}</Text>
              ) : null}
              {/* A CLEAR SUCCESS: ✓ "Number verified", for a moment, before the password. */}
              <View className="flex-row items-center justify-center gap-2 pt-4" accessibilityLiveRegion="polite">
                {callWait === 'waiting' ? <ActivityIndicator size="small" color={ui.muted} /> : null}
                {callWait === 'verified' ? <Feather name="check-circle" size={18} color={ui.tint.good.ink} /> : null}
                <Text className={`shrink text-center text-sm ${callWait === 'verified' ? 'font-bold text-good-ink' : callWait === 'waiting' ? 'text-muted' : 'text-warn-ink'}`}>
                  {callWait === 'verified' ? i18nT('auth.call-verified')
                    : callWait === 'expired' ? i18nT('auth.call-expired')
                    : callWait === 'offline' ? i18nT('n.auth.wa-offline')
                    : i18nT('auth.call-waiting')}
                </Text>
              </View>
              {callWait === 'waiting' || callWait === 'offline' ? (
                <Text className="pt-2 text-center text-xs text-muted">{i18nT('auth.call-expires-in', { time: mmss(callLeft) })}</Text>
              ) : null}
              {callSlow && (callWait === 'waiting' || callWait === 'offline') ? (
                <Text className="pt-3 text-center text-sm text-warn-ink">{i18nT('auth.call-slow')}</Text>
              ) : null}
              {callWait !== 'verified' ? (
                <Pressable
                  className="mt-5 items-center"
                  disabled={busy}
                  onPress={() => {
                    setLine(null);
                    setStep('request');
                  }}
                >
                  <Text className="text-sm font-semibold text-muted">{i18nT('n.app.sign-in.use-a-different-number')}</Text>
                </Pressable>
              ) : null}
            </>
          ) : step === 'wa-send' ? (
            <>
              {/* WHATSAPP IN REVERSE (free). The observer sends US this code
                  from the WhatsApp on the number they typed; lib/wa-signin.ts
                  collects the session. The code is a selectable Text, never a
                  TextInput — see the letterSpacing note on the OTP box below.
                  Twin of app/observe.html #wa-send.
                  SHORT ON PURPOSE (owner, 2026-09-30): title, one line, the
                  code, the button, the waiting line; everything else is a small
                  fallback link underneath. */}
              <Text className="text-2xl font-bold text-ink">{i18nT('n.auth.wa-title')}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{i18nT('n.auth.wa-body-3')}</Text>
              <View className="items-center rounded-2xl bg-card px-4 py-5">
                <Text
                  selectable
                  accessibilityLabel={i18nT('n.auth.wa-code-a11y', { code: (wa?.code ?? '').split('').join(' ') })}
                  className={`text-3xl font-bold ${waWait === 'expired' ? 'text-faint' : 'text-ink'}`}
                >
                  {wa?.code}
                </Text>
              </View>
              {waWait === 'expired' ? (
                <Pressable
                  disabled={busy}
                  onPress={() => void startWa()}
                  accessibilityRole="button"
                  className={`mt-5 items-center rounded-2xl py-4 ${busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
                >
                  {busy ? (
                    <ActivityIndicator color={BRAND.gold} accessibilityLabel={i18nT('n.auth.wa-starting')} />
                  ) : (
                    <Text className="text-base font-bold text-hawk-gold">{i18nT('n.auth.wa-again')}</Text>
                  )}
                </Pressable>
              ) : (
                <Pressable
                  disabled={waWait === 'verified'}
                  onPress={() => {
                    // Android: the WhatsApp app itself (whatsapp://), wa.me only
                    // if that fails. iOS: wa.me, WhatsApp's Universal Link, with
                    // no "open WhatsApp?" confirm (lib/wa-signin.ts). In a
                    // browser (the web build) wa.me as before: a browser
                    // swallows an unknown scheme without an error.
                    if (!wa) return;
                    if (Platform.OS === 'web') Linking.openURL(wa.waLink).catch(() => {});
                    else void openWhatsApp(wa.waLink, (u) => Linking.openURL(u), Platform.OS);
                  }}
                  accessibilityRole="button"
                  className="mt-5 flex-row items-center justify-center rounded-2xl bg-hawk-green py-4 active:opacity-80"
                >
                  <Feather name="message-circle" size={18} color={BRAND.gold} />
                  <Text className="pl-2 text-base font-bold text-hawk-gold">{i18nT('n.auth.wa-open')}</Text>
                </Pressable>
              )}
              <View className="flex-row items-center justify-center gap-2 pt-4" accessibilityLiveRegion="polite">
                {waCalm ? <ActivityIndicator size="small" color={ui.muted} /> : null}
                <Text className={`shrink text-center text-sm ${waCalm ? 'text-muted' : 'text-warn-ink'}`}>
                  {waLine}
                </Text>
              </View>
              <Text className="pt-2 text-center text-xs text-muted">{i18nT('n.auth.wa-safety')}</Text>
              {waWait !== 'verified' ? (
                <>
                  {wa?.waNumber ? (
                    <Text selectable className="mt-5 text-center text-sm text-muted">
                      {i18nT('n.auth.wa-number', { number: wa.waNumber })}
                    </Text>
                  ) : null}
                  {/* A PAID code: only while the server sends them (WA_PAID_OTP). */}
                  {waPaid ? (
                    <Pressable className="mt-3 items-center" disabled={busy} onPress={() => paidCode('whatsapp')}>
                      <Text className="text-center text-sm font-semibold text-good-ink">
                        {i18nT('n.auth.wa-fallback-whatsapp')}
                      </Text>
                    </Pressable>
                  ) : null}
                  {smsOk ? (
                    <Pressable className="mt-3 items-center" disabled={busy} onPress={() => paidCode('sms')}>
                      <Text className="text-center text-sm font-semibold text-good-ink">
                        {i18nT('n.auth.wa-fallback-sms')}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    className="mt-3 items-center"
                    disabled={busy}
                    onPress={() => {
                      setLine(null);
                      setStep('request');
                    }}
                  >
                    <Text className="text-sm font-semibold text-muted">{i18nT('n.app.sign-in.use-a-different-number')}</Text>
                  </Pressable>
                </>
              ) : null}
            </>
          ) : step === 'otp' ? (
            <>
              <Text className="text-2xl font-bold text-ink">{i18nT('n.app.sign-in.enter-the-code')}</Text>
              <Text className="pb-4 pt-1 text-sm text-muted">{line}</Text>
              {tgLink ? (
                <Pressable
                  className="mb-4 items-center rounded-2xl bg-card py-3 active:opacity-80"
                  onPress={() => {
                    Linking.openURL(tgLink).catch(() => WebBrowser.openBrowserAsync(tgLink));
                  }}
                >
                  <Text className="text-base font-semibold text-good-ink">{i18nT('n.app.sign-in.open-telegram')}</Text>
                </Pressable>
              ) : null}
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
                    {cooldown > 0 ? i18nT('n.app.sign-in.resend-in-s', { v0: cooldown }) : i18nT('n.app.sign-in.resend-code')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setTgLink(null);
                    setStep('request');
                  }}
                >
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
          {tgLink && step !== 'otp' ? (
            <Pressable
              className="mt-3 items-center rounded-2xl bg-card py-3"
              onPress={() => WebBrowser.openBrowserAsync(tgLink)}
            >
              <Text className="text-base font-semibold text-good-ink">{i18nT('n.app.sign-in.open-telegram')}</Text>
            </Pressable>
          ) : null}
        </View>
        </ScrollView>
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

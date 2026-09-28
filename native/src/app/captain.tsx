import Feather from '@expo/vector-icons/Feather';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Crumb, Prompt } from '@/components/wizard';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { BASE } from '@/lib/api';
import { authedSend } from '@/lib/authed-send';
import { dayMonthYear } from '@/lib/dates';
import { t as i18nT } from '@/lib/i18n';
import { regFetch } from '@/lib/register-fetch';
import { useUi } from '@/lib/theme';

/**
 * APPLY TO BE A WARD CAPTAIN — the native twin of app/captain.html, over the
 * same two endpoints (backend routes/captains.js): GET /api/captains/mine and
 * POST /api/captains/apply. One open application per observer.
 *
 * NO NAME AND NO PHONE, on purpose and by the server's design: the account
 * keeps a phone only as an HMAC, and the owner replies through Hawkeye alerts.
 * The captain-message alert lands HERE (lib/web-routes.ts), where the status is.
 *
 * It used to be reachable only as the website's page, which in the app meant a
 * signed-OUT browser tab and the website's sign-in form. The ward captain's
 * guide is folded in below the lede for the same reason — the app never opens
 * our own pages — and its prose is the website's own keys, so both clients say
 * the same thing in every language.
 */
type Status = 'new' | 'contacted' | 'approved' | 'declined';
type Application = {
  id: number;
  state: string;
  lga: string;
  ward: string;
  organisation: string;
  note: string;
  volunteers: number;
  status: Status;
  createdAt: number;
};
type Mine = { application: Application | null; canApply: boolean };

const REG = `${BASE}/api/register`;
/** The server's own limits (routes/captains.js LIMITS). */
const MAX_ORG = 120;
const MAX_NOTE = 600;
const MAX_VOLUNTEERS = 500;

/** Server codes are snake_case; the bundle keys are kebab-case (as on the web). */
const KNOWN = new Set([
  'ward_required', 'unknown_ward', 'note_required', 'bad_volunteers', 'consent_required',
  'already_applied', 'rate_limited', 'signed_out', 'network', 'failed',
]);
const errText = (code: string) =>
  i18nT(`captain.err.${(KNOWN.has(code) ? code : 'failed').replace(/_/g, '-')}` as string);

function codeOf(status: number, body: { error?: string } | null): string {
  if (status === 401) return 'signed_out';
  if (status === 429) return 'rate_limited';
  return body?.error && KNOWN.has(body.error) ? body.error : 'failed';
}

/**
 * The guide, as keys. Module-level KEYS, resolved at render — a module-level
 * i18nT() would freeze the language at import (see the note in (tabs)/more.tsx).
 */
const GUIDE: { h: string; items: string[]; ordered?: boolean; safety?: boolean }[] = [
  {
    h: 'captain-guide.what-h',
    items: ['captain-guide.what-1', 'captain-guide.what-2', 'captain-guide.what-3', 'captain-guide.what-4'],
    ordered: true,
  },
  { h: 'captain-guide.invite-h', items: ['captain-guide.invite-1', 'captain-guide.invite-2', 'captain-guide.invite-3'] },
  {
    h: 'captain-guide.rules-h',
    items: ['captain-guide.rules-1', 'captain-guide.rules-2', 'captain-guide.rules-3', 'captain-guide.rules-4', 'captain-guide.rules-5'],
  },
  { h: 'captain-guide.safety-h', items: ['captain-guide.safety-1', 'captain-guide.safety-2', 'captain-guide.safety-3'], safety: true },
  { h: 'captain-guide.never-h', items: ['captain-guide.never-1', 'captain-guide.never-2', 'captain-guide.never-3'] },
];

/** The observer's latest application, or why it could not be read. */
async function fetchMine(): Promise<{ ok: true; mine: Mine } | { ok: false; code: string }> {
  try {
    const r = await authedSend<Mine>('GET', '/api/captains/mine');
    if (r.status !== 200 || !r.body) return { ok: false, code: codeOf(r.status, r.body as { error?: string } | null) };
    return { ok: true, mine: r.body };
  } catch {
    return { ok: false, code: 'network' };
  }
}

/** One register list (states / lgas / wards), or null when it could not load. */
async function fetchList(path: string): Promise<string[] | null> {
  try {
    const r = await regFetch(`${REG}/${path}`);
    if (!r.ok) return null;
    const v = await r.json();
    return Array.isArray(v) ? v.filter((x) => x != null && x !== '') : null;
  } catch {
    return null;
  }
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="mb-2 mr-2 rounded-full bg-surface px-4 py-2 active:opacity-70">
      <Text className="text-sm font-semibold text-ink">{label}</Text>
    </Pressable>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <Text className="pb-1.5 pt-4 text-sm font-semibold text-ink">{children}</Text>;
}

export default function Captain() {
  const ui = useUi();
  const { guide } = useLocalSearchParams<{ guide?: string }>();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const scroller = useRef<ScrollView>(null);

  const [guideOpen, setGuideOpen] = useState(guide === '1');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [app, setApp] = useState<Application | null>(null);
  const [canApply, setCanApply] = useState(false);
  /** Above the status card: "sent", or an error once the form is gone (409). */
  const [notice, setNotice] = useState<{ ok: boolean; code?: string } | null>(null);
  /** Under the Send button. */
  const [formMsg, setFormMsg] = useState<{ ok: boolean; code?: string } | null>(null);
  const [sending, setSending] = useState(false);

  const [states, setStates] = useState<string[]>([]);
  const [lgas, setLgas] = useState<string[]>([]);
  const [wards, setWards] = useState<string[]>([]);
  const [stateSel, setStateSel] = useState<string | null>(null);
  const [lgaSel, setLgaSel] = useState<string | null>(null);
  const [wardSel, setWardSel] = useState<string | null>(null);
  const [regErr, setRegErr] = useState(false);

  const [org, setOrg] = useState('');
  const [note, setNote] = useState('');
  const [volunteers, setVolunteers] = useState('0');
  const [consent, setConsent] = useState(false);

  /* Fetches are plain promises and state is set in their callbacks, so no
     effect below sets state in its own body (react-hooks/set-state-in-effect). */
  const applyMine = useCallback((m: { ok: true; mine: Mine } | { ok: false; code: string }) => {
    if (m.ok) {
      setApp(m.mine.application ?? null);
      setCanApply(!!m.mine.canApply);
    } else setLoadErr(m.code);
    setLoading(false);
  }, []);

  useEffect(() => {
    let live = true;
    fetchMine().then((m) => { if (live) applyMine(m); });
    return () => { live = false; };
  }, [applyMine]);

  const retry = () => {
    setLoading(true);
    setLoadErr(null);
    setNotice(null);
    fetchMine().then(applyMine);
  };

  /* THE REGISTER CASCADE — the same lists collation and map-unit browse, and
     answered from the offline pack when it is held (lib/register-fetch.ts). */
  const got = useCallback((set: (v: string[]) => void) => (v: string[] | null) => {
    setRegErr(!v);
    if (v) set(v);
  }, []);

  useEffect(() => {
    if (canApply && !states.length) fetchList('states').then(got(setStates));
  }, [canApply, states.length, got]);
  // The stale lower lists are cleared where the choice is made (pickState /
  // pickLga), not here.
  useEffect(() => {
    if (stateSel) fetchList(`lgas?state=${encodeURIComponent(stateSel)}`).then(got(setLgas));
  }, [stateSel, got]);
  useEffect(() => {
    if (stateSel && lgaSel) {
      fetchList(`wards?state=${encodeURIComponent(stateSel)}&lga=${encodeURIComponent(lgaSel)}`).then(got(setWards));
    }
  }, [stateSel, lgaSel, got]);

  const pickState = (v: string | null) => {
    setLgas([]);
    setWards([]);
    setLgaSel(null);
    setWardSel(null);
    setStateSel(v);
  };
  const pickLga = (v: string | null) => {
    setWards([]);
    setWardSel(null);
    setLgaSel(v);
  };

  const submit = async () => {
    const body = {
      state: stateSel ?? '',
      lga: lgaSel ?? '',
      ward: wardSel ?? '',
      organisation: org.trim(),
      note: note.trim(),
      volunteers: Number(volunteers.trim() === '' ? NaN : volunteers.trim()),
      consent,
    };
    // The server's own checks, so the common mistakes answer at once.
    let code: string | null = null;
    if (!body.state || !body.lga || !body.ward) code = 'ward_required';
    else if (!body.note) code = 'note_required';
    else if (!Number.isInteger(body.volunteers) || body.volunteers < 0 || body.volunteers > MAX_VOLUNTEERS) {
      code = 'bad_volunteers';
    } else if (!body.consent) code = 'consent_required';
    if (code) {
      setFormMsg({ ok: false, code });
      return;
    }
    setSending(true);
    setFormMsg(null);
    try {
      const r = await authedSend<{ application?: Application; error?: string }>('POST', '/api/captains/apply', body);
      if (r.status === 201 && r.body?.application) {
        setApp(r.body.application);
        setCanApply(false);
        setNotice({ ok: true });
        scroller.current?.scrollTo({ y: 0, animated: true });
        return;
      }
      const c = codeOf(r.status, r.body);
      if (r.status === 409 && r.body?.application) {
        // Already applied (another device, or a double tap): show that one.
        setApp(r.body.application);
        setCanApply(false);
        setNotice({ ok: false, code: c });
        scroller.current?.scrollTo({ y: 0, animated: true });
        return;
      }
      setFormMsg({ ok: false, code: c });
    } catch {
      setFormMsg({ ok: false, code: 'network' });
    } finally {
      setSending(false);
    }
  };

  const badge = (s: Status) =>
    s === 'approved' ? 'bg-good text-good-ink' : s === 'declined' ? 'bg-surface text-muted' : 'bg-surface text-ink';

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title={i18nT('captain.title')} translateY={translateY} onClose={() => router.back()} />
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.ScrollView
          ref={scroller as never}
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 40 }}
        >
          <Text className="text-sm leading-5 text-muted">{i18nT('captain.lede')}</Text>

          {/* THE GUIDE, folded. Read before applying, and again once approved
              ("Start with the captain's guide"), so it lives on this screen. */}
          <View className="mt-4 overflow-hidden rounded-2xl bg-card">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: guideOpen }}
              onPress={() => setGuideOpen((o) => !o)}
              className="flex-row items-center px-4 py-3.5 active:opacity-70"
            >
              <Feather name="book-open" size={17} color={ui.tint.good.ink} />
              <Text className="flex-1 pl-3 text-base font-semibold text-ink">{i18nT('captain-guide.title')}</Text>
              <Feather name={guideOpen ? 'chevron-down' : 'chevron-right'} size={16} color={ui.faint} />
            </Pressable>
            {guideOpen ? (
              <View className="border-t border-line px-4 pb-4 pt-3">
                <Text className="text-sm leading-5 text-muted">{i18nT('captain-guide.lede')}</Text>
                {GUIDE.map((sec) => (
                  <View key={sec.h} className={`pt-4 ${sec.safety ? 'border-l-4 border-hawk-gold pl-3' : ''}`}>
                    <Text className="pb-1.5 text-sm font-bold text-ink">{i18nT(sec.h)}</Text>
                    {sec.items.map((k, i) => (
                      <View key={k} className="flex-row py-1">
                        <Text className="w-5 text-sm text-muted">{sec.ordered ? `${i + 1}.` : '•'}</Text>
                        <Text className="flex-1 text-sm leading-5 text-ink">{i18nT(k)}</Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          {loading ? (
            <ActivityIndicator className="pt-8" color={ui.tint.good.ink} />
          ) : loadErr ? (
            <View className="mt-4 rounded-2xl bg-card p-4">
              <Text className="text-sm text-bad-ink">{errText(loadErr)}</Text>
              <Pressable
                onPress={() => (loadErr === 'signed_out' ? router.push('/sign-in') : retry())}
                className="mt-3 items-center self-start rounded-xl border border-line bg-surface px-4 py-2.5 active:opacity-70"
              >
                <Text className="text-sm font-semibold text-ink">
                  {loadErr === 'signed_out' ? i18nT('captain.sign-in') : i18nT('n.app._layout.try-again')}
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              {notice ? (
                <Text className={`pt-4 text-sm font-semibold ${notice.ok ? 'text-good-ink' : 'text-bad-ink'}`}>
                  {notice.ok ? i18nT('captain.sent') : errText(notice.code ?? 'failed')}
                </Text>
              ) : null}

              {app ? (
                <View className="mt-4 rounded-2xl bg-card p-4">
                  <Text className="text-base font-bold text-ink">{i18nT('captain.your-application')}</Text>
                  <View className="flex-row pt-2">
                    <Text
                      className={`overflow-hidden rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider ${badge(app.status)}`}
                    >
                      {i18nT(`captain.status.${app.status}`)}
                    </Text>
                  </View>
                  <Text className="pt-2 text-sm text-ink">
                    <Text className="font-bold">{app.ward}</Text>, {app.lga}, {app.state}
                  </Text>
                  <Text className="pt-1 text-xs text-muted">
                    {i18nT('captain.applied-on', { date: dayMonthYear(new Date(app.createdAt)) })}
                  </Text>
                  <Text className="pt-2 text-sm leading-5 text-ink">{i18nT(`captain.status-line.${app.status}`)}</Text>
                  <View className="flex-row flex-wrap pt-3">
                    {app.status === 'approved' ? (
                      <Pressable
                        onPress={() => {
                          setGuideOpen(true);
                          scroller.current?.scrollTo({ y: 0, animated: true });
                        }}
                        className="mb-2 mr-2 rounded-xl bg-hawk-green px-4 py-2.5 active:opacity-80"
                      >
                        <Text className="text-sm font-bold text-hawk-gold">{i18nT('captain.read-guide')}</Text>
                      </Pressable>
                    ) : null}
                    {/* Replies arrive as alerts, so the feed is one tap away. */}
                    {app.status !== 'declined' ? (
                      <Pressable
                        onPress={() => router.navigate('/(tabs)/alerts' as never)}
                        className="mb-2 mr-2 rounded-xl border border-line bg-surface px-4 py-2.5 active:opacity-70"
                      >
                        <Text className="text-sm font-semibold text-ink">{i18nT('captain.open-alerts')}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {canApply ? (
                <View className="mt-4 rounded-2xl bg-card p-4">
                  <Text className="pb-2 text-base font-bold text-ink">{i18nT('captain.your-ward')}</Text>
                  {!stateSel ? (
                    <>
                      <Prompt>{i18nT('n.app.map-unit.select-the-state')}</Prompt>
                      <View className="flex-row flex-wrap">
                        {states.map((s) => <Chip key={s} label={s} onPress={() => pickState(s)} />)}
                      </View>
                    </>
                  ) : !lgaSel ? (
                    <>
                      <Crumb label={stateSel} onPress={() => pickState(null)} />
                      <Prompt>{i18nT('n.app.map-unit.select-the-lga')}</Prompt>
                      <View className="flex-row flex-wrap">
                        {lgas.map((l) => <Chip key={l} label={l} onPress={() => pickLga(l)} />)}
                      </View>
                    </>
                  ) : !wardSel ? (
                    <>
                      <Crumb label={`${stateSel} · ${lgaSel}`} onPress={() => pickLga(null)} />
                      <Prompt>{i18nT('n.app.map-unit.select-the-ward')}</Prompt>
                      <View className="flex-row flex-wrap">
                        {wards.map((w) => <Chip key={w} label={w} onPress={() => setWardSel(w)} />)}
                      </View>
                    </>
                  ) : (
                    <Crumb label={`${wardSel} · ${lgaSel} · ${stateSel}`} onPress={() => setWardSel(null)} />
                  )}
                  {regErr ? <Text className="pt-1 text-xs text-bad-ink">{i18nT('captain.err.register')}</Text> : null}

                  <Text className="pb-1 pt-5 text-base font-bold text-ink">{i18nT('captain.about-you')}</Text>
                  <Label>
                    {i18nT('captain.organisation')} <Text className="font-normal text-muted">{i18nT('captain.optional')}</Text>
                  </Label>
                  <TextInput
                    value={org}
                    onChangeText={setOrg}
                    maxLength={MAX_ORG}
                    autoComplete="organization"
                    className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink"
                  />
                  <Text className="pt-1 text-xs text-muted">{i18nT('captain.organisation-hint')}</Text>

                  <Label>{i18nT('captain.note')}</Label>
                  <TextInput
                    value={note}
                    onChangeText={setNote}
                    maxLength={MAX_NOTE}
                    multiline
                    textAlignVertical="top"
                    style={{ minHeight: 96 }}
                    className="rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink"
                  />
                  <Text className="pt-1 text-xs text-muted">{i18nT('captain.note-hint')}</Text>

                  <Label>{i18nT('captain.volunteers')}</Label>
                  <TextInput
                    value={volunteers}
                    onChangeText={(v) => setVolunteers(v.replace(/[^0-9]/g, '').slice(0, 3))}
                    keyboardType="number-pad"
                    maxLength={3}
                    className="w-28 rounded-xl border border-line bg-surface px-3 py-3 text-sm text-ink"
                  />

                  <Text className="pb-1 pt-5 text-base font-bold text-ink">{i18nT('captain.contact-h')}</Text>
                  {/* In-app only: no name and no phone are asked for or stored. */}
                  <Text className="text-xs leading-5 text-muted">{i18nT('captain.contact')}</Text>

                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: consent }}
                    onPress={() => setConsent((c) => !c)}
                    className="mt-4 flex-row items-start active:opacity-70"
                  >
                    <Feather
                      name={consent ? 'check-square' : 'square'}
                      size={22}
                      color={consent ? ui.tint.good.ink : ui.muted}
                    />
                    <Text className="flex-1 pl-3 text-sm leading-5 text-ink">{i18nT('captain.consent')}</Text>
                  </Pressable>
                  <Text className="pt-2 text-xs text-muted">{i18nT('captain.privacy')}</Text>

                  <Pressable
                    disabled={sending}
                    onPress={submit}
                    accessibilityRole="button"
                    className={`mt-4 flex-row items-center justify-center rounded-2xl py-4 active:opacity-80 ${
                      sending ? 'bg-disabled' : 'bg-hawk-green'
                    }`}
                  >
                    {sending ? <ActivityIndicator color="#fff" style={{ marginRight: 8 }} /> : null}
                    <Text className={`text-base font-bold ${sending ? 'text-white' : 'text-hawk-gold'}`}>
                      {i18nT('captain.submit')}
                    </Text>
                  </Pressable>
                  {formMsg ? (
                    <Text className={`pt-2 text-sm ${formMsg.ok ? 'text-good-ink' : 'text-bad-ink'}`}>
                      {formMsg.ok ? i18nT('captain.sent') : errText(formMsg.code ?? 'failed')}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </>
          )}

          <Text className="pt-5 text-xs leading-5 text-muted">{i18nT('captain.no-access-note')}</Text>
        </Animated.ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

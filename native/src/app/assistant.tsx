import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { HEADER_CONTENT_H } from '@/hooks/use-hide-on-scroll';
import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

const BASE = 'https://hawkeye.com.ng';

/** The server slices the question at 500 chars (services/assistant.js); say so here. */
const MAX_Q = 500;

const GREETING =
  'Ask me about the crowd-reported results — a national tally, a polling unit, or how much of the country is mapped.';

/**
 * Tapping one FILLS the box instead of sending. The send button is pinned in the
 * footer, and it stays the only thing that fires a question — a chip that asked
 * on tap would put the screen's primary action back inside the scroll. It also
 * lets someone swap "presidential" for the race they actually care about.
 */
const SUGGESTIONS = [
  'What is the presidential tally so far?',
  'How much of Nigeria is mapped?',
  'Which states still have no reports?',
];

type Turn = { id: number; q: string; a: string | null };

/**
 * Ask Hawkeye — native twin of the web's floating assistant (app/menu.js).
 *
 * Read-only and non-partisan: the backend answers only from four public lookups
 * (national tally, coverage, one polling unit, coverage gaps) and is instructed
 * never to declare a winner. It writes nothing, so this screen sends no token
 * and no device id.
 *
 * Signed-out access matches the web. The endpoint has never required an account;
 * the web only hides the bubble in places where a floating widget is wrong (the
 * landing fold, the auth form), which is a placement rule, not an access rule.
 */
export default function Assistant() {
  const ui = useUi();
  const insets = useSafeAreaInsets();
  // A chat auto-scrolls to the newest turn, so a scroll-hiding header would
  // vanish on the first answer and never come back — this one stays put. It is
  // absolutely positioned, so the thread pads its top by headerH to clear it.
  const headerH = insets.top + HEADER_CONTENT_H;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // null = not answered yet. The composer must work before the health check
  // lands, so an unknown state is treated as available and a real ask reports
  // its own failure.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failedId, setFailedId] = useState<number | null>(null);

  const scroller = useRef<ScrollView>(null);
  const nextId = useRef(1);

  // The assistant is off wherever no provider key is configured, and the server
  // says so plainly. Ask once so the screen can offer an honest closed state
  // instead of a composer that can only ever fail.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/assistant/health`, {
          headers: { accept: 'application/json' },
        });
        const h = (await r.json()) as { enabled?: boolean };
        if (live) setEnabled(Boolean(h?.enabled));
      } catch {
        if (live) setEnabled(null);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /**
   * One shot, no streaming: POST /api/assistant returns the finished answer in a
   * single JSON body (it may run several tool round-trips server-side first), so
   * there is no token stream to render — the waiting state is the whole story.
   *
   * `retryId` re-runs an existing turn rather than appending a duplicate of the
   * question the user can still see above.
   */
  const ask = async (question: string, retryId?: number) => {
    const text = question.trim();
    if (!text || busy) return;

    const id = retryId ?? nextId.current++;
    if (retryId === undefined) setTurns((t) => [...t, { id, q: text, a: null }]);
    setQ('');
    setErr(null);
    setFailedId(null);
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      // The route answers 200 with {answer} or {error} on purpose — an origin 5xx
      // gets replaced by Cloudflare's HTML error page, so a non-JSON body here
      // means the edge answered, not the app.
      const j = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
      if (j.answer) {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, a: j.answer! } : x)));
        return;
      }
      setFailedId(id);
      setErr(
        j.error === 'assistant_unconfigured'
          ? "The assistant isn't switched on yet. (assistant_unconfigured / HTTP " + res.status + ')'
          : `Could not answer that. (${j.error ?? 'no_answer'} / HTTP ${res.status})`,
      );
    } catch (e) {
      setFailedId(id);
      setErr(`Could not reach the assistant. (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  const failed = turns.find((t) => t.id === failedId) ?? null;
  const canSend = !busy && (q.trim().length > 0 || failed !== null);
  const off = enabled === false;

  return (
    <View className="flex-1 bg-surface">
      <ScreenHeader title="Ask Hawkeye" onClose={() => router.back()} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        className="flex-1"
      >
        <ScrollView
          ref={scroller}
          contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        >
          <View className="mb-2 max-w-[88%] self-start rounded-2xl rounded-bl-md bg-card px-4 py-3">
            <Text className="text-sm text-ink">{GREETING}</Text>
          </View>

          {/* An assistant bubble that happens to carry bad news, so it is still
              a bubble: bg-warn darkens with the theme and text-ink reads on it.
              bg-amber-50 stayed pale while --ink went near-white on top of it. */}
          {off ? (
            <View className="mb-2 max-w-[88%] self-start rounded-2xl rounded-bl-md bg-warn px-4 py-3">
              <Text className="text-sm text-ink">
                The assistant isn&apos;t switched on yet. The results, docket and coverage screens
                carry the same figures it would read from.
              </Text>
            </View>
          ) : null}

          {turns.length === 0 && !off ? (
            <View className="pt-1">
              <Text className="pb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Try asking
              </Text>
              {SUGGESTIONS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setQ(s)}
                  className="mb-2 flex-row items-center rounded-2xl bg-card px-4 py-3 active:opacity-80"
                >
                  <Feather name="message-circle" size={14} color={ui.tint.good.ink} />
                  <Text className="flex-1 pl-2.5 text-sm text-ink">{s}</Text>
                  <Feather name="arrow-up-right" size={14} color={ui.faint} />
                </Pressable>
              ))}
            </View>
          ) : null}

          {turns.map((t) => (
            <View key={t.id}>
              {/* THE KEYLINE IS LOAD-BEARING, not decoration.
                  bg-hawk-green is a fixed brand surface, so text-white on it is
                  11.6:1 in both themes and the words were never the problem. What
                  broke in dark mode is which bubble is WHOSE: the assistant's
                  bg-card is #12241b and this fill is #004225 — 1.40:1 apart, and
                  1.62:1 against the surface behind them. Two dark-green rectangles
                  in a column, with only the alignment left to say who spoke.
                  good-ink at 50% over the green gives the edge 4.66:1 on the dark
                  surface and 4.03:1 against the assistant bubble, and in light mode
                  resolves to #0b6b3a over #004225 — a quiet rim, because there the
                  fill already separates on its own (10.2:1 / 11.6:1). */}
              <View className="mb-2 max-w-[88%] self-end rounded-2xl rounded-br-md border border-good-ink/50 bg-hawk-green px-4 py-3">
                <Text className="text-sm text-white">{t.q}</Text>
              </View>
              {t.a ? (
                <View className="mb-2 max-w-[88%] self-start rounded-2xl rounded-bl-md bg-card px-4 py-3">
                  <Text className="text-sm leading-5 text-ink">{t.a}</Text>
                </View>
              ) : busy && t.id === turns[turns.length - 1]?.id ? (
                <View className="mb-2 flex-row items-center self-start rounded-2xl rounded-bl-md bg-card px-4 py-3">
                  <ActivityIndicator size="small" color={ui.tint.good.ink} />
                  <Text className="pl-2 text-sm text-muted">Reading the reports…</Text>
                </View>
              ) : (
                // No pretend answer bubble for a failure: the named reason and the
                // retry both live in the footer, where they can't scroll away.
                <View className="mb-2 self-start rounded-2xl rounded-bl-md bg-surface px-4 py-2">
                  <Text className="text-xs font-semibold text-muted">Unanswered</Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>

        {/* Sibling of the thread, inside the keyboard avoider: a chat grows without
            limit, so the composer is the one thing that must never scroll — and
            the failure line rides with it so a retry never drifts off-screen. */}
        <View
          className="border-t border-line bg-surface px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          {err ? <Text className="pb-2 text-sm font-semibold text-warn-ink">{err}</Text> : null}

          <View className="flex-row items-end">
            <TextInput
              className="mr-2 max-h-28 flex-1 rounded-2xl bg-card px-4 py-3 text-base text-ink"
              placeholder={off ? 'The assistant is switched off' : 'Ask about the results…'}
              placeholderTextColor={ui.faint}
              editable={!off}
              multiline
              maxLength={MAX_Q}
              value={q}
              onChangeText={setQ}
              onSubmitEditing={() => ask(q)}
              blurOnSubmit={false}
              returnKeyType="send"
            />
            <Pressable
              disabled={!canSend || off}
              onPress={() => (q.trim() ? ask(q) : failed ? ask(failed.q, failed.id) : undefined)}
              className={`h-12 items-center justify-center rounded-2xl px-5 ${
                canSend && !off ? 'bg-hawk-green active:opacity-80' : 'bg-disabled'
              }`}
            >
              {busy ? (
                <ActivityIndicator color={BRAND.gold} />
              ) : (
                <Text className="text-base font-bold text-hawk-gold">
                  {!q.trim() && failed ? 'Retry' : 'Ask'}
                </Text>
              )}
            </Pressable>
          </View>

          {/* Removed: the disclaimer bar states the unofficial/INEC point once,
              app-wide. Repeating it under every answer was noise. */}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

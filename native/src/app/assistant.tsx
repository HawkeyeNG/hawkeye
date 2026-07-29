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
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';

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
    <SafeAreaView className="flex-1 bg-hawk-mist">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-white"
        >
          <Feather name="x" size={18} color={BRAND.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Ask Hawkeye</Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <ScrollView
          ref={scroller}
          contentContainerClassName="px-4 pb-4 pt-3"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        >
          <View className="mb-2 max-w-[88%] self-start rounded-2xl rounded-bl-md bg-white px-4 py-3">
            <Text className="text-sm text-hawk-ink">{GREETING}</Text>
          </View>

          {off ? (
            <View className="mb-2 max-w-[88%] self-start rounded-2xl rounded-bl-md bg-amber-50 px-4 py-3">
              <Text className="text-sm text-amber-900">
                The assistant isn&apos;t switched on yet. The results, docket and coverage screens
                carry the same figures it would read from.
              </Text>
            </View>
          ) : null}

          {turns.length === 0 && !off ? (
            <View className="pt-1">
              <Text className="pb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Try asking
              </Text>
              {SUGGESTIONS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setQ(s)}
                  className="mb-2 flex-row items-center rounded-2xl bg-white px-4 py-3 active:opacity-80"
                >
                  <Feather name="message-circle" size={14} color={BRAND.leaf} />
                  <Text className="flex-1 pl-2.5 text-sm text-hawk-ink">{s}</Text>
                  <Feather name="arrow-up-right" size={14} color="#9db5a7" />
                </Pressable>
              ))}
            </View>
          ) : null}

          {turns.map((t) => (
            <View key={t.id}>
              <View className="mb-2 max-w-[88%] self-end rounded-2xl rounded-br-md bg-hawk-green px-4 py-3">
                <Text className="text-sm text-white">{t.q}</Text>
              </View>
              {t.a ? (
                <View className="mb-2 max-w-[88%] self-start rounded-2xl rounded-bl-md bg-white px-4 py-3">
                  <Text className="text-sm leading-5 text-hawk-ink">{t.a}</Text>
                </View>
              ) : busy && t.id === turns[turns.length - 1]?.id ? (
                <View className="mb-2 flex-row items-center self-start rounded-2xl rounded-bl-md bg-white px-4 py-3">
                  <ActivityIndicator size="small" color={BRAND.leaf} />
                  <Text className="pl-2 text-sm text-neutral-500">Reading the reports…</Text>
                </View>
              ) : (
                // No pretend answer bubble for a failure: the named reason and the
                // retry both live in the footer, where they can't scroll away.
                <View className="mb-2 self-start rounded-2xl rounded-bl-md bg-hawk-mist px-4 py-2">
                  <Text className="text-xs font-semibold text-neutral-500">Unanswered</Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>

        {/* Sibling of the thread, inside the keyboard avoider: a chat grows without
            limit, so the composer is the one thing that must never scroll — and
            the failure line rides with it so a retry never drifts off-screen. */}
        <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
          {err ? <Text className="pb-2 text-sm font-semibold text-amber-800">{err}</Text> : null}

          <View className="flex-row items-end">
            <TextInput
              className="mr-2 max-h-28 flex-1 rounded-2xl bg-white px-4 py-3 text-base text-hawk-ink"
              placeholder={off ? 'The assistant is switched off' : 'Ask about the results…'}
              placeholderTextColor="#9db5a7"
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
                canSend && !off ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'
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

          <Text className="pt-2 text-xs text-neutral-500">
            Answers come only from crowd-reported, unofficial figures. INEC declares official
            results.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

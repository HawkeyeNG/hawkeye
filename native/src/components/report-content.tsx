import { Feather } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';

const BASE = 'https://hawkeye.com.ng';

/** Reason codes the server accepts (FLAG_REASONS in routes/incidents.js). */
const REASONS: { key: 'abuse' | 'false' | 'privacy' | 'other'; label: string }[] = [
  { key: 'abuse', label: 'Abusive or harmful' },
  { key: 'false', label: 'False or misleading' },
  { key: 'privacy', label: 'Privacy violation' },
  { key: 'other', label: 'Something else' },
];

/**
 * "Report this content" — required of any app that publishes user content
 * (App Store 1.2, Play's UGC policy), and the native twin of the flag button
 * on incidents.html. Reports land in the same content_flags queue a moderator
 * works through.
 *
 * Deliberately available signed-out: the person harmed by a published photo is
 * often not an observer, and making them register first would defeat it.
 */
export function ReportContent({
  kind,
  targetId,
  label = 'Report this content',
}: {
  kind: 'incident' | 'result';
  targetId: number;
  label?: string;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    if (!reason) return;
    setBusy(true);
    setMsg(null);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const res = await fetch(`${BASE}/api/flags`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ kind, targetId, reason, detail: detail.slice(0, 500) }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(`Could not send the report. (${b.error ?? 'error'} / HTTP ${res.status})`);
        return;
      }
      setSent(true);
      setOpen(false);
    } catch (e) {
      setMsg(`Could not send the report. (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        disabled={sent}
        className="flex-row items-center pt-2 active:opacity-70"
        onPress={() => setOpen(true)}
      >
        <Feather name={sent ? 'check' : 'flag'} size={13} color={sent ? BRAND.leaf : '#9db5a7'} />
        <Text className={`pl-1.5 text-xs ${sent ? 'font-bold text-hawk-leaf' : 'text-faint'}`}>
          {sent ? 'Reported — our team will review' : label}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          className="flex-1 justify-end bg-black/40"
        >
          <View className="rounded-t-3xl bg-surface px-5 pb-8 pt-5">
            <View className="flex-row items-center pb-3">
              <Text className="flex-1 text-lg font-bold text-ink">Report this content</Text>
              <Pressable
                hitSlop={12}
                onPress={() => setOpen(false)}
                className="h-8 w-8 items-center justify-center rounded-full bg-card"
              >
                <Feather name="x" size={16} color={ui.ink} />
              </Pressable>
            </View>
            <Text className="pb-3 text-sm text-muted">
              Tell us what is wrong with it. A moderator reviews every report.
            </Text>

            {REASONS.map((r) => (
              <Pressable
                key={r.key}
                onPress={() => setReason(r.key)}
                className={`mb-2 flex-row items-center rounded-2xl px-4 py-3 ${
                  reason === r.key ? 'bg-hawk-green' : 'bg-card'
                }`}
              >
                <Feather
                  name={reason === r.key ? 'check-circle' : 'circle'}
                  size={16}
                  color={reason === r.key ? BRAND.gold : '#9db5a7'}
                />
                <Text
                  className={`pl-3 text-base ${
                    reason === r.key ? 'font-bold text-hawk-gold' : 'text-ink'
                  }`}
                >
                  {r.label}
                </Text>
              </Pressable>
            ))}

            <TextInput
              value={detail}
              onChangeText={setDetail}
              multiline
              maxLength={500}
              placeholder="Add any detail (optional)"
              placeholderTextColor="#9ca3af"
              className="min-h-[64px] rounded-2xl bg-card px-4 py-3 text-sm text-ink"
            />
            {msg ? (
              <Text className="pt-2 text-sm font-semibold text-amber-800">{msg}</Text>
            ) : null}

            <Pressable
              disabled={!reason || busy}
              onPress={send}
              className={`mt-3 items-center rounded-2xl py-3.5 ${
                !reason || busy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'
              }`}
            >
              {busy ? (
                <ActivityIndicator color={BRAND.gold} />
              ) : (
                <Text className="text-base font-bold text-hawk-gold">Send report</Text>
              )}
            </Pressable>
            <Pressable
              className="mt-2 items-center rounded-2xl bg-card py-3.5 active:opacity-70"
              onPress={() => setOpen(false)}
            >
              <Text className="text-base font-semibold text-muted">Cancel</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

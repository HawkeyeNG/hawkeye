import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReportContent } from '@/components/report-content';
import { StatusChip, TallyBar, type Tally } from '@/components/tally';
import { BRAND } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';

const BASE = 'https://hawkeye.com.ng';

type Flag = {
  id: number;
  type: string;
  severity: string;
  detail: { summary?: string; reason?: string };
};

type Submission = {
  id: number;
  votes: { party: string; count: number }[];
  sheetUrl: string;
  venueUrl: string;
  capturedAt: number;
  locationVerified: boolean;
  ocr: { matched: number; total: number } | null;
  vision: { counts?: { party: string; count: number }[] } | null;
  entryHash: string;
};

type CaseFile = {
  id: number;
  contest: string;
  status: string;
  closesAt: number;
  tally: Tally;
  rule: string;
  unit: {
    name: string;
    ward: string;
    lga: string;
    state: string;
    registeredVoters: number | null;
  };
  flags: Flag[];
  submissions: Submission[];
  verdicts?: { observer: number; verdict: string; comment: string | null; at: number }[];
  error?: string;
};

type Answer = 'yes' | 'no' | 'unsure';

/**
 * Case file — native twin of app/case.html, and the one screen in the trust
 * surfaces that WRITES.
 *
 * A juror never picks a side: they answer factual questions about evidence they
 * can see, and a published rule computes the verdict from those answers. That
 * separation is the whole design, so the UI keeps it visible.
 */
export default function CaseScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const auth = useAuth();
  const [c, setC] = useState<CaseFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<{ verdict: string | null } | null>(null);

  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/docket/${id}`, {
        headers: { accept: 'application/json' },
      });
      const d = (await res.json()) as CaseFile;
      setC(d);
      setErr(d.error ?? (res.ok ? null : `HTTP ${res.status}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // One verdict per person: ask the server whether this observer already judged
  // before offering the questionnaire at all.
  useEffect(() => {
    if (auth.status !== 'signedIn' || !id) return;
    (async () => {
      try {
        const token = await SecureStore.getItemAsync('hawkeye.auth.token');
        const r = await fetch(`${BASE}/api/docket/${id}/mine`, {
          headers: { authorization: `Bearer ${token}` },
        });
        setMine((await r.json()) as { verdict: string | null });
      } catch {
        setMine({ verdict: null });
      }
    })();
  }, [auth.status, id]);

  const cast = async () => {
    if (!c) return;
    const flags: Record<string, Answer | undefined> = {};
    for (const f of c.flags) flags[f.id] = answers[`flag_${f.id}`];
    if (!answers.sheet || !answers.counts || Object.values(flags).some((v) => !v)) {
      setMsg('Answer every question.');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const ident = await getIdentity();
      const res = await fetch(`${BASE}/api/docket/${c.id}/verdict`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': ident.deviceId,
        },
        body: JSON.stringify({
          sheet: answers.sheet,
          counts: answers.counts,
          flags,
          comment: comment.trim(),
        }),
      });
      const r = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        verdict?: string;
        tally?: Tally;
        error?: string;
      };
      if (r.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setMine({ verdict: r.verdict ?? 'recorded' });
        setC({ ...c, tally: r.tally ?? c.tally });
        setMsg(`Recorded — computed verdict: ${r.verdict}.`);
      } else {
        setMsg(
          r.error === 'already_judged'
            ? 'You already judged this case.'
            : `Could not record. (${r.error ?? 'error'} / HTTP ${res.status})`,
        );
      }
    } catch (e) {
      setMsg(`Could not record. (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  if (err || (c && c.error)) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <Feather name="file-text" size={26} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
          Case not found
        </Text>
        <Text className="pt-1 text-center text-sm text-neutral-600">
          This case doesn&apos;t exist, or the link is out of date. ({c?.error ?? err})
        </Text>
        <Pressable
          className="mt-5 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
          onPress={() => router.back()}
        >
          <Text className="text-base font-bold text-hawk-gold">All cases</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!c) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist">
        <ActivityIndicator color={BRAND.leaf} />
      </SafeAreaView>
    );
  }

  const Radio = ({ name, label }: { name: string; label: string }) => (
    <View className="flex-row pt-1.5">
      {(['yes', 'no', 'unsure'] as Answer[]).map((v) => {
        const on = answers[name] === v;
        return (
          <Pressable
            key={v}
            onPress={() => setAnswers((a) => ({ ...a, [name]: v }))}
            className={`mr-2 rounded-full px-4 py-2 ${on ? 'bg-hawk-green' : 'bg-hawk-mist'}`}
            accessibilityLabel={`${label}: ${v}`}
          >
            <Text className={`text-xs font-bold ${on ? 'text-hawk-gold' : 'text-neutral-600'}`}>
              {v === 'unsure' ? "Can't tell" : v === 'yes' ? 'Yes' : 'No'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  const Question = ({ name, text }: { name: string; text: string }) => (
    <View className="pt-3">
      <Text className="text-sm text-hawk-ink">{text}</Text>
      <Radio name={name} label={text} />
    </View>
  );

  const noted = (c.verdicts ?? []).filter((v) => v.comment);

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-white"
        >
          <Feather name="arrow-left" size={18} color={BRAND.ink} />
        </Pressable>
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Case #{c.id}</Text>
        <View className="ml-2">
          <StatusChip status={c.status} />
        </View>
      </View>

      <ScrollView contentContainerClassName="px-4 pb-10 pt-3">
        <Text className="text-xl font-bold text-hawk-ink">{c.unit.name}</Text>
        <Text className="pt-1 text-xs text-neutral-500">
          {c.contest} · {c.unit.ward} ward, {c.unit.lga}, {c.unit.state}
          {c.unit.registeredVoters
            ? ` · ${c.unit.registeredVoters.toLocaleString()} registered voters`
            : ''}{' '}
          · {c.status === 'open' ? `closes ${new Date(c.closesAt).toLocaleString()}` : 'resolved'}
        </Text>

        {c.flags.map((f) => (
          <View key={f.id} className="mt-3 rounded-2xl bg-amber-50 px-4 py-3">
            <Text className="text-sm font-bold text-amber-900">{f.type}</Text>
            <Text className="pt-0.5 text-sm text-neutral-700">{f.detail.summary ?? ''}</Text>
            {f.detail.reason ? (
              <Text className="pt-1 text-xs text-neutral-500">{f.detail.reason}</Text>
            ) : null}
          </View>
        ))}

        <Text className="pb-1 pt-5 text-base font-bold text-hawk-ink">Evidence</Text>
        {c.submissions.map((s) => (
          <View key={s.id} className="mb-3 rounded-2xl bg-white px-4 py-3">
            <Text className="text-sm font-bold text-hawk-ink">
              Report #{s.id} · {new Date(s.capturedAt).toLocaleString()}
            </Text>
            <Text className="pt-0.5 text-xs text-neutral-500">
              location {s.locationVerified ? 'verified ✅' : 'unverified'}
            </Text>
            <View className="flex-row pt-2">
              {[
                { url: s.sheetUrl, cap: 'Result sheet' },
                { url: s.venueUrl, cap: 'Surroundings' },
              ].map((img) => (
                <Pressable
                  key={img.cap}
                  className="mr-2 flex-1"
                  onPress={() => WebBrowser.openBrowserAsync(`${BASE}${img.url}`)}
                >
                  <Image
                    source={{ uri: `${BASE}${img.url}` }}
                    className="h-32 w-full rounded-xl bg-hawk-mist"
                    resizeMode="cover"
                  />
                  <Text className="pt-1 text-[11px] text-neutral-500">{img.cap} — tap for full size</Text>
                </Pressable>
              ))}
            </View>

            <View className="pt-2">
              {s.votes.filter((v) => v.count > 0).length ? (
                s.votes
                  .filter((v) => v.count > 0)
                  .map((v) => (
                    <View key={v.party} className="flex-row justify-between py-0.5">
                      <Text className="text-sm text-neutral-700">{v.party}</Text>
                      <Text className="text-sm font-semibold text-hawk-ink">
                        {v.count.toLocaleString()}
                      </Text>
                    </View>
                  ))
              ) : (
                <Text className="text-sm text-neutral-500">all zeros</Text>
              )}
            </View>

            {s.vision?.counts ? (
              <Text className="pt-1.5 text-xs text-neutral-500">
                AI read-back from the sheet:{' '}
                {s.vision.counts.map((x) => `${x.party} ${x.count}`).join(', ')} (advisory)
              </Text>
            ) : null}
            {s.ocr ? (
              <Text className="pt-1 text-xs text-neutral-500">
                OCR: {s.ocr.matched}/{s.ocr.total} typed counts found on the sheet.
              </Text>
            ) : null}
            <Pressable className="pt-1.5" onPress={() => router.push('/ledger')}>
              <Text className="font-mono text-[10px] text-neutral-400">
                ledger entry {s.entryHash.slice(0, 32)}…
              </Text>
              <Text className="pt-0.5 text-xs font-bold text-hawk-leaf">
                Re-verify the whole chain →
              </Text>
            </Pressable>
            {/* Published observer photos are user content: App Store 1.2 and
                Play's UGC policy both require a way to object to them. */}
            <ReportContent kind="result" targetId={s.id} label="Report this evidence" />
          </View>
        ))}

        <Text className="pb-1 pt-3 text-base font-bold text-hawk-ink">The crowd&apos;s verdict</Text>
        <View className="rounded-2xl bg-white px-4 py-4">
          <TallyBar t={c.tally} />
          <Text className="pt-2 text-sm text-neutral-700">
            {c.tally.total} verdict(s): {c.tally.fraudulent} fraudulent · {c.tally.legit} legit ·{' '}
            {c.tally.inconclusive} inconclusive.
          </Text>

          {c.status !== 'open' ? (
            <Text className="pt-3 text-sm text-neutral-500">
              This case is closed. The record above is permanent.
            </Text>
          ) : auth.status !== 'signedIn' ? (
            <>
              <Text className="pt-3 text-sm text-neutral-600">
                Only verified observers can judge — one verdict per person, on the public record.
              </Text>
              <Pressable
                className="mt-3 items-center rounded-2xl bg-hawk-green py-3 active:opacity-80"
                onPress={() => router.push('/sign-in')}
              >
                <Text className="text-base font-bold text-hawk-gold">Become an observer</Text>
              </Pressable>
            </>
          ) : mine?.verdict ? (
            <Text className="pt-3 text-sm text-neutral-600">
              You judged this case: <Text className="font-bold">{mine.verdict}</Text>. One verdict
              per person.
            </Text>
          ) : (
            <>
              <Question
                name="sheet"
                text="1. Is the photographed sheet an official INEC EC8A result form?"
              />
              <Question
                name="counts"
                text="2. Do the figures written on the sheet match the reported counts above?"
              />
              {/* One question PER flag — each can be wrong (or right) in its own way. */}
              {c.flags.map((f, i) => (
                <Question
                  key={f.id}
                  name={`flag_${f.id}`}
                  text={`3${c.flags.length > 1 ? String.fromCharCode(97 + i) : ''}. This result was flagged: “${
                    f.detail.summary || f.type
                  }”. Looking at the evidence yourself, is that specific reason correct?`}
                />
              ))}

              <Text className="pt-4 text-sm text-hawk-ink">
                Optional note — what did you see? (public, max 280 chars)
              </Text>
              <View className="mt-1 rounded-xl bg-hawk-mist px-3 py-2">
                <TextInputBox value={comment} onChange={setComment} />
              </View>

              <Pressable
                disabled={busy}
                onPress={cast}
                className={`mt-3 items-center rounded-2xl py-3.5 ${
                  busy ? 'bg-neutral-300' : 'bg-hawk-green active:opacity-80'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color={BRAND.gold} />
                ) : (
                  <Text className="text-base font-bold text-hawk-gold">Cast my verdict</Text>
                )}
              </Pressable>
              <Text className="pt-2 text-xs text-neutral-500">
                Your answers compute the verdict by a published rule — you never pick a side
                directly. Notes are public but never counted.
              </Text>
            </>
          )}

          {msg ? (
            <Text className="pt-2 text-sm font-semibold text-hawk-leaf">{msg}</Text>
          ) : null}
        </View>

        {noted.length ? (
          <>
            <Text className="pb-1 pt-4 text-base font-bold text-hawk-ink">What jurors noted</Text>
            {noted.map((v, i) => (
              <View key={i} className="mb-2 rounded-2xl bg-white px-4 py-3">
                <Text className="text-sm italic text-neutral-700">“{v.comment}”</Text>
                <Text className="pt-1 text-xs text-neutral-500">
                  observer #{v.observer}, judged {v.verdict}, {new Date(v.at).toLocaleString()}
                </Text>
              </View>
            ))}
          </>
        ) : null}

        {c.rule ? (
          <Text className="pt-3 text-center text-xs text-neutral-400">
            Resolution rule: {c.rule}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function TextInputBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      multiline
      maxLength={280}
      placeholder="e.g. the INEC stamp is missing; figures column reads 108 not 180"
      placeholderTextColor="#9ca3af"
      className="min-h-[56px] text-sm text-hawk-ink"
    />
  );
}

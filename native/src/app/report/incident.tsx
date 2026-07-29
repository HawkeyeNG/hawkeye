import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useState } from 'react';
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

import { CaptureCamera, type Media } from '@/components/capture-camera';
import { Prompt } from '@/components/wizard';
import { BRAND } from '@/lib/api';
import { authedGet, useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';
import { getQuickFix } from '@/lib/location';
import { queueJob } from '@/lib/outbox';
import { filePart } from '@/lib/submit';

/** Kind codes from /api/incidents/kinds, with observer-facing labels. */
const KINDS: { code: string; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { code: 'violence', label: 'Violence', icon: 'alert-octagon' },
  { code: 'ballot_snatching', label: 'Ballot snatching', icon: 'box' },
  { code: 'vote_buying', label: 'Vote buying', icon: 'dollar-sign' },
  { code: 'intimidation', label: 'Intimidation', icon: 'user-x' },
  { code: 'bvas_failure', label: 'BVAS failure', icon: 'cpu' },
  { code: 'late_materials', label: 'Late materials', icon: 'clock' },
  { code: 'obstruction', label: 'Obstruction', icon: 'slash' },
  { code: 'other', label: 'Other', icon: 'more-horizontal' },
];

const MAX_MEDIA = 4;

/** The reporter's saved unit. `name` is nullable — the server LEFT JOINs the
 *  register, so a saved code that is no longer listed comes back bare. */
type MyUnit = { pu_code: string; name: string | null };

/** Report an incident — kind, evidence (photo/video), description, GPS. */
export default function ReportIncident() {
  const auth = useAuth();
  const [kind, setKind] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [camera, setCamera] = useState(false);
  const [useGps, setUseGps] = useState(true);
  const [unit, setUnit] = useState<MyUnit | null>(null);
  /** Tells "this observer saved no unit" apart from "we never got an answer". */
  const [unitKnown, setUnitKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; line: string; icon: 'check' | 'clock' } | null>(
    null,
  );

  const canSubmit = useMemo(
    () => !!kind && (description.trim().length > 0 || media.length > 0),
    [kind, description, media],
  );

  /**
   * The report has to carry the reporter's saved polling unit: the server reads
   * `puCode` off the form and derives the incident's state from it, so without
   * it the row lands with pu_code AND state null — watchers of that unit are
   * never alerted and the incident shows stateless on the public feed.
   *
   * Resolved on mount rather than at submit (where the PWA does it) because a
   * report queued offline still has to carry the code, and by the time the
   * outbox drains there is no screen left to ask from.
   */
  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    let live = true;
    authedGet<{ unit: MyUnit | null }>('/api/observers/my-unit')
      .then((r) => {
        if (!live) return;
        setUnit(r.unit ?? null);
        setUnitKnown(true);
      })
      .catch(() => {
        // Optional routing field — a lookup failure must never block reporting.
      });
    return () => {
      live = false;
    };
  }, [auth.status]);

  /**
   * Gallery/files picker — parity with the PWA's
   * <input type="file" accept="image/*,video/*" multiple>. Evidence often
   * already exists on the phone (filmed before opening Hawkeye, or received
   * from someone at the unit), so camera-only would lose real reports.
   *
   * Unlike result submissions, incidents carry NO photo-location coherence
   * requirement server-side — GPS is an optional stamp on the report itself —
   * so a library file is a legitimate source here. Result sheets stay
   * camera-only by design.
   */
  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setLine('Allow photo access to attach files from your device.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_MEDIA - media.length,
      quality: 0.7,
      videoMaxDuration: 90,
    });
    if (res.canceled) return;
    const picked: Media[] = res.assets.map((a) => ({
      uri: a.uri,
      capturedAt: Date.now(),
      lat: 0,
      lng: 0,
      type: a.type === 'video' ? 'video' : 'image',
    }));
    setMedia((arr) => [...arr, ...picked].slice(0, MAX_MEDIA));
  };

  const onSubmit = async () => {
    if (!kind) return;
    setBusy(true);
    setLine('Submitting…');
    try {
      const id = await getIdentity();
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      // GPS is optional for incidents — a bounded quick fix (≤8s), never a stall.
      // An urgent report must not wait on a satellite lock indoors. Skipped
      // outright when the stamp is switched off: someone reporting the people
      // standing next to them has a real reason not to pin themselves to a map.
      const fix = useGps ? await getQuickFix() : null;
      // Only re-asked when the mount lookup never landed, and bounded — an
      // optional routing field must not hold up the report that carries it.
      let puCode = unit?.pu_code ?? null;
      if (!unitKnown) {
        puCode = await Promise.race([
          authedGet<{ unit: MyUnit | null }>('/api/observers/my-unit').then(
            (r) => r.unit?.pu_code ?? null,
          ),
          new Promise<null>((r) => setTimeout(() => r(null), 4_000)),
        ]).catch(() => null);
      }

      // One description of the body, shared by the live POST and the queued
      // copy, so what the outbox eventually sends is what this attempt built.
      const fields: Record<string, string> = { kind };
      if (description.trim()) fields.description = description.trim().slice(0, 2000);
      if (fix) {
        fields.lat = String(fix.lat);
        fields.lng = String(fix.lng);
      }
      if (puCode) fields.puCode = puCode;
      const files = media.map((m, i) => ({
        field: 'media',
        uri: m.uri,
        name: m.type === 'video' ? `clip${i}.mp4` : `photo${i}.jpg`,
        type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
      }));

      // Fresh FormData PER ATTEMPT: on Android a body whose file parts were
      // already streamed by a failed attempt cannot be replayed — reusing it
      // makes the retry throw instantly and masks the original error.
      const buildForm = () => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        for (const f of files) form.append(f.field, filePart(f.uri, f.name, f.type));
        return form;
      };
      const post = () =>
        fetch('https://hawkeye.com.ng/api/incidents', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-device-id': id.deviceId },
          body: buildForm(),
        });
      // One silent retry: a reset connection on Nigerian mobile networks is a
      // transient, not a verdict. (Server-side dedupe is not a concern here —
      // a retried incident that DID land twice just shows twice in the queue.)
      let res: Response | null = null;
      try {
        res = await post();
      } catch {
        setLine('Connection dropped — retrying…');
        try {
          res = await post();
        } catch {
          res = null;
        }
      }
      if (!res) {
        // Both attempts threw, so nothing reached the server — hand the report
        // to the outbox instead of asking someone in the middle of an incident
        // to hold the screen open until the network returns. Queued ONLY on
        // this path: a request that came back with an HTTP answer WAS received,
        // and replaying it would file the same incident twice.
        try {
          await queueJob({
            kind: 'incident',
            body: fields,
            files,
            label: `Incident — ${KINDS.find((k) => k.code === kind)?.label ?? kind}`,
          });
        } catch (e) {
          setLine(
            `Upload failed and the report could not be saved for later — nothing was sent. (${e instanceof Error ? e.message : String(e)})`,
          );
          return;
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Saved to send later',
          icon: 'clock',
          line: 'No connection right now. Your report and its evidence are stored on this phone and go out on their own once you are back online — you can close the app.',
        });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: number; error?: string; hint?: string };
      if (res.ok && body.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone({
          title: 'Incident reported',
          icon: 'check',
          line: 'Your report is under review. If accepted, it appears on the public incident log — your identity stays your observer ID only.',
        });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        // Always name the failure: a code the user can read back beats a shrug.
        const code = body.error ?? `HTTP ${res.status}`;
        setLine(
          body.error === 'empty_report' ? 'Add a photo, video or a description.'
          : body.error === 'invalid_media' ? (body.hint ?? 'One file could not be processed — retake it.')
          : `${body.hint ?? 'Submission failed — try again.'} (${code})`,
        );
      }
    } catch (e) {
      // Getting here means the upload itself did NOT fail (that path queues) —
      // identity, the token read or the GPS/unit lookup threw. Name the
      // exception: "Network request failed" and a JS error are very different
      // diagnoses, and the generic line hid which one we had.
      const msg = e instanceof Error ? e.message : String(e);
      setLine(`Could not prepare the report — nothing was sent. (${msg})`);
    } finally {
      setBusy(false);
    }
  };

  if (auth.status !== 'signedIn') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <Feather name="lock" size={28} color={BRAND.leaf} />
        <Text className="pt-3 text-center text-base font-semibold text-hawk-ink">
          Sign in to report an incident
        </Text>
        <Pressable
          className="mt-4 rounded-2xl bg-hawk-green px-6 py-3"
          onPress={() => router.push('/sign-in')}
        >
          <Text className="text-base font-bold text-hawk-gold">Sign in</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={() => router.back()}>
          <Text className="text-sm text-neutral-500">Not now</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (camera) {
    return (
      <CaptureCamera
        title="Capture evidence"
        hint="Photo, or switch to video (up to 90s). Stay safe — distance first."
        allowVideo
        onCapture={(m) => {
          setMedia((arr) => [...arr, m].slice(0, MAX_MEDIA));
          setCamera(false);
        }}
        onCancel={() => setCamera(false)}
      />
    );
  }

  if (done) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
          {/* A tick on a queued report would claim a delivery that has not
              happened — the icon has to tell the two outcomes apart. */}
          <Feather name={done.icon} size={28} color={BRAND.gold} />
        </View>
        <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">{done.title}</Text>
        <Text className="pt-2 text-center text-sm text-neutral-600">{done.line}</Text>
        <Pressable
          className="mt-6 rounded-2xl bg-hawk-green px-8 py-3 active:opacity-80"
          onPress={() => router.back()}
        >
          <Text className="text-base font-bold text-hawk-gold">Done</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

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
        <Text className="pl-3 text-lg font-bold text-hawk-ink">Report an incident</Text>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <ScrollView contentContainerClassName="px-4 pb-4 pt-4" keyboardShouldPersistTaps="handled">
          <Prompt>Select what happened</Prompt>
          <View className="flex-row flex-wrap">
            {KINDS.map((k) => (
              <Pressable
                key={k.code}
                onPress={() => setKind(k.code)}
                className={`mb-2 mr-2 flex-row items-center rounded-full px-4 py-2 ${
                  kind === k.code ? 'bg-hawk-green' : 'bg-white'
                }`}
              >
                <Feather
                  name={k.icon}
                  size={13}
                  color={kind === k.code ? BRAND.gold : '#6b7f74'}
                />
                <Text
                  className={`pl-1.5 text-sm font-semibold ${
                    kind === k.code ? 'text-hawk-gold' : 'text-neutral-700'
                  }`}
                >
                  {k.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View className="pt-3">
            <Prompt>Add evidence, or describe it below</Prompt>
          </View>
          <View className="flex-row flex-wrap">
            {media.map((m, i) => (
              <View key={m.uri} className="mb-2 mr-2 overflow-hidden rounded-xl bg-white">
                <Image source={{ uri: m.uri }} style={{ width: 76, height: 76 }} contentFit="cover" />
                {m.type === 'video' ? (
                  <View className="absolute inset-0 items-center justify-center bg-black/30">
                    <Feather name="play" size={20} color="#fff" />
                  </View>
                ) : null}
                <Pressable
                  hitSlop={8}
                  className="absolute right-1 top-1 h-5 w-5 items-center justify-center rounded-full bg-black/60"
                  onPress={() => setMedia((arr) => arr.filter((_, j) => j !== i))}
                >
                  <Feather name="x" size={11} color="#fff" />
                </Pressable>
              </View>
            ))}
            {media.length < MAX_MEDIA ? (
              <>
                <Pressable
                  className="mb-2 mr-2 h-[76px] w-[76px] items-center justify-center rounded-xl border-2 border-dashed border-hawk-leaf bg-white"
                  onPress={() => setCamera(true)}
                >
                  <Feather name="camera" size={20} color={BRAND.leaf} />
                  <Text className="pt-1 text-[10px] font-semibold text-hawk-leaf">Camera</Text>
                </Pressable>
                <Pressable
                  className="mb-2 h-[76px] w-[76px] items-center justify-center rounded-xl border-2 border-dashed border-hawk-leaf bg-white"
                  onPress={pickFromLibrary}
                >
                  <Feather name="image" size={20} color={BRAND.leaf} />
                  <Text className="pt-1 text-[10px] font-semibold text-hawk-leaf">Upload</Text>
                </Pressable>
              </>
            ) : null}
          </View>

          <Text className="pb-2 pt-3 text-sm font-semibold text-neutral-500">Description</Text>
          <TextInput
            className="min-h-[110px] rounded-2xl bg-white px-4 py-3 text-base text-hawk-ink"
            placeholder="What did you witness? Where, when, who was involved…"
            placeholderTextColor="#9db5a7"
            multiline
            textAlignVertical="top"
            maxLength={2000}
            value={description}
            onChangeText={setDescription}
          />

          {/* Location is opt-OUT, matching the PWA's checked-by-default box. The
              stamp helps a reviewer place the report, but an observer standing
              among the people they are reporting has a real reason to withhold
              it, and that choice has to be on screen before they commit. */}
          <Pressable
            onPress={() => setUseGps((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: useGps }}
            className="mt-3 flex-row items-center rounded-2xl bg-white px-4 py-3 active:opacity-80"
          >
            <Feather
              name={useGps ? 'check-square' : 'square'}
              size={19}
              color={useGps ? BRAND.leaf : '#9db5a7'}
            />
            <View className="flex-1 pl-3">
              <Text className="text-sm font-semibold text-hawk-ink">
                Attach my current location
              </Text>
              <Text className="text-xs text-neutral-500">
                {useGps
                  ? 'Helps reviewers place the incident. Coordinates are never published.'
                  : 'No coordinates will be attached to this report.'}
              </Text>
            </View>
          </Pressable>

          {unit ? (
            <Text className="pt-2 text-xs text-neutral-500">
              Filed under {unit.name ?? unit.pu_code} ({unit.pu_code}) — your saved polling unit.
              Watchers there are alerted once a reviewer approves it.
            </Text>
          ) : null}

          <Text className="pt-3 text-xs text-neutral-500">
            Your safety first: never confront anyone to get footage. Reports are reviewed
            before publication; your phone number is never attached.
          </Text>

        </ScrollView>

        {/* Pinned below the scroll: the kind grid, evidence thumbnails and the
            description box all grow above it, so the one committing action would
            otherwise sit off-screen — and an incident is filed one-handed, under
            time pressure. The status line rides in the footer too, so a failed
            attempt doesn't push the retry button further away. */}
        <View className="border-t border-black/5 bg-hawk-mist px-4 pb-6 pt-3">
          {line ? <Text className="pb-2 text-sm font-semibold text-amber-800">{line}</Text> : null}
          <Pressable
            disabled={!canSubmit || busy}
            onPress={onSubmit}
            className={`items-center rounded-2xl py-4 ${
              canSubmit && !busy ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'
            }`}
          >
            {busy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <Text className="text-base font-bold text-hawk-gold">Submit incident report</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useMemo, useState } from 'react';
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
import { BRAND } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getIdentity } from '@/lib/identity';

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

/** Report an incident — kind, evidence (photo/video), description, GPS. */
export default function ReportIncident() {
  const auth = useAuth();
  const [kind, setKind] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [media, setMedia] = useState<Media[]>([]);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<number | null>(null);

  const canSubmit = useMemo(
    () => !!kind && (description.trim().length > 0 || media.length > 0),
    [kind, description, media],
  );

  const onSubmit = async () => {
    if (!kind) return;
    setBusy(true);
    setLine('Submitting…');
    try {
      const id = await getIdentity();
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const form = new FormData();
      form.append('kind', kind);
      if (description.trim()) form.append('description', description.trim().slice(0, 2000));
      // GPS is optional for incidents — attach it when permitted, silently skip otherwise.
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.granted) {
          const fix = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          form.append('lat', String(fix.coords.latitude));
          form.append('lng', String(fix.coords.longitude));
        }
      } catch {
        /* no fix — still a valid report */
      }
      media.forEach((m, i) =>
        form.append(
          'media',
          {
            uri: m.uri,
            name: m.type === 'video' ? `clip${i}.mp4` : `photo${i}.jpg`,
            type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
          } as unknown as Blob,
        ),
      );
      const res = await fetch('https://hawkeye.com.ng/api/incidents', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-device-id': id.deviceId },
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: number; error?: string; hint?: string };
      if (res.ok && body.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDoneId(body.id ?? 0);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setLine(
          body.error === 'empty_report' ? 'Add a photo, video or a description.'
          : body.error === 'invalid_media' ? (body.hint ?? 'One file could not be processed — retake it.')
          : body.hint ?? 'Submission failed — try again.',
        );
      }
    } catch {
      // A thrown fetch mid-upload is usually a reset connection: weak network,
      // or a file past the server's 30MB cap (why video is capped at 720p/25MB).
      setLine('Upload failed — nothing was sent. On weak network, try fewer or shorter clips.');
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
        hint="Photo, or switch to video (up to 30s). Stay safe — distance first."
        allowVideo
        onCapture={(m) => {
          setMedia((arr) => [...arr, m].slice(0, MAX_MEDIA));
          setCamera(false);
        }}
        onCancel={() => setCamera(false)}
      />
    );
  }

  if (doneId !== null) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-hawk-mist px-8">
        <View className="h-16 w-16 items-center justify-center rounded-full bg-hawk-green">
          <Feather name="check" size={28} color={BRAND.gold} />
        </View>
        <Text className="pt-4 text-center text-lg font-bold text-hawk-ink">Incident reported</Text>
        <Text className="pt-2 text-center text-sm text-neutral-600">
          Your report is under review. If accepted, it appears on the public incident log —
          your identity stays your observer ID only.
        </Text>
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
        <ScrollView contentContainerClassName="px-4 pb-8 pt-4" keyboardShouldPersistTaps="handled">
          <Text className="pb-2 text-sm font-semibold text-neutral-500">What happened?</Text>
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

          <Text className="pb-2 pt-3 text-sm font-semibold text-neutral-500">Evidence</Text>
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
              <Pressable
                className="mb-2 h-[76px] w-[76px] items-center justify-center rounded-xl border-2 border-dashed border-hawk-leaf bg-white"
                onPress={() => setCamera(true)}
              >
                <Feather name="camera" size={20} color={BRAND.leaf} />
                <Text className="pt-1 text-[10px] font-semibold text-hawk-leaf">Add</Text>
              </Pressable>
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

          <Text className="pt-3 text-xs text-neutral-500">
            Your safety first: never confront anyone to get footage. Reports are reviewed
            before publication; your phone number is never attached.
          </Text>

          {line ? <Text className="pt-3 text-sm font-semibold text-amber-800">{line}</Text> : null}

          <Pressable
            disabled={!canSubmit || busy}
            onPress={onSubmit}
            className={`mt-4 items-center rounded-2xl py-4 ${
              canSubmit && !busy ? 'bg-hawk-green active:opacity-80' : 'bg-neutral-300'
            }`}
          >
            {busy ? (
              <ActivityIndicator color={BRAND.gold} />
            ) : (
              <Text className="text-base font-bold text-hawk-gold">Submit incident report</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

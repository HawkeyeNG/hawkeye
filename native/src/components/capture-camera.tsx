import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { Shot } from '@/lib/submit';
import { BRAND } from '@/lib/api';

/**
 * In-app capture with a GPS stamp taken at shutter time — the property the
 * backend checks (photo-location coherence): every photo carries the fix of
 * where it was actually taken, so gallery imports can't back a submission.
 *
 * With `allowVideo` a Photo|Video toggle appears (incident evidence). Video
 * records up to VIDEO_MAX_S seconds, tap the red button again to stop.
 */
export type Media = Shot & { type: 'image' | 'video' };

const VIDEO_MAX_S = 30;

type Props = {
  title: string;
  hint: string;
  allowVideo?: boolean;
  onCapture: (media: Media) => void;
  onCancel: () => void;
};

export function CaptureCamera({ title, hint, allowVideo, onCapture, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const cam = useRef<CameraView>(null);

  if (!permission) return <View className="flex-1 bg-black" />;
  if (!permission.granted) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-8">
        <Feather name="camera-off" size={32} color="#fff" />
        <Text className="pt-4 text-center text-base text-white">
          Hawkeye needs the camera to capture evidence in-app.
        </Text>
        <Pressable className="mt-5 rounded-2xl bg-hawk-gold px-6 py-3" onPress={requestPermission}>
          <Text className="text-base font-bold text-hawk-ink">Allow camera</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={onCancel}>
          <Text className="text-sm text-neutral-400">Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const getFix = async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    return Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  };

  const shootPhoto = async () => {
    if (busy) return;
    setBusy(true);
    setLine('Hold still…');
    try {
      const photo = await cam.current!.takePictureAsync({ quality: 0.8 });
      setLine('Getting your location…');
      const fix = await getFix();
      if (!fix) {
        setLine('Location is required — evidence must prove where it was taken.');
        setBusy(false);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCapture({
        uri: photo.uri,
        capturedAt: Date.now(),
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        type: 'image',
      });
    } catch {
      setLine('Capture failed — try again.');
      setBusy(false);
    }
  };

  const toggleVideo = async () => {
    if (recording) {
      cam.current?.stopRecording();
      return;
    }
    if (busy) return;
    if (!micPermission?.granted) {
      const m = await requestMic();
      if (!m.granted) {
        setLine('Microphone is needed to record video with sound.');
        return;
      }
    }
    setBusy(true);
    setRecording(true);
    setLine(`Recording — up to ${VIDEO_MAX_S}s. Tap again to stop.`);
    try {
      // Grab the fix while recording runs; both resolve before onCapture.
      const fixP = getFix();
      const video = await cam.current!.recordAsync({ maxDuration: VIDEO_MAX_S });
      setRecording(false);
      setLine('Saving…');
      const fix = await fixP;
      if (!video?.uri || !fix) {
        setLine(fix ? 'Recording failed — try again.' : 'Location is required for evidence.');
        setBusy(false);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCapture({
        uri: video.uri,
        capturedAt: Date.now(),
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        type: 'video',
      });
    } catch {
      setRecording(false);
      setLine('Recording failed — try again.');
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 bg-black">
      <CameraView ref={cam} style={{ flex: 1 }} facing="back" mode={mode} />
      <View className="absolute inset-x-0 top-0 px-5 pt-14">
        <Text className="text-lg font-bold text-white">{title}</Text>
        <Text className="pt-1 text-sm text-neutral-300">{line ?? hint}</Text>
      </View>

      {allowVideo ? (
        <View className="absolute inset-x-0 bottom-36 flex-row justify-center gap-2">
          {(['picture', 'video'] as const).map((m) => (
            <Pressable
              key={m}
              disabled={busy || recording}
              onPress={() => setMode(m)}
              className={`rounded-full px-4 py-1.5 ${mode === m ? 'bg-hawk-gold' : 'bg-black/50'}`}
            >
              <Text className={`text-xs font-bold ${mode === m ? 'text-hawk-ink' : 'text-white'}`}>
                {m === 'picture' ? 'Photo' : 'Video'}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-8 pb-12">
        <Pressable hitSlop={12} onPress={onCancel} disabled={busy && !recording}>
          <Text className="text-base font-semibold text-white">Cancel</Text>
        </Pressable>
        <Pressable
          onPress={mode === 'picture' ? shootPhoto : toggleVideo}
          disabled={busy && !recording}
          className="items-center justify-center rounded-full border-4 border-white"
          style={{ width: 72, height: 72 }}
        >
          {busy && !recording && mode === 'picture' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View
              className={recording ? 'bg-red-600' : mode === 'video' ? 'bg-red-500' : 'bg-hawk-gold'}
              style={
                recording
                  ? { width: 28, height: 28, borderRadius: 6 }
                  : { width: 56, height: 56, borderRadius: 28 }
              }
            />
          )}
        </Pressable>
        <View style={{ width: 48 }} />
      </View>
    </View>
  );
}

import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
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
 */
type Props = {
  title: string;
  hint: string;
  onCapture: (shot: Shot) => void;
  onCancel: () => void;
};

export function CaptureCamera({ title, hint, onCapture, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const cam = useRef<CameraView>(null);

  if (!permission) return <View className="flex-1 bg-black" />;
  if (!permission.granted) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-8">
        <Feather name="camera-off" size={32} color="#fff" />
        <Text className="pt-4 text-center text-base text-white">
          Hawkeye needs the camera to photograph the result sheet.
        </Text>
        <Pressable
          className="mt-5 rounded-2xl bg-hawk-gold px-6 py-3"
          onPress={requestPermission}
        >
          <Text className="text-base font-bold text-hawk-ink">Allow camera</Text>
        </Pressable>
        <Pressable className="mt-3" onPress={onCancel}>
          <Text className="text-sm text-neutral-400">Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    setLine('Hold still…');
    try {
      // Fix and photo in parallel — the stamp is the moment of capture.
      const [photo, perm] = await Promise.all([
        cam.current!.takePictureAsync({ quality: 0.8 }),
        Location.requestForegroundPermissionsAsync(),
      ]);
      if (!perm.granted) {
        setLine('Location is required — the report must prove where it was taken.');
        setBusy(false);
        return;
      }
      setLine('Getting your location…');
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCapture({
        uri: photo.uri,
        capturedAt: Date.now(),
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
      });
    } catch {
      setLine('Capture failed — try again.');
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 bg-black">
      <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
      <View className="absolute inset-x-0 top-0 px-5 pt-14">
        <Text className="text-lg font-bold text-white">{title}</Text>
        <Text className="pt-1 text-sm text-neutral-300">{line ?? hint}</Text>
      </View>
      <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-8 pb-12">
        <Pressable hitSlop={12} onPress={onCancel} disabled={busy}>
          <Text className="text-base font-semibold text-white">Cancel</Text>
        </Pressable>
        <Pressable
          onPress={shoot}
          disabled={busy}
          className="h-18 w-18 items-center justify-center rounded-full border-4 border-white"
          style={{ width: 72, height: 72 }}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View className="h-14 w-14 rounded-full bg-hawk-gold" />
          )}
        </Pressable>
        <View style={{ width: 48 }} />
      </View>
    </View>
  );
}

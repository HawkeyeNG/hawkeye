import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t as i18nT } from '@/lib/i18n';

/**
 * EVIDENCE PHOTOS, FULL SCREEN, IN THE APP.
 *
 * The ledger, the case file and the incident feed each opened a full-size photo
 * by handing its url to the in-app BROWSER — a raw JPEG in a browser chrome, no
 * zoom worth the name, and a trip out of the app to read a number off a result
 * sheet. Reading that number is the whole point of the photo.
 *
 * Pinch and double-tap to zoom, drag to pan, built from react-native-gesture-
 * handler and reanimated: both are already in the binary (components/ask-fab.tsx
 * drags on them), so this ships over the air to 1.0.8 and 1.0.9 alike. No new
 * native module.
 *
 * VIDEOS ARE NOT HANDLED HERE: components/video-viewer.tsx plays them, on a
 * binary that has expo-video (the first store build after 1.0.9). Older binaries
 * still open a video in the browser — see app/incidents.tsx.
 */
const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;

function clamp(v: number, lo: number, hi: number): number {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
}

function Zoomable({ uri, label }: { uri: string; label?: string }) {
  const { width: W, height: H } = useWindowDimensions();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  /* Keep the picture on screen: at zoom s the frame overhangs by (s-1)/2 of
     itself on each side, and that is as far as it may travel. */
  const settle = () => {
    'worklet';
    if (scale.value <= 1.02) {
      scale.value = withTiming(1);
      tx.value = withTiming(0);
      ty.value = withTiming(0);
      return;
    }
    const mx = (W * (scale.value - 1)) / 2;
    const my = (H * (scale.value - 1)) / 2;
    tx.value = withTiming(clamp(tx.value, -mx, mx));
    ty.value = withTiming(clamp(ty.value, -my, my));
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = clamp(startScale.value * e.scale, 1, MAX_ZOOM);
    })
    .onEnd(() => settle());

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      startX.value = tx.value;
      startY.value = ty.value;
    })
    .onUpdate((e) => {
      // At 1x there is nothing to move, and a drag must not shove the sheet about.
      if (scale.value <= 1) return;
      tx.value = startX.value + e.translationX;
      ty.value = startY.value + e.translationY;
    })
    .onEnd(() => settle());

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((_e, ok) => {
      if (!ok) return;
      if (scale.value > 1.02) {
        scale.value = withTiming(1);
        tx.value = withTiming(0);
        ty.value = withTiming(0);
      } else {
        scale.value = withTiming(DOUBLE_TAP_ZOOM);
      }
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <View style={{ flex: 1 }}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
        <Animated.View style={[{ width: W, height: H }, style]}>
          <Image
            source={{ uri }}
            style={{ width: W, height: H }}
            contentFit="contain"
            accessibilityLabel={label}
            onLoad={() => setState('ready')}
            onError={() => setState('failed')}
          />
        </Animated.View>
      </GestureDetector>
      {state === 'loading' ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
          <ActivityIndicator color="#fff" />
        </View>
      ) : state === 'failed' ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center px-10">
          <Feather name="image" size={28} color="#9ca3af" />
          <Text className="pt-3 text-center text-sm text-white">{i18nT('n.components.image-viewer.failed')}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Shown while `uri` is set; `onClose` clears it. One per screen, fed by
 * whichever photo was tapped.
 */
export function ImageViewer({
  uri,
  label,
  onClose,
}: {
  uri: string | null;
  label?: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal is its own native window on Android: gestures inside it need a
          root of their own, the app's root does not reach in. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Keyed by the url, so a second photo starts at 1x rather than
            wherever the last one was left. */}
        {uri ? <Zoomable key={uri} uri={uri} label={label} /> : null}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={i18nT('common.close')}
          className="absolute right-4 h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-70"
          style={{ top: insets.top + 10 }}
        >
          <Feather name="x" size={24} color="#fff" />
        </Pressable>
        <View
          pointerEvents="none"
          className="absolute left-0 right-0 items-center"
          style={{ bottom: insets.bottom + 16 }}
        >
          <Text className="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white">
            {i18nT('n.components.sheet-reference.pinch-or-double-tap-to-zoom')}
          </Text>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

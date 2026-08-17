import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUi } from '@/lib/theme';

/**
 * THE SHEET, STILL READABLE WHEN THE FIGURES ARE TYPED.
 *
 * The flow captures first on purpose — the EC8A is the perishable thing on
 * election day, and the tally can be typed later from somewhere safer (see
 * docs/REPORT-FLOW-CAPTURE-FIRST.md). But "later, from somewhere safer" is
 * exactly the moment the observer no longer has the sheet in front of them, and
 * the votes step told them to "copy the figures exactly as written on the sheet"
 * while showing no sheet at all. Their own photograph was already on the device,
 * two steps back, and nothing surfaced it.
 *
 * So the photo comes with them. Enlarging matters as much as showing: an EC8A is
 * a dense grid of party rows, and a 120px-high thumbnail proves a photo exists
 * without letting anyone read a number off it. Pinch, drag and double-tap, on a
 * black field so the paper is the only thing lit.
 */
const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 3;

export function SheetReference({
  uri,
  label = 'Your result sheet',
  hint = 'Tap to enlarge — read the figures off your own photo.',
}: {
  uri: string;
  label?: string;
  hint?: string;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label}. Opens full screen, zoomable.`}
        className="mb-3 overflow-hidden rounded-2xl bg-card active:opacity-80"
      >
        <Image source={{ uri }} style={{ width: '100%', height: 120 }} contentFit="cover" />
        <View className="flex-row items-center px-3.5 py-2.5">
          <Feather name="maximize-2" size={14} color={ui.tint.good.ink} />
          <View className="flex-1 pl-2.5">
            <Text className="text-xs font-bold text-ink">{label}</Text>
            <Text className="pt-0.5 text-[11px] text-muted">{hint}</Text>
          </View>
        </View>
      </Pressable>

      <Modal
        visible={open}
        transparent={false}
        animationType="fade"
        // Android's hardware back must close the viewer, not the report flow.
        onRequestClose={() => setOpen(false)}
        statusBarTranslucent
      >
        <Zoomable uri={uri} onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function Zoomable({ uri, onClose }: { uri: string; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const scale = useSharedValue(1);
  const startScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  /**
   * How far the image may be dragged at the current zoom: half the overflow in
   * each direction. Without it a pinched-in image can be flung off screen and
   * the observer is left staring at black with no way back to the paper.
   */
  const clampPan = (v: number, limit: number) => {
    'worklet';
    return Math.min(limit, Math.max(-limit, v));
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.value = scale.value;
    })
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(1, startScale.value * e.scale));
    })
    .onEnd(() => {
      // Snapping back to fit at the bottom keeps "I have lost the picture" from
      // being a state you can end up parked in.
      if (scale.value <= 1.01) {
        scale.value = withTiming(1);
        x.value = withTiming(0);
        y.value = withTiming(0);
      }
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      const overX = (width * scale.value - width) / 2;
      const overY = (height * scale.value - height) / 2;
      x.value = clampPan(startX.value + e.translationX, overX);
      y.value = clampPan(startY.value + e.translationY, overY);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd(() => {
      const zoomed = scale.value > 1.01;
      scale.value = withTiming(zoomed ? 1 : DOUBLE_TAP_SCALE);
      if (zoomed) {
        x.value = withTiming(0);
        y.value = withTiming(0);
      }
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {/* Simultaneous, not Race: reading a dense grid means pinching and dragging
          in one continuous movement, and making them compete forces the observer
          to lift off between every adjustment. */}
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
        <Animated.View style={[{ flex: 1 }, style]}>
          <Image
            source={{ uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            accessibilityLabel="Your photograph of the result sheet"
          />
        </Animated.View>
      </GestureDetector>

      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the sheet"
        style={{ position: 'absolute', top: insets.top + 10, right: 16 }}
        className="h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-70"
      >
        <Feather name="x" size={22} color="#fff" />
      </Pressable>

      <View
        style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 14 }}
        pointerEvents="none"
      >
        <Text className="text-center text-xs text-white/70">
          Pinch or double-tap to zoom · drag to move
        </Text>
      </View>
    </View>
  );
}

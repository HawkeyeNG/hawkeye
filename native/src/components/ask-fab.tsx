import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { router, usePathname } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { BRAND } from '@/lib/api';

/** Diameter of the bubble. Below ~48 it stops being a comfortable one-thumb target. */
const SIZE = 52;
/** Gap left between the bubble and the screen edge once it snaps. */
const EDGE = 14;
/** (tabs)/_layout pins the tab bar at this height; the bubble never sits on it. */
const TAB_BAR = 62;
/**
 * How far above the lowest allowed spot the bubble first appears.
 *
 * The bottom of a screen belongs to the pinned footer CTA (see the report flow's
 * Continue): a bubble resting there would cover the one control an observer is
 * under time pressure to press. It starts clear of that band; anyone who wants it
 * lower can drag it there.
 */
const FOOTER_CLEAR = 150;

const SPRING = { damping: 18, stiffness: 190, mass: 0.6 } as const;

const K_POS = 'hawkeye.ask_fab.pos';

/**
 * Only the edge and the height are stored, never a raw x. A phone that rotates —
 * or a different device restoring a backup — would put an absolute x somewhere
 * arbitrary; a side re-snaps correctly at any width.
 */
type Pos = { side: 'left' | 'right'; y: number };

/**
 * Screens where a floating widget is wrong rather than merely unnecessary:
 * /assistant is what the bubble opens, welcome and sign-in are deliberately
 * chrome-free, and every capture surface (the three report flows, practice) is a
 * full-screen camera whose own controls must not compete with anything. Mirrors
 * the web's placement rule in app/menu.js.
 */
const HIDDEN = new Set(['/assistant', '/welcome', '/sign-in', '/practice']);

const clampUi = (v: number, lo: number, hi: number) => {
  'worklet';
  return Math.min(Math.max(v, lo), hi);
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

type Bounds = {
  width: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  restY: number;
};

function useBounds(): Bounds {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const minY = insets.top + 8;
  // Clamped against the tab bar on every screen, not just the tabbed ones: a
  // consistent floor is worth more than 62px of reach on the modal screens.
  const maxY = Math.max(minY, height - insets.bottom - TAB_BAR - SIZE - 8);
  return {
    width,
    minX: EDGE,
    maxX: width - SIZE - EDGE,
    minY,
    maxY,
    restY: Math.max(minY, maxY - FOOTER_CLEAR),
  };
}

/**
 * "Ask Hawkeye" — a draggable chat bubble, mounted once in the root layout.
 *
 * Modelled on the dev-client's floating menu: drag it anywhere, let go, it snaps
 * to the nearer edge and stays there across launches. Dragging is the point —
 * one fixed corner always covers something on someone's screen.
 *
 * The stored position is resolved before anything renders and then handed to the
 * bubble as its starting point, so it never flashes in the default corner and
 * jumps to where the user actually left it.
 */
export function AskFab() {
  const pathname = usePathname();
  const bounds = useBounds();
  const [pos, setPos] = useState<Pos | null>(null);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      let saved: Pos | null = null;
      try {
        const raw = await AsyncStorage.getItem(K_POS);
        if (raw) saved = JSON.parse(raw) as Pos;
      } catch {
        saved = null;
      }
      if (!live) return;
      // Nobody has moved it yet, so nobody has been told what it is.
      if (!saved) setHint(true);
      setPos(saved ?? { side: 'right', y: bounds.restY });
    })();
    return () => {
      live = false;
    };
    // Mount only. Bounds are read once for the very first placement; every later
    // size change is absorbed by the clamp inside the bubble's animated style.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 5000);
    return () => clearTimeout(t);
  }, [hint]);

  /**
   * Kept in React state as well as on disk: the bubble unmounts on the hidden
   * routes below, and on the way back it must start from where it was last
   * dropped, not from where this render first found it.
   */
  const settle = useCallback((next: Pos) => {
    setPos(next);
    AsyncStorage.setItem(K_POS, JSON.stringify(next)).catch(() => {});
  }, []);

  if (!pos || HIDDEN.has(pathname) || pathname.startsWith('/report')) return null;

  return (
    // NO full-screen wrapper. There was one, with pointerEvents="box-none", and it
    // swallowed every touch in the app: nothing outside the bubble responded until
    // a navigation tore the overlay down. box-none is supposed to let touches fall
    // through to whatever is underneath, but the layer sits above native screens
    // (react-native-screens) rather than above ordinary sibling views, and that is
    // not a case it reliably covers.
    //
    // Nothing needed the wrapper anyway: both children are position:'absolute', so
    // they lay out against the root GestureHandlerRootView — the same full-screen
    // coordinate space the overlay was providing — and the bubble's drag comes from
    // shared values, not from any parent's bounds. With the wrapper gone the only
    // touchable surface is the 56pt bubble itself, so this class of bug cannot
    // return; there is no longer a screen-sized view to misconfigure.
    <>
      {hint ? (
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.delay(500)}
          exiting={FadeOut}
          // Positioned against the screen, not the bubble: a child hanging outside
          // its parent's bounds is clipped on Android. The hint only ever shows at
          // the untouched default spot, so those coordinates are known.
          style={[styles.hint, { right: EDGE + SIZE + 8, top: bounds.restY + 13 }]}
          className="rounded-full border border-line bg-card px-2.5 py-1"
        >
          <Text className="text-xs font-semibold text-ink">Ask Hawkeye</Text>
        </Animated.View>
      ) : null}
      <Bubble start={pos} bounds={bounds} onSettle={settle} />
    </>
  );
}

/**
 * Pan and tap RACE rather than nest: a pan only claims the touch after 6px of
 * travel, so the hand-wobble of a real tap still opens the chat instead of
 * nudging the bubble a few pixels and swallowing the press.
 */
function Bubble({
  start,
  bounds,
  onSettle,
}: {
  start: Pos;
  bounds: Bounds;
  onSettle: (p: Pos) => void;
}) {
  const { width, minX, maxX, minY, maxY } = bounds;

  const x = useSharedValue(start.side === 'left' ? minX : maxX);
  const y = useSharedValue(clamp(start.y, minY, maxY));
  const scale = useSharedValue(1);
  const grabX = useSharedValue(0);
  const grabY = useSharedValue(0);

  const open = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/assistant');
  };

  const pan = Gesture.Pan()
    .minDistance(6)
    .onBegin(() => {
      scale.value = withSpring(1.08, SPRING);
    })
    .onStart(() => {
      grabX.value = x.value;
      grabY.value = y.value;
    })
    .onUpdate((e) => {
      x.value = clampUi(grabX.value + e.translationX, minX, maxX);
      y.value = clampUi(grabY.value + e.translationY, minY, maxY);
    })
    .onEnd(() => {
      const side = x.value + SIZE / 2 < width / 2 ? 'left' : 'right';
      const at = clampUi(y.value, minY, maxY);
      x.value = withSpring(side === 'left' ? minX : maxX, SPRING);
      y.value = withSpring(at, SPRING);
      scheduleOnRN(onSettle, { side, y: at });
    })
    .onFinalize(() => {
      scale.value = withSpring(1, SPRING);
    });

  const tap = Gesture.Tap()
    // Deliberately loose: a press held long enough to drift a few pixels is still
    // someone asking a question, not someone moving the bubble.
    .maxDistance(14)
    .onEnd((_e, success) => {
      if (success) scheduleOnRN(open);
    });

  // Rotation and split-screen change every bound at once. Clamping here rather
  // than in an effect re-seats the bubble on the correct edge for the new size
  // without a second source of truth for where it is.
  const fab = useAnimatedStyle(() => ({
    transform: [
      { translateX: clampUi(x.value, minX, maxX) },
      { translateY: clampUi(y.value, minY, maxY) },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={Gesture.Race(pan, tap)}>
      <Animated.View
        accessibilityRole="button"
        accessibilityLabel="Ask Hawkeye about the results"
        accessibilityHint="Opens the assistant. Drag to move the button."
        style={[fab, styles.fab]}
        className="items-center justify-center rounded-full border border-line bg-hawk-green"
      >
        <Feather name="message-circle" size={22} color={BRAND.gold} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // zIndex/elevation live on the two absolute children now that the wrapping
  // layer is gone — they are what has to sit above the screen and the tab bar.
  hint: { position: 'absolute', zIndex: 40, elevation: 8 },
  fab: {
    position: 'absolute',
    zIndex: 40,
    width: SIZE,
    height: SIZE,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
});

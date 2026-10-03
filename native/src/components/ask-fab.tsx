import Feather from '@expo/vector-icons/Feather';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { BRAND } from '@/lib/api';
import { t as i18nT } from '@/lib/i18n';

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
 *
 * /profile too (design audit Oct 2026, X2): it is a column of settings rows, and
 * the bubble's resting spot landed on the "Save report media" switch. A results
 * assistant has nothing to offer on a settings screen.
 */
const HIDDEN = new Set(['/assistant', '/chat', '/welcome', '/sign-in', '/practice', '/profile']);

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

/**
 * IS SOMEONE TYPING? (first-time walkthrough #3)
 *
 * With the keyboard up the visible area is a few hundred points, and the bubble
 * — resting above the tab bar — landed on the field being typed into. It steps
 * aside while the keyboard is shown and comes back when it closes. iOS gets the
 * "will" events (the bubble leaves as the keyboard starts to rise); Android only
 * has "did". The web export has no keyboard events at all, so there a focused
 * text field stands in for the keyboard, as it does on the website (menu.js).
 */
function useTyping(): boolean {
  const [typing, setTyping] = useState(() => Platform.OS !== 'web' && Keyboard.isVisible());
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof document === 'undefined') return;
      const TEXT = /^(text|tel|number|email|password|search|url)$/;
      const sync = () => {
        const el = document.activeElement as HTMLElement | null;
        const input = el?.tagName === 'INPUT' && TEXT.test((el as HTMLInputElement).type || 'text');
        setTyping(!!el && (input || el.tagName === 'TEXTAREA' || el.isContentEditable));
      };
      const out = () => setTimeout(sync, 0);
      document.addEventListener('focusin', sync);
      document.addEventListener('focusout', out);
      return () => {
        document.removeEventListener('focusin', sync);
        document.removeEventListener('focusout', out);
      };
    }
    const ios = Platform.OS === 'ios';
    const subs = [
      Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setTyping(true)),
      Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setTyping(false)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return typing;
}

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
  // On the FAQ and About screens the bubble IS "Chat with us" — a person (the
  // web chat), not the bot — as the web's corner button is on those pages. One
  // bubble per screen, one meaning per bubble.
  const { slug } = useGlobalSearchParams<{ slug?: string }>();
  const onChatPage = pathname === '/page' && (slug === 'faq' || slug === 'about');
  const bounds = useBounds();
  const typing = useTyping();
  const [pos, setPos] = useState<Pos | null>(null);

  /**
   * NO FIRST-RUN LABEL. There used to be an "Ask Hawkeye" pill beside the bubble
   * for five seconds on first launch, and it landed on whatever list row sat at
   * that height — the "Save report media" switch on Profile, candidate rows on a
   * race page. House rule: a label never sits over content. The bubble's chat
   * glyph and its accessibilityLabel/Hint carry what it is (design audit
   * Oct 2026, X2).
   */
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
      setPos(saved ?? { side: 'right', y: bounds.restY });
    })();
    return () => {
      live = false;
    };
    // Mount only. Bounds are read once for the very first placement; every later
    // size change is absorbed by the clamp inside the bubble's animated style.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Kept in React state as well as on disk: the bubble unmounts on the hidden
   * routes below, and on the way back it must start from where it was last
   * dropped, not from where this render first found it.
   */
  const settle = useCallback((next: Pos) => {
    setPos(next);
    AsyncStorage.setItem(K_POS, JSON.stringify(next)).catch(() => {});
  }, []);

  // Unmounted while typing; `pos` lives up here, so it comes back where it was.
  if (!pos || typing || HIDDEN.has(pathname) || pathname.startsWith('/report')) return null;

  return (
    // NO full-screen wrapper. There was one, with pointerEvents="box-none", and it
    // swallowed every touch in the app: nothing outside the bubble responded until
    // a navigation tore the overlay down. box-none is supposed to let touches fall
    // through to whatever is underneath, but the layer sits above native screens
    // (react-native-screens) rather than above ordinary sibling views, and that is
    // not a case it reliably covers.
    //
    // Nothing needed the wrapper anyway: the bubble is position:'absolute', so it
    // lays out against the root GestureHandlerRootView — the same full-screen
    // coordinate space the overlay was providing — and its drag comes from shared
    // values, not from any parent's bounds. With the wrapper gone the only
    // touchable surface is the 52pt bubble itself, so this class of bug cannot
    // return; there is no longer a screen-sized view to misconfigure.
    <Bubble start={pos} bounds={bounds} onSettle={settle} chat={onChatPage} />
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
  chat,
}: {
  start: Pos;
  bounds: Bounds;
  onSettle: (p: Pos) => void;
  chat: boolean;
}) {
  const { width, minX, maxX, minY, maxY } = bounds;

  const x = useSharedValue(start.side === 'left' ? minX : maxX);
  const y = useSharedValue(clamp(start.y, minY, maxY));
  const scale = useSharedValue(1);
  const grabX = useSharedValue(0);
  const grabY = useSharedValue(0);

  const open = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Cast: the typed-routes list regenerates on `expo start` and may not know /chat yet.
    router.push((chat ? '/chat' : '/assistant') as never);
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
        accessibilityLabel={
          chat
            ? i18nT('common.chat-with-us')
            : i18nT('n.components.ask-fab.ask-hawkeye-about-the-results')
        }
        accessibilityHint={chat ? undefined : i18nT('n.components.ask-fab.opens-the-assistant-drag-to-move')}
        style={[fab, styles.fab]}
        className="items-center justify-center rounded-full border border-line bg-hawk-green"
      >
        <Feather name="message-circle" size={22} color={BRAND.gold} />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // zIndex/elevation live on the bubble itself now that the wrapping layer is
  // gone — it is what has to sit above the screen and the tab bar.
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

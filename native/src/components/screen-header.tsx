import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Animated, Image, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_CONTENT_H } from '@/hooks/use-hide-on-scroll';
import { useUi } from '@/lib/theme';

/**
 * Shared top pane for native screens — the native twin of the web's .gov-header:
 * the hawkeye mark (tap -> Home) on the left, the screen title, and a right
 * action (close/back, or the menu). Absolutely positioned and driven by
 * useHideOnScroll's translateY, so the whole pane slides away on scroll-down and
 * returns on scroll-up. Screens pad their scroll content by the hook's headerH so
 * nothing starts underneath it.
 */
export function ScreenHeader({
  title,
  translateY,
  onClose,
  right,
}: {
  title: string;
  translateY: Animated.AnimatedInterpolation<number>;
  onClose?: () => void;
  right?: 'close' | 'menu' | 'none';
}) {
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const rightKind = right ?? (onClose ? 'close' : 'none');
  return (
    <Animated.View
      className="border-b border-line bg-surface"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, transform: [{ translateY }] }}
    >
      <View style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center px-4" style={{ height: HEADER_CONTENT_H }}>
          <Pressable
            onPress={() => router.navigate('/(tabs)' as never)}
            hitSlop={8}
            className="mr-3"
            accessibilityRole="button"
            accessibilityLabel="Home"
          >
            <Image
              source={require('@/assets/images/icon.png')}
              style={{ width: 30, height: 30, borderRadius: 8 }}
            />
          </Pressable>
          <Text className="flex-1 text-xl font-bold text-ink" numberOfLines={1}>
            {title}
          </Text>
          {rightKind === 'close' ? (
            <Pressable
              onPress={onClose ?? (() => router.back())}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Feather name="x" size={24} color={ui.ink} />
            </Pressable>
          ) : rightKind === 'menu' ? (
            <Pressable
              onPress={() => router.navigate('/(tabs)/more' as never)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Menu"
            >
              <Feather name="menu" size={24} color={ui.ink} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ContentBlock, QuestionRow, SectionLabel } from '@/components/content-kit';
import { SocialRow } from '@/components/social-row';
import { useUi } from '@/lib/theme';
import { PAGES } from '@/lib/content';
import RAW from '@/lib/pages.json';

const WEB: Record<string, string> = {
  how: 'how.html',
  guide: 'guide.html',
  faq: 'faq.html',
  about: 'about.html',
  privacy: 'privacy.html',
};

/** The FAQ is already question-shaped, so its extracted copy still serves —
 *  folded into heading + following paragraphs. */
function faqPairs() {
  const blocks = (RAW as { faq: { blocks: { type: string; text?: string; items?: string[] }[] } })
    .faq.blocks;
  const out: { q: string; a: string[] }[] = [];
  let intro = '';
  for (const b of blocks) {
    if (b.type === 'heading' && b.text) out.push({ q: b.text, a: [] });
    else if (b.text) {
      if (out.length) out[out.length - 1].a.push(b.text);
      else intro = b.text;
    }
  }
  return { intro, items: out };
}

/**
 * Explainer pages — How Hawkeye Works, Observer Guide, FAQ, About, Privacy.
 *
 * The shell is the design: a collapsing brand header, jump chips that scroll to
 * a section, and content rendered as native shapes (timelines, expandable
 * layers, tappable action cards) instead of stacked prose. Structured copy
 * lives in lib/content.ts; components/content-kit.tsx owns the shapes.
 */
export default function StaticPage() {
  const ui = useUi();
  const { slug } = useLocalSearchParams<{ slug?: string }>();
  const key = slug ?? '';
  const page = PAGES[key];
  const faq = key === 'faq' ? faqPairs() : null;

  const scroll = useRef<ScrollView>(null);
  const y = useRef(new Animated.Value(0)).current;
  /** Measured tops of each 'label' block, so a chip can scroll to it. */
  const [anchors, setAnchors] = useState<Record<string, number>>({});
  const [active, setActive] = useState(0);

  const title = page?.title ?? (faq ? 'FAQ' : 'Hawkeye');
  const kicker = page?.kicker ?? 'Answers to the common questions';
  const sections = page?.sections ?? [];

  // Header title fades in only once the big title has scrolled away — one title
  // on screen at a time, the way a native detail screen behaves.
  const compact = y.interpolate({ inputRange: [40, 90], outputRange: [0, 1], extrapolate: 'clamp' });
  const heroFade = y.interpolate({ inputRange: [0, 80], outputRange: [1, 0], extrapolate: 'clamp' });

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    y.setValue(e.nativeEvent.contentOffset.y);
    const pos = e.nativeEvent.contentOffset.y + 120;
    const idx = sections.reduce((acc, s, i) => (anchors[s] != null && anchors[s] <= pos ? i : acc), 0);
    if (idx !== active) setActive(idx);
  };

  const jump = (s: string) => {
    const top = anchors[s];
    if (top != null) scroll.current?.scrollTo({ y: Math.max(top - 70, 0), animated: true });
  };

  const onLabelLayout = (text: string) => (e: LayoutChangeEvent) => {
    const top = e.nativeEvent.layout.y;
    setAnchors((a) => (a[text] === top ? a : { ...a, [text]: top }));
  };

  if (!page && !faq) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-surface px-8">
        <Text className="text-sm text-muted">That page doesn&apos;t exist.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-surface">
      {/* Collapsing header */}
      <View className="border-b border-line bg-surface px-4 pb-2 pt-2">
        <View className="flex-row items-center">
          <Pressable
            hitSlop={12}
            onPress={() => router.back()}
            className="h-9 w-9 items-center justify-center rounded-full bg-card"
          >
            <Feather name="x" size={18} color={ui.ink} />
          </Pressable>
          <Animated.Text
            numberOfLines={1}
            style={{ opacity: compact }}
            className="flex-1 px-3 text-base font-bold text-ink"
          >
            {title}
          </Animated.Text>
          <Pressable
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full bg-card"
            onPress={() =>
              Share.share({
                message: `${title} — Hawkeye\nhttps://hawkeye.com.ng/${WEB[key] ?? ''}`,
              })
            }
          >
            <Feather name="share-2" size={16} color={ui.tint.good.ink} />
          </Pressable>
        </View>

        {sections.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="pt-2">
            {sections.map((s, i) => (
              <Pressable
                key={s}
                onPress={() => jump(s)}
                className={`mr-2 rounded-full px-3.5 py-1.5 ${
                  i === active ? 'bg-hawk-green' : 'bg-card'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    i === active ? 'text-hawk-gold' : 'text-muted'
                  }`}
                >
                  {s}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>

      <ScrollView
        ref={scroll}
        scrollEventThrottle={16}
        onScroll={onScroll}
        contentContainerClassName="px-4 pb-12 pt-3"
      >
        <Animated.View style={{ opacity: heroFade }}>
          <Text className="text-[11px] font-bold uppercase tracking-[1.5px] text-good-ink">
            {kicker}
          </Text>
          <Text className="pt-1 text-3xl font-bold leading-9 text-ink">{title}</Text>
        </Animated.View>

        {page
          ? page.blocks.map((b, i) =>
              b.kind === 'label' ? (
                <View key={i} onLayout={onLabelLayout(b.text)}>
                  <SectionLabel text={b.text} />
                </View>
              ) : (
                <ContentBlock key={i} block={b} />
              ),
            )
          : null}

        {faq ? (
          <>
            <Text className="pb-3 pt-2 text-[15px] leading-6 text-ink">{faq.intro}</Text>
            {faq.items.map((q) => (
              <QuestionRow key={q.q} q={q.q} a={q.a} />
            ))}
          </>
        ) : null}

        {/* Every explainer page ends the same way: where to find Hawkeye. */}
        <SectionLabel text="Find Hawkeye" />
        <SocialRow />
      </ScrollView>
    </SafeAreaView>
  );
}

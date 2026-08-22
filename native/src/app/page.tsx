import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Image,
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
  /** Measured tops of each 'label' block, so a chip can scroll to it. */
  const [anchors, setAnchors] = useState<Record<string, number>>({});
  const [active, setActive] = useState(0);

  const title = page?.title ?? (faq ? 'FAQ' : 'Hawkeye');
  const kicker = page?.kicker ?? 'Answers to the common questions';
  const sections = page?.sections ?? [];

  // ONE TITLE, IN THE HEADER, ALWAYS THERE.
  //
  // This used to cross-fade: a big title in the body, and a header title that
  // faded in only once that had scrolled past 40-90px. Two problems, and the
  // second is why it went. The page opened with a header that had a mark, a
  // share button and a close button but NO title — it read as a header that had
  // failed to render, and only proved otherwise if you scrolled. And the fade
  // was a repetition either way: the same words twice, once at the top of the
  // body and once in the chrome, differing only in when each was visible.
  //
  // A persistent nav title is what a reader expects and what every other screen
  // here does through ScreenHeader. The body now opens on the kicker and the
  // lede, which is what the page is actually about.

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
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
      {/* The hawkeye mark (tap → Home) leads, matching the shared ScreenHeader
          convention; the persistent title, share, close and jump chips are this
          screen's own richer variant of it. */}
      <View className="border-b border-line bg-surface px-4 pb-2 pt-2">
        <View className="flex-row items-center">
          <Pressable
            onPress={() => router.navigate('/(tabs)' as never)}
            hitSlop={8}
            className="mr-1"
            accessibilityRole="button"
            accessibilityLabel="Home"
          >
            <Image
              source={require('@/assets/images/icon.png')}
              style={{ width: 30, height: 30, borderRadius: 8 }}
            />
          </Pressable>
          {/* text-lg, up from the text-base it wore as a fade-in compact title:
              it is the page's only title now and has to carry that weight. Not
              ScreenHeader's text-xl, because this header also holds share and
              close buttons and a row of jump chips. */}
          <Text numberOfLines={1} className="flex-1 px-3 text-lg font-bold text-ink">
            {title}
          </Text>
          <Pressable
            hitSlop={12}
            className="mr-2 h-9 w-9 items-center justify-center rounded-full bg-card"
            onPress={() =>
              Share.share({
                message: `${title} — Hawkeye\nhttps://hawkeye.com.ng/${WEB[key] ?? ''}`,
              })
            }
          >
            <Feather name="share-2" size={16} color={ui.tint.good.ink} />
          </Pressable>
          <Pressable
            hitSlop={12}
            onPress={() => router.back()}
            className="h-9 w-9 items-center justify-center rounded-full bg-card"
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Feather name="x" size={18} color={ui.ink} />
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
        <Text className="text-[11px] font-bold uppercase tracking-[1.5px] text-good-ink">
          {kicker}
        </Text>

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

        {/* Every explainer page ends the same way: where to find Hawkeye.
            SocialRow renders its own section label. */}
        <SocialRow />
      </ScrollView>
    </SafeAreaView>
  );
}

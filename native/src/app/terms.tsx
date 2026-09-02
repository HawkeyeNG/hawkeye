import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
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

import { ContentBlock, SectionLabel } from '@/components/content-kit';
import { SocialRow } from '@/components/social-row';
import { useUi } from '@/lib/theme';
import type { Page } from '@/lib/content';

/**
 * Terms of Service — the native twin of app/terms.html.
 *
 * Copy is faithful to that page (tightened, never invented), re-declared as
 * content-kit blocks in the same style as lib/content.ts. It lives here rather
 * than in PAGES because the stores need a stable, directly-linkable /terms
 * route — not a slug on the shared explainer screen — and terms is the one
 * page whose absence is a submission blocker rather than a parity gap.
 *
 * The web page is an accordion list, so the legal boilerplate stays an
 * accordion here: the clauses nobody reads collapse, the ones that change what
 * an observer should do stay open as rules and a callout.
 */
const TERMS: Page = {
  title: 'Terms of Service',
  kicker: 'Last updated 13 July 2026',
  // These strings are rendered twice: ALL-CAPS as the in-page SectionLabel, and
  // as-is on the jump chips in the header — so they carry Title Case for the
  // chips' sake. Each must stay byte-identical to its 'label' block below; the
  // scroll anchors are keyed by the text itself.
  sections: ['What Hawkeye Is', 'Acceptable Use', 'Your Content', 'The Legal Part', 'Contact'],
  blocks: [
    {
      kind: 'lede',
      text: 'Hawkeye is a free, independent, nonpartisan election-transparency tool. By using the website, mobile app, or any Hawkeye service, you agree to these terms.',
    },
    { kind: 'label', text: 'What Hawkeye Is' },
    {
      kind: 'para',
      text: 'Hawkeye lets citizens photograph, sign, and publish the results announced at their polling unit to an independent, tamper-evident public record.',
    },
    {
      kind: 'callout',
      icon: 'alert-circle',
      title: 'Official Results Are INEC’s Alone',
      body: 'Hawkeye is not affiliated with, endorsed by, or acting on behalf of INEC, any government body, or any political party. It produces crowd-reported evidence for public scrutiny; it does not, and cannot, declare a winner.',
    },
    { kind: 'label', text: 'Acceptable Use' },
    {
      kind: 'rules',
      tone: 'enforced',
      title: 'What Is Asked of You',
      items: [
        'Submit only truthful reports of what you genuinely witnessed at a polling unit.',
        'One verified phone number is one observer identity.',
        'Never put yourself at risk to gather a report. Follow all applicable laws.',
      ],
    },
    {
      kind: 'rules',
      tone: 'never',
      title: 'What Is Not Allowed',
      items: [
        'Fabricating, altering or misrepresenting results, photos or locations.',
        'Creating multiple identities, evading anti-fraud controls, or filing duplicate or automated reports.',
        'Uploading unlawful, defamatory or harassing content, or media you have no right to share.',
        'Disrupting, overloading, reverse-engineering, or gaining unauthorised access to the service.',
      ],
    },
    { kind: 'label', text: 'Your Content' },
    {
      kind: 'rules',
      tone: 'public',
      title: 'Published, Permanently',
      items: [
        'Your counts, photos and their locations go onto a public, tamper-evident ledger and, by design, cannot be edited or deleted — that permanence is what makes them trustworthy.',
        'Your phone number is never published.',
      ],
    },
    {
      kind: 'para',
      text: 'By submitting, you grant Hawkeye a non-exclusive, worldwide, royalty-free licence to store, publish and display that content for election-transparency purposes. You confirm you have the right to submit it.',
    },
    {
      kind: 'actions',
      items: [
        {
          icon: 'lock',
          title: 'Privacy & Data',
          body: 'What we keep, what becomes public, and what never leaves your phone.',
          cta: 'Read the privacy policy',
          href: '/page?slug=privacy',
        },
      ],
    },
    { kind: 'label', text: 'The Legal Part' },
    { kind: 'para', text: 'Tap a clause to read it in full.' },
    {
      kind: 'layers',
      items: [
        {
          icon: 'share-2',
          title: 'Social Media & Third-Party Platforms',
          points: [
            'Hawkeye may publish its own public-service content — election-integrity explainers, result summaries — to its official accounts on platforms such as TikTok, Instagram and Facebook, using those platforms’ official APIs.',
            'Such posts are made only from Hawkeye’s own accounts and are subject to the respective platform’s terms.',
            'Hawkeye does not access, collect, or post to any third-party user’s social-media account.',
          ],
        },
        {
          icon: 'alert-triangle',
          title: 'No Warranty',
          points: [
            'Hawkeye is provided “as is”, without warranties of any kind.',
            'Crowd-reported data is partial and unofficial and may contain errors; it is offered for transparency and scrutiny, not as a definitive count.',
            'We do not guarantee uninterrupted or error-free service.',
          ],
        },
        {
          icon: 'shield-off',
          title: 'Limitation of Liability',
          points: [
            'To the maximum extent permitted by law, Hawkeye and its operators are not liable for any indirect, incidental, or consequential damages arising from your use of, or inability to use, the service, or from reliance on any crowd-reported data.',
          ],
        },
        {
          icon: 'refresh-cw',
          title: 'Changes to These Terms',
          points: [
            'We may update these terms; continued use after changes constitutes acceptance.',
            'These terms are governed by the laws of the Federal Republic of Nigeria.',
          ],
        },
      ],
    },
    { kind: 'label', text: 'Contact' },
    {
      kind: 'contacts',
      items: [
        {
          icon: 'mail',
          label: 'Questions about these terms',
          value: 'info@hawkeye.com.ng',
          url: 'mailto:info@hawkeye.com.ng',
        },
      ],
    },
    {
      kind: 'para',
      text: 'Hawkeye is an independent transparency initiative and is not affiliated with INEC. Official results are those declared by INEC. Built and operated by IniXien, LLC (© 2026).',
    },
  ],
};

export default function Terms() {
  const ui = useUi();
  const scroll = useRef<ScrollView>(null);
  /** Measured tops of each 'label' block, so a chip can scroll to it. */
  const [anchors, setAnchors] = useState<Record<string, number>>({});
  const [active, setActive] = useState(0);

  const { title, kicker, sections, blocks } = TERMS;

  // ONE TITLE, IN THE HEADER, ALWAYS THERE — see the note in page.tsx, of
  // which this screen is a near-copy. The cross-fade opened the page on a
  // header holding a mark and two buttons but no title, which reads as a
  // header that failed to render, and said the same words twice either way.

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
          {/* text-lg: the page's only title now. Not ScreenHeader's text-xl,
              because this header also holds share, close and jump chips. */}
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.2}
            className="flex-1 px-3 text-lg font-bold text-ink"
          >
            {title}
          </Text>
          <Pressable
            hitSlop={12}
            className="mr-2 h-9 w-9 items-center justify-center rounded-full bg-card"
            onPress={() =>
              Share.share({
                message: `${title} — Hawkeye\nhttps://hawkeye.com.ng/terms.html`,
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
      </View>

      <ScrollView
        ref={scroll}
        scrollEventThrottle={16}
        onScroll={onScroll}
        contentContainerClassName="px-4 pb-12 pt-3"
      >
        {/* pb-4 — see page.tsx: replaces the gap the hero title used to make. */}
        <Text className="pb-4 text-[11px] font-bold uppercase tracking-[1.5px] text-good-ink">
          {kicker}
        </Text>

        {blocks.map((b, i) =>
          b.kind === 'label' ? (
            <View key={i} onLayout={onLabelLayout(b.text)}>
              <SectionLabel text={b.text} />
            </View>
          ) : (
            <ContentBlock key={i} block={b} />
          ),
        )}

        {/* Every explainer page ends the same way: where to find Hawkeye.
            SocialRow renders its own section label. */}
        <SocialRow />
      </ScrollView>
    </SafeAreaView>
  );
}

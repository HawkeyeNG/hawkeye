import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';
import PAGES from '@/lib/pages.json';

type Block =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] };

type Page = { title: string; blocks: Block[] };

const CONTACT = /[\w.+-]+@[\w-]+\.[\w.]+/;

/** Pages whose headings are questions worth collapsing. */
const ACCORDION = new Set(['faq']);

/** Fold a flat block list into heading → its following paragraphs. */
function groups(blocks: Block[]) {
  const out: { heading: string | null; body: string[] }[] = [];
  for (const b of blocks) {
    if (b.type === 'heading') out.push({ heading: b.text, body: [] });
    else if (b.type === 'text') {
      if (!out.length) out.push({ heading: null, body: [] });
      out[out.length - 1].body.push(b.text);
    } else if (b.type === 'list') {
      if (!out.length) out.push({ heading: null, body: [] });
      out[out.length - 1].body.push(...b.items.map((i) => `• ${i}`));
    }
  }
  return out;
}

/**
 * The static pages — How Hawkeye Works, Observer Guide, FAQ, About, Privacy —
 * rendered natively from copy extracted straight out of the website's own HTML
 * (scripts/extract_pages.mjs → lib/pages.json). Extracting rather than
 * retyping keeps the two frontends saying exactly the same thing, and a re-run
 * picks up any edit to the site.
 */
export default function StaticPage() {
  const { slug } = useLocalSearchParams<{ slug?: string }>();
  const page = (PAGES as Record<string, Page>)[slug ?? ''];
  const accordion = ACCORDION.has(slug ?? '');
  const [open, setOpen] = useState<Record<number, boolean>>({});

  return (
    <SafeAreaView className="flex-1 bg-hawk-mist">
      <View className="flex-row items-center px-4 pt-2">
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full bg-white"
        >
          <Feather name="x" size={18} color={BRAND.ink} />
        </Pressable>
        <Text className="flex-1 pl-3 text-lg font-bold text-hawk-ink" numberOfLines={1}>
          {page?.title ?? 'Hawkeye'}
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-4 pb-10 pt-3">
        {!page ? (
          <Text className="pt-6 text-sm text-neutral-500">That page doesn&apos;t exist.</Text>
        ) : accordion ? (
          // The FAQ is question/answer pairs, and its own copy says "tap any
          // question" — so it stays an accordion here rather than one long wall.
          groups(page.blocks).map((g, i) =>
            g.heading ? (
              <View key={i} className="mb-2 overflow-hidden rounded-2xl bg-white">
                <Pressable
                  className="flex-row items-center px-4 py-3.5 active:bg-hawk-mist"
                  onPress={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
                >
                  <Text className="flex-1 pr-2 text-sm font-semibold text-hawk-ink">
                    {g.heading}
                  </Text>
                  <Feather
                    name={open[i] ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color="#9db5a7"
                  />
                </Pressable>
                {open[i]
                  ? g.body.map((b, j) => (
                      <Text key={j} className="px-4 pb-3 text-sm leading-5 text-neutral-600">
                        {b}
                      </Text>
                    ))
                  : null}
              </View>
            ) : (
              g.body.map((b, j) => (
                <Text key={`${i}-${j}`} className="pb-2 text-sm text-neutral-600">
                  {b}
                </Text>
              ))
            ),
          )
        ) : (
          page.blocks.map((b, i) => {
            if (b.type === 'heading') {
              return (
                <Text key={i} className="pb-1 pt-4 text-base font-bold text-hawk-ink">
                  {b.text}
                </Text>
              );
            }
            if (b.type === 'list') {
              return (
                <View key={i} className="mt-2 rounded-2xl bg-white px-4 py-3">
                  {b.items.map((it, j) => (
                    <View key={j} className="flex-row py-1">
                      <Text className="text-sm text-hawk-leaf">•</Text>
                      <Text className="flex-1 pl-2 text-sm text-neutral-700">{it}</Text>
                    </View>
                  ))}
                </View>
              );
            }
            const email = b.text.match(CONTACT)?.[0];
            return (
              <View key={i}>
                <Text className="pt-2 text-sm leading-5 text-neutral-700">{b.text}</Text>
                {email ? (
                  <Pressable
                    className="pt-1"
                    onPress={() => WebBrowser.openBrowserAsync(`mailto:${email}`)}
                  >
                    <Text className="text-sm font-bold text-hawk-leaf">Email {email} →</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

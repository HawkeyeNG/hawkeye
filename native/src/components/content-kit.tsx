import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { LayoutAnimation, Linking, Platform, Pressable, Text, UIManager, View } from 'react-native';

import { BRAND } from '@/lib/api';
import { useUi } from '@/lib/theme';
import type { Block, Icon } from '@/lib/content';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Expand/collapse should animate — an instant jump reads as a redraw, not a
 *  disclosure, and on a phone that difference is most of the "native" feel. */
const animate = () =>
  LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));

export function SectionLabel({ text }: { text: string }) {
  const ui = useUi();
  return (
    <Text className="pb-2 pt-6 text-[11px] font-bold uppercase tracking-[1.5px] text-faint">
      {text}
    </Text>
  );
}

function ActionCard({
  icon,
  title,
  body,
  cta,
  href,
}: {
  icon: Icon;
  title: string;
  body: string;
  cta: string;
  href: string;
}) {
  return (
    <Pressable
      className="mb-2 flex-row rounded-2xl bg-card p-4 active:opacity-80"
      onPress={() => router.push(href as never)}
    >
      <View className="h-11 w-11 items-center justify-center rounded-2xl bg-surface">
        <Feather name={icon} size={19} color={BRAND.leaf} />
      </View>
      <View className="flex-1 pl-3.5">
        <Text className="text-base font-bold text-ink">{title}</Text>
        <Text className="pt-1 text-sm leading-5 text-muted">{body}</Text>
        <View className="flex-row items-center pt-2">
          <Text className="text-sm font-bold text-hawk-leaf">{cta}</Text>
          <Feather name="arrow-right" size={13} color={BRAND.leaf} style={{ marginLeft: 4 }} />
        </View>
      </View>
    </Pressable>
  );
}

/** Numbered timeline: the connector line is what makes a sequence read as a
 *  sequence rather than three stacked paragraphs. */
function Steps({
  items,
  start = 1,
}: {
  items: { title: string; body: string; bullets?: string[] }[];
  start?: number;
}) {
  return (
    <View className="rounded-2xl bg-card px-4 py-2">
      {items.map((s, i) => (
        <View key={s.title} className="flex-row">
          <View className="items-center" style={{ width: 34 }}>
            <View className="mt-3 h-7 w-7 items-center justify-center rounded-full bg-hawk-green">
              <Text className="text-xs font-bold text-hawk-gold">{start + i}</Text>
            </View>
            {i < items.length - 1 ? <View className="w-px flex-1 bg-surface" /> : null}
          </View>
          <View className="flex-1 pb-4 pl-3 pt-3">
            <Text className="text-base font-bold text-ink">{s.title}</Text>
            <Text className="pt-1 text-sm leading-5 text-muted">{s.body}</Text>
            {s.bullets?.map((b) => (
              <View key={b} className="flex-row pt-1.5">
                <View className="mt-2 h-1 w-1 rounded-full bg-hawk-leaf" />
                <Text className="flex-1 pl-2 text-sm leading-5 text-muted">{b}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function Layer({ icon, title, points }: { icon: Icon; title: string; points: string[] }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  return (
    <View className="mb-2 overflow-hidden rounded-2xl bg-card">
      <Pressable
        className="flex-row items-center px-4 py-3.5 active:bg-surface"
        onPress={() => {
          animate();
          Haptics.selectionAsync();
          setOpen((o) => !o);
        }}
      >
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-surface">
          <Feather name={icon} size={16} color={BRAND.leaf} />
        </View>
        <Text className="flex-1 pl-3 text-base font-semibold text-ink">{title}</Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={ui.faint} />
      </Pressable>
      {open ? (
        <View className="px-4 pb-3">
          {points.map((p) => (
            <View key={p} className="flex-row pt-2">
              <View className="mt-2 h-1.5 w-1.5 rounded-full bg-hawk-leaf" />
              <Text className="flex-1 pl-2.5 text-sm leading-5 text-muted">{p}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const TONE: Record<string, { icon: Icon; color: string; bg: string; text: string }> = {
  enforced: { icon: 'check-circle', color: '#0b6b3a', bg: 'bg-emerald-50', text: 'text-hawk-leaf' },
  never: { icon: 'x-circle', color: '#b91c1c', bg: 'bg-red-50', text: 'text-red-700' },
  private: { icon: 'lock', color: '#0b6b3a', bg: 'bg-emerald-50', text: 'text-hawk-leaf' },
  public: { icon: 'globe', color: '#b45309', bg: 'bg-amber-50', text: 'text-amber-800' },
};

function Rules({ tone, title, items }: { tone: string; title?: string; items: string[] }) {
  const t = TONE[tone] ?? TONE.enforced;
  return (
    <View className={`mb-2 rounded-2xl ${t.bg} px-4 py-3.5`}>
      {title ? <Text className={`pb-1 text-sm font-bold ${t.text}`}>{title}</Text> : null}
      {items.map((it) => (
        <View key={it} className="flex-row pt-2">
          <Feather name={t.icon} size={15} color={t.color} style={{ marginTop: 2 }} />
          <Text className="flex-1 pl-2.5 text-sm leading-5 text-ink">{it}</Text>
        </View>
      ))}
    </View>
  );
}

function Callout({ icon, title, body }: { icon: Icon; title: string; body: string }) {
  return (
    <View className="mt-3 flex-row rounded-2xl bg-hawk-green px-4 py-4">
      <Feather name={icon} size={18} color={BRAND.gold} style={{ marginTop: 2 }} />
      <View className="flex-1 pl-3">
        <Text className="text-base font-bold text-hawk-gold">{title}</Text>
        <Text className="pt-1 text-sm leading-5 text-emerald-50">{body}</Text>
      </View>
    </View>
  );
}

/** Contacts open the OS handler — mail app, Telegram app — not a web view. */
function Contacts({ items }: { items: { icon: Icon; label: string; value: string; url: string }[] }) {
  const ui = useUi();
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {items.map((c, i) => (
        <Pressable
          key={c.url}
          className={`flex-row items-center px-4 py-3.5 active:bg-surface ${
            i > 0 ? 'border-t border-line' : ''
          }`}
          onPress={() => Linking.openURL(c.url)}
        >
          <Feather name={c.icon} size={17} color={BRAND.leaf} />
          <View className="flex-1 pl-3">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              {c.label}
            </Text>
            <Text className="text-base text-ink">{c.value}</Text>
          </View>
          <Feather name="external-link" size={15} color={ui.faint} />
        </Pressable>
      ))}
    </View>
  );
}

/** One content block → its native shape. */
export function ContentBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'lede':
      return (
        <Text className="pb-1 pt-1 text-[15px] leading-6 text-ink">{block.text}</Text>
      );
    case 'label':
      return <SectionLabel text={block.text} />;
    case 'para':
      return <Text className="pt-2 text-sm leading-5 text-muted">{block.text}</Text>;
    case 'actions':
      return (
        <View className="pt-1">
          {block.items.map((a) => (
            <ActionCard key={a.title} {...a} />
          ))}
        </View>
      );
    case 'steps':
      return <Steps items={block.items} start={block.start} />;
    case 'layers':
      return (
        <View className="pt-1">
          {block.items.map((l) => (
            <Layer key={l.title} {...l} />
          ))}
        </View>
      );
    case 'rules':
      return <Rules tone={block.tone} title={block.title} items={block.items} />;
    case 'callout':
      return <Callout {...block} />;
    case 'contacts':
      return <Contacts items={block.items} />;
  }
}

/** Q/A accordion — used by the FAQ, which is already question-shaped. */
export function QuestionRow({ q, a }: { q: string; a: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="mb-2 overflow-hidden rounded-2xl bg-card">
      <Pressable
        className="flex-row items-center px-4 py-3.5 active:bg-surface"
        onPress={() => {
          animate();
          Haptics.selectionAsync();
          setOpen((o) => !o);
        }}
      >
        <Text className="flex-1 pr-2 text-[15px] font-semibold text-ink">{q}</Text>
        <Feather name={open ? 'minus' : 'plus'} size={16} color={BRAND.leaf} />
      </Pressable>
      {open
        ? a.map((p, i) => (
            <Text key={i} className="px-4 pb-3 text-sm leading-5 text-muted">
              {p}
            </Text>
          ))
        : null}
    </View>
  );
}

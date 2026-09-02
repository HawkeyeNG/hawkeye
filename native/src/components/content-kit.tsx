import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { LayoutAnimation, Linking, Platform, Pressable, Text, UIManager, View } from 'react-native';

import { BRAND } from '@/lib/api';
import { useUi, type Tone } from '@/lib/theme';
import type { Block, Icon } from '@/lib/content';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Expand/collapse should animate — an instant jump reads as a redraw, not a
 *  disclosure, and on a phone that difference is most of the "native" feel. */
const animate = () =>
  LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));

export function SectionLabel({ text }: { text: string }) {
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
  const ui = useUi();
  return (
    <Pressable
      className="mb-2 flex-row rounded-2xl bg-card p-4 active:opacity-80"
      onPress={() => router.push(href as never)}
    >
      <View className="h-11 w-11 items-center justify-center rounded-2xl bg-surface">
        <Feather name={icon} size={19} color={ui.tint.good.ink} />
      </View>
      <View className="flex-1 pl-3.5">
        <Text className="text-base font-bold text-ink">{title}</Text>
        <Text className="pt-1 text-sm leading-5 text-muted">{body}</Text>
        <View className="flex-row items-center pt-2">
          <Text className="text-sm font-bold text-good-ink">{cta}</Text>
          <Feather
            name="arrow-right"
            size={13}
            color={ui.tint.good.ink}
            style={{ marginLeft: 4 }}
          />
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
                <View className="mt-2 h-1 w-1 rounded-full bg-good-ink" />
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
          <Feather name={icon} size={16} color={ui.tint.good.ink} />
        </View>
        <Text className="flex-1 pl-3 text-base font-semibold text-ink">{title}</Text>
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={ui.faint} />
      </Pressable>
      {open ? (
        <View className="px-4 pb-3">
          {points.map((p) => (
            <View key={p} className="flex-row pt-2">
              <View className="mt-2 h-1.5 w-1.5 rounded-full bg-good-ink" />
              <Text className="flex-1 pl-2.5 text-sm leading-5 text-muted">{p}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A rule list is a tinted card. The tint used to be a hardcoded bg-emerald-50 /
 * bg-red-50 / bg-amber-50 with a fixed hex heading, which is why these cards
 * stayed pale in dark mode while the body copy set in text-ink went near-white
 * on top of them — the Terms screen was unreadable. Tone now names a semantic
 * pair (bg-good/text-good-ink …) that darkens with the theme, and the icon,
 * which takes a colour PROP rather than a class, reads the same pair off
 * useUi().tint.
 */
const TONE: Record<string, { icon: Icon; tone: Tone }> = {
  enforced: { icon: 'check-circle', tone: 'good' },
  never: { icon: 'x-circle', tone: 'bad' },
  private: { icon: 'lock', tone: 'good' },
  public: { icon: 'globe', tone: 'warn' },
};

export const TINT: Record<Tone, { bg: string; text: string }> = {
  good: { bg: 'bg-good', text: 'text-good-ink' },
  bad: { bg: 'bg-bad', text: 'text-bad-ink' },
  warn: { bg: 'bg-warn', text: 'text-warn-ink' },
};

function Rules({ tone, title, items }: { tone: string; title?: string; items: string[] }) {
  const ui = useUi();
  const t = TONE[tone] ?? TONE.enforced;
  const tint = TINT[t.tone];
  return (
    <View className={`mb-2 rounded-2xl ${tint.bg} px-4 py-3.5`}>
      {title ? <Text className={`pb-1 text-sm font-bold ${tint.text}`}>{title}</Text> : null}
      {items.map((it) => (
        <View key={it} className="flex-row pt-2">
          <Feather
            name={t.icon}
            size={15}
            color={ui.tint[t.tone].ink}
            style={{ marginTop: 2 }}
          />
          <Text className="flex-1 pl-2.5 text-sm leading-5 text-ink">{it}</Text>
        </View>
      ))}
    </View>
  );
}

function Callout({
  icon,
  title,
  body,
  cta,
  href,
}: {
  icon: Icon;
  title: string;
  body: string;
  cta?: string;
  href?: string;
}) {
  /**
   * ROUTED WHEN IT HAS SOMEWHERE TO GO. A callout that ends "go and do X" and
   * cannot take you to X is asking the reader to go and find it — which, for
   * the guide's closing "Rehearse It First", meant hunting under More for the
   * one action the whole page builds towards.
   *
   * The whole card is the target, not just the label: a 44dp+ tap area is the
   * accessible minimum and the same rule the actions cards follow. Unrouted
   * callouts render as a plain View exactly as before, so every other caller is
   * untouched.
   */
  const inner = (
    <>
      <Feather name={icon} size={18} color={BRAND.gold} style={{ marginTop: 2 }} />
      <View className="flex-1 pl-3">
        <Text className="text-base font-bold text-hawk-gold">{title}</Text>
        <Text className="pt-1 text-sm leading-5 text-emerald-50">{body}</Text>
        {cta && href ? (
          <View className="flex-row items-center pt-2.5">
            <Text className="text-sm font-bold text-hawk-gold">{cta}</Text>
            <Feather name="arrow-right" size={13} color={BRAND.gold} style={{ marginLeft: 4 }} />
          </View>
        ) : null}
      </View>
    </>
  );
  const className = 'mt-3 flex-row rounded-2xl bg-hawk-green px-4 py-4';
  if (!href) return <View className={className}>{inner}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${cta ?? ''}`.trim()}
      className={`${className} active:opacity-80`}
      onPress={() => router.push(href as never)}
    >
      {inner}
    </Pressable>
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
          <Feather name={c.icon} size={17} color={ui.tint.good.ink} />
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
        <Text className="flex-1 pr-2 text-[15px] font-semibold text-ink">{q}</Text>
        <Feather name={open ? 'minus' : 'plus'} size={16} color={ui.tint.good.ink} />
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

/* ─── Dashboard kit ───────────────────────────────────────────────────────────
 *
 * Verify the Ledger, the Public Docket and Election Integrity are meant to read
 * as one screen shape: stat tiles first, one plain sentence saying what they
 * mean, the detail folded away underneath. That match was held together by
 * copy-paste — ledger.tsx and docket.tsx each carried their own byte-identical
 * TINT / Stat / Fold, so tweaking a tile on one screen quietly split it from the
 * other. The shape lives here now; screens import it and do not redeclare it.
 */

/**
 * A number and what it counts.
 *
 * `tone` tints the whole tile through the semantic pairs, so it darkens with the
 * theme rather than leaving pale-on-pale text in dark mode. Pass it only when
 * the count actually carries a verdict — callers gate it on non-zero, because a
 * docket with nothing struck is not a red docket and a screen with no flags is
 * not a red screen.
 *
 * `tight` drops the value a step to text-base, for tiles whose value is a phrase
 * or a date ("Broken at #12", "12 Jan") rather than a numeral that can afford
 * the display size.
 */
export function Stat({
  value,
  label,
  tone,
  tight,
  topBar,
}: {
  value: string;
  label: string;
  tone?: Tone;
  tight?: boolean;
  /** Optional 4px coloured top stripe (integrity's severity cue — ported from the
   *  website). Opt-in so the other dashboards keep their plain tiles. */
  topBar?: string;
}) {
  return (
    <View
      className={`mb-2 mr-2 min-w-[44%] flex-1 rounded-2xl px-3.5 py-3 ${
        tone ? TINT[tone].bg : 'bg-card'
      }`}
      style={topBar ? { borderTopWidth: 4, borderTopColor: topBar } : undefined}
    >
      <Text
        className={`${tight ? 'text-base' : 'text-xl'} font-bold ${
          tone ? TINT[tone].text : 'text-ink'
        }`}
      >
        {value}
      </Text>
      <Text className="pt-1 text-[10px] font-bold uppercase tracking-[1px] text-muted">
        {label}
      </Text>
    </View>
  );
}

/**
 * Detail, folded away — and every fold starts CLOSED. These screens lead with
 * numbers; the cryptography or the arbitration rules behind them are here for
 * whoever wants them, but a panel that opens itself puts the paragraphs back in
 * front of the result.
 */
export function Fold({ title, body }: { title: string; body: string[] }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  return (
    <View className="mt-2 overflow-hidden rounded-2xl bg-card">
      <Pressable
        className="flex-row items-center px-4 py-3.5 active:bg-surface"
        onPress={() => {
          animate();
          Haptics.selectionAsync();
          setOpen((o) => !o);
        }}
      >
        <Text className="flex-1 pr-2 text-[15px] font-semibold text-ink">{title}</Text>
        <Feather name={open ? 'minus' : 'plus'} size={16} color={ui.tint.good.ink} />
      </Pressable>
      {open
        ? body.map((p, i) => (
            <Text key={i} className="px-4 pb-3 text-sm leading-5 text-muted">
              {p}
            </Text>
          ))
        : null}
    </View>
  );
}

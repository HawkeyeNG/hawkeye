import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';

import { useUi } from '@/lib/theme';
import { useThemePref, type ThemePref } from '@/lib/theme-pref';

import { ScreenHeader } from '@/components/screen-header';
import { SocialRow } from '@/components/social-row';
import { Tour } from '@/components/tour';
import { useHideOnScroll } from '@/hooks/use-hide-on-scroll';
import { GovDisclaimer } from '@/components/gov-disclaimer';
import { LANGS, LANG_NAMES, t as i18nT, useI18n } from '@/lib/i18n';

/**
 * More — the menu.js panel groups, carried over 1:1. Until each page is
 * rebuilt natively, entries open the live site in an in-app browser tab,
 * so nothing the web app offers is unreachable from the native shell.
 */
type Icon = keyof typeof Feather.glyphMap;
type MenuLink = { label: string; labelKey: string; href: string; icon: Icon };
type MenuItem = MenuLink | { acc: string; accKey: string; icon: Icon; items: MenuLink[] };

/**
 * EVERY ROW CARRIES A KEY, AND KEEPS ITS ENGLISH.
 *
 * GROUPS is a module-level const: it is evaluated ONCE, at import, which happens
 * before AsyncStorage has returned the stored language. Wrapping these strings in
 * i18nT() here would therefore freeze whatever was current at import — English on
 * a cold start — and never update again, however many times the provider
 * remounts. That is precisely the failure lib/i18n.tsx warns about.
 *
 * So the constant holds a KEY plus the English, and the row RESOLVES it during
 * render (see the i18nT call at the `{it.label}` sites below). Render re-runs on
 * every language change because the provider remounts its children with
 * key={lang}, so the label follows the language without the constant ever being
 * re-evaluated. Keeping the English inline also means this file still reads as
 * English source and still renders correctly with no bundle loaded.
 *
 * NATIVE'S t() TAKES (key, params) — NOT (key, english), which is the web's
 * signature. It falls back to the English BUNDLE and then to the key itself, so
 * the English here is documentation and the safety net is
 * scripts/i18n/native_bundles.mjs refusing to write a bundle that is missing a
 * catalogue key. Every key below is in that catalogue.
 *
 * The keys are the WEB catalogue's wherever the copy is shared, so the same
 * button cannot end up with two different Hausa sentences across the two clients
 * (scripts/i18n/native_bundles.mjs copies the web value for any non-`n.*` key).
 */
const GROUPS: { title: string; titleKey: string; items: MenuItem[] }[] = [
  {
    title: 'Take part',
    titleKey: 'nav.take-part',
    items: [
      { label: 'My Profile', labelKey: 'profile.my-profile', href: 'native:/profile', icon: 'user' },
      // Report accordion — the three report flows collapsed under one entry.
      {
        acc: 'Report',
        accKey: 'nav.report',
        icon: 'edit-3',
        items: [
          { label: 'Report a Result', labelKey: 'common.report-a-result', href: 'native:/report/result', icon: 'camera' },
          { label: 'Report a Collation Result', labelKey: 'common.report-a-collation-result', href: 'native:/report/collation', icon: 'layers' },
          { label: 'Report an Incident', labelKey: 'common.report-an-incident', href: 'native:/report/incident', icon: 'alert-triangle' },
        ],
      },
      { label: 'Practice Run', labelKey: 'nav.practice-run', href: 'native:/practice', icon: 'play-circle' },
      { label: 'Map a Polling Unit', labelKey: 'common.map-a-polling-unit', href: 'native:/map-unit', icon: 'map-pin' },
    ],
  },
  {
    title: 'Trust & verify',
    titleKey: 'nav.trust-verify',
    items: [
      { label: 'Verify the Ledger', labelKey: 'common.verify-the-ledger', href: 'native:/ledger', icon: 'shield' },
      { label: 'Election Integrity', labelKey: 'common.election-integrity', href: 'native:/integrity', icon: 'activity' },
      { label: 'Public Docket', labelKey: 'common.public-docket', href: 'native:/docket', icon: 'file-text' },
      { label: 'Incident Reports', labelKey: 'incident-reports.incident-reports', href: 'native:/incidents', icon: 'alert-triangle' },
    ],
  },
  {
    title: 'Live data',
    titleKey: 'nav.live-data',
    items: [
      // The website's nav lists the Leaderboard here, so the menu does too. It
      // is also a tab, but a tab is not a list entry: someone looking for it by
      // name in the menu found nothing. "Leaderboard", not "National
      // Leaderboard" — the word matches results.html's nav and <h1>.
      { label: 'Leaderboard', labelKey: 'common.leaderboard', href: 'native:/(tabs)/results', icon: 'bar-chart-2' },
      // RACES IS ONE LINK, NOT AN ACCORDION — the same call app/menu.js made.
      // It listed All Races / Osun 2026 / Presidency 2027: a hand-kept list of
      // three, hardcoded in a menu, sitting above a screen that derives every
      // race from /api/contests, groups them completed / ongoing / upcoming and
      // offers all 36 governorships. The accordion could only ever be a stale
      // subset of the page beneath it, and "Osun 2026" was a finished election
      // pinned to the menu. The filter the accordion was reaching for already
      // lives on /races.
      { label: 'Races', labelKey: 'races.races', href: 'native:/races', icon: 'trending-up' },
      { label: 'Public Reports Log', labelKey: 'common.public-reports-log', href: 'native:/reports-log', icon: 'list' },
      { label: 'Political Data', labelKey: 'common.political-data', href: 'native:/political', icon: 'pie-chart' },
    ],
  },
  {
    title: 'Learn & about',
    titleKey: 'nav.learn-about',
    items: [
      // A WAY BACK TO THE TOUR. It runs itself once, on first arrival at Home,
      // and its Skip button is meant to be pressed — which would make a
      // first-run-only tour unreachable forever for exactly the people who
      // later wish they had watched it. `action:` rather than `native:` because
      // this row opens a modal on THIS screen instead of navigating.
      { label: 'Take the tour', labelKey: 'nav.take-the-tour', href: 'action:tour', icon: 'compass' },
      { label: 'Ask Hawkeye', labelKey: 'nav.ask-hawkeye', href: 'native:/assistant', icon: 'message-square' },
      { label: 'How Hawkeye Works', labelKey: 'common.how-hawkeye-works', href: 'native:/page?slug=how', icon: 'help-circle' },
      { label: 'Observer Guide', labelKey: 'common.observer-guide', href: 'native:/page?slug=guide', icon: 'book-open' },
      { label: 'FAQ', labelKey: 'nav.faq', href: 'native:/page?slug=faq', icon: 'message-circle' },
      { label: 'About & Contact', labelKey: 'common.about-contact', href: 'native:/page?slug=about', icon: 'info' },
      { label: 'Support Hawkeye', labelKey: 'support.support-hawkeye', href: 'native:/support', icon: 'heart' },
      { label: 'Privacy & Data', labelKey: 'common.privacy-data', href: 'native:/page?slug=privacy', icon: 'lock' },
      { label: 'Terms of Service', labelKey: 'nav.terms-of-service', href: 'native:/terms', icon: 'file-text' },
    ],
  },
];

/**
 * The three appearance choices, in the order every OS lists them: follow the
 * device first, then the two overrides.
 */
/**
 * `labelKey`, not `label`. These three sat beside the language pills as the only
 * untranslated words in the section — "System / Light / Dark" in English next to
 * "Asụsụ Igbo" and "Èdè Yorùbá", which reads as a half-finished translation
 * rather than a deliberate one.
 */
const THEME_OPTIONS: {
  value: ThemePref;
  labelKey: string;
  icon: keyof typeof Feather.glyphMap;
}[] = [
  { value: 'system', labelKey: 'n.app.tabs.more.system', icon: 'smartphone' },
  { value: 'light', labelKey: 'n.app.tabs.more.light', icon: 'sun' },
  { value: 'dark', labelKey: 'n.app.tabs.more.dark', icon: 'moon' },
];

/**
 * Theme — Light / Dark / System. The first of the two Preferences cards.
 *
 * Deliberately a visible segmented control rather than a row that opens a
 * sheet: the reason this exists at all is that the app followed the OS with no
 * override and the setting could not be found. One more tap to reveal it would
 * not have fixed that.
 *
 * NO HEADING OF ITS OWN — PreferencesGroup below owns the heading for both
 * cards. Two cards under one heading rather than one card with four bands:
 * every divider in this app's cards is the same hairline, so merging would have
 * made the Theme/Language boundary look identical to the boundary between a
 * setting's own label and its control, and the pair would read as four equal
 * rows instead of two settings.
 */
function ThemeCard() {
  const ui = useUi();
  const { pref, scheme, setPref } = useThemePref();
  const current = THEME_OPTIONS.find((o) => o.value === pref) ?? THEME_OPTIONS[0];

  return (
    <View className="pb-2">
      <View className="overflow-hidden rounded-2xl bg-card">
        <View className="flex-row items-center px-4 py-3.5">
          {/* Themed, not the fixed light green it was: on the one row whose job
              is to prove the theme flips, a hardcoded #0b6b3a sat at ~2.5:1 on
              the dark card — under the 3:1 minimum for non-text, and a visible
              smudge beside tints that had all moved. */}
          <Feather name="droplet" size={17} color={ui.tint.good.ink} />
          <Text className="flex-1 pl-3 text-base text-ink">{i18nT('n.app.tabs.more.theme')}</Text>
          <Text className="text-sm text-muted">
            {/* Saying which way "System" currently lands saves anyone wondering
                whether the setting took effect at all. */}
            {current.value === 'system'
              ? `${i18nT('n.app.tabs.more.system')} · ${i18nT('n.app.tabs.more.' + scheme)}`
              : i18nT(current.labelKey)}
          </Text>
        </View>
        <View className="border-t border-line p-3">
          <View className="flex-row rounded-full bg-surface p-1">
            {THEME_OPTIONS.map((o) => {
              const on = o.value === pref;
              return (
                <Pressable
                  key={o.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${i18nT(o.labelKey)} — ${i18nT('n.app.tabs.more.theme')}`}
                  onPress={() => {
                    if (on) return;
                    Haptics.selectionAsync();
                    setPref(o.value);
                  }}
                  /* Selected is bg-card on a bg-surface track — the raised-on-
                     inset relationship the rest of the app uses, and the only
                     pair that separates in BOTH themes. bg-good was the first
                     choice (it is what contest-picker's active filter uses) but
                     in light mode #dff2e8 on #e8f2ec is two pale mints and the
                     selected pill vanished; the good-ink label carries that
                     signal instead. */
                  className={`flex-1 flex-row items-center justify-center rounded-full py-2 active:opacity-70 ${
                    on ? 'bg-card' : ''
                  }`}
                >
                  <Feather
                    name={o.icon}
                    size={14}
                    color={on ? ui.tint.good.ink : ui.muted}
                  />
                  <Text
                    className={`pl-1.5 text-xs font-bold ${on ? 'text-good-ink' : 'text-muted'}`}
                  >
                    {i18nT(o.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * Language — the same shape as Appearance directly above it, for the same
 * reason: a preference nobody can find is a preference nobody has. Four
 * options fit a segmented control, and each is labelled in ITS OWN language,
 * because someone looking for Hausa is looking for the word "Hausa" and not
 * for a row that currently says something they cannot read.
 *
 * The draft caveat is stated once under the control rather than against each
 * option: all three translations have the same standing, and repeating it four
 * times would crowd a row that has to stay scannable.
 */
function LanguageCard() {
  const ui = useUi();
  const { lang, setLang } = useI18n();

  return (
    <View className="pb-2">
      <View className="overflow-hidden rounded-2xl bg-card">
        <View className="flex-row items-center px-4 py-3.5">
          <Feather name="globe" size={17} color={ui.tint.good.ink} />
          <Text className="flex-1 pl-3 text-base text-ink">
            {i18nT('n.app.tabs.more.language')}
          </Text>
          <Text className="text-sm text-muted">{LANG_NAMES[lang].native}</Text>
        </View>
        <View className="border-t border-line p-3">
          <View className="flex-row rounded-full bg-surface p-1">
            {LANGS.map((code) => {
              const on = code === lang;
              return (
                <Pressable
                  key={code}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={LANG_NAMES[code].english}
                  onPress={() => {
                    if (on) return;
                    Haptics.selectionAsync();
                    setLang(code);
                  }}
                  className={`flex-1 items-center justify-center rounded-full py-2 active:opacity-70 ${
                    on ? 'bg-card' : ''
                  }`}
                >
                  <Text
                    numberOfLines={1}
                    className={`text-xs font-bold ${on ? 'text-good-ink' : 'text-muted'}`}
                  >
                    {LANG_NAMES[code].native}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {lang !== 'en' ? (
            <Text className="px-1 pt-2.5 text-[11px] leading-4 text-muted">
              {i18nT('n.app.tabs.more.draft-translation-being-reviewed')}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Preferences — the two settings this app has, under one heading.
 *
 * IT WAS "APPEARANCE", AND IT WAS AT THE TOP. Both changed together.
 *
 * The name, because the section stopped being about appearance the moment
 * Language joined it. The position, because the argument for top billing —
 * written here as "it is the one setting in the app and nobody could find it" —
 * had stopped being true twice over: there are two settings now, and the
 * discoverability problem it named was already solved by the control existing
 * at all and by its being a visible segmented control rather than a row behind
 * a tap. Position was a third remedy for a problem fixed twice, and the rent
 * was paid by the four navigation groups.
 *
 * This screen is the only route to Practice Run, Map a Polling Unit and My
 * Profile — things an observer reaches WITH A QUEUE BEHIND THEM. Theme and
 * language are set once, at home, the night before. Two preference cards plus
 * the compliance banner above "Take part" put the every-time controls below the
 * fold on a mid-range phone, and further at an accessibility font scale. That
 * is the frequency ordering exactly inverted.
 *
 * It also matches the web, which this screen documents itself as carrying over
 * 1:1: app/menu.js builds every navigation group first and appends its theme
 * row last. Native was the outlier against its own stated source of truth.
 *
 * Placed above SocialRow rather than below it — native's "Find Hawkeye" section
 * plus the LLC line read as a footer, and a setting below a footer is worse
 * than the small parity gap with menu.js.
 */
function PreferencesGroup() {
  return (
    <View className="pb-2">
      <Text className="pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
        {i18nT('n.app.tabs.more.preferences')}
      </Text>
      <ThemeCard />
      <LanguageCard />
    </View>
  );
}

// A collapsible menu entry — Report is now the only one, since Races became a
// single link: a normal-looking row whose chevron flips and whose sub-links
// reveal below, indented. Default closed — the point is a shorter menu. Report
// earns it because its three children are three genuinely different filings
// (result, collation, incident) with no page above them that lists all three;
// Races did not, because /races already is that page.
function MenuAccordion({
  title,
  icon,
  items,
  border,
}: {
  title: string;
  icon: Icon;
  items: MenuLink[];
  border: boolean;
}) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const go = (href: string) =>
    href.startsWith('native:')
      ? router.push(href.slice(7) as never)
      : WebBrowser.openBrowserAsync(`https://hawkeye.com.ng/${href}`);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className={`flex-row items-center px-4 py-3.5 active:bg-surface ${border ? 'border-t border-line' : ''}`}
        onPress={() => {
          Haptics.selectionAsync();
          setOpen((o) => !o);
        }}
      >
        <Feather name={icon} size={17} color={ui.tint.good.ink} />
        <Text className="flex-1 pl-3 text-base text-ink">{title}</Text>
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={16} color={ui.faint} />
      </Pressable>
      {open &&
        items.map((it) => (
          <Pressable
            key={it.href}
            className="flex-row items-center border-t border-line py-3 pl-11 pr-4 active:bg-surface"
            onPress={() => go(it.href)}
          >
            {/* The LEADING icon is the row's own mark and takes the row colour,
                the same as every top-level row above; `ui.faint` is the chevron
                colour and giving it to a leading icon is what made these three
                read as disabled. Only the trailing chevron stays faint. */}
            <Feather name={it.icon} size={16} color={ui.tint.good.ink} />
            <Text className="flex-1 pl-3 text-[15px] text-ink">{i18nT(it.labelKey)}</Text>
          </Pressable>
        ))}
    </View>
  );
}

export default function More() {
  const ui = useUi();
  const { translateY, onScroll, headerH, scrollEventThrottle } = useHideOnScroll();
  const [tourOpen, setTourOpen] = useState(false);
  return (
    <View className="flex-1 bg-surface">
      {/* Controlled, not `auto`: this is the replay, and it must open when the
          row is tapped regardless of whether the device has seen it before. */}
      <Tour visible={tourOpen} onClose={() => setTourOpen(false)} />
      {/* Tab screen: right="none" — the tab bar owns navigation, and this IS the
          menu the shared header's menu button points at. The big in-scroll
          "More" title is gone; the header carries it now. */}
      <ScreenHeader title={i18nT('nav.more')} right="none" translateY={translateY} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        contentContainerStyle={{ paddingTop: headerH + 12, paddingHorizontal: 16, paddingBottom: 32 }}
      >
        {/* GovDisclaimer STAYS AT THE TOP and does not travel with Preferences.
            Its docblock records it as a Play "Misleading Claims" remedy that
            has to be visible without interaction, and tests/gov_disclaimer_test
            pins this screen as a required mount site — burying it below four
            menu groups would be a store-compliance regression, not a layout
            choice. Preferences moved; this did not. */}
        <GovDisclaimer />
        {GROUPS.map((g) => (
          <View key={g.title} className="pb-2">
            <Text className="pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {i18nT(g.titleKey)}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              {g.items.map((it, i) =>
                'acc' in it ? (
                  <MenuAccordion key={it.acc} title={i18nT(it.accKey)} icon={it.icon} items={it.items} border={i > 0} />
                ) : (
                  <Pressable
                    key={it.href}
                    className={`flex-row items-center px-4 py-3.5 active:bg-surface ${
                      i > 0 ? 'border-t border-line' : ''
                    }`}
                    onPress={() =>
                      it.href === 'action:tour'
                        ? setTourOpen(true)
                        : it.href.startsWith('native:')
                          ? router.push(it.href.slice(7) as never)
                          : WebBrowser.openBrowserAsync(`https://hawkeye.com.ng/${it.href}`)
                    }
                  >
                    <Feather name={it.icon} size={17} color={ui.tint.good.ink} />
                    <Text className="flex-1 pl-3 text-base text-ink">{i18nT(it.labelKey)}</Text>
                    <Feather name="chevron-right" size={16} color={ui.faint} />
                  </Pressable>
                ),
              )}
            </View>
          </View>
        ))}
        <PreferencesGroup />
        {/* Heading included — SocialRow owns the whole "Find Hawkeye" section. */}
        <SocialRow />
        {/* The independence/INEC sentence lived here AND in the disclaimer bar at
            the top of this same screen. One of them had to go. */}
        <Text className="pt-5 text-center text-xs text-faint">{i18nT('n.app.tabs.more.inixien-llc')}</Text>
      </Animated.ScrollView>
    </View>
  );
}

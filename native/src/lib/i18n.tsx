import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { BASE } from '@/lib/api';

import en from '@/lib/i18n/en.json';
import ha from '@/lib/i18n/ha.json';
import ig from '@/lib/i18n/ig.json';
import yo from '@/lib/i18n/yo.json';

/**
 * i18n — the app's language, and every string it renders.
 *
 * ── WHY NOT i18next ──
 * That was the plan, and the measurement did not support it. i18next plus
 * react-i18next is ~20 kB of JS whose main draw is a plural engine, and on
 * Hermes it also needs the FormatJS `Intl.PluralRules` polyfill (another
 * ~30 kB with its locale data) or plurals silently fall back to English —
 * a failure mode that looks like nothing at all.
 *
 * What this app actually needs from a plural engine is thirteen strings of the
 * form "{n} observer(s)", and only ENGLISH inflects them: Yorùbá and Igbo are
 * "other"-only in CLDR, and Hausa does not mark plural on the noun in these
 * constructions. So the rule is four lines (see `plural` below) and applies to
 * one language. Paying 50 kB and a polyfill to move it into a library would be
 * the wrong trade in an app whose size is a shipping constraint.
 *
 * The bundles are the same shape as app/i18n/*.json on the web, and the storage
 * key is the same string, so the two clients cannot drift on what "the language
 * is Hausa" means.
 *
 * ── WHY IT TELLS THE SERVER ──
 * The server sends push notifications, Telegram messages and OTP codes; it
 * cannot read this device's storage. `observers.lang` is the copy it uses, and
 * PUT /api/observers/language is how it learns. Best-effort: the app has
 * already changed language by then, and a failed call only delays notifications
 * until the next one.
 */

export const LANGS = ['en', 'ha', 'ig', 'yo'] as const;
export type Lang = (typeof LANGS)[number];

/** The same key app/i18n.js writes in the browser. Deliberately identical. */
export const LANG_KEY = 'hawkeye_lang';

const BUNDLES: Record<Lang, Record<string, string>> = {
  en: en as Record<string, string>,
  ha: ha as Record<string, string>,
  ig: ig as Record<string, string>,
  yo: yo as Record<string, string>,
};

export const LANG_NAMES: Record<Lang, { native: string; english: string }> = {
  en: { native: 'English', english: 'English' },
  ha: { native: 'Hausa', english: 'Hausa' },
  ig: { native: 'Asụsụ Igbo', english: 'Igbo' },
  yo: { native: 'Èdè Yorùbá', english: 'Yoruba' },
};

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

/**
 * Plural selection, English only.
 *
 * A key with a `_one` variant uses it when count === 1; everything else takes
 * the base key. The other three bundles simply have no `_one`, which is not an
 * omission — Yorùbá and Igbo have a single CLDR form, and Hausa does not
 * inflect the noun here.
 */
function plural(bundle: Record<string, string>, key: string, count: number | undefined): string | undefined {
  if (count === 1 && bundle[key + '_one'] != null) return bundle[key + '_one'];
  return bundle[key];
}

/**
 * Translate.
 *
 * Falls through the chosen bundle, then English, then the key itself. A missing
 * `{placeholder}` is left with its braces on: a sentence with a visible hole is
 * a bug someone reports, a sentence missing a number silently is not.
 */
export function translate(lang: Lang, key: string, params?: Record<string, string | number | null | undefined>): string {
  const count = typeof params?.count === 'number' ? params.count : undefined;
  const s = plural(BUNDLES[lang] ?? BUNDLES.en, key, count) ?? plural(BUNDLES.en, key, count);
  if (s == null) return key;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  ));
}

/**
 * `t` IS A PLAIN FUNCTION, NOT A HOOK, AND THAT IS THE WHOLE DESIGN.
 *
 * Fifty-two files render translated text, much of it inside `.map()` callbacks
 * and small render helpers that are not components. Making every call site
 * obtain `t` from a hook means deciding, for each one, which enclosing function
 * is a component — a judgement a codemod gets wrong, and getting it wrong means
 * a hook called conditionally or outside a component, which React punishes at
 * runtime rather than at build time.
 *
 * So `t` reads a module variable, and getting every render function to run
 * again is the provider's job — done by REMOUNTING, not by relying on a state
 * change to propagate. See the note on `key={lang}` below for why: setting
 * state on the provider alone does NOT reach components that never consume the
 * context, and measuring it in the running app is how that was established
 * rather than assumed.
 *
 * A memoised component still needs useT() on top of the remount, because
 * React.memo can skip even a remounted parent's child when props are equal.
 * There is exactly one in the app (ResultsMap), and it does.
 */
let currentLang: Lang = 'en';

export function t(key: string, params?: Record<string, string | number | null | undefined>): string {
  return translate(currentLang, key, params);
}

/**
 * The chosen language, for the sign-up call.
 *
 * lib/auth.ts cannot hold a hook — requestOtp is a plain async function — and
 * importing the provider's context there would be a cycle. This is the same
 * module variable `t` reads.
 */
/**
 * A map whose values are translated WHEN READ, not when the module loads.
 *
 * `const ERRORS = { gps_required: t('n...') }` looks right and is not: module
 * constants are evaluated at import, before AsyncStorage has returned the
 * stored language, so every value froze as English and no remount could move
 * it. Holding the key and translating in the proxy's getter keeps the call
 * sites ("ERRORS[code]") exactly as they were.
 *
 * Values that are not keys (a plain English literal, a number) pass through, so
 * a map can hold both.
 */
export function lazyT<T extends object>(entries: T): T {
  return new Proxy(entries, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v === 'string') return v.startsWith('n.') ? t(v) : v;
      /* Arrays of objects and nested objects freeze exactly as flat maps do --
         FILTERS on the home feed is a list of { key, label } -- so the getter
         recurses rather than handing back a raw inner object. Functions
         (.map, .find) are returned as they are and still see the proxy. */
      if (v !== null && typeof v === 'object') return lazyT(v as object);
      return v;
    },
  });
}

export function currentLangForOtp(): Lang {
  return currentLang;
}

/**
 * The chosen language, for lib/content.ts.
 *
 * Same module variable, a second name: content.ts asks for it during render, to
 * translate the explainer tree, and calling it "ForOtp" at that site would read
 * as a mistake. It is a plain function rather than a hook for exactly the reason
 * `t` is — see the note above.
 */
export function currentLang_(): Lang {
  return currentLang;
}

type LangState = {
  lang: Lang;
  /** True once the stored choice has been read — nothing has to wait on it. */
  ready: boolean;
  /** Has the reader ever chosen? Distinct from "is English": drives the prompt. */
  chosen: boolean;
  setLang: (next: Lang) => void;
  t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
};

const Ctx = createContext<LangState | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  const [chosen, setChosen] = useState(false);
  const [ready, setReady] = useState(false);

  /* The module variable and the React state are set together, always. The
     module variable is what `t()` reads; the state is what re-renders the tree
     so those reads happen again. Either one alone is a language change that
     half-applies. */
  const apply = useCallback((next: Lang) => {
    currentLang = next;
    setLangState(next);
  }, []);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(LANG_KEY)
      .then((v) => {
        if (!alive) return;
        if (isLang(v)) { apply(v); setChosen(true); }
      })
      .catch(() => { /* unreadable storage means English, which is a fine default */ })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [apply]);

  const setLang = useCallback((next: Lang) => {
    apply(next);
    setChosen(true);
    AsyncStorage.setItem(LANG_KEY, next).catch(() => { /* the app is already in it */ });
    tellServer(next);
  }, [apply]);

  const value = useMemo<LangState>(() => ({
    lang,
    ready,
    chosen,
    setLang,
    t: (key, params) => translate(lang, key, params),
  }), [lang, ready, chosen, setLang]);

  /**
   * `key={lang}` REMOUNTS THE APP WHEN THE LANGUAGE CHANGES, and it is the
   * reason this design is safe.
   *
   * `t` is a module function, so a component only shows the new language if its
   * render function runs again. Context propagation reaches CONSUMERS, but
   * almost nothing here consumes the context — that was the whole point of not
   * threading a hook through fifty-two files. And `children` arriving as a
   * stable element lets React bail out of re-rendering the subtree when only
   * this component's state changed. Measured in the running app: the
   * hook-driven half of a card updated while the `t`-driven half beside it
   * stayed in Hausa.
   *
   * A remount re-runs every render function beneath it, so there is no
   * subscriber to miss. The cost is losing in-memory screen state, which for a
   * deliberate, rare settings action is the right trade — and the outbox,
   * auth and the report drafts are all persisted outside React anyway.
   */
  return (
    <Ctx.Provider value={value}>
      <Fragment key={lang}>{children}</Fragment>
    </Ctx.Provider>
  );
}

/**
 * NEVER THROWS WHEN THE PROVIDER IS ABSENT.
 *
 * Screens are rendered outside the provider in two real situations — the
 * headless store-screenshot harness, and any test that mounts one component on
 * its own. A hook that threw there would turn "this screen is not translated"
 * into "this screen is a red box", which is a much worse trade for a string
 * lookup. English is always a correct answer.
 */
export function useI18n(): LangState {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return {
    lang: 'en',
    ready: true,
    chosen: false,
    setLang: () => {},
    t: (key, params) => translate('en', key, params),
  };
}

/** Just the translate function, for the common case. */
export function useT() {
  return useI18n().t;
}

async function tellServer(lang: Lang) {
  try {
    /* IMPORTED LAZILY, to break a cycle. lib/auth.ts imports this module for
       currentLangForOtp(); importing it back at the top would make the two
       modules circular, which ESM tolerates only as long as nobody touches a
       binding during evaluation — a constraint no future edit is obliged to
       remember. A dynamic import inside the function has no such rule. */
    const { getToken } = await import('@/lib/auth');
    const token = getToken();
    if (!token) return;   // signed out: it rides the OTP request at sign-up
    await fetch(`${BASE}/api/observers/language`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ lang }),
    });
  } catch {
    /* Notifications lag until the next change or sign-in. The app is correct. */
  }
}

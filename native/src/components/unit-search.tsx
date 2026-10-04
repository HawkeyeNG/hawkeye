import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { RegisterTierBadge } from '@/components/unit-map';
import { BRAND } from '@/lib/api';
import {
  ensureStateHeld,
  localSearch,
  rememberedState,
  rememberState,
  warmRegister,
} from '@/lib/register';
import { useUi } from '@/lib/theme';
import { t as i18nT } from '@/lib/i18n';

/**
 * Free-text polling-unit search — the native twin of app/pu-search.js, sharing
 * its endpoint (`GET /api/register/search`).
 *
 * Every native PU picker offered exactly two routes to a unit: GPS "near me",
 * and the state → LGA → ward cascade. Neither serves the common case of knowing
 * your unit's NAME but not the ward the register files it under. This matches
 * name, unit code and ward on partial input — "aso dr" finds "Aso Drive".
 *
 * It returns the row shape `/api/register/units` already returns, so each
 * screen's existing select handler takes it unchanged.
 */
// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

/** How long a search may wait on the server before the phone's own pack answers. */
const SEARCH_TIMEOUT_MS = 8_000;

/** Only the fields this component itself renders; callers keep their own types.
 *  The coordinate columns are here because the row states whether the unit's
 *  LOCATION is known — see the badge in the list below. */
type Row = {
  pu_code: string;
  name: string;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
  coords_source?: string | null;
  locationTier?: string;
  lat?: number | null;
  crowd_lat?: number | null;
};

export function UnitSearch<T extends Row>({
  onSelect,
  state,
  lga,
  placeholder = i18nT('n.components.unit-search.name-ward-or-unit-number'),
  onEngaged,
  selectedCode,
  onContinue,
  accent = false,
}: {
  onSelect: (unit: T) => void;
  /** Optional narrowing when the caller already knows where it is. */
  state?: string | null;
  lga?: string | null;
  placeholder?: string;
  /** Fires when the observer starts/stops using this search (typing), so the
   *  host screen can clear space — e.g. map-unit hides the map + nearby list. */
  onEngaged?: (active: boolean) => void;
  /**
   * THE SAME SELECTED TREATMENT THE NEARBY ROWS GET. Tapping a search result
   * only sets the host's `unit`; nothing on the row changed, so the only
   * evidence a choice had registered was a footer CTA that in a dense ward sits
   * well below the row just tapped. The nearby list has shown a filled row and
   * an inline Continue since launch — search simply never got it, and the two
   * lists sit one above the other on the same screen.
   */
  selectedCode?: string | null;
  /** Omit and the row still highlights — it just carries no inline button,
   *  which is right on screens whose next step is not "continue". */
  onContinue?: () => void;
  /** A brand-gold ring while the field has focus, so on a screen whose one job
   *  is this search the box is unmistakably where to type. The unfocused ring
   *  is transparent, not absent, so focusing does not shift the layout by 2px. */
  accent?: boolean;
}) {
  const ui = useUi();
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  useEffect(() => { onEngaged?.(q.trim().length > 0); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState<T[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Monotonic request id: a slow earlier response must never overwrite a newer one.
  const seq = useRef(0);

  /**
   * THE STATE TO SEARCH OFFLINE when the host names none: the state of the last
   * unit chosen anywhere, or the observer's saved unit (lib/register.ts
   * rememberState). Flow walkthrough REP-UNIT-02: no host ever passed `state`,
   * so the packs never answered and every offline search failed.
   *
   * It is a FALLBACK, not a filter. A host-given `state` still narrows the
   * server query and answers from the pack first, as before; a remembered one
   * never narrows anything online — an observer saved in Lagos who reports in
   * Ogun must still find their Ogun unit by name — and is read only when the
   * server cannot be reached.
   */
  const [remembered, setRemembered] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rememberedState().then((s) => { if (live) setRemembered(s); });
    return () => { live = false; };
  }, []);
  const offlineState = state ?? remembered;

  // Pull the packs as soon as the box exists, not on the first keystroke:
  // someone opening this is about to search, and there are a few seconds of
  // tapping first — enough for a ~32 KB state pack on most links. The index
  // (~56 KB) comes either way, since it is what makes browse work offline.
  useEffect(() => { warmRegister(offlineState); }, [offlineState]);

  const say = (units: T[], truncated: boolean, term: string, server: boolean) => {
    setRows(units);
    setNote(
      units.length === 0
        ? i18nT('n.components.unit-search.no-unit-matches-try-fewer-letters', { v0: term })
        : truncated
          ? server
            ? i18nT('n.components.unit-search.first-matches-keep-typing-to-narrow-2', { v0: units.length })
            : i18nT('n.components.unit-search.first-matches-keep-typing-to-narrow', { v0: units.length })
          : units.length === 1
            ? i18nT('n.components.unit-search.one-match')
            : i18nT('n.components.unit-search.n-matches', { v0: units.length }),
    );
  };

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setRows(null);
      setNote(term ? i18nT('n.components.unit-search.keep-typing-at-least-3') : '');
      return;
    }
    // OFFLINE FIRST for a state the HOST named. If its pack is decoded, answer
    // from it and do not touch the network at all — instant, and it still
    // works at a polling unit with no signal.
    const local = state ? localSearch(term, { state, lga }) : null;
    if (local && local.units.length) {
      seq.current += 1; // supersede any request still in flight
      setBusy(false);
      say(local.units as T[], local.truncated, term, false);
      return;
    }

    // Debounced: every keystroke is a full-table LIKE scan server-side.
    const t = setTimeout(async () => {
      const mine = ++seq.current;
      setBusy(true);
      try {
        const p = new URLSearchParams({ q: term });
        if (state) p.set('state', state);
        if (lga) p.set('lga', lga);
        /* A DEADLINE. React Native's fetch never times out by itself, and a
           phone with bars but no data (election morning, one mast) would sit on
           a spinner instead of reaching the offline answer below. */
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS);
        let r: { units?: T[]; truncated?: boolean };
        try {
          r = await fetch(`${BASE}/api/register/search?${p}`, { signal: ctl.signal }).then((x) => x.json());
        } finally {
          clearTimeout(timer);
        }
        if (mine !== seq.current) return;
        say(r.units ?? [], !!r.truncated, term, true);
      } catch {
        if (mine !== seq.current) return;
        /* The server could not be reached: answer from the remembered state's
           pack if it is on this phone (a storage read, no network), and say
           plainly which of the two things is missing when it is not. */
        const held = await ensureStateHeld(offlineState);
        if (mine !== seq.current) return;
        const off = held ? localSearch(term, { state: offlineState, lga }) : null;
        if (off) {
          say(off.units as T[], off.truncated, term, false);
        } else {
          setRows(null);
          setNote(
            offlineState
              ? i18nT('n.components.unit-search.offline-no-pack', { v0: offlineState })
              : i18nT('n.components.unit-search.offline-browse'),
          );
        }
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q, state, lga, offlineState]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View className="mt-4">
      <Text className="pb-1.5 text-sm font-bold text-ink">{i18nT('n.components.unit-search.search-for-your-polling-unit')}</Text>
      <View
        className={`flex-row items-center rounded-2xl bg-card px-3.5 ${
          accent ? `border-2 ${focused ? 'border-hawk-gold' : 'border-transparent'}` : ''
        }`}
      >
        <TextInput
          value={q}
          onChangeText={setQ}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={ui.faint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          className="flex-1 py-3 text-base text-ink"
        />
        {busy ? <ActivityIndicator size="small" /> : null}
      </View>
      {note ? <Text className="pt-1.5 text-xs text-muted">{note}</Text> : null}
      {rows?.map((u) => {
        const sel = selectedCode != null && selectedCode === u.pu_code;
        return (
        <Pressable
          key={u.pu_code}
          onPress={() => {
            // The next search — here or on any picker — can answer offline.
            void rememberState(u.state);
            onSelect(u);
          }}
          className={`mt-2 flex-row items-center rounded-2xl px-4 py-3 active:opacity-70 ${
            sel ? 'bg-hawk-green' : 'bg-card'
          }`}
        >
          <View className="flex-1 pr-2">
          <Text className={`text-base font-semibold ${sel ? 'text-white' : 'text-ink'}`}>{u.name}</Text>
          <Text className={`pt-0.5 text-xs ${sel ? 'text-emerald-100' : 'text-muted'}`}>
            {u.pu_code}
            {u.ward ? ` · ${u.ward}` : ''}
            {u.lga ? `, ${u.lga}` : ''}
            {u.state ? `, ${u.state}` : ''}
          </Text>
          {/* WHETHER THE UNIT'S LOCATION IS KNOWN, in the same words and the
              same dot the browse lists, the nearby rows and the map legend use.
              Search shipped without it while every other list on both platforms
              carried one — so the same unit read "location verified" on the
              website and said nothing here, and an observer picking from search
              could not tell a mapped unit from one nobody has stood at. That
              distinction decides whether the geofence can check them in. */}
          <RegisterTierBadge u={u} selected={sel} />
          </View>
          {/* Inline Continue on the chosen row, for the same reason the nearby
              list has one: in a dense ward the footer CTA can sit far below the
              row just tapped. */}
          {sel && onContinue ? (
            <Pressable
              className="flex-row items-center rounded-xl bg-hawk-gold px-3 py-2 active:opacity-80"
              onPress={onContinue}
            >
              {/* Fixed ink on a fixed brand surface — the gold does not flip
                  with the theme, so the text on it must not either. */}
              <Text className="pr-1 text-sm font-bold text-hawk-ink">{i18nT('n.app.practice.continue')}</Text>
              <Feather name="arrow-right" size={14} color={BRAND.ink} />
            </Pressable>
          ) : null}
        </Pressable>
        );
      })}
    </View>
  );
}

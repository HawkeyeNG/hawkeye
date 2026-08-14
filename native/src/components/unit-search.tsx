import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { RegisterTierBadge } from '@/components/unit-map';
import { localSearch, warmRegister } from '@/lib/register';
import { useUi } from '@/lib/theme';

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
const BASE = 'https://hawkeye.com.ng';

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
  placeholder = 'Name, ward or unit number',
  onEngaged,
}: {
  onSelect: (unit: T) => void;
  /** Optional narrowing when the caller already knows where it is. */
  state?: string | null;
  lga?: string | null;
  placeholder?: string;
  /** Fires when the observer starts/stops using this search (typing), so the
   *  host screen can clear space — e.g. map-unit hides the map + nearby list. */
  onEngaged?: (active: boolean) => void;
}) {
  const ui = useUi();
  const [q, setQ] = useState('');
  useEffect(() => { onEngaged?.(q.trim().length > 0); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState<T[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Monotonic request id: a slow earlier response must never overwrite a newer one.
  const seq = useRef(0);

  // Parse the bundled register as soon as the box exists, not on first
  // keystroke: someone opening this is about to search, and there are a few
  // seconds of tapping first — enough to be ready before they finish typing.
  useEffect(() => { warmRegister(); }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setRows(null);
      setNote(term ? 'Keep typing — at least 3 characters.' : '');
      return;
    }
    // OFFLINE FIRST. If the bundled register is parsed, answer from it and do
    // not touch the network at all — instant, and it still works at a polling
    // unit with no signal. Only Osun is bundled, so anything else falls through.
    const local = localSearch(term, { state, lga });
    if (local && local.units.length) {
      seq.current += 1; // supersede any request still in flight
      setBusy(false);
      setRows(local.units as T[]);
      setNote(local.truncated
        ? `First ${local.units.length} matches — keep typing to narrow it.`
        : `${local.units.length} match${local.units.length === 1 ? '' : 'es'}.`);
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
        const r = await fetch(`${BASE}/api/register/search?${p}`).then((x) => x.json());
        if (mine !== seq.current) return;
        const units: T[] = r.units ?? [];
        setRows(units);
        setNote(
          units.length === 0
            ? `No unit matches “${term}”. Try fewer letters, or browse the register below.`
            : r.truncated
              ? `First ${units.length} matches — keep typing to narrow it.`
              : `${units.length} match${units.length === 1 ? '' : 'es'}.`,
        );
      } catch {
        if (mine === seq.current) { setRows(null); setNote('Could not search just now — check your connection.'); }
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q, state, lga]);

  return (
    <View className="mt-4">
      <Text className="pb-1.5 text-sm font-bold text-ink">Search for your polling unit</Text>
      <View className="flex-row items-center rounded-2xl bg-card px-3.5">
        <TextInput
          value={q}
          onChangeText={setQ}
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
      {rows?.map((u) => (
        <Pressable
          key={u.pu_code}
          onPress={() => onSelect(u)}
          className="mt-2 rounded-2xl bg-card px-4 py-3 active:opacity-70"
        >
          <Text className="text-base font-semibold text-ink">{u.name}</Text>
          <Text className="pt-0.5 text-xs text-muted">
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
          <RegisterTierBadge u={u} />
        </Pressable>
      ))}
    </View>
  );
}

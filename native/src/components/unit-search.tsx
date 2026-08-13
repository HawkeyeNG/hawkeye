import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

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

/** Only the fields this component itself renders; callers keep their own types. */
type Row = {
  pu_code: string;
  name: string;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
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

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setRows(null);
      setNote(term ? 'Keep typing — at least 3 characters.' : '');
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
        </Pressable>
      ))}
    </View>
  );
}

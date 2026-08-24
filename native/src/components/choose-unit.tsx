import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, Text, View } from 'react-native';

import { ModalCard } from '@/components/modal-card';
import { UnitSearch } from '@/components/unit-search';
import { BRAND } from '@/lib/api';
import { getIdentity } from '@/lib/identity';
import { describeFixFailure, tryQuickFix } from '@/lib/location';
import * as SecureStore from '@/lib/secure-store';
import { useUi } from '@/lib/theme';

const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

/**
 * CHOOSE your polling unit. Not map one.
 *
 * "My Polling Unit" in the profile used to open /map-unit — a screen titled
 * "Map a polling unit", whose instruction is "Stand at the polling unit and
 * record one GPS fix" and whose primary button is "I am standing here — record
 * fix". Saving is a secondary row on it. Someone who just wants to say which
 * unit is theirs was being handed a surveying tool and asked to be standing in
 * the right place to use it. Those are different jobs: mapping contributes a
 * coordinate to the register, choosing is a preference about alerts.
 *
 * /map-unit is untouched and still the right screen for the surveying job.
 *
 * ASSEMBLY, NOT NEW MACHINERY. `UnitSearch` is already written to drop into any
 * host and works offline from the register packs; `tryQuickFix` and
 * `describeFixFailure` are the shared location helpers every other screen uses;
 * `POST /api/observers/my-unit` is the one writer. The only new thing here is
 * the arrangement.
 *
 * NEAR-ME IS DELIBERATELY THE SIMPLE ONE. map-unit's version also takes an
 * envelope, draws a ring and captions it — all of which serve a map this modal
 * does not have. Here it is one lookup that shortlists units, because that is
 * the whole job.
 */
type Row = {
  pu_code: string;
  name: string;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
};

export function ChooseUnitModal({
  visible,
  onClose,
  onSaved,
  current,
}: {
  visible: boolean;
  onClose: () => void;
  /** Fires with the saved unit so the host can update without a refetch. */
  onSaved?: (unit: Row) => void;
  /**
   * The unit already saved, so the list can mark it. Looser than `Row` on
   * purpose: this comes from /api/observers/me, where a register row with no
   * name is possible, whereas everything UnitSearch hands back is named.
   */
  current?: { pu_code: string; name?: string | null } | null;
}) {
  const ui = useUi();
  const [near, setNear] = useState<Row[]>([]);
  const [nearBusy, setNearBusy] = useState(false);
  const [nearLine, setNearLine] = useState<string | null>(null);
  const [gpsSettings, setGpsSettings] = useState(false);
  const [picked, setPicked] = useState<Row | null>(null);
  const [saving, setSaving] = useState(false);

  const findNearby = async () => {
    setNearBusy(true);
    setNear([]);
    setGpsSettings(false);
    setNearLine('Getting your location…');
    try {
      const r = await tryQuickFix();
      if (!r.ok) {
        // NAMED failures, not one message for all of them. Telling an observer
        // with working permission that they have none is how this screen loses
        // the people it is for — the same discrimination map-unit makes.
        const d = describeFixFailure(r);
        setNearLine(`${d.lead}, or search for it below. (${d.code})`);
        setGpsSettings(d.settings);
        return;
      }
      const res = await fetch(`${BASE}/api/polling-units?lat=${r.fix.lat}&lng=${r.fix.lng}`).catch(() => null);
      const rows = res && res.ok ? ((await res.json().catch(() => [])) as Row[]) : [];
      const list = Array.isArray(rows) ? rows.slice(0, 8) : [];
      setNear(list);
      setNearLine(list.length ? null : 'No units found near you — search for it below.');
    } catch {
      setNearLine('Could not check your location — search for it below.');
    } finally {
      setNearBusy(false);
    }
  };

  const save = async (unit: Row) => {
    setSaving(true);
    try {
      const token = await SecureStore.getItemAsync('hawkeye.auth.token');
      const id = await getIdentity();
      const res = await fetch(`${BASE}/api/observers/my-unit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-device-id': id.deviceId,
        },
        body: JSON.stringify({ puCode: unit.pu_code }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        const code = body.error ?? `http_${res.status}`;
        // The code is in the message on purpose: "try again" with nothing to
        // report is the message that wastes a support round-trip.
        Alert.alert(
          'Could not save your polling unit',
          code === 'unknown_unit'
            ? `${unit.name} is not in the register. (${code} / HTTP ${res.status})`
            : `Please check your connection and try again. (${code} / HTTP ${res.status})`,
        );
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved?.(unit);
      close();
    } catch {
      Alert.alert('Could not save your polling unit', 'Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    setPicked(null);
    setNear([]);
    setNearLine(null);
    setGpsSettings(false);
    onClose();
  };

  const chosen = picked ?? null;

  const UnitRow = ({ u }: { u: Row }) => {
    const on = chosen?.pu_code === u.pu_code;
    const isCurrent = current?.pu_code === u.pu_code;
    return (
      <Pressable
        onPress={() => setPicked(u)}
        className={`mb-2 rounded-2xl px-3 py-2.5 ${on ? 'bg-good' : 'bg-card'}`}
      >
        <View className="flex-row items-center">
          <View className="flex-1 pr-2">
            <Text className={`text-sm font-bold ${on ? 'text-good-ink' : 'text-ink'}`}>{u.name}</Text>
            <Text className="pt-0.5 text-[11px] text-muted">
              {[u.ward, u.lga, u.state].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {isCurrent ? (
            <Text className="text-[10px] font-bold uppercase text-muted">Saved</Text>
          ) : null}
          {on ? <Feather name="check" size={16} color={ui.tint.good.ink} /> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <ModalCard
      visible={visible}
      onClose={close}
      title="Choose your polling unit"
      footer={
        <View className="flex-row">
          <Pressable
            onPress={close}
            className="mr-2 flex-1 items-center rounded-full border border-line py-3 active:opacity-70"
          >
            <Text className="text-sm font-bold text-muted">Cancel</Text>
          </Pressable>
          {/* The commit is disabled until something is chosen, rather than
              hidden: a footer that appears and disappears moves the Cancel
              button under the reader's thumb between taps. */}
          <Pressable
            disabled={!chosen || saving}
            onPress={() => chosen && save(chosen)}
            className={`flex-1 items-center rounded-full py-3 ${!chosen || saving ? 'bg-disabled' : 'bg-good active:opacity-80'}`}
          >
            {saving ? (
              <ActivityIndicator color={ui.tint.good.ink} />
            ) : (
              <Text className={`text-sm font-bold ${chosen ? 'text-good-ink' : 'text-faint'}`}>
                Save this unit
              </Text>
            )}
          </Pressable>
        </View>
      }
    >
      <Text className="pb-3 text-sm text-muted">
        This is the unit you will get alerts about. You do not need to be there
        now — to record a unit&apos;s location instead, use Map a Polling Unit.
      </Text>

      {/* GPS FIRST, same order every other picker uses: the drill-down is four
          taps deep before it shows a unit. */}
      <Pressable
        disabled={nearBusy}
        onPress={findNearby}
        className={`flex-row items-center justify-center rounded-2xl py-3.5 ${nearBusy ? 'bg-disabled' : 'bg-hawk-green active:opacity-80'}`}
      >
        {nearBusy ? (
          <ActivityIndicator color={BRAND.gold} />
        ) : (
          <>
            <Feather name="crosshair" size={16} color={BRAND.gold} />
            <Text className="pl-2 text-sm font-bold text-hawk-gold">Find units near me</Text>
          </>
        )}
      </Pressable>

      {nearLine ? (
        <Text className="pt-3 text-sm font-semibold text-warn-ink">{nearLine}</Text>
      ) : null}
      {/* Only for the failures the settings app actually cures. The button above
          is already the retry, so a weak signal gets the sentence and another
          tap, not a detour into system settings. */}
      {gpsSettings ? (
        <Pressable
          onPress={() => Linking.openSettings()}
          className="mt-2 flex-row items-center self-start rounded-xl border border-line px-3 py-2 active:opacity-70"
        >
          <Feather name="settings" size={14} color={ui.muted} />
          <Text className="pl-2 text-sm font-semibold text-ink">Open phone settings</Text>
        </Pressable>
      ) : null}

      {near.length ? (
        <View className="pt-3">
          <Text className="pb-2 text-[11px] font-bold uppercase tracking-wider text-faint">
            Near you
          </Text>
          {near.map((u) => (
            <UnitRow key={u.pu_code} u={u} />
          ))}
        </View>
      ) : null}

      <Text className="pb-2 pt-4 text-[11px] font-bold uppercase tracking-wider text-faint">
        Or search for it
      </Text>
      {/* Offline-capable: UnitSearch reads the register packs, so this works
          with no signal even though "near me" above does not. */}
      <UnitSearch<Row> onSelect={(u) => setPicked(u)} selectedCode={chosen?.pu_code} />

      {chosen ? (
        <View className="mt-3 rounded-2xl bg-surface px-3 py-2.5">
          <Text className="text-[11px] font-bold uppercase tracking-wider text-faint">Selected</Text>
          <Text className="pt-1 text-sm font-bold text-ink">{chosen.name}</Text>
          <Text className="text-[11px] text-muted">
            {[chosen.ward, chosen.lga, chosen.state].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}
    </ModalCard>
  );
}

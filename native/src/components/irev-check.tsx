/**
 * THE IReV CHECK on an observer's own report (Profile → Result reports).
 *
 * Hawkeye compares a unit's reported result with the sheet INEC uploads to
 * IReV, later, in a scheduled job (backend routes/observers.js irevCheck). This
 * draws where that stands — waiting for INEC's upload, comparing, or decided —
 * and once decided, both sets of figures side by side, so "matches" is shown
 * rather than asserted. Per UNIT: the comparison is of the unit's combined
 * result, which is what the column says ("Reported"), not "Yours".
 *
 * Web twin: app/profile.html irevCheckHtml().
 */
import Feather from '@expo/vector-icons/Feather';
import { Linking, Pressable, Text, View } from 'react-native';
import { t as i18nT } from '@/lib/i18n';
import { useUi } from '@/lib/theme';

export type IrevCheckData = {
  state: 'waiting' | 'checking' | 'match' | 'mismatch' | 'unclear';
  docUrl?: string | null;
  rows?: { party: string; reported: number | null; irev: number | null }[];
  total?: { reported: number; irev: number };
} | null | undefined;

const ROWS_SHOWN = 4;

export function IrevCheck({ irev }: { irev: IrevCheckData }) {
  const ui = useUi();
  if (!irev) return null;
  const decided = irev.state === 'match' || irev.state === 'mismatch';
  const icon = irev.state === 'match' ? 'check-circle' : irev.state === 'mismatch' ? 'alert-triangle'
    : irev.state === 'unclear' ? 'help-circle' : 'clock';
  const tint = irev.state === 'match' ? ui.tint.good.ink : irev.state === 'mismatch' ? ui.tint.warn.ink : ui.faint;
  const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());
  return (
    <View className="mt-2 rounded-xl bg-surface px-3 py-2.5">
      <View className="flex-row items-center">
        <Feather name={icon} size={14} color={tint} />
        <Text className="ml-1.5 flex-1 text-xs font-bold text-ink">{i18nT(`irev.state.${irev.state}`)}</Text>
      </View>
      {decided && irev.rows?.length ? (
        <View className="pt-2">
          <View className="flex-row pb-1">
            <Text className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{i18nT('irev.col-party')}</Text>
            <Text className="w-20 text-right text-[10px] font-semibold uppercase tracking-wider text-faint">{i18nT('irev.col-reported')}</Text>
            <Text className="w-20 text-right text-[10px] font-semibold uppercase tracking-wider text-faint">{i18nT('irev.col-irev')}</Text>
          </View>
          {[...irev.rows.slice(0, ROWS_SHOWN), ...(irev.total ? [{ party: i18nT('irev.total-valid'), reported: irev.total.reported, irev: irev.total.irev, total: true }] : [])]
            .map((r) => {
              const same = r.reported === r.irev;
              return (
                <View key={r.party} className="flex-row items-center border-t border-line py-1.5">
                  <Text className={`flex-1 text-sm ${'total' in r ? 'font-bold' : 'font-semibold'} text-ink`}>{r.party}</Text>
                  <Text className="w-20 text-right text-sm font-semibold text-ink" style={{ fontVariant: ['tabular-nums'] }}>{fmt(r.reported)}</Text>
                  <Text className={`w-20 text-right text-sm font-semibold ${same ? 'text-ink' : 'text-warn-ink'}`} style={{ fontVariant: ['tabular-nums'] }}>{fmt(r.irev)}</Text>
                </View>
              );
            })}
        </View>
      ) : null}
      {irev.docUrl && (decided || irev.state === 'unclear') ? (
        <Pressable onPress={() => void Linking.openURL(irev.docUrl!)} className="pt-2" accessibilityRole="link">
          <Text className="text-xs font-bold text-good-ink">{i18nT('irev.view-sheet')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** On the receipt, right after sending: the check happens later, and where to see it. */
export function IrevNext() {
  const ui = useUi();
  return (
    <View className="mt-3 flex-row rounded-2xl bg-card px-4 py-3">
      <Feather name="clock" size={16} color={ui.tint.good.ink} style={{ marginTop: 2 }} />
      <View className="ml-2.5 flex-1">
        <Text className="text-sm font-bold text-ink">{i18nT('irev.check-title')}</Text>
        <Text className="pt-0.5 text-xs text-muted">{i18nT('irev.receipt-next')}</Text>
      </View>
    </View>
  );
}

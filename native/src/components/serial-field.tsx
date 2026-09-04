import { Text, TextInput, View } from 'react-native';

import { useUi } from '@/lib/theme';

/**
 * The form serial, offered for confirmation beside the figures.
 *
 * ── WHY IT MOVED TO THE COUNTS STEP ───────────────────────────────────────
 *
 * All three flows used to put this immediately above the Send button, where an
 * optional field competes with the one irreversible action on the screen and
 * loses: in 120 demo submissions and every real one, `sheet_serial` is null in
 * the database. Not once filled.
 *
 * The counts step is where the observer is already reading the sheet — the
 * photograph is on screen as a reference, and they are copying figures off it.
 * Asking for one more printed value there costs a glance, not a context switch.
 *
 * ── WHY IT IS WORTH ASKING FOR AT ALL ─────────────────────────────────────
 *
 * backend/src/services/integrity.js: "Reused EC8A serial: same form serial
 * reported at a DIFFERENT unit = forgery", logged at HIGH severity. That
 * detector exists and has never fired, because nothing has ever fed it. The
 * serial is also the most legible thing on the page — printed, while every
 * figure that matters is biro — which is why an OCR proposal is realistic here
 * and nowhere else on the form.
 *
 * ── AND WHY THE PROPOSAL IS ONLY EVER A PROPOSAL ──────────────────────────
 *
 * The same detector is what makes a WRONG serial dangerous: it accuses two
 * innocent polling units of forgery, and a systematic misread would do it at
 * national scale. So a read value arrives pre-filled and visibly labelled as
 * coming from the photo, for the observer to check against the sheet in their
 * hand — never silently, and always editable.
 */
export function SerialField({
  value,
  onChange,
  proposed,
  editable = true,
  label = 'Sheet serial number',
  where = 'top right of the EC8A',
}: {
  value: string;
  onChange: (v: string) => void;
  /** What the on-device read found, or null. */
  proposed: string | null;
  editable?: boolean;
  label?: string;
  where?: string;
}) {
  const ui = useUi();
  // The pill means "this exact text came off your photo", so it goes the moment
  // the observer edits it — a corrected value wearing a FROM SHEET badge would
  // be the screen lying about where the number came from.
  const fromSheet = Boolean(proposed) && value === proposed;

  return (
    <View className="mb-3 rounded-2xl bg-card p-4">
      <View className="flex-row items-center pb-1">
        <Text className="flex-1 text-sm font-bold text-ink">{label}</Text>
        {fromSheet ? (
          <View className="rounded-full bg-surface px-2 py-0.5">
            <Text className="text-[9px] font-bold text-hawk-leaf">FROM SHEET</Text>
          </View>
        ) : null}
      </View>
      <Text className="pb-2 text-xs text-muted">
        {fromSheet
          ? `Read from your photo — check it matches the S/N printed at the ${where}.`
          : `Printed at the ${where}, after “S/N”. Optional, but it is how a sheet copied to a second unit gets caught.`}
      </Text>
      <TextInput
        className="rounded-xl bg-surface px-4 py-3 text-base font-bold text-ink"
        placeholder="e.g. 0000388"
        placeholderTextColor={ui.faint}
        autoCapitalize="characters"
        keyboardType="number-pad"
        value={value}
        onChangeText={onChange}
        editable={editable}
      />
    </View>
  );
}

/**
 * "YOUR COPY" — the receipt card under its heading, saved once with the
 * report's photos, and the line that says whether it was.
 *
 * One block for every report screen that hands the observer a card: a unit
 * result (report/result.tsx), a collation (report/collation.tsx) and an
 * incident (report/incident.tsx). The card itself decides what it may claim
 * from `data` (lib/receipt.ts: the kind, and whether there is an entry hash or
 * a reference yet); this only shows it and keeps it. Practice keeps its own
 * notes (practice.tsx), because what it says about saving is practice-specific.
 *
 * Shown unconditionally rather than behind a button — a card nobody can see
 * until they tap something is a card most people never see. IT SAVES WITH THE
 * PHOTOS, under the same Profile switch; the line below says which happened,
 * because a save that silently does nothing looks exactly like a broken feature.
 */
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { ReceiptCard, type ReceiptCardHandle } from '@/components/receipt-card';
import { t as i18nT } from '@/lib/i18n';
import type { ReceiptData } from '@/lib/receipt';
import { saveReceiptPng } from '@/lib/receipt-file';

export function ReceiptCopy({ data }: { data: ReceiptData }) {
  const cardRef = useRef<ReceiptCardHandle>(null);
  const [saved, setSaved] = useState<boolean | null>(null);
  /* Once per report. A ref as well as the state: the card's onReady is held
     in a ref of its own and may read a render-old `saved`. */
  const savingRef = useRef(false);
  return (
    <>
      <Text className="pb-1 pt-5 text-[11px] font-bold uppercase tracking-wider text-faint">
        {i18nT('observe.your-copy')}
      </Text>
      <View className="items-start">
        <ReceiptCard
          ref={cardRef}
          onReady={async () => {
            if (savingRef.current) return;
            savingRef.current = true;
            setSaved(await saveReceiptPng(cardRef.current));
          }}
          data={data}
        />
        <Text className="pt-2 text-xs text-muted">
          {saved === null
            ? ''
            : saved
              ? i18nT('observe.card-saved-with-photos')
              : i18nT('observe.copies-off-note')}
        </Text>
      </View>
    </>
  );
}

import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BAR_CONTENT_HEIGHT, CTA_LIFT } from '@/app/(tabs)/_layout';
import { ModalCard } from '@/components/modal-card';
import { BRAND } from '@/lib/api';
import { markTourSeen, setTourSpotlight, shouldShowTour, TOUR_STEPS } from '@/lib/tour';
import { useUi } from '@/lib/theme';

/**
 * The first-run tour — five cards, one per tab, with Skip visible on every one.
 *
 * SKIP IS NOT A CORNER ×. It sits in the footer beside Next, the same size and
 * on screen from the first card, because a tour someone cannot obviously leave
 * is worse than no tour. Both exits — skipping and finishing — write the same
 * flag: "I do not want this" and "I have had this" are the same instruction.
 *
 * Built on ModalCard so it inherits the two rules that card exists to enforce:
 * the body scrolls and is capped as a FRACTION of the screen, and the actions
 * are a sibling of the scroll area rather than inside it, so Next and Skip are
 * never below the fold on a short phone.
 *
 * `auto` is the first-run entry: it asks storage whether this device has seen
 * the tour and opens itself if not. Called with `auto` false it is a controlled
 * modal, which is how More → "Take the tour" replays it.
 */
export function Tour({
  auto = false,
  visible,
  onClose,
}: {
  /** Open on mount if this device has not seen the tour. */
  auto?: boolean;
  /** Controlled mode — ignored when `auto` is set. */
  visible?: boolean;
  onClose?: () => void;
}) {
  const ui = useUi();
  /** Gesture bar / home indicator — the tab bar pays it, so the scrim gap must too. */
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (!auto) return undefined;
    let live = true;
    // Fire-and-forget, and never rethrows: shouldShowTour swallows its own
    // errors and answers "seen" when it cannot tell.
    void shouldShowTour().then((show) => {
      if (live && show) setOpen(true);
    });
    return () => {
      live = false;
    };
  }, [auto]);

  const showing = auto ? open : !!visible;
  const step = TOUR_STEPS[i];
  const last = i === TOUR_STEPS.length - 1;

  /**
   * LIGHT THE TAB THIS STEP IS ABOUT.
   *
   * The card describes a button; the button is on screen, six centimetres
   * below, behind the scrim. Publishing the step's route makes the tab bar ring
   * it (see (tabs)/_layout.tsx), so "Report — the green button" is read beside
   * the actual green button rather than instead of it.
   *
   * The cleanup matters as much as the set: a ring left burning after the tour
   * closes is a tab that looks permanently selected. It clears on unmount here
   * and in finish() below, which is the single exit for Skip, Close and a
   * backdrop tap alike.
   */
  useEffect(() => {
    setTourSpotlight(showing ? (step?.route ?? null) : null);
    return () => setTourSpotlight(null);
  }, [showing, step]);

  const finish = () => {
    setTourSpotlight(null);
    void markTourSeen();
    setI(0);
    setOpen(false);
    onClose?.();
  };

  if (!step) return null;

  return (
    <ModalCard
      visible={showing}
      // Tapping the backdrop is a deliberate exit too, and counts as skipping —
      // an app that reopened the tour on the next launch because the reader
      // dismissed it the quickest way would be arguing with them.
      // AN OUTSIDE TAP NO LONGER ENDS IT. It is the easiest gesture to make by
      // mistake, and it both closed the tour and wrote the seen flag, so it
      // never came back. Leaving is the corner cross or hardware Back.
      dismissOnBackdrop={false}
      onCloseIcon={finish}
      onClose={finish}
      /**
       * STOP THE SCRIM ABOVE THE TAB BAR, so the ringed tab is lit rather than
       * dimmed to the same grey as everything else. + CTA_LIFT because the
       * Report circle overhangs the bar's top edge by ~12dp — without the
       * headroom the scrim would clip the ring on exactly the step that most
       * needs it.
       */
      bottomGap={BAR_CONTENT_HEIGHT + insets.bottom + CTA_LIFT}
      title="Welcome to Hawkeye"
      footer={
        <View>
          {/* Progress first, so the reader knows how long this is before
              deciding whether to skip. Five dots, not "1 of 5" — the shape of
              the thing is the answer to the question being asked. */}
          <View className="flex-row justify-center pb-3">
            {TOUR_STEPS.map((s, n) => (
              <View
                key={s.title}
                className={`mx-1 h-1.5 w-1.5 rounded-full ${n === i ? 'bg-good-ink' : 'bg-line'}`}
              />
            ))}
          </View>
          <View className="flex-row">
            {/* BACK, NOT SKIP. Five cards is enough that missing one matters and
                there was no way to return to it; leaving now lives in the corner
                cross, which is harder to hit by accident than a full-width
                button under the thumb. Disabled on card one rather than hidden,
                so the footer keeps its shape as the reader moves through. */}
            <Pressable
              onPress={() => setI((n) => Math.max(0, n - 1))}
              disabled={i === 0}
              accessibilityRole="button"
              accessibilityState={{ disabled: i === 0 }}
              className={`mr-2 flex-1 items-center rounded-full border border-line py-3 ${
                i === 0 ? 'opacity-40' : 'active:opacity-70'
              }`}
            >
              <Text className="text-sm font-bold text-muted">Back</Text>
            </Pressable>
            <Pressable
              onPress={() => (last ? finish() : setI(i + 1))}
              accessibilityRole="button"
              className="flex-1 items-center rounded-full bg-good py-3 active:opacity-80"
            >
              <Text className="text-sm font-bold text-good-ink">
                {last ? 'Start observing' : 'Next'}
              </Text>
            </Pressable>
          </View>
        </View>
      }
    >
      <View className="flex-row items-center pb-2">
        {/* THE REPORT CHIP IS THE REPORT BUTTON.
            Every step used to get the same neutral chip — a grey circle with a
            green glyph — including the one whose whole body is "Report — the
            green button". It was describing a control the reader was about to
            look for, in colours that control does not have. Report now wears
            the tab bar's own pairing: bg-hawk-green (#004225) with the glyph in
            BRAND.gold (#f5b301), the exact two values (tabs)/_layout.tsx uses.
            Size stays 18, not the real bar's 22 — that is sized for a 48dp
            circle and this chip is 40. */}
        <View
          className={`h-10 w-10 items-center justify-center rounded-full ${
            step.cta ? 'bg-hawk-green' : 'bg-surface'
          }`}
        >
          <Feather
            name={step.icon as never}
            size={18}
            color={step.cta ? BRAND.gold : ui.tint.good.ink}
          />
        </View>
        <Text className="pl-3 text-base font-bold text-ink">{step.title}</Text>
      </View>
      <Text className="text-sm leading-5 text-muted">{step.body}</Text>
      {/* The nonpartisan line, on the first card only. It is the first thing the
          app says to a new observer everywhere else — the board, the race pages
          and the store listing all carry it — and a welcome screen that omitted
          it would be the one place Hawkeye introduced itself without it. */}
      {i === 0 ? (
        <Text className="pt-4 text-xs text-faint">
          Hawkeye is independent and nonpartisan. It is not affiliated with INEC
          or any government body, and it does not declare results — it records
          what observers report and lets anyone check the record.
        </Text>
      ) : null}
    </ModalCard>
  );
}

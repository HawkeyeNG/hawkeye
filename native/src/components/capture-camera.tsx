import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, type LayoutChangeEvent, Pressable, Text, View } from 'react-native';

import { readSheet, type SheetRead } from '@/lib/ocr';
import { scanSheet, scannerAvailable } from '@/lib/scan';
import type { Shot } from '@/lib/submit';
import { describeFixFailure, trySubmitFix, type FixFailure } from '@/lib/location';
import { BRAND } from '@/lib/api';

/**
 * In-app capture with a GPS stamp taken at capture time — the property the
 * backend checks (photo-location coherence): every photo carries the fix of
 * where it was actually taken, so gallery imports can't back a submission.
 *
 * Photos go through a PREVIEW-CONFIRM step (Use photo / Retake): an observer
 * must look at the shot before it counts — a blurry EC8A is worthless
 * evidence — and it makes each step transition explicit instead of instant.
 *
 * GPS acquisition never hangs — bounded tiers live in lib/location. A failed
 * fix is a clear error with retry; Cancel is NEVER disabled.
 */
export type Media = Shot & { type: 'image' | 'video'; read?: SheetRead | null };

/**
 * Video compression happens AT THE ENCODER, not by cutting recordings short:
 * CameraView pins 720p and VIDEO_BITRATE caps the encoder, so length is bought
 * with efficiency instead of quality. 2 Mbps video + AAC audio ≈ 2.13 Mbit/s
 * → 90s ≈ 24MB, inside the 25MB stop and the server's 30MB/file cap.
 * Dev-build era (with push notifications): react-native-compressor for
 * WhatsApp-grade H.265 re-encode (minutes of video), and Google ML Kit for
 * on-device doc-scan/OCR of result sheets.
 */
// react-native-compressor exists only in the dev client, not Expo Go — probe
// once. With it, recordings are re-encoded H.265 after capture, so the length
// cap doubles; without it the encoder cap is the only thing keeping 90s ≈ 24MB
// under the edge's 33MB body limit, so the old cap stays.
let VideoCompressor: { compress: (uri: string, opts: object) => Promise<string> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  VideoCompressor = (require('react-native-compressor') as typeof import('react-native-compressor'))
    .Video;
} catch {
  VideoCompressor = null;
}

// Optional image downscaler (parity with the web/Capacitor compressCapture step):
// shrink a freshly captured photo to the same targets before it is hashed/signed,
// so a sheet is ~1500 px / q0.76 and a venue ~1280 px / q0.72 across every
// platform instead of a full-sensor multi-MB JPEG. Probed like VideoCompressor —
// no-op until `npx expo install expo-image-manipulator` adds it and the app is
// rebuilt. Add it before the next release build to activate.
let ImageManipulator: {
  manipulateAsync: (uri: string, actions: object[], opts?: object) => Promise<{ uri: string; width: number; height: number }>;
  SaveFormat: { JPEG: string };
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // @ts-ignore optional module, added via `npx expo install expo-image-manipulator`
  ImageManipulator = require('expo-image-manipulator');
} catch {
  ImageManipulator = null;
}

// Downscale to the shared upload target. Optional + fully guarded: if the module
// is absent or the resize throws, the ORIGINAL photo is returned unchanged —
// compression must never block or corrupt a capture (same contract as web).
async function downscaleForUpload(uri: string, isDocument: boolean): Promise<string> {
  if (!ImageManipulator?.manipulateAsync) return uri;
  const maxDim = isDocument ? 1500 : 1280;
  const quality = isDocument ? 0.76 : 0.72;
  try {
    const probe = await ImageManipulator.manipulateAsync(uri, []);
    const longer = Math.max(probe.width, probe.height);
    const jpeg = { compress: quality, format: ImageManipulator.SaveFormat.JPEG };
    if (longer <= maxDim) {
      const out = await ImageManipulator.manipulateAsync(uri, [], jpeg);
      return out.uri || uri;
    }
    const resize = probe.width >= probe.height ? { width: maxDim } : { height: maxDim };
    const out = await ImageManipulator.manipulateAsync(uri, [{ resize }], jpeg);
    return out.uri || uri;
  } catch {
    return uri;
  }
}

const VIDEO_MAX_S = VideoCompressor ? 180 : 90;
const VIDEO_BITRATE = 2_000_000;
const VIDEO_MAX_BYTES = 25 * 1024 * 1024; // pre-compress stop; edge rejects >33MB bodies

type Props = {
  title: string;
  hint: string;
  allowVideo?: boolean;
  /** Show a document framing guide (result-sheet step). */
  frameGuide?: boolean;
  /** Question asked on the preview-confirm screen — must match what was shot. */
  confirmTitle?: string;
  confirmHint?: string;
  onCapture: (media: Media) => void;
  onCancel: () => void;
  /** Practice only: proceed without a GPS fix instead of blocking on it. */
  requireFix?: boolean;
  /** Run on-device text recognition over the shot (the result-sheet step).
   *  Party codes let it propose the figures it reads. */
  readDocument?: boolean;
  partyCodes?: string[];
  /** Optional third control beside Cancel (practice's "Use a sample"). */
  extraAction?: { label: string; onPress: () => void };
  /** Loud yellow banner for the VENUE step — observers routinely mistake it for
   *  "re-shoot the sheet". Set on the venue step only (never on incidents). */
  venueGuide?: string;
};

/**
 * Who owns a document step's screen.
 *
 * 'scanning'    — the scanner is up, or about to be. NO camera preview is
 *                 mounted: mounting <CameraView> and opening the scanner over
 *                 it is what made the camera flash for a split second first.
 * 'unavailable' — this build has no scanner module at all (Expo Go).
 * 'failed'      — the scanner module exists but would not start; lib/scan.ts
 *                 documents why, and a retry is worth offering.
 * null          — not a document step; the plain camera is the point.
 */
type ScanState = 'scanning' | 'unavailable' | 'failed' | null;

/**
 * Shared bounded GPS (lib/location): photo/video stamps use the accurate tier.
 *
 * Returns the failure REASON rather than a bare null, because both callers below
 * render it. No permission prompt here — trySubmitFix's ensureUsable() checks
 * location services before asking, which is the order that actually helps.
 */
const getFix = async (): Promise<
  { ok: true; fix: { lat: number; lng: number } } | FixFailure
> => trySubmitFix();

export function CaptureCamera({
  title,
  hint,
  allowVideo,
  frameGuide,
  confirmTitle = 'Check the photo',
  confirmHint = 'Is every figure readable? Blurry photos cannot back a report.',
  onCapture,
  onCancel,
  requireFix = true,
  readDocument,
  partyCodes,
  extraAction,
  venueGuide,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ uri: string; capturedAt: number } | null>(null);
  const [fixState, setFixState] = useState<'pending' | 'ok' | 'failed'>('pending');
  /** Why the stamp failed — drives the copy instead of a blanket GPS excuse. */
  const [fixFail, setFixFail] = useState<FixFailure | null>(null);
  /**
   * Decided at MOUNT, not in an effect: an effect runs after the first paint,
   * so any camera mounted meanwhile is a frame the observer actually sees.
   * A document step therefore starts owned by the scanner, and only a genuine
   * failure ever hands the screen to the plain camera.
   */
  const [scanState, setScanState] = useState<ScanState>(() =>
    readDocument ? (scannerAvailable() ? 'scanning' : 'unavailable') : null,
  );
  /** Result of on-device recognition on the current preview. */
  const [read, setRead] = useState<SheetRead | null | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  /**
   * Measured heights of the overlaid chrome (top instruction card, bottom
   * control bar). The preview is full-bleed and the chrome floats ON it, so the
   * only thing that needs to know where the chrome ends is the framing guide.
   * Measured rather than hardcoded because the top card's height moves with the
   * hint, the scanner note and the device's font scale.
   */
  const [chrome, setChrome] = useState({ top: 0, bottom: 0 });
  /**
   * Chrome measurement. Ignores sub-pixel churn so a re-render cannot start a
   * layout loop with the guide it feeds.
   */
  const measure = (edge: 'top' | 'bottom') => (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setChrome((c) => (Math.abs(c[edge] - h) < 2 ? c : { ...c, [edge]: h }));
  };
  const cam = useRef<CameraView>(null);
  const fixRef = useRef<Promise<{ lat: number; lng: number } | null> | null>(null);
  const cancelled = useRef(false);
  // Generation counter: Retake/Cancel bump it, and any in-flight confirmation
  // (Use photo waiting on GPS) aborts when its generation is stale. Without
  // this, a pending confirmation fired onCapture AFTER the user hit Retake —
  // silently advancing the flow to the next step under their feet.
  const gen = useRef(0);
  /** The auto-open fires once per capture step, never after a cancel. */
  const autoScanned = useRef(false);
  // Re-entry guard for the scanner, as a ref rather than `busy`: retake() clears
  // busy and calls scanDoc in the same tick, so the value scanDoc closes over is
  // the stale `true` — it would bail, leaving the step on its placeholder with
  // nothing but Cancel.
  const scanning = useRef(false);
  /** Lets the mount effect call scanDoc, which is declared below it. */
  const scanDocRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => () => void (cancelled.current = true), []);

  // Live elapsed counter while recording — an observer filming under pressure
  // needs to see time passing and how close the 90s cap is, not guess.
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(t);
  }, [recording]);

  // Recognise the sheet while the observer is still looking at it, so the
  // verdict arrives before they commit — not after the upload. MUST live above
  // the permission early-returns with the other hooks: the first render exits
  // at the permission gate, and a hook that only mounts after permission is
  // granted is "rendered more hooks than during the previous render".
  useEffect(() => {
    if (!readDocument || !preview) return;
    let live = true;
    const g = gen.current;
    readSheet(preview.uri, partyCodes ?? []).then((r) => {
      if (live && g === gen.current) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [readDocument, preview, partyCodes]);

  // The scanner is the camera for documents: open it as the step begins rather
  // than making the observer choose. Once only — after a cancel they are in the
  // plain camera deliberately, and re-opening would trap them in a loop.
  // Gated on the granted permission, not just mount: the first render exits at
  // the permission gate ABOVE scanDoc's declaration, so the ref is still null
  // then. Waiting for the granted render means the ref is assigned by the time
  // this fires.
  useEffect(() => {
    if (!readDocument || !permission?.granted || !scannerAvailable() || autoScanned.current) return;
    autoScanned.current = true;
    void scanDocRef.current?.();
  }, [readDocument, permission?.granted]);

  const cancel = () => {
    cancelled.current = true;
    if (recording) cam.current?.stopRecording();
    onCancel();
  };

  if (!permission) return <View className="flex-1 bg-black" />;
  if (!permission.granted) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-8">
        <Feather name="camera-off" size={32} color="#fff" />
        <Text className="pt-4 text-center text-base text-white">
          Hawkeye needs the camera to capture evidence in-app.
        </Text>
        <Pressable className="mt-5 rounded-2xl bg-hawk-gold px-6 py-3" onPress={requestPermission}>
          <Text className="text-base font-bold text-hawk-ink">Allow camera</Text>
        </Pressable>
        {/* A denied camera must not dead-end a flow that has an escape (the
            PWA rule: no camera -> use a sample). */}
        {extraAction ? (
          <Pressable className="mt-4" onPress={extraAction.onPress}>
            <Text className="text-sm font-bold text-hawk-gold">{extraAction.label}</Text>
          </Pressable>
        ) : null}
        {/* Fixed neutral, not text-faint: this screen is always black, and
            --faint follows the theme down to #6e8076 (2.5:1 on black). */}
        <Pressable className="mt-3" onPress={cancel}>
          <Text className="text-sm text-neutral-300">Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const startFix = () => {
    setFixState('pending');
    fixRef.current = getFix().then((r) => {
      // Unwrap for the consumers (everything downstream wants {lat,lng}) but keep
      // WHY it failed, so the copy below can stop guessing at "weak signal".
      if (!cancelled.current) {
        setFixState(r.ok ? 'ok' : 'failed');
        setFixFail(r.ok ? null : r);
      }
      return r.ok ? r.fix : null;
    });
  };

  /**
   * Hand off to ML Kit's document scanner, then re-enter our own confirm step
   * with the cropped result. The GPS fix starts BEFORE the scanner opens: the
   * scanner is a separate activity, and the fix has to belong to the moment
   * the observer was standing at the sheet, not to whenever they came back.
   */
  const scanDoc = async () => {
    if (scanning.current) return;
    scanning.current = true;
    setBusy(true);
    setLine(null);
    // Takes the screen back from the fallback camera on "Try scanner again".
    setScanState('scanning');
    startFix();
    const out = await scanSheet();
    scanning.current = false;
    if (cancelled.current) return;
    setBusy(false);
    if (out.ok) {
      setPreview({ uri: out.uri, capturedAt: Date.now() });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    if (out.reason === 'cancelled') {
      // Backing out of the scanner means backing out of the step. Dropping the
      // observer into a different capture mode they did not ask for is how you
      // end up with an uncropped sheet nobody intended to take.
      cancel();
      return;
    }
    // Only a real failure exposes the plain camera, and it says which of the two
    // failures this was — silently downgrading the tool hides that the sheet is
    // about to be sent as an uncropped photo.
    setScanState(out.reason);
  };

  // Assigned here, BELOW the permission gate, which is why the auto-open effect
  // waits for `permission.granted` rather than firing on mount — and why no
  // branch that expects the scanner may return above this line.
  scanDocRef.current = scanDoc;

  /** A document step: the shot exists to be READ, not looked at. */
  const isDocument = !!(readDocument || frameGuide);

  const shootPhoto = async () => {
    if (busy) return;
    setBusy(true);
    setLine('Hold still…');
    try {
      // `quality` is JPEG compression, NOT resolution: expo-camera decodes the
      // full-sensor frame (pictureSize unset -> CameraX HIGHEST_AVAILABLE) and
      // re-compresses it at quality*100, with no downscale. 0.7 is fine for a
      // venue photo and wrong for a sheet — q70 smears the thin strokes of
      // handwritten tallies, which is exactly what ML Kit has to read. A sheet
      // is worth the extra ~2x on the wire; the edge cap is 33MB.
      const photo = await cam.current!.takePictureAsync({ quality: isDocument ? 0.95 : 0.7 });
      if (cancelled.current) return;
      startFix(); // resolve GPS while the observer reviews the shot
      setPreview({ uri: photo.uri, capturedAt: Date.now() });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      setLine('Capture failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  const retake = () => {
    gen.current++; // abort any pending confirmation before it can fire onCapture
    setPreview(null);
    setRead(undefined);
    setLine(null);
    setBusy(false);
    setFixState('pending');
    // Retaking a document means scanning it again, not falling back to the raw
    // camera — the crop is the point. 'scanning' is exactly "the scanner still
    // owns this step": a preview only ever hid it, a failure would have replaced
    // it, so no separate flag is needed to tell those apart.
    if (scanState === 'scanning') void scanDocRef.current?.();
  };

  const usePhoto = async () => {
    if (!preview || busy) return;
    const g = gen.current;
    setBusy(true);
    setLine('Confirming your location…');
    const fix = await fixRef.current;
    if (cancelled.current || g !== gen.current) return; // user retook/cancelled meanwhile
    if (!fix && requireFix) {
      setBusy(false);
      setFixState('failed');
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Downscale to the shared upload target before the bytes are hashed/signed, so
    // storage + bandwidth match web/Capacitor (no-op until the module is built in).
    const finalUri = await downscaleForUpload(preview.uri, isDocument);
    if (cancelled.current || g !== gen.current) return; // retaken/cancelled mid-downscale
    setPreview(null);
    setBusy(false);
    onCapture({
      uri: finalUri,
      capturedAt: preview.capturedAt,
      ...(fix ?? { lat: 0, lng: 0 }),
      type: 'image',
      read,
    });
  };

  const toggleVideo = async () => {
    if (recording) {
      cam.current?.stopRecording();
      return;
    }
    if (busy) return;
    if (!micPermission?.granted) {
      const m = await requestMic();
      if (!m.granted) {
        setLine('Microphone is needed to record video with sound.');
        return;
      }
    }
    setBusy(true);
    setRecording(true);
    setLine(`Recording — up to ${VIDEO_MAX_S}s. Tap again to stop.`);
    try {
      const fixP = getFix();
      const video = await cam.current!.recordAsync({
        maxDuration: VIDEO_MAX_S,
        maxFileSize: VIDEO_MAX_BYTES,
      });
      setRecording(false);
      if (cancelled.current) return;
      setLine('Saving…');
      const got = await fixP;
      if (cancelled.current) return;
      const fix = got.ok ? got.fix : null;
      if (!video?.uri || !fix) {
        if (fix) setLine('Recording failed — try again.');
        else if (!got.ok) {
          const d = describeFixFailure(got);
          setFixFail(got);
          setLine(`${d.lead}. (${d.code})`);
        }
        setBusy(false);
        return;
      }
      let uri = video.uri;
      if (VideoCompressor) {
        setLine('Compressing…');
        try {
          uri = await VideoCompressor.compress(video.uri, { compressionMethod: 'auto' });
        } catch {
          uri = video.uri; // a failed compress must never lose the recording
        }
        if (cancelled.current) return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCapture({ uri, capturedAt: Date.now(), ...fix, type: 'video' });
    } catch {
      setRecording(false);
      setLine('Recording failed — try again.');
      setBusy(false);
    }
  };

  // ---- photo preview-confirm --------------------------------------------
  if (preview) {
    return (
      <View className="flex-1 bg-black">
        <Image source={{ uri: preview.uri }} style={{ flex: 1 }} contentFit="contain" />
        {/* Scrim card: white-on-photo is unreadable against a bright result
            sheet — this text is an instruction, so it must always win. */}
        <View className="absolute inset-x-0 top-0 px-4 pt-14">
          <View className="rounded-2xl bg-black/75 px-4 py-3">
            <Text className="text-lg font-bold text-white">{confirmTitle}</Text>
            <Text className="pt-1 text-sm text-neutral-200">
              {busy
                ? 'Confirming your location — a few seconds…'
                : fixState === 'failed'
                  ? // Name the actual cause: "move near a window" is wrong advice
                    // when location services are off or the permission is blocked.
                    fixFail
                    ? `${describeFixFailure(fixFail).lead}. (${describeFixFailure(fixFail).code})`
                    : 'No GPS fix — move near a window or outside, then retry.'
                  : confirmHint}
            </Text>
            {/* On-device read of the sheet, as its own card: a verdict nobody
                notices is the same as no verdict. Advisory throughout — the
                server re-reads the upload regardless. */}
            {readDocument ? (
              read === undefined ? (
                <View className="mt-2 flex-row items-center rounded-xl bg-white/10 px-3 py-2">
                  <ActivityIndicator size="small" color="#fcd34d" />
                  <Text className="pl-2 text-xs font-semibold text-neutral-200">
                    Reading the sheet…
                  </Text>
                </View>
              ) : read === null ? (
                <View className="mt-2 rounded-xl bg-amber-400/15 px-3 py-2">
                  <Text className="text-xs font-semibold text-amber-200">
                    Could not read this sheet on this phone. Send it anyway if it looks clear —
                    the server reads it too.
                  </Text>
                </View>
              ) : read.numericLines >= 3 ? (
                <View className="mt-2 rounded-xl bg-emerald-400/15 px-3 py-2">
                  <View className="flex-row items-center">
                    <Feather name="check-circle" size={13} color="#6ee7b7" />
                    <Text className="pl-1.5 text-xs font-bold text-emerald-200">
                      Readable — {read.numericLines} lines with figures
                    </Text>
                  </View>
                  {Object.keys(read.counts).length ? (
                    <Text className="pt-1 text-xs text-emerald-100">
                      Read:{' '}
                      {Object.entries(read.counts)
                        .map(([p, n]) => `${p} ${n}`)
                        .join(' · ')}
                    </Text>
                  ) : (
                    <Text className="pt-1 text-xs text-emerald-100/80">
                      No party totals matched — you will enter them yourself.
                    </Text>
                  )}
                </View>
              ) : (
                <View className="mt-2 rounded-xl bg-amber-400/15 px-3 py-2">
                  <Text className="text-xs font-semibold text-amber-200">
                    Little text detected — check focus and glare, then retake.
                  </Text>
                </View>
              )
            ) : null}
          </View>
        </View>
        <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-6 pb-12">
          {/* The camera chrome is always dark, so its scrims are fixed white at
              low alpha — bg-card/15 turned into a near-invisible dark-on-dark
              plate once --card followed the theme. */}
          <Pressable className="rounded-2xl bg-white/15 px-6 py-3.5" onPress={retake}>
            <Text className="text-base font-semibold text-white">Retake</Text>
          </Pressable>
          {fixState === 'failed' ? (
            <Pressable
              className="rounded-2xl bg-hawk-gold px-6 py-3.5"
              onPress={() => {
                startFix();
                usePhoto();
              }}
            >
              <Text className="text-base font-bold text-hawk-ink">Retry GPS</Text>
            </Pressable>
          ) : (
            <Pressable className="rounded-2xl bg-hawk-gold px-6 py-3.5" onPress={usePhoto} disabled={busy}>
              {/* bg-hawk-gold is a fixed brand surface, so its label must be the
                  fixed hawk ink — text-ink flips to near-white on the dark theme
                  and vanishes into the gold (1.6:1). */}
              {busy ? (
                <ActivityIndicator color={BRAND.ink} />
              ) : (
                <Text className="text-base font-bold text-hawk-ink">Use photo</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  // ---- scanner holding screen --------------------------------------------
  // The one thing a document step shows until the scanner is up. Deliberately
  // NOT a camera: the scanner runs in its own activity, so anything we mount
  // underneath is a frame the observer sees flash and then lose.
  if (scanState === 'scanning') {
    return (
      <View className="flex-1 items-center justify-center bg-black px-10">
        <Feather name="crop" size={30} color={BRAND.gold} />
        <Text className="pt-4 text-center text-lg font-bold text-white">{title}</Text>
        <Text className="pt-2 text-center text-sm text-neutral-300">Opening scanner…</Text>
        <View className="pt-7">
          <ActivityIndicator color={BRAND.gold} />
        </View>
        {/* The scanner is another app's activity — if it never comes back, this
            is the only way out. Same rule as the shutter screen's Cancel. */}
        <Pressable className="mt-12" hitSlop={12} onPress={cancel}>
          <Text className="text-base font-semibold text-white">Cancel</Text>
        </Pressable>
      </View>
    );
  }

  /** Why the observer is looking at a plain camera on a step that wanted a scan. */
  const scanNote =
    scanState === 'unavailable'
      ? 'This build has no document scanner, so the sheet will be a plain photo. Fill the frame and keep it flat.'
      : scanState === 'failed'
        ? 'The scanner could not start — Google Play services downloads it the first time it runs, so it needs a connection once. Taking a plain photo instead.'
        : null;


  /**
   * The guide is every pixel the observer can see the sheet in, minus the
   * floating chrome — not a fixed fraction of the screen. The preview itself was
   * always full-bleed (`flex: 1`); the small viewport the observer reported was
   * this box, a centred 82%x62% rectangle whose top corners sat UNDER the
   * instruction card, so "fit the sheet in the frame" pointed at a target with an
   * invisible top edge.
   *
   * Be honest about the size of the win: on a 360x800dp screen the box goes from
   * 295x496 to 340x487, so +15% width and +13% area — worthwhile, but the height
   * is unchanged because chrome, not arithmetic, is what bounds it. The
   * instruction card (with the scanner note, which is always present when this
   * guide is visible — the guide only renders in the fallback camera) plus the
   * control bar are ~305dp of an 800dp screen. The next real height comes from
   * shortening the callers' `hint` copy or collapsing the scanner note, not from
   * anything left to tune here.
   *
   * Extra clearance where a floating control sits above the bottom bar (the
   * Photo/Video selector at bottom-36, "Try scanner again" at bottom-132) so the
   * guide never runs under one — both land 8dp inside this bound, not by luck:
   * chrome.bottom is 48dp of safe-area padding plus the 72dp shutter, and each
   * term below is that floating control's own offset-plus-height minus 120.
   */
  const guideBottom =
    chrome.bottom + 8 + (scanState === 'failed' ? 52 : 0) + (allowVideo ? 48 : 0);

  // ---- live camera -------------------------------------------------------
  return (
    <View className="flex-1 bg-black">
      {/*
       * Full-bleed on purpose, and it does NOT stretch the image — read off
       * expo-camera 57.0.3 (android/.../ExpoCameraView.kt) rather than assumed:
       *
       *  - `previewView.scaleType` is only ever assigned inside `ratio?.let {}`.
       *    We pass no `ratio`, so it keeps PreviewView's default FILL_CENTER:
       *    the frame is scaled uniformly and CENTRE-CROPPED to the view. Uniform
       *    scale means no distortion; a `flex: 1` preview is safe.
       *  - DO NOT add `ratio="4:3"` (or "16:9") to "fix" the crop. Either value
       *    flips scaleType to FIT_CENTER, which letterboxes the preview inside
       *    the screen — the small viewport this component was changed to stop
       *    having. 4:3 in a ~9:19.5 screen loses ~38% of the preview area.
       *  - Which way the crop cuts matters for framing, so: a 4:3 sensor is
       *    WIDER than a tall phone, so FILL_CENTER keeps the FULL capture HEIGHT
       *    and hides roughly the outer 39% of the capture's WIDTH. The captured
       *    JPEG is therefore a superset of what the preview shows — anything the
       *    observer frames is captured, never the reverse — and HEIGHT is the
       *    axis they control that maps 1:1 onto pixels on the sheet, which is
       *    what the guide's nudge says.
       *
       * Resolution is already maximal and nothing below downsamples, so there is
       * no prop to add here: `pictureSize` unset -> CameraX
       * HIGHEST_AVAILABLE_STRATEGY for both preview and ImageCapture, and
       * PictureOptions.maxDownsampling defaults to 1 (ResolveTakenPicture only
       * halves resolution to recover from an OutOfMemoryError). Leave
       * `autofocus` unset too: FocusMode.OFF is CONTINUOUS autofocus, while 'on'
       * means focus once and LOCK — the wrong one for a handheld sheet.
       */}
      <CameraView
        ref={cam}
        style={{ flex: 1 }}
        facing="back"
        mode={mode}
        videoQuality="720p"
        videoBitrate={VIDEO_BITRATE}
      />

      {frameGuide && mode === 'picture' ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 10,
            right: 10,
            top: chrome.top + 8,
            bottom: guideBottom,
          }}
        >
          <View className="flex-1 rounded-xl border border-hawk-gold/50" />
          {/* Corner brackets: at this size a thin full outline reads as a border,
              so the corners carry the "this is the target" signal. */}
          {(
            [
              { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 },
              { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 },
              {
                bottom: 0,
                left: 0,
                borderBottomWidth: 3,
                borderLeftWidth: 3,
                borderBottomLeftRadius: 12,
              },
              {
                bottom: 0,
                right: 0,
                borderBottomWidth: 3,
                borderRightWidth: 3,
                borderBottomRightRadius: 12,
              },
            ] as const
          ).map((corner, i) => (
            <View
              key={i}
              className="absolute border-hawk-gold"
              style={{ width: 34, height: 34, ...corner }}
            />
          ))}
          {/* Says the quiet part out loud. The callers' hint ("fit the sheet in
              the frame") is satisfied by a sheet that only half fills it; what
              the OCR needs is the sheet pushed to these edges. Names TOP TO
              BOTTOM specifically: the preview keeps the whole capture height but
              hides the outer ~39% of its width (FILL_CENTER, see the CameraView
              note), so height is the axis where closing the distance converts
              directly into pixels on the tallies. */}
          {/* /75, not /60: this pill floats INSIDE the framing guide, i.e. over
              the result sheet itself, and a result sheet is white paper. Gold on
              black/60 over white is 3.10:1 — the instruction telling the observer
              how to frame the one photo the OCR has to read was the least legible
              text on the screen, and only in the case that always happens. /75
              takes it to 5.59:1 over white and matches the sibling instruction
              cards above (black/70 and black/75); over a dark scene it moves
              10.49 -> 10.81, so nothing is lost at the other end. */}
          <View className="absolute inset-x-0 top-2 items-center">
            <Text className="rounded-full bg-black/75 px-3 py-1 text-[11px] font-semibold text-hawk-gold">
              Fill this frame top to bottom — closer reads sharper
            </Text>
          </View>
        </View>
      ) : null}

      <View
        onLayout={measure('top')}
        className={`absolute inset-x-0 top-0 ${frameGuide ? 'px-3 pt-12' : 'px-4 pt-14'}`}
      >
        {/* Tighter on a document step: every point of chrome here is a point the
            framing guide below cannot use. */}
        <View className={`rounded-2xl bg-black/70 px-4 ${frameGuide ? 'py-2' : 'py-3'}`}>
          <Text className={`font-bold text-white ${frameGuide ? 'text-base' : 'text-lg'}`}>
            {title}
          </Text>
          <Text className={`pt-1 text-neutral-200 ${frameGuide ? 'text-xs' : 'text-sm'}`}>
            {line ?? hint}
          </Text>
          {/* Loud venue cue: observers keep re-shooting the sheet by mistake. */}
          {venueGuide ? (
            <View className="mt-2 rounded-xl bg-yellow-400 px-3 py-2">
              <Text className="text-center text-sm font-extrabold text-neutral-900">{venueGuide}</Text>
            </View>
          ) : null}
          {/* Never degrade silently: an uncropped photo is weaker evidence than
              a scan, so say the scanner is out and say which failure it was.
              'unavailable' is a build without the module — retrying cannot help
              — while 'failed' is Play services not having fetched it yet, which
              a connection and a second tap usually fixes. */}
          {scanNote ? (
            <View className="mt-2 rounded-xl bg-amber-400/15 px-3 py-2">
              <Text className="text-xs font-semibold text-amber-200">{scanNote}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Centred above the Photo/Video selector, cap ABOVE the counter so the
          eye reads limit-then-elapsed. right-anchored placements landed over
          Cancel; top-anchored ones fought the camera cutout. */}
      {recording ? (
        <View className="absolute inset-x-0 items-center" style={{ bottom: 188 }}>
          {/* Both fixed: the camera chrome is always dark, so text-faint and
              bg-card (the recording dot) both went dark-on-dark with the theme. */}
          <Text className="pb-1 text-[10px] font-semibold text-neutral-300">
            max {VIDEO_MAX_S}s
          </Text>
          <View className="flex-row items-center rounded-full bg-red-600 px-3 py-1.5">
            <View className="mr-1.5 h-2 w-2 rounded-full bg-white" />
            <Text className="text-sm font-bold text-white">
              {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
              {String(elapsed % 60).padStart(2, '0')}
            </Text>
          </View>
        </View>
      ) : null}

      {allowVideo ? (
        <View className="absolute inset-x-0 bottom-36 flex-row justify-center gap-2">
          {(['picture', 'video'] as const).map((m) => (
            <Pressable
              key={m}
              disabled={busy || recording}
              onPress={() => setMode(m)}
              className={`rounded-full px-4 py-1.5 ${mode === m ? 'bg-hawk-gold' : 'bg-black/50'}`}
            >
              <Text className={`text-xs font-bold ${mode === m ? 'text-hawk-ink' : 'text-white'}`}>
                {m === 'picture' ? 'Photo' : 'Video'}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Offered only for 'failed', where a second attempt is a real chance —
          the module is installed on demand, so the retry that follows a
          reconnect is the one that works. A build with no scanner at all gets
          the explanation and no button, because a control that cannot succeed
          is the hand-waving this replaces. */}
      {scanState === 'failed' && !recording ? (
        <View className="absolute inset-x-0 items-center" style={{ bottom: 132 }}>
          <Pressable
            disabled={busy}
            onPress={scanDoc}
            className="flex-row items-center rounded-full bg-hawk-gold px-5 py-2.5 active:opacity-80"
          >
            <Feather name="crop" size={15} color={BRAND.ink} />
            <Text className="pl-2 text-sm font-bold text-hawk-ink">Try scanner again</Text>
          </Pressable>
        </View>
      ) : null}

      <View
        onLayout={measure('bottom')}
        className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-8 pb-12"
      >
        {/* Cancel is never disabled — a stuck capture must always have an exit. */}
        <Pressable hitSlop={12} onPress={cancel}>
          <Text className="text-base font-semibold text-white">Cancel</Text>
        </Pressable>
        <Pressable
          onPress={mode === 'picture' ? shootPhoto : toggleVideo}
          disabled={busy && !recording}
          className="items-center justify-center rounded-full border-4 border-white"
          style={{ width: 72, height: 72 }}
        >
          {busy && !recording && mode === 'picture' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View
              className={recording ? 'bg-red-600' : mode === 'video' ? 'bg-red-500' : 'bg-hawk-gold'}
              style={
                recording
                  ? { width: 28, height: 28, borderRadius: 6 }
                  : { width: 56, height: 56, borderRadius: 28 }
              }
            />
          )}
        </Pressable>
        {extraAction ? (
          <Pressable hitSlop={12} onPress={extraAction.onPress} style={{ maxWidth: 96 }}>
            <Text className="text-right text-sm font-semibold text-hawk-gold">
              {extraAction.label}
            </Text>
          </Pressable>
        ) : (
          <View style={{ width: 48 }} />
        )}
      </View>
    </View>
  );
}

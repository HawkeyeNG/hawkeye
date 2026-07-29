import { Feather } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { readSheet, type SheetRead } from '@/lib/ocr';
import { scanSheet, scannerAvailable } from '@/lib/scan';
import type { Shot } from '@/lib/submit';
import { getSubmitFix } from '@/lib/location';
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
};

/** Shared bounded GPS (lib/location): photo/video stamps use the accurate tier. */
const getFix = async (): Promise<{ lat: number; lng: number } | null> => {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) return null;
  return getSubmitFix();
};

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
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ uri: string; capturedAt: number } | null>(null);
  const [fixState, setFixState] = useState<'pending' | 'ok' | 'failed'>('pending');
  /** Result of on-device recognition on the current preview. */
  const [read, setRead] = useState<SheetRead | null | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const cam = useRef<CameraView>(null);
  const fixRef = useRef<Promise<{ lat: number; lng: number } | null> | null>(null);
  const cancelled = useRef(false);
  // Generation counter: Retake/Cancel bump it, and any in-flight confirmation
  // (Use photo waiting on GPS) aborts when its generation is stale. Without
  // this, a pending confirmation fired onCapture AFTER the user hit Retake —
  // silently advancing the flow to the next step under their feet.
  const gen = useRef(0);
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
        <Pressable className="mt-3" onPress={cancel}>
          <Text className="text-sm text-neutral-400">Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const startFix = () => {
    setFixState('pending');
    fixRef.current = getFix().then((f) => {
      if (!cancelled.current) setFixState(f ? 'ok' : 'failed');
      return f;
    });
  };

  /**
   * Hand off to ML Kit's document scanner, then re-enter our own confirm step
   * with the cropped result. The GPS fix starts BEFORE the scanner opens: the
   * scanner is a separate activity, and the fix has to belong to the moment
   * the observer was standing at the sheet, not to whenever they came back.
   */
  const scanDoc = async () => {
    if (busy) return;
    setBusy(true);
    setLine('Opening scanner…');
    startFix();
    const out = await scanSheet();
    if (cancelled.current) return;
    setBusy(false);
    if (out.ok) {
      setPreview({ uri: out.uri, capturedAt: Date.now() });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    }
    // Cancelled is a choice, not a fault — say nothing and leave the camera up.
    setLine(
      out.reason === 'cancelled'
        ? null
        : 'Scanner unavailable — frame the sheet and shoot it directly.',
    );
  };

  const shootPhoto = async () => {
    if (busy) return;
    setBusy(true);
    setLine('Hold still…');
    try {
      const photo = await cam.current!.takePictureAsync({ quality: 0.7 });
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
    setPreview(null);
    setBusy(false);
    onCapture({
      uri: preview.uri,
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
      const fix = await fixP;
      if (cancelled.current) return;
      if (!video?.uri || !fix) {
        setLine(fix ? 'Recording failed — try again.' : 'No GPS fix — move near a window and retry.');
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
                  ? 'No GPS fix — move near a window or outside, then retry.'
                  : confirmHint}
            </Text>
            {/* On-device read of the sheet — a warning while it can still be
                acted on. Never blocks: the server re-reads the upload anyway. */}
            {readDocument && read !== undefined ? (
              <View className="flex-row items-center pt-2">
                <Feather
                  name={read && read.numericLines >= 3 ? 'check-circle' : 'alert-triangle'}
                  size={13}
                  color={read && read.numericLines >= 3 ? '#6ee7b7' : '#fcd34d'}
                />
                <Text className="pl-1.5 text-xs text-neutral-200">
                  {read === null
                    ? 'Could not read this sheet on-device — send it anyway if it looks clear.'
                    : read.numericLines >= 3
                      ? `Readable — ${read.numericLines} lines with figures${
                          Object.keys(read.counts).length
                            ? `, ${Object.keys(read.counts).length} party total(s) recognised`
                            : ''
                        }.`
                      : 'Little text detected — check focus and glare, then retake.'}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-6 pb-12">
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

  // ---- live camera -------------------------------------------------------
  return (
    <View className="flex-1 bg-black">
      <CameraView
        ref={cam}
        style={{ flex: 1 }}
        facing="back"
        mode={mode}
        videoQuality="720p"
        videoBitrate={VIDEO_BITRATE}
      />

      {frameGuide && mode === 'picture' ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <View
            className="rounded-2xl border-2 border-dashed border-hawk-gold/80"
            style={{ width: '82%', height: '62%' }}
          />
        </View>
      ) : null}

      <View className="absolute inset-x-0 top-0 px-4 pt-14">
        <View className="rounded-2xl bg-black/70 px-4 py-3">
          <Text className="text-lg font-bold text-white">{title}</Text>
          <Text className="pt-1 text-sm text-neutral-200">
            {line ??
              (readDocument && scannerAvailable()
                ? `${hint} Tap Scan sheet to auto-crop it.`
                : hint)}
          </Text>
        </View>
      </View>

      {/* Centred above the Photo/Video selector, cap ABOVE the counter so the
          eye reads limit-then-elapsed. right-anchored placements landed over
          Cancel; top-anchored ones fought the camera cutout. */}
      {recording ? (
        <View className="absolute inset-x-0 items-center" style={{ bottom: 188 }}>
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

      {/* Document steps lead with the scanner: it finds the sheet's edges and
          returns a flat, cropped page. The plain shutter stays underneath for
          anyone who would rather just take the photo. */}
      {readDocument && scannerAvailable() && !recording ? (
        <View className="absolute inset-x-0 items-center" style={{ bottom: 132 }}>
          <Pressable
            disabled={busy}
            onPress={scanDoc}
            className="flex-row items-center rounded-full bg-hawk-gold px-5 py-2.5 active:opacity-80"
          >
            <Feather name="crop" size={15} color={BRAND.ink} />
            <Text className="pl-2 text-sm font-bold text-hawk-ink">Scan sheet</Text>
          </Pressable>
        </View>
      ) : null}

      <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-8 pb-12">
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

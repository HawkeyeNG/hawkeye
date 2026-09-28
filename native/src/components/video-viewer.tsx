import Feather from '@expo/vector-icons/Feather';
import { requireOptionalNativeModule, useEventListener } from 'expo';
import type { VideoPlayer, VideoPlayerStatus, VideoViewProps } from 'expo-video';
import { useEffect, useState, type ComponentType } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';
import { t as i18nT } from '@/lib/i18n';

/**
 * EVIDENCE VIDEOS, FULL SCREEN, IN THE APP — with Hawkeye's own controls.
 *
 * The incident feed handed every clip to the in-app browser: a raw .mp4 in a
 * browser chrome, a trip out of the app, and a different set of controls on
 * every phone. This is the video twin of components/image-viewer.tsx: same
 * black full-screen modal, same close button, same safe-area handling.
 *
 * ── EXPO-VIDEO IS NEW, AND OLDER PHONES RUN THIS JS TOO ──
 * expo-video is a native module that ships with the first store build AFTER
 * 1.0.9. Phones on 1.0.9 and earlier still receive this file over the air (EAS
 * Update), and expo-video's JS entry calls requireNativeModule('ExpoVideo') the
 * moment it is imported — which THROWS in a binary built without it. So, the
 * same shape as lib/certificate-pdf.ts does for expo-print:
 *   - nothing imports 'expo-video' at runtime except the require() below, which
 *     sits behind requireOptionalNativeModule('ExpoVideo') (null, not a throw,
 *     when the module is absent). `import type` is erased at compile time;
 *   - canPlayVideoInApp() is false on those binaries, and the caller keeps its
 *     old behaviour (the browser). tests/video_viewer_guard_test.mjs holds both.
 *
 * The controls are ours (nativeControls={false}): a large centre play/pause, a
 * scrubber you can tap or drag with elapsed/total time, mute, close. They fade
 * out after HIDE_AFTER_MS while playing and come back on a tap — never while a
 * screen reader is on, where a control that vanishes is a control that is gone.
 * Every string is keyed (n.components.video-viewer.*), errors and labels too.
 */
const HIDE_AFTER_MS = 3000;
/** How far one screen-reader swipe on the scrubber moves, in seconds. */
const STEP_S = 5;
const SCRIM = 'rgba(0,0,0,0.6)';
const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

type ExpoVideo = {
  useVideoPlayer: (source: string, setup?: (player: VideoPlayer) => void) => VideoPlayer;
  VideoView: ComponentType<VideoViewProps>;
};

let cached: ExpoVideo | null | undefined;

/** expo-video, or null on a binary built without it (1.0.9 and earlier). Never throws. */
function videoModule(): ExpoVideo | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    // The web build (the browser preview of this app) has no binary to be out
    // of step with, and expo-video's <video>-backed web implementation never
    // registers 'ExpoVideo' — so there the package is taken directly.
    if (Platform.OS === 'web' || requireOptionalNativeModule('ExpoVideo')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('expo-video') as ExpoVideo;
    }
  } catch {
    cached = null;
  }
  return cached;
}

/** True when this binary can play a clip in the app; false means "use the browser, as before". */
export const canPlayVideoInApp = () => videoModule() !== null;

/* The player is a value a hook returned, and the React Compiler's lint forbids
   assigning to one inside the component. Its setters ARE the API (seek = set
   currentTime), so they are made through these calls instead. */
function setPosition(p: VideoPlayer, sec: number) {
  p.currentTime = sec;
}
function setSound(p: VideoPlayer, muted: boolean) {
  p.muted = muted;
}

/** 75.4 → "1:15", 3725 → "1:02:05". Never NaN on screen. */
export function clock(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function CloseButton({ onPress, top }: { onPress: () => void; top: number }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={i18nT('common.close')}
      className="absolute right-4 h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-70"
      style={{ top }}
    >
      <Feather name="x" size={24} color="#fff" />
    </Pressable>
  );
}

/** The clip will not play: say so plainly, and offer the one thing that might still work. */
function Failed({ onOpenInBrowser }: { onOpenInBrowser?: () => void }) {
  return (
    <View style={FILL} className="items-center justify-center px-10" pointerEvents="box-none">
      <Feather name="video-off" size={28} color="#9ca3af" />
      <Text className="pt-3 text-center text-sm text-white" accessibilityLiveRegion="polite">
        {i18nT('n.components.video-viewer.failed')}
      </Text>
      {onOpenInBrowser ? (
        <Pressable
          onPress={onOpenInBrowser}
          accessibilityRole="button"
          className="active:opacity-70"
          style={{
            marginTop: 16,
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            borderRadius: 999,
            backgroundColor: 'rgba(255,255,255,0.14)',
          }}
        >
          <Feather name="external-link" size={16} color="#fff" />
          <Text style={{ marginLeft: 8, color: '#fff', fontSize: 14, fontWeight: '600' }}>
            {i18nT('n.components.video-viewer.open-in-browser')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Player({
  V,
  uri,
  label,
  onClose,
  onOpenInBrowser,
}: {
  V: ExpoVideo;
  uri: string;
  label?: string;
  onClose: () => void;
  onOpenInBrowser?: () => void;
}) {
  const insets = useSafeAreaInsets();
  // Not autoplaying and not looping: evidence is watched on purpose, once, with
  // its sound — the reader presses play.
  const player = V.useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = false;
    p.timeUpdateEventInterval = 0.25;
  });
  const [status, setStatus] = useState<VideoPlayerStatus>(() => player.status);
  /** Ready at least once. A later 'loading' is buffering, not a first load. */
  const [everReady, setEverReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  /** Where a finger on the scrubber is, in seconds; null when nobody is scrubbing. */
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  const [trackW, setTrackW] = useState(0);
  const [shown, setShown] = useState(true);
  /** Bumped on every interaction so the hide timer starts over. */
  const [poke, setPoke] = useState(0);
  const [screenReader, setScreenReader] = useState(false);

  useEventListener(player, 'statusChange', ({ status: s }) => {
    setStatus(s);
    if (s === 'readyToPlay') {
      setEverReady(true);
      if (player.duration > 0) setDuration(player.duration);
    }
    if (s === 'error') {
      setShown(true);
      AccessibilityInfo.announceForAccessibility(i18nT('n.components.video-viewer.failed'));
    }
  });
  useEventListener(player, 'sourceLoad', ({ duration: d }) => {
    if (d > 0) setDuration(d);
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    setPlaying(isPlaying);
    if (isPlaying) setEnded(false);
    else setShown(true); // paused: the controls come back and stay
  });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => setTime(currentTime));
  useEventListener(player, 'mutedChange', ({ muted: m }) => setMuted(m));
  useEventListener(player, 'playToEnd', () => {
    setEnded(true);
    setShown(true);
    if (player.duration > 0) setTime(player.duration);
  });

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) setScreenReader(on);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const scrubbing = scrubAt !== null;
  // The timer is set by the effect and cleared by its own cleanup; nothing in
  // the dependency list is a fresh function per render, so a re-render cannot
  // cancel it by accident — only a real change (or a poke) restarts it.
  useEffect(() => {
    if (!shown || !playing || scrubbing || screenReader) return;
    const id = setTimeout(() => setShown(false), HIDE_AFTER_MS);
    return () => clearTimeout(id);
  }, [shown, playing, scrubbing, screenReader, poke]);

  const wake = () => {
    setShown(true);
    setPoke((n) => n + 1);
  };

  const atEnd = ended || (duration > 0 && time >= duration - 0.25);

  const seekTo = (sec: number) => {
    const d = duration > 0 ? duration : player.duration;
    const to = Math.max(0, d > 0 ? Math.min(d, sec) : sec);
    setPosition(player, to);
    setTime(to);
    setEnded(false);
  };

  const toggle = () => {
    wake();
    if (playing) {
      player.pause();
      return;
    }
    if (atEnd) seekTo(0);
    player.play();
  };

  const toggleMute = () => {
    wake();
    const m = !muted;
    setSound(player, m);
    setMuted(m);
  };

  const secAt = (x: number) => (trackW > 0 ? Math.min(1, Math.max(0, x / trackW)) : 0) * duration;
  // Tap or drag anywhere on the 44pt strip. Runs on the JS thread: it drives
  // React state and the player, not an animation. Each event carries its own
  // x, so the release seeks to where the finger lifted — no ref to keep in step.
  const scrub = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => {
      if (!(duration > 0)) return;
      setScrubAt(secAt(e.x));
      setShown(true);
    })
    .onUpdate((e) => {
      if (duration > 0) setScrubAt(secAt(e.x));
    })
    .onFinalize((e) => {
      setScrubAt(null);
      if (duration > 0) seekTo(secAt(e.x));
      wake();
    });

  const failed = status === 'error';
  const loading = !failed && (!everReady || status === 'loading');
  const controls = !failed && everReady && (shown || screenReader);
  const canHide = shown && playing && !screenReader;
  const pos = scrubAt ?? time;
  const frac = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;
  const knob = scrubbing ? 20 : 14;
  const timeText = { color: '#fff', fontSize: 12, fontVariant: ['tabular-nums' as const], minWidth: 38, textAlign: 'center' as const };

  return (
    <View style={{ flex: 1 }} accessibilityViewIsModal>
      <V.VideoView
        player={player}
        style={FILL}
        contentFit="contain"
        nativeControls={false}
        allowsPictureInPicture={false}
        surfaceType="textureView"
        accessibilityLabel={label ?? i18nT('n.components.video-viewer.label')}
      />

      {/* Behind every control: a tap here shows the controls, or hides them
          while the clip plays. */}
      {!failed ? (
        <Pressable
          style={FILL}
          onPress={() => (canHide ? setShown(false) : wake())}
          accessibilityRole="button"
          accessibilityLabel={
            canHide ? i18nT('n.components.video-viewer.hide-controls') : i18nT('n.components.video-viewer.show-controls')
          }
        />
      ) : null}

      {failed ? <Failed onOpenInBrowser={onOpenInBrowser} /> : null}

      {loading ? (
        <View pointerEvents="none" style={FILL} className="items-center justify-center">
          <ActivityIndicator color="#fff" size="large" accessibilityLabel={i18nT('n.components.video-viewer.loading')} />
        </View>
      ) : null}

      {controls && !loading ? (
        <View pointerEvents="box-none" style={FILL} className="items-center justify-center">
          <Pressable
            onPress={toggle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              playing
                ? i18nT('n.components.video-viewer.pause')
                : atEnd
                  ? i18nT('n.components.video-viewer.replay')
                  : i18nT('n.components.video-viewer.play')
            }
            className="active:opacity-70"
            style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: SCRIM, alignItems: 'center', justifyContent: 'center' }}
          >
            <Feather
              name={playing ? 'pause' : atEnd ? 'rotate-ccw' : 'play'}
              size={34}
              color="#fff"
              // The play triangle's optical centre sits left of its box.
              style={playing || atEnd ? undefined : { marginLeft: 4 }}
            />
          </Pressable>
        </View>
      ) : null}

      {controls ? (
        <View
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: insets.bottom + 12,
            flexDirection: 'row',
            alignItems: 'center',
            borderRadius: 16,
            backgroundColor: SCRIM,
            paddingLeft: 12,
            paddingRight: 4,
          }}
        >
          <Text style={timeText} accessibilityElementsHidden importantForAccessibility="no">
            {clock(pos)}
          </Text>
          <GestureDetector gesture={scrub}>
            <View
              onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
              style={{ flex: 1, height: 44, justifyContent: 'center', marginHorizontal: 10 }}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={i18nT('n.components.video-viewer.seek')}
              accessibilityValue={{
                min: 0,
                max: Math.round(duration),
                now: Math.round(pos),
                text: i18nT('n.components.video-viewer.position', { v0: clock(pos), v1: clock(duration) }),
              }}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={(e: AccessibilityActionEvent) => {
                if (e.nativeEvent.actionName === 'increment') seekTo(pos + STEP_S);
                else if (e.nativeEvent.actionName === 'decrement') seekTo(pos - STEP_S);
              }}
            >
              <View style={{ height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.3)' }}>
                <View style={{ width: `${frac * 100}%`, height: 4, backgroundColor: BRAND.gold }} />
              </View>
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: frac * trackW - knob / 2,
                  top: (44 - knob) / 2,
                  width: knob,
                  height: knob,
                  borderRadius: knob / 2,
                  backgroundColor: BRAND.gold,
                }}
              />
            </View>
          </GestureDetector>
          <Text style={timeText} accessibilityElementsHidden importantForAccessibility="no">
            {clock(duration)}
          </Text>
          <Pressable
            onPress={toggleMute}
            accessibilityRole="button"
            accessibilityLabel={muted ? i18nT('n.components.video-viewer.unmute') : i18nT('n.components.video-viewer.mute')}
            className="h-11 w-11 items-center justify-center active:opacity-70"
          >
            <Feather name={muted ? 'volume-x' : 'volume-2'} size={20} color="#fff" />
          </Pressable>
        </View>
      ) : null}

      {controls || failed || !everReady ? <CloseButton onPress={onClose} top={insets.top + 10} /> : null}
    </View>
  );
}

/**
 * Shown while `uri` is set; `onClose` clears it. One per screen, fed by
 * whichever clip was tapped. `onOpenInBrowser` is offered only when the clip
 * will not play here — the caller owns the browser, so its screen stays the one
 * place a video can leave the app.
 */
export function VideoViewer({
  uri,
  label,
  onClose,
  onOpenInBrowser,
}: {
  uri: string | null;
  label?: string;
  onClose: () => void;
  onOpenInBrowser?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const V = uri ? videoModule() : null;
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal is its own native window on Android: the scrubber's gesture
          needs a root of its own there, as image-viewer.tsx's pinch does. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
        {uri && V ? (
          // Keyed by the url, so a second clip starts from zero with fresh state.
          <Player key={uri} V={V} uri={uri} label={label} onClose={onClose} onOpenInBrowser={onOpenInBrowser} />
        ) : uri ? (
          <>
            <Failed onOpenInBrowser={onOpenInBrowser} />
            <CloseButton onPress={onClose} top={insets.top + 10} />
          </>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

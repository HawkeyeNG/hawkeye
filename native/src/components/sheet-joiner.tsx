/**
 * Joins the parts of one sheet into ONE JPEG file (lib/sheet-parts.ts says
 * why and how). Mount it where the join is asked for; call join(uris).
 *
 * On a phone: a 1 x 1, invisible WebView running JOIN_HTML — a canvas, the same
 * engine the Lite app joins in, and react-native-webview is already in every
 * store build, so this ships over the air. On the web export: the page's own
 * canvas (joinInDocument), since react-native-webview has no web target.
 *
 * The output is written as a FRESH JPEG under the cache: no camera EXIF can
 * survive a canvas, which is the same privacy guarantee downscaleForUpload
 * gives a single photo (capture-camera.tsx).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { bytesFromBase64 } from '@/lib/receipt-file';
import { JOIN_HTML, JOIN_MAX_W, joinInDocument } from '@/lib/sheet-parts';

let ImageManipulator: {
  manipulateAsync: (uri: string, actions: object[], opts?: object) => Promise<{ uri: string; width: number; height: number; base64?: string }>;
  SaveFormat: { JPEG: string };
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // @ts-ignore installed since the first release build; probed like capture-camera.tsx does
  ImageManipulator = require('expo-image-manipulator');
} catch {
  ImageManipulator = null;
}

export type SheetJoinerHandle = {
  /** Join these photos, top first. Resolves to the joined file (or a data: URI on the web export). */
  join: (uris: string[]) => Promise<{ uri: string; width: number; height: number }>;
};

/** A part as a JPEG data: URI no wider than the join can use (less to carry across the bridge). */
async function asDataUri(uri: string): Promise<string> {
  if (!ImageManipulator?.manipulateAsync) throw new Error('no image manipulator');
  const probe = await ImageManipulator.manipulateAsync(uri, []);
  const actions = probe.width > JOIN_MAX_W ? [{ resize: { width: JOIN_MAX_W } }] : [];
  const out = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 0.92, format: ImageManipulator.SaveFormat.JPEG, base64: true,
  });
  if (!out.base64) throw new Error('no base64 from the manipulator');
  return `data:image/jpeg;base64,${out.base64}`;
}

const JOIN_TIMEOUT_MS = 30000;

export const SheetJoiner = forwardRef<SheetJoinerHandle>(function SheetJoiner(_props, ref) {
  const web = useRef<WebView>(null);
  const readyResolve = useRef<(() => void) | null>(null);
  // Created ONCE: a `useRef(new Promise(...))` argument would be rebuilt on every
  // render and repoint readyResolve at a promise nobody awaits.
  const ready = useRef<Promise<void> | null>(null);
  if (!ready.current) ready.current = new Promise<void>((res) => { readyResolve.current = res; });
  const pending = useRef(new Map<string, (m: { ok: boolean; b64?: string; width?: number; height?: number; error?: string }) => void>());
  const seq = useRef(0);

  const onMessage = (e: WebViewMessageEvent) => {
    let m: { type?: string; id?: string; ok?: boolean; b64?: string; width?: number; height?: number; error?: string };
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.type === 'ready') { readyResolve.current?.(); return; }
    const done = m.id ? pending.current.get(m.id) : null;
    if (done) { pending.current.delete(m.id as string); done({ ok: !!m.ok, b64: m.b64, width: m.width, height: m.height, error: m.error }); }
  };

  useImperativeHandle(ref, () => ({
    join: async (uris) => {
      const parts = await Promise.all(uris.map(asDataUri));
      let out: { b64: string; width: number; height: number };
      if (Platform.OS === 'web') {
        out = await joinInDocument(parts);
        return { uri: `data:image/jpeg;base64,${out.b64}`, width: out.width, height: out.height };
      }
      await Promise.race([ready.current, new Promise((_, rej) => setTimeout(() => rej(new Error('joiner not ready')), JOIN_TIMEOUT_MS))]);
      const id = `j${++seq.current}`;
      const reply = await new Promise<{ ok: boolean; b64?: string; width?: number; height?: number; error?: string }>((res, rej) => {
        const t = setTimeout(() => { pending.current.delete(id); rej(new Error('join timed out')); }, JOIN_TIMEOUT_MS);
        pending.current.set(id, (m) => { clearTimeout(t); res(m); });
        web.current?.postMessage(JSON.stringify({ type: 'join', id, parts }));
      });
      if (!reply.ok || !reply.b64) throw new Error(reply.error || 'join failed');
      out = { b64: reply.b64, width: reply.width || 0, height: reply.height || 0 };
      const dir = new Directory(Paths.cache, 'hawkeye-sheet-parts');
      try { dir.create({ intermediates: true, idempotent: true }); } catch { /* already there */ }
      const f = new File(dir, `sheet-${Date.now()}.jpg`);
      try { f.create({ overwrite: true }); } catch { /* already there */ }
      f.write(bytesFromBase64(out.b64));
      return { uri: f.uri, width: out.width, height: out.height };
    },
  }));

  if (Platform.OS === 'web') return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 }}>
      <WebView
        ref={web}
        source={{ html: JOIN_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        onMessage={onMessage}
        style={{ width: 1, height: 1, backgroundColor: 'transparent' }}
      />
    </View>
  );
});

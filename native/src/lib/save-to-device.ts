/**
 * Keep a copy of a report's photos and videos on the observer's own phone.
 *
 * Called once per report, at the moment it is handed off — accepted by the
 * server or parked in the outbox — never from the outbox flush, so a retried
 * report is not saved twice.
 *
 * ── What gets saved ──
 * Exactly the files the report uploads or queues: capture-camera's re-saved
 * JPEGs (no camera EXIF, GPS included) and its compressed recordings. Never a
 * camera original, and never a file picked from the library — that one is on
 * the phone already. Callers pass only in-app captures.
 *
 * ── It must never cost the report anything ──
 * Fire-and-forget after the submit result is known, every failure swallowed.
 * Permission denied is a silent skip, and the question is put at most once per
 * session.
 *
 * ── Permissions: add-only, and nothing Play has to review ──
 *  - iOS asks for ADD-ONLY access (NSPhotoLibraryAddUsageDescription). That
 *    level cannot read or create albums — the library's Album.get/create demand
 *    full access and throw — so iOS saves to the library without one.
 *  - Android 11+ needs no permission at all: the library's AssetModernFactory
 *    inserts into MediaStore with no check, and an app may always add its own
 *    files. Asking there would only raise the legacy WRITE_EXTERNAL_STORAGE
 *    dialog, which the merged manifest still declares up to API 32, for
 *    nothing.
 *    Android 10 and older take the write-only request (WRITE_EXTERNAL_STORAGE).
 *    READ_MEDIA_* and ACCESS_MEDIA_LOCATION are blocked in app.json.
 *
 * ── Lazy import ──
 * expo-media-library is a native module; a build cut before it was added throws
 * while evaluating it. Imported inside the call for the reason lib/biometric.ts
 * gives, so profile.tsx can import the preference from here safely.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const PREF_KEY = 'hawkeye_save_report_media';
const ALBUM = 'Hawkeye';

type MediaLibrary = typeof import('expo-media-library');

/**
 * The choice made on this screen this session, if any. Read before storage so
 * turning it OFF holds for the rest of the session even if the write to disk
 * failed — the person who switches this off may be expecting their phone to be
 * inspected.
 */
let sessionChoice: boolean | null = null;

/** Default ON. An unreadable preference counts as OFF: see sessionChoice. */
export async function isSaveToDeviceEnabled(): Promise<boolean> {
  if (sessionChoice !== null) return sessionChoice;
  try {
    return (await AsyncStorage.getItem(PREF_KEY)) !== 'off';
  } catch {
    return false;
  }
}

export async function setSaveToDeviceEnabled(on: boolean): Promise<void> {
  sessionChoice = on;
  try {
    if (on) await AsyncStorage.removeItem(PREF_KEY);
    else await AsyncStorage.setItem(PREF_KEY, 'off');
  } catch {
    /* holds for this session anyway; see sessionChoice */
  }
}

/** undefined = never tried, null = this build does not carry the module. */
let cached: MediaLibrary | null | undefined;

async function loadMediaLibrary(): Promise<MediaLibrary | null> {
  if (cached !== undefined) return cached;
  try {
    cached = await import('expo-media-library');
  } catch {
    cached = null;
  }
  return cached;
}

/** Settled once per session, granted or not, so nobody is asked twice. */
let permission: Promise<boolean> | null = null;

function mayAdd(ML: MediaLibrary): Promise<boolean> {
  permission ??= (async () => {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 30) return true;
    const now = await ML.getPermissionsAsync(true);
    if (now.granted) return true;
    if (!now.canAskAgain) return false;
    return (await ML.requestPermissionsAsync(true)).granted;
  })().catch(() => false);
  return permission;
}

async function saveOne(ML: MediaLibrary, uri: string): Promise<void> {
  try {
    if (Platform.OS !== 'android') {
      await ML.Asset.create(uri);
      return;
    }
    // Only this app's own files are visible to the query without a read
    // permission, so this finds the album we made — or nothing, and the first
    // save creates it (Pictures/Hawkeye) with that file in it.
    const album = await ML.Album.get(ALBUM);
    if (album) await ML.Asset.create(uri, album);
    else await ML.Album.create(ALBUM, [uri]);
  } catch {
    // No album after all: keep the copy anyway, in the default folder.
    await ML.Asset.create(uri).catch(() => undefined);
  }
}

/**
 * Copy a handed-off report's in-app captures to the photo library. Returns at
 * once; the work runs in the background and never throws.
 */
export function saveReportMedia(uris: (string | null | undefined)[]): void {
  const todo = uris.filter((u): u is string => !!u);
  if (!todo.length || Platform.OS === 'web') return;
  void (async () => {
    try {
      if (!(await isSaveToDeviceEnabled())) return;
      const ML = await loadMediaLibrary();
      if (!ML || !(await mayAdd(ML))) return;
      for (const uri of todo) await saveOne(ML, uri);
    } catch {
      /* a convenience copy — never a reason to disturb the report */
    }
  })();
}

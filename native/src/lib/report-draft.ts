/**
 * A report in progress, kept on the phone until it is handed off.
 *
 * Flow walkthrough REP-RES-02 / REP-INC-03: a reload, an OS kill of the
 * backgrounded app (low-memory Android does this to a camera-heavy app all
 * day) or a crash mid-report used to lose the photos, the unit, the race and
 * every typed figure — everything lived in useState. The EC8A may not be on
 * display any more by the time the app comes back.
 *
 * WHAT IS KEPT. Small JSON in AsyncStorage: the fields, plus the PHOTO URIS —
 * not the photos. The files stay where the camera wrote them; a draft whose
 * files have gone (the OS reclaimed its cache) is not offered, because a
 * report that resumes with its evidence missing is worse than a fresh start.
 *
 * WHEN IT GOES. On hand-off (accepted, or safe in the outbox — the outbox
 * keeps its own durable copy from then on), and on "Discard" when leaving.
 * Never on a timer while the screen is open.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

type Stamped<T> = T & { savedAt: number };

/** Write (replace) the draft. Fire-and-forget: a full disk must not break the flow. */
export function saveDraft<T extends object>(key: string, data: T): void {
  try {
    AsyncStorage.setItem(key, JSON.stringify({ ...data, savedAt: Date.now() })).catch(() => {});
  } catch {
    /* unserialisable: nothing kept, nothing broken */
  }
}

/** The draft, if one younger than `maxAgeMs` exists. A stale one is deleted. */
export async function loadDraft<T extends object>(key: string, maxAgeMs: number): Promise<Stamped<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Stamped<T>;
    if (!d || typeof d.savedAt !== 'number' || Date.now() - d.savedAt > maxAgeMs) {
      clearDraft(key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(key: string): void {
  AsyncStorage.removeItem(key).catch(() => {});
}

/**
 * Is the file a draft points at still there?
 *
 * The camera writes into the cache directory, which Android may empty while
 * the app is not running. A `data:` URI carries its bytes and always is; on the
 * web build a `blob:` URI dies with the page that made it, so it never is.
 */
export async function fileStillThere(uri: string | null | undefined): Promise<boolean> {
  if (!uri) return false;
  if (uri.startsWith('data:')) return true;
  if (Platform.OS === 'web' || uri.startsWith('blob:')) return false;
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/** "14:05" — the draft's own time, in the phone's clock, for the resume question. */
export function draftTime(savedAt: number): string {
  const d = new Date(savedAt);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

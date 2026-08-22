/**
 * SecureStore with a web fallback.
 *
 * expo-secure-store has no web implementation at all — its web module is
 * literally an empty object, so every call throws "not a function" the
 * moment the app runs in a browser. bootstrapAuth() catches that and reports
 * signed-out, which is why signing in on the web build appeared to succeed and
 * then bounced straight back to welcome no matter what credentials were used.
 *
 * On a device nothing changes: the calls go to expo-secure-store exactly as
 * before, so the token still lives in the Keystore / Keychain. On web they go
 * to localStorage, which is NOT secure storage — that is acceptable only
 * because the web target exists for local development and screenshots, and the
 * app ships to Android and iOS.
 */
import { Platform } from 'react-native';
import * as Native from 'expo-secure-store';

const web = Platform.OS === 'web';

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // a browser with storage blocked
  }
}

export async function getItemAsync(key: string): Promise<string | null> {
  if (!web) return Native.getItemAsync(key);
  return store()?.getItem(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (!web) return Native.setItemAsync(key, value);
  store()?.setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  if (!web) return Native.deleteItemAsync(key);
  store()?.removeItem(key);
}

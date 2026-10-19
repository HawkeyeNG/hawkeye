// In-memory SecureStore (stands for both expo-secure-store and @/lib/secure-store).
const N = (globalThis.__native ??= {});
N.secure ??= new Map();
export const getItemAsync = async (k) => (N.secure.has(k) ? N.secure.get(k) : null);
export const setItemAsync = async (k, v) => { N.secure.set(k, String(v)); };
export const deleteItemAsync = async (k) => { N.secure.delete(k); };

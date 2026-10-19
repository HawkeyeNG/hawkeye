// In-memory AsyncStorage; the map is globalThis.__native.asyncStorage.
const N = (globalThis.__native ??= {});
N.asyncStorage ??= new Map();
const AsyncStorage = {
  getItem: async (k) => (N.asyncStorage.has(k) ? N.asyncStorage.get(k) : null),
  setItem: async (k, v) => { N.asyncStorage.set(k, String(v)); },
  removeItem: async (k) => { N.asyncStorage.delete(k); },
  multiRemove: async (ks) => { for (const k of ks) N.asyncStorage.delete(k); },
};
export default AsyncStorage;

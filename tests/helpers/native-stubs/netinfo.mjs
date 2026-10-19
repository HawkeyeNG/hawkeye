const N = (globalThis.__native ??= {});
N.netListeners ??= [];
export default {
  addEventListener: (f) => { N.netListeners.push(f); return () => {}; },
  fetch: async () => ({ isConnected: true, isInternetReachable: true }),
};

// react-native, as far as the lib/ modules under test reach into it.
const N = (globalThis.__native ??= {});
N.appStateListeners ??= [];
export const Platform = { OS: 'android', select: (o) => o.android ?? o.default };
export const AppState = {
  currentState: 'active',
  addEventListener: (_e, f) => { N.appStateListeners.push(f); return { remove() {} }; },
};
export default { Platform, AppState };

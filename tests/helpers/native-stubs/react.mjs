// Only the hooks lib/ modules call at module scope or from exported stores.
export const useSyncExternalStore = (_s, get) => get();
export const createContext = (v) => ({ Provider: null, _v: v });
export const useContext = (c) => c._v;
export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];
export const useEffect = () => {};
export const useMemo = (f) => f();
export const useCallback = (f) => f;
export const useRef = (v) => ({ current: v });
export const Fragment = 'Fragment';
export default { useSyncExternalStore, createContext, useContext, useState, useEffect, useMemo, useCallback, useRef, Fragment };

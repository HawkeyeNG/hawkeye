/**
 * Load REAL native/src TypeScript modules in plain Node, with the native
 * modules they import swapped for stubs (tests/helpers/native-stubs/).
 *
 * The app has no test runner, and these modules (the outbox, submit, auth) pull
 * in half of Expo. Each `.ts` file is transpiled with the app's own TypeScript
 * on load, '@/…' resolves into native/src exactly as Metro resolves it, and any
 * specifier named in STUBS is answered by a stub whose behaviour the test sets
 * on globalThis.__native. Everything not stubbed is the shipped code.
 *
 *   import { loadNative } from './helpers/native-loader.mjs';
 *   const outbox = await loadNative('lib/outbox.ts', { stub: ['@/lib/identity', ...] });
 */
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { H } from './harness.mjs';

const NATIVE = path.join(H, 'native');
const STUB_DIR = path.join(H, 'tests', 'helpers', 'native-stubs');

/** Specifier -> stub file. Native modules always; app modules only on request. */
const ALWAYS = {
  'react-native': 'react-native.mjs',
  react: 'react.mjs',
  '@react-native-async-storage/async-storage': 'async-storage.mjs',
  '@react-native-community/netinfo': 'netinfo.mjs',
  'expo-file-system': 'expo-file-system.mjs',
  'expo-secure-store': 'secure-store.mjs',
  'expo-crypto': 'expo-crypto.mjs',
  '@sentry/react-native': 'sentry.mjs',
};
const OPTIONAL = {
  '@/lib/identity': 'identity.mjs',
  '@/lib/i18n': 'i18n.mjs',
  '@/lib/evidence': 'evidence.mjs',
  '@/lib/submit': 'submit.mjs',
  '@/lib/outbox': 'outbox.mjs',
  '@/lib/auth': 'auth.mjs',
  '@/lib/biometric': 'biometric.mjs',
  '@/lib/device-signals': 'device-signals.mjs',
  '@/lib/pending-invite': 'pending-invite.mjs',
  '@/lib/secure-store': 'secure-store.mjs',
  '@/lib/register': 'register.mjs',
};

let registered = false;
const stubbed = new Map(Object.entries(ALWAYS).map(([k, f]) => [k, pathToFileURL(path.join(STUB_DIR, f)).href]));

globalThis.__native ??= {};

const HOOKS = `
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
let cfg;
let ts;
export async function initialize(data) {
  cfg = data;
  ts = createRequire(data.native + '/package.json')('typescript');
}
const SRC = () => cfg.native + '/src/';
function srcFile(rest) {
  for (const ext of ['', '.ts', '.tsx', '/index.ts']) {
    const f = SRC() + rest + ext;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}
export async function resolve(spec, ctx, next) {
  if (cfg.stubs[spec]) return { url: cfg.stubs[spec], shortCircuit: true };
  if (spec.startsWith('@/')) {
    const f = srcFile(spec.slice(2));
    if (!f) throw new Error('native-loader: cannot resolve ' + spec);
    return { url: pathToFileURL(f).href, shortCircuit: true };
  }
  if (ctx.parentURL && ctx.parentURL.startsWith(pathToFileURL(SRC()).href) && !spec.startsWith('.') && !spec.startsWith('node:')) {
    return next(spec, { ...ctx, parentURL: pathToFileURL(cfg.native + '/package.json').href });
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (/\\.tsx?$/.test(url)) {
    const src = fs.readFileSync(fileURLToPath(url), 'utf8');
    const out = ts.transpileModule(src, { fileName: fileURLToPath(url), compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: false,
    } }).outputText;
    return { format: 'module', source: out, shortCircuit: true };
  }
  if (url.endsWith('.json') && url.startsWith(pathToFileURL(SRC()).href)) {
    return { format: 'module', source: 'export default ' + fs.readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return next(url, ctx);
}
`;

/**
 * Import a native/src module. `stub` lists app modules ('@/lib/…') to replace
 * with their stub; the set is fixed by the first call in a process.
 */
export async function loadNative(rel, { stub = [] } = {}) {
  if (!registered) {
    for (const s of stub) {
      if (!OPTIONAL[s]) throw new Error(`native-loader: no stub for ${s}`);
      stubbed.set(s, pathToFileURL(path.join(STUB_DIR, OPTIONAL[s])).href);
    }
    register('data:text/javascript,' + encodeURIComponent(HOOKS), {
      data: { native: NATIVE, stubs: Object.fromEntries(stubbed) },
    });
    registered = true;
  }
  return import(pathToFileURL(path.join(NATIVE, 'src', rel)).href);
}

/**
 * Make long timers short: every setTimeout of `over` ms or more fires after
 * 1/`factor` of its delay. Deadlines measured in minutes then fire in a test's
 * milliseconds, while the code under test keeps its real constants.
 */
export function fastTimers(factor = 1000, over = 5000) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms = 0, ...a) => real(f, ms >= over ? Math.ceil(ms / factor) : ms, ...a);
}

/** A fetch that never answers (a stalled socket) but honours its AbortSignal. */
export const stalled = (init) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
});

/** 'resolved' / 'rejected <message>' / 'never settled' within `ms` of real time. */
export const settles = (p, ms = 2000) => Promise.race([
  Promise.resolve(p).then(() => 'resolved', (e) => `rejected ${e && e.message}`),
  new Promise((r) => (globalThis.__realSetTimeout || setTimeout)(() => r('never settled'), ms)),
]);
globalThis.__realSetTimeout ??= setTimeout;

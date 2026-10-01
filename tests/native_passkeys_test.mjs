/**
 * NATIVE PASSKEYS (lib/passkeys.ts, from the 1.0.12 store build) — and the
 * older binaries that run the same JS by OTA without the native module.
 *
 * react-native-passkeys' entry calls requireNativeModule('ReactNativePasskeys')
 * AT IMPORT, which throws in a binary built without it (1.0.11 and older). One
 * runtime import of the package anywhere in native/src would crash that screen
 * on every older phone. Checked, each part with a control:
 *
 *  1. STATIC: nothing in native/src loads 'react-native-passkeys' at runtime —
 *     `import type` only (erased; checked on the project's own Babel config,
 *     which is what Metro bundles). lib/passkeys.ts asks
 *     requireOptionalNativeModule('ReactNativePasskeys') instead.
 *  2. RUNTIME, module ABSENT (an OTA on 1.0.11): loads without a throw, says
 *     unavailable, offers nothing, and Profile can still list passkeys.
 *  3. RUNTIME, module PRESENT: the sheet gets the server's options reduced to
 *     what it reads (no transports, hints or extensions); what comes back is
 *     reshaped into the JSON the server verifies (base64url ids, type,
 *     rawId); failures are classified (cancel, none on this phone, no lock…);
 *     the after-sign-in offer respects new accounts, "Not now" (30 days) and a
 *     passkey already here.
 *  4. STRINGS: every passkey key the app calls resolves in ha, ig and yo to
 *     something that is neither the English nor the key.
 *  5. ASSOCIATION FILES + CONFIG: iOS webcredentials beside the existing
 *     applinks (app.json, AASA); Android get_login_creds for the production
 *     package only — never for .dev, whose debug certificate is the public
 *     React Native one; the package pinned exactly.
 *
 *   node tests/native_passkeys_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
const NATIVE = path.join(ROOT, 'native');
const SRC = path.join(NATIVE, 'src');
const FILE = path.join(SRC, 'lib/passkeys.ts');
const nreq = createRequire(path.join(NATIVE, 'package.json'));
const ts = nreq('typescript');

let fail = 0;
const check = (label, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `\n        ${extra}`}`); };

/* ---------------------------------------------------------------- 1. static */
console.log('=== 1. no runtime import of react-native-passkeys ===');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PKG = /(import\s+(?!type\s)[^;]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s+(?!type\s)[^;]*?from\s*|import\s*)['"]react-native-passkeys(?:\/[^'"]*)?['"]/g;
const uses = (src) => [...src.matchAll(PKG)].length;
const hits = walk(SRC).flatMap((f) => (uses(stripComments(fs.readFileSync(f, 'utf8'))) ? [path.relative(NATIVE, f)] : []));
check('nothing in native/src loads react-native-passkeys at runtime', hits.length === 0, JSON.stringify(hits));
check('control: a static import is caught', uses("import { create } from 'react-native-passkeys';") === 1);
check('control: a dynamic import() is caught', uses("const p = await import('react-native-passkeys');") === 1);
check('control: a require() is caught', uses("const p = require('react-native-passkeys/build');") === 1);
check('control: `import type` is not a runtime use', uses("import type { CreationResponse } from 'react-native-passkeys';") === 0);
const src = fs.readFileSync(FILE, 'utf8');
check("lib/passkeys.ts asks requireOptionalNativeModule('ReactNativePasskeys')",
  /requireOptionalNativeModule<\w+>\('ReactNativePasskeys'\)/.test(src));
{
  let out = null;
  let err = null;
  try {
    out = nreq('@babel/core').transformSync(src, {
      filename: FILE, cwd: NATIVE, babelrc: false, configFile: path.join(NATIVE, 'babel.config.js'),
      caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
    }).code;
  } catch (e) { err = e; }
  check('Babel (the project config) compiles lib/passkeys.ts', !!out, String(err && err.message).slice(0, 200));
  if (out) check('…and the bundle it makes never names the package', !/react-native-passkeys/.test(out));
}

/* --------------------------------------------------------------- 2. runtime */
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function load({ present = false, supported = true, platform = 'ios', serverOk = true, lock = true } = {}) {
  const log = { create: [], get: [], login: [], sent: [] };
  const store = new Map();
  const reply = { get: null, create: null, getThrows: null, createThrows: null };
  const native = {
    isSupported: () => supported,
    create: async (req) => { log.create.push(req); if (reply.createThrows) throw reply.createThrows; return reply.create; },
    get: async (req) => { log.get.push(req); if (reply.getThrows) throw reply.getThrows; return reply.get; },
  };
  const mods = {
    expo: { requireOptionalNativeModule: (n) => (n === 'ReactNativePasskeys' && present ? native : null) },
    'react-native': { Platform: { OS: platform } },
    '@react-native-async-storage/async-storage': {
      __esModule: true,
      default: {
        getItem: async (k) => (store.has(k) ? store.get(k) : null),
        setItem: async (k, v) => { store.set(k, String(v)); },
        removeItem: async (k) => { store.delete(k); },
      },
    },
    '@/lib/api': { api: { passkeysEnabled: async (rp) => serverOk && rp === 'hawkeye.com.ng' } },
    '@/lib/auth': {
      passkeyLoginOptions: async () => ({
        ok: true,
        options: {
          challenge: 'Y2hhbGxlbmdl', rpId: 'hawkeye.com.ng', timeout: 120000, userVerification: 'required',
          allowCredentials: [{ id: 'abc', type: 'public-key', transports: ['smart-card', 'cable'] }], hints: ['client-device'], extensions: { x: 1 },
        },
      }),
      passkeyLogin: async (response) => { log.login.push(response); return { ok: true, needsUnit: false }; },
    },
    '@/lib/authed-send': {
      authedSend: async (method, p, body, headers) => {
        log.sent.push({ method, p, body, headers });
        if (p.endsWith('/register-options')) {
          return { status: 200, body: { options: {
            challenge: 'Y2g', rp: { name: 'Hawkeye', id: 'hawkeye.com.ng' }, user: { id: 'dXNlcg', name: 'Hawkeye observer #7', displayName: 'Hawkeye observer #7' },
            pubKeyCredParams: [{ alg: -7, type: 'public-key' }], timeout: 120000, attestation: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            excludeCredentials: [{ id: 'old', type: 'public-key', transports: ['internal', 'smart-card'] }],
            extensions: { credProps: true }, hints: [],
          } } };
        }
        if (p.endsWith('/register')) return { status: 200, body: { passkeys: [{ id: 'new', label: 'iCloud Keychain', createdAt: 1, lastUsedAt: null, synced: true }] } };
        if (p.endsWith('/remove')) return { status: 200, body: { passkeys: [] } };
        return { status: 200, body: { passkeys: [{ id: 'p1', label: 'Chrome · Windows', createdAt: 1, lastUsedAt: 2, synced: true }] } };
      },
    },
    '@/lib/i18n': { t: (k) => `T(${k})`, currentLangForOtp: () => 'ha' },
    '@/lib/identity': { getIdentity: async () => ({ deviceId: 'd'.repeat(64) }) },
    'expo-local-authentication': {
      SecurityLevel: { NONE: 0, SECRET: 1 },
      isEnrolledAsync: async () => lock,
      getEnrolledLevelAsync: async () => (lock ? 1 : 0),
    },
  };
  const req = (id) => { if (!(id in mods)) throw new Error('unexpected import ' + id); return mods[id]; };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: req, setTimeout, clearTimeout });
  return { api: module.exports, log, store, reply };
}

console.log('\n=== 2. module ABSENT (OTA on a 1.0.11 binary) ===');
{
  let loaded = null;
  let err = null;
  try { loaded = load({ present: false }); } catch (e) { err = e; }
  check('lib/passkeys.ts loads without the native module', !!loaded, String(err));
  if (loaded) {
    const { api: P, log } = loaded;
    check('passkeysInBinary() is false', P.passkeysInBinary() === false);
    check('passkeysUsable() is false', (await P.passkeysUsable()) === false);
    check("createState() is 'no'", (await P.createState()) === 'no');
    const s = await P.signInWithPasskey();
    check('sign-in answers unsupported, and nothing reaches the server', s.ok === false && s.error === 'unsupported' && log.login.length === 0, JSON.stringify(s));
    const r = await P.registerPasskeyHere();
    check('registration answers unsupported, no options are asked for', r.ok === false && log.sent.length === 0, JSON.stringify(r));
    check('no offer after a returning sign-in', (await P.shouldOfferPasskey(false)) === false);
    const list = await P.listPasskeys();
    check('Profile can still list passkeys (no module needed)', Array.isArray(list) && list.length === 1);
  }
  const web = load({ present: true, platform: 'web' });
  check('control: the web build never touches the module either', web.api.passkeysInBinary() === false);
}

console.log('\n=== 3. module PRESENT ===');
{
  const { api: P, log, store, reply } = load({ present: true });
  check('control: with the module present, passkeysInBinary() is true', P.passkeysInBinary() === true);
  check('…and passkeysUsable() is true when the server says so', (await P.passkeysUsable()) === true);
  check('control: an OS too old for passkeys (isSupported false) is not offered one', load({ present: true, supported: false }).api.passkeysInBinary() === false);
  check('control: a server with passkeys off is not offered one', (await load({ present: true, serverOk: false }).api.passkeysUsable()) === false);

  // Sign-in: the request the sheet sees, and what the server gets back.
  reply.get = {
    id: 'q+/w==', rawId: undefined, type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: 'Y2Q', authenticatorData: 'YWQ', signature: 'c2ln', userHandle: 'dXNlcg==' },
    clientExtensionResults: { largeBlob: { supported: null } },
  };
  const s = await P.signInWithPasskey();
  check('sign-in succeeds through passkeyLogin', s.ok === true, JSON.stringify(s));
  const g = log.get[0] || {};
  check('the sheet gets rpId hawkeye.com.ng and the challenge', g.rpId === 'hawkeye.com.ng' && g.challenge === 'Y2hhbGxlbmdl', JSON.stringify(g));
  check('…without hints, extensions or transports (an unknown transport fails the iOS enum)',
    !('hints' in g) && !('extensions' in g) && JSON.stringify(g.allowCredentials) === JSON.stringify([{ id: 'abc', type: 'public-key' }]), JSON.stringify(g));
  const sent = log.login[0] || {};
  check('the server gets base64url ids, rawId filled in, type public-key',
    sent.id === 'q-_w' && sent.rawId === 'q-_w' && sent.type === 'public-key' && sent.response?.userHandle === 'dXNlcg', JSON.stringify(sent));
  check('…and no platform extension outputs', JSON.stringify(sent.clientExtensionResults) === '{}');
  check('a passkey sign-in marks this phone as having one (no offer after)', store.get('hawkeye_pk_here') === '1');

  // Registration.
  store.clear();
  reply.create = { id: 'bmV3', rawId: 'bmV3', type: 'public-key', response: { clientDataJSON: 'Y2Q', attestationObject: 'YW8', transports: ['internal', 7] } };
  const r = await P.registerPasskeyHere();
  check('registration succeeds and returns the new list', r.ok === true && r.passkeys.length === 1, JSON.stringify(r));
  const opt = log.sent.find((x) => x.p.endsWith('/register-options'));
  check('options are asked for with the device id and the language', opt?.headers?.['x-device-id'] === 'd'.repeat(64) && opt?.body?.lang === 'ha', JSON.stringify(opt));
  const c = log.create[0] || {};
  check('the create sheet gets rp.id, user and the challenge', c.rp?.id === 'hawkeye.com.ng' && c.user?.name === 'Hawkeye observer #7' && c.challenge === 'Y2g', JSON.stringify(c));
  check('…excludeCredentials without transports; no hints or extensions',
    JSON.stringify(c.excludeCredentials) === JSON.stringify([{ id: 'old', type: 'public-key' }]) && !('hints' in c) && !('extensions' in c), JSON.stringify(c));
  const reg = log.sent.find((x) => x.p.endsWith('/passkeys/register'));
  check('the registration posted carries the device id and clean transports',
    reg?.headers?.['x-device-id'] === 'd'.repeat(64) && JSON.stringify(reg?.body?.response?.response?.transports) === '["internal"]', JSON.stringify(reg));

  // A sheet that hands back nothing is a cancel; a malformed reply is never posted.
  reply.get = null;
  const before = log.login.length;
  const n = await P.signInWithPasskey();
  check('no credential back = cancelled, nothing posted', n.ok === false && n.error === 'cancelled' && log.login.length === before, JSON.stringify(n));
  reply.get = { id: 'x', response: { clientDataJSON: 'a' } };
  const m = await P.signInWithPasskey();
  check('control: a reply missing its signature is not posted either', m.ok === false && log.login.length === before, JSON.stringify(m));

  // Failures, as each OS reports them.
  const F = (e) => P.nativeFailure(e);
  check('iOS cancel (ERR_USER_CANCELLED) = cancelled', F({ code: 'ERR_USER_CANCELLED', message: 'The operation couldn’t be completed.' }) === 'cancelled');
  check('Android cancel (UserCancelled) = cancelled', F({ code: 'Passkey Get', message: 'UserCancelled' }) === 'cancelled');
  check('Android no passkey (NoCredentials) = none-here', F({ code: 'Passkey Get', message: 'NoCredentials' }) === 'none-here');
  check('iOS without Face ID / Touch ID = no-lock', F({ code: 'ERR_BIOMETRIC', message: 'Biometrics must be enabled' }) === 'no-lock');
  check('a passkey already on this phone = already-here (Android DomError, iOS 17.4+ error 1006)',
    F({ message: 'DomError: InvalidStateError - excluded' }) === 'already-here'
    && F({ code: 'ERR_UNKNOWN', message: 'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1006.)' }) === 'already-here');
  check('association not set up = unavailable (iOS ERR_NOT_CONFIGURED / ERR_NOT_SUPPORTED, Android SecurityError)',
    F({ code: 'ERR_NOT_CONFIGURED' }) === 'unavailable' && F({ code: 'ERR_NOT_SUPPORTED' }) === 'unavailable'
    && F({ message: 'DomError: SecurityError - cannot be validated' }) === 'unavailable');
  check('control: anything else = failed', F(new Error('boom')) === 'failed');
  reply.getThrows = { code: 'Passkey Get', message: 'NoCredentials' };
  const nc = await P.signInWithPasskey();
  check('a thrown NoCredentials reaches the caller as none-here', nc.ok === false && nc.error === 'none-here', JSON.stringify(nc));
  check('every failure has a sentence, through a key', ['cancelled', 'none-here', 'no-lock', 'already-here', 'unavailable', 'network', 'passkey_failed', 'too_many_passkeys', 'failed']
    .every((e) => /^T\((n\.)?passkey\./.test(P.passkeyErrorText(e))));

  // The offer after a returning sign-in.
  store.clear();
  check('offered after a returning sign-in on a phone with a lock', (await P.shouldOfferPasskey(false)) === true);
  check('never to a brand-new account', (await P.shouldOfferPasskey(true)) === false);
  await P.offerPasskeyLater();
  check('"Not now" holds it back', (await P.shouldOfferPasskey(false)) === false);
  store.set('hawkeye_pk_offer_later', String(Date.now() - 31 * 24 * 3600_000));
  check('…for 30 days, then it may ask again', (await P.shouldOfferPasskey(false)) === true);
  store.set('hawkeye_pk_here', '1');
  check('not once this phone has a passkey', (await P.shouldOfferPasskey(false)) === false);
  const rm = await P.removePasskey('p1');
  check('removing one forgets that this phone has one (offer again later)', rm.ok === true && !store.has('hawkeye_pk_here'));
  const nolock = load({ present: true, lock: false });
  check("no lock on the phone: createState() 'no-lock', and no offer",
    (await nolock.api.createState()) === 'no-lock' && (await nolock.api.shouldOfferPasskey(false)) === false);
  const droid = load({ present: true, platform: 'android' });
  check('Android counts a PIN or pattern as a lock', (await droid.api.createState()) === 'yes');
}

/* ---------------------------------------------------------------- 4. strings */
console.log('\n=== 4. strings ===');
const B = {};
for (const l of ['en', 'ha', 'ig', 'yo']) B[l] = JSON.parse(fs.readFileSync(path.join(SRC, `lib/i18n/${l}.json`), 'utf8'));
const called = new Set();
for (const f of [FILE, path.join(SRC, 'app/sign-in.tsx'), path.join(SRC, 'app/profile.tsx')]) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/i18nT\(\s*'((?:n\.)?passkey\.[^']+)'/g)) called.add(m[1]);
}
check('the passkey keys are called from lib, sign-in and profile', called.size >= 20, `${called.size}: ${[...called].join(', ')}`);
const bad = [];
for (const k of called) {
  if (typeof B.en[k] !== 'string') { bad.push(`${k} missing from en`); continue; }
  for (const l of ['ha', 'ig', 'yo']) {
    const v = B[l][k];
    if (typeof v !== 'string' || v === k || v === B.en[k]) bad.push(`${k} [${l}] = ${JSON.stringify(v)}`);
  }
}
check('every one is translated in ha, ig and yo', bad.length === 0, bad.slice(0, 8).join('\n        '));
const webEn = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/i18n/en.json'), 'utf8'));
const drift = [...called].filter((k) => !k.startsWith('n.') && webEn[k] !== B.en[k]);
check('shared keys say exactly what the web says', drift.length === 0, drift.join(', '));

/* ------------------------------------------------ 5. association files + config */
console.log('\n=== 5. association files and config ===');
const appJson = JSON.parse(fs.readFileSync(path.join(NATIVE, 'app.json'), 'utf8')).expo;
const domains = appJson.ios?.associatedDomains || [];
check('iOS keeps applinks:hawkeye.com.ng', domains.includes('applinks:hawkeye.com.ng'), JSON.stringify(domains));
check('iOS adds webcredentials:hawkeye.com.ng', domains.includes('webcredentials:hawkeye.com.ng'), JSON.stringify(domains));
const aasa = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/.well-known/apple-app-site-association'), 'utf8'));
check('AASA lists the native app under webcredentials.apps', (aasa.webcredentials?.apps || []).includes('G99KD9RW94.ng.com.hawkeye.observer'), JSON.stringify(aasa.webcredentials));
check('…and only the native app (Lite cannot use passkeys)', JSON.stringify(aasa.webcredentials?.apps) === '["G99KD9RW94.ng.com.hawkeye.observer"]');
const ids = (aasa.applinks?.details || []).map((d) => d.appID);
check('AASA applinks unchanged: native then Lite, /open and /join',
  JSON.stringify(ids) === JSON.stringify(['G99KD9RW94.ng.com.hawkeye.observer', 'G99KD9RW94.ng.com.hawkeye.lite'])
  && (aasa.applinks.details || []).every((d) => JSON.stringify(d.paths) === JSON.stringify(['/open', '/open/*', '/join/*'])), JSON.stringify(aasa.applinks));
const links = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/.well-known/assetlinks.json'), 'utf8'));
const byPkg = (p) => links.filter((s) => s.target?.package_name === p);
const prod = byPkg('ng.com.hawkeye.observer');
check('assetlinks: one statement for ng.com.hawkeye.observer', prod.length === 1);
const rel = prod[0]?.relation || [];
check('…with handle_all_urls AND get_login_creds', rel.includes('delegate_permission/common.handle_all_urls') && rel.includes('delegate_permission/common.get_login_creds'), JSON.stringify(rel));
check('…for the Play app signing and upload certificates, as before',
  JSON.stringify(prod[0]?.target?.sha256_cert_fingerprints?.map((f) => f.slice(0, 5))) === '["DE:AC","8E:6F"]');
const dev = byPkg('ng.com.hawkeye.observer.dev');
check('the .dev package (public RN debug certificate FA:C6) is NOT trusted with passkeys',
  dev.length === 1 && !dev[0].relation.includes('delegate_permission/common.get_login_creds'));
check('Lite is NOT trusted with passkeys either (a WebView cannot use them)',
  byPkg('ng.com.hawkeye.lite').every((s) => !s.relation.includes('delegate_permission/common.get_login_creds')));
check('control: the relation check can fail', !['delegate_permission/common.handle_all_urls'].includes('delegate_permission/common.get_login_creds'));
const pkgJson = JSON.parse(fs.readFileSync(path.join(NATIVE, 'package.json'), 'utf8'));
check('react-native-passkeys is pinned to an exact version', /^\d+\.\d+\.\d+$/.test(pkgJson.dependencies['react-native-passkeys'] || ''), pkgJson.dependencies['react-native-passkeys']);

console.log(`\n${fail ? `${fail} FAILED` : 'all passed'}`);
process.exit(fail ? 1 : 0);

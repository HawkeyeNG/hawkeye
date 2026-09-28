#!/usr/bin/env node
/**
 * Test for check_ota_config.mjs, the CI gate on the built ipa/aab (design D9).
 *
 *   node native/scripts/test_check_ota_config.mjs [--real-aab <a pre-1.0.9 native .aab>]
 *
 * The GOOD fixtures are not typed by hand. They are what Expo's own config
 * plugins write into Expo.plist and AndroidManifest from the current
 * native/app.json, so this also fails if app.json stops producing a build that
 * can reach updates.hawkeye.com.ng. Plists are written by Python's plistlib
 * (XML and binary), a writer independent of the reader under test; ipa and aab
 * zips by Python's zipfile. Every bad fixture is a control that must fail.
 *
 * --real-aab: a bundle built before the switch. It must FAIL, and its real
 * aapt2 manifest, with only the updates meta-data swapped for the plugin's,
 * must PASS: that proves the protobuf reader on real build output, not only on
 * this file's encoder.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_URL, protoManifestMetaData } from './check_ota_config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.join(HERE, '..');
const GATE = path.join(HERE, 'check_ota_config.mjs');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-gate-'));
const realIdx = process.argv.indexOf('--real-aab');
const REAL_AAB = realIdx > 0 ? process.argv[realIdx + 1] : null;
const EAS_URL = 'https://u.expo.dev/51397c6b-30ae-4bfb-8c34-589e5ff3a76d';

let fails = 0, n = 0;
const result = (ok, msg) => { n++; if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

// ---- what prebuild writes, from Expo's own plugins and the real app.json ----------------------
process.env.APP_VARIANT = 'production';
const require = createRequire(path.join(NATIVE, 'package.json'));
const { getConfig } = require('@expo/config');
const { IOSConfig, AndroidConfig } = require('@expo/config-plugins');
const updatesVersion = require('expo-updates/package.json').version;
const { exp } = getConfig(NATIVE, { skipSDKVersionRequirement: true });
const iosGood = await IOSConfig.Updates.setUpdatesConfigAsync(NATIVE, exp, {}, updatesVersion);
const man = await AndroidConfig.Updates.setUpdatesConfigAsync(
  NATIVE, exp, { manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' } }] } }, updatesVersion);
const androidGood = man.manifest.application[0]['meta-data']
  .filter((m) => m.$['android:value'] !== undefined)
  .map((m) => [m.$['android:name'], m.$['android:value']]);
const A = (k) => `expo.modules.updates.${k}`;
const aGet = (k) => androidGood.find(([name]) => name === A(k))?.[1];
if (iosGood.EXUpdatesURL !== EXPECTED_URL || aGet('EXPO_UPDATE_URL') !== EXPECTED_URL || !iosGood.EXUpdatesCodeSigningCertificate) {
  console.log(`FAIL app.json no longer yields the self-hosted config: ${JSON.stringify({ ios: iosGood.EXUpdatesURL, android: aGet('EXPO_UPDATE_URL') })}`);
  process.exit(1);
}

// A foreign certificate with the SAME subject: the gate must compare bytes, not names.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Hawkeye OTA updates',
  '-keyout', path.join(T, 'foreign.key'), '-out', path.join(T, 'foreign.crt')], { stdio: 'ignore' });
const FOREIGN = fs.readFileSync(path.join(T, 'foreign.crt'), 'utf8');
const CERT = iosGood.EXUpdatesCodeSigningCertificate;

// ---- writers -------------------------------------------------------------------------------------
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args]);
function zip(out, entries) { // entries: [archiveName, Buffer]
  const dir = fs.mkdtempSync(path.join(T, 'z-'));
  const pairs = entries.map(([name, buf], i) => { const f = path.join(dir, String(i)); fs.writeFileSync(f, buf); return [f, name]; });
  py('import zipfile,sys,json\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n  [z.write(f,a) for f,a in json.loads(sys.argv[2])]',
    out, JSON.stringify(pairs));
  return out;
}
function plist(obj, fmt) {
  const j = path.join(T, 'p.json');
  fs.writeFileSync(j, JSON.stringify(obj));
  return py('import plistlib,sys,json\nsys.stdout.buffer.write(plistlib.dumps(json.load(open(sys.argv[1])),fmt=getattr(plistlib,sys.argv[2])))', j, fmt);
}
function ipa(name, expoPlist, fmt = 'FMT_BINARY') {
  const entries = [['Payload/Hawkeye.app/Info.plist', plist({ CFBundleIdentifier: 'ng.com.hawkeye.observer' }, fmt)]];
  if (expoPlist) entries.push(['Payload/Hawkeye.app/Expo.plist', plist(expoPlist, fmt)]);
  return zip(path.join(T, `${name}.ipa`), entries);
}

// aapt2 protobuf XML (Resources.proto): XmlNode{element=1}, XmlElement{name=3, attribute=4, child=5},
// XmlAttribute{namespace_uri=1, name=2, value=3, compiled_item=6}, Item{str=2}, String{value=1}.
const vint = (x) => { const b = []; do { let y = x % 128; x = Math.floor(x / 128); if (x) y |= 128; b.push(y); } while (x); return Buffer.from(b); };
const fld = (no, payload) => Buffer.concat([vint(no * 8 + 2), vint(payload.length), payload]);
const s = (x) => Buffer.from(x, 'utf8');
const NS = 'http://schemas.android.com/apk/res/android';
const attr = (name, value) => fld(4, Buffer.concat([fld(1, s(NS)), fld(2, s(name)), fld(3, s(value))]));
const attrCompiled = (name, value) => fld(4, Buffer.concat([fld(1, s(NS)), fld(2, s(name)), fld(6, fld(2, fld(1, s(value))))]));
const el = (name, attrs, children = []) => Buffer.concat([fld(3, s(name)), ...attrs, ...children.map((c) => fld(5, fld(1, c)))]);
const metaEl = ([k, v], mk = attr) => el('meta-data', [mk('name', k), mk('value', v)]);
const manifestPb = (meta, mk) => fld(1, el('manifest', [attr('package', 'ng.com.hawkeye.observer')], [
  el('application', [attr('name', '.MainApplication')], meta.map((m) => metaEl(m, mk)))]));
const aab = (name, pb) => zip(path.join(T, `${name}.aab`), [['base/manifest/AndroidManifest.xml', pb], ['BundleConfig.pb', Buffer.alloc(0)]]);

// Full-fidelity protobuf field list, to rewrite a REAL manifest without touching the rest of it.
function decodeAll(buf) {
  const out = []; let p = 0;
  const varint = () => { let v = 0, m = 1, b; do { b = buf[p++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
  while (p < buf.length) {
    const key = varint(), no = Math.floor(key / 8), wt = key % 8;
    if (wt === 0) out.push({ no, wt, v: varint() });
    else if (wt === 2) { const len = varint(); out.push({ no, wt, raw: buf.subarray(p, p + len) }); p += len; }
    else { const len = wt === 1 ? 8 : 4; out.push({ no, wt, raw: buf.subarray(p, p + len) }); p += len; }
  }
  return out;
}
const encodeAll = (list) => Buffer.concat(list.map((f) => (f.wt === 0 ? Buffer.concat([vint(f.no * 8), vint(f.v)])
  : f.wt === 2 ? Buffer.concat([vint(f.no * 8 + 2), vint(f.raw.length), f.raw]) : Buffer.concat([vint(f.no * 8 + f.wt), f.raw]))));
const elName = (elBuf) => { const f = decodeAll(elBuf).find((x) => x.no === 3 && x.wt === 2); return f && f.raw.toString('utf8'); };
function rewriteRealManifest(pb, newMeta) {
  const root = decodeAll(pb);
  const rootEl = root.find((f) => f.no === 1);
  const mf = decodeAll(rootEl.raw);
  let touched = false;
  for (const child of mf.filter((f) => f.no === 5)) {
    const node = decodeAll(child.raw); const nodeEl = node.find((f) => f.no === 1);
    if (!nodeEl || elName(nodeEl.raw) !== 'application') continue;
    const app = decodeAll(nodeEl.raw).filter((f) => {
      if (f.no !== 5) return true;
      const cn = decodeAll(f.raw).find((x) => x.no === 1);
      if (!cn || elName(cn.raw) !== 'meta-data') return true;
      const [[k] = []] = protoManifestMetaData(fld(1, cn.raw));
      return !String(k).startsWith('expo.modules.updates.');
    });
    for (const m of newMeta) app.push({ no: 5, wt: 2, raw: fld(1, metaEl(m)) });
    nodeEl.raw = encodeAll(app); child.raw = encodeAll(node); touched = true;
  }
  if (!touched) throw new Error('no <application> in the real manifest');
  rootEl.raw = encodeAll(mf);
  return encodeAll(root);
}

// ---- run -----------------------------------------------------------------------------------------
function gate(kind, file) {
  const r = spawnSync('node', [GATE, kind, file], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}
function expect(label, kind, file, want) {
  const { code, out } = gate(kind, file);
  const ok = want === 'pass' ? code === 0 : want === 'unreadable' ? code === 2 : code === 1;
  const why = out.split('\n').filter((l) => l.startsWith('::error::OTA config:')).map((l) => l.slice(21, 90)).join(' | ');
  result(ok, `${label}: exit ${code}${want === 'pass' ? '' : ` (control, must ${want === 'unreadable' ? 'be unreadable' : 'fail'})`}${why ? ` — ${why}` : ''}`);
  if (!ok) console.log(out.replace(/^/gm, '      '));
}

console.log(`fixtures from @expo/config-plugins (expo-updates ${updatesVersion}) and native/app.json ${exp.version}; temp ${T}\n`);
for (const fmt of ['FMT_BINARY', 'FMT_XML']) {
  const f = fmt === 'FMT_BINARY' ? 'binary' : 'XML';
  expect(`iOS ${f}: prebuild's Expo.plist`, '--ipa', ipa(`good-${f}`, iosGood, fmt), 'pass');
  expect(`iOS ${f}: certificate with CRLF line ends (same bytes)`, '--ipa',
    ipa(`crlf-${f}`, { ...iosGood, EXUpdatesCodeSigningCertificate: CERT.replace(/\n/g, '\r\n') }, fmt), 'pass');
  expect(`iOS ${f}: EAS URL`, '--ipa', ipa(`eas-${f}`, { ...iosGood, EXUpdatesURL: EAS_URL }, fmt), 'fail');
  expect(`iOS ${f}: URL with a trailing slash`, '--ipa', ipa(`slash-${f}`, { ...iosGood, EXUpdatesURL: `${EXPECTED_URL}/` }, fmt), 'fail');
  const { EXUpdatesCodeSigningCertificate: _c, ...noCert } = iosGood;
  expect(`iOS ${f}: no certificate`, '--ipa', ipa(`nocert-${f}`, noCert, fmt), 'fail');
  expect(`iOS ${f}: foreign certificate, same subject`, '--ipa',
    ipa(`foreign-${f}`, { ...iosGood, EXUpdatesCodeSigningCertificate: FOREIGN }, fmt), 'fail');
  expect(`iOS ${f}: keyid "root"`, '--ipa',
    ipa(`keyid-${f}`, { ...iosGood, EXUpdatesCodeSigningMetadata: { keyid: 'root', alg: 'rsa-v1_5-sha256' } }, fmt), 'fail');
  expect(`iOS ${f}: updates disabled`, '--ipa', ipa(`off-${f}`, { ...iosGood, EXUpdatesEnabled: false }, fmt), 'fail');
}
expect('iOS: ipa without Expo.plist', '--ipa', ipa('noplist', null), 'unreadable');

const swap = (k, v) => androidGood.map(([name, val]) => [name, name === A(k) ? v : val]);
expect("Android: prebuild's meta-data", '--aab', aab('good', manifestPb(androidGood)), 'pass');
expect('Android: values only in compiled_item', '--aab', aab('compiled', manifestPb(androidGood, attrCompiled)), 'pass');
expect('Android: certificate newlines normalised to spaces', '--aab',
  aab('spaces', manifestPb(swap('CODE_SIGNING_CERTIFICATE', aGet('CODE_SIGNING_CERTIFICATE').replace(/\n/g, ' ')))), 'pass');
expect('Android: EAS URL', '--aab', aab('eas', manifestPb(swap('EXPO_UPDATE_URL', EAS_URL))), 'fail');
expect('Android: no certificate', '--aab',
  aab('nocert', manifestPb(androidGood.filter(([k]) => k !== A('CODE_SIGNING_CERTIFICATE')))), 'fail');
expect('Android: foreign certificate, same subject', '--aab', aab('foreign', manifestPb(swap('CODE_SIGNING_CERTIFICATE', FOREIGN))), 'fail');
expect('Android: metadata alg changed', '--aab',
  aab('alg', manifestPb(swap('CODE_SIGNING_METADATA', JSON.stringify({ keyid: 'main', alg: 'none' })))), 'fail');
expect('Android: updates disabled', '--aab', aab('off', manifestPb(swap('ENABLED', 'false'))), 'fail');
expect('Android: URL meta-data twice', '--aab',
  aab('dup', manifestPb([...androidGood, [A('EXPO_UPDATE_URL'), EAS_URL]])), 'unreadable');
expect('Android: not a bundle manifest', '--aab', zip(path.join(T, 'empty.aab'), [['BundleConfig.pb', Buffer.alloc(0)]]), 'unreadable');

if (REAL_AAB) {
  const pb = execFileSync('unzip', ['-p', REAL_AAB, 'base/manifest/AndroidManifest.xml'], { maxBuffer: 1 << 26 });
  const before = protoManifestMetaData(pb);
  expect(`real ${path.basename(REAL_AAB)} (pre-1.0.9)`, '--aab', REAL_AAB, 'fail');
  const url = before.find(([k]) => k === A('EXPO_UPDATE_URL'))?.[1];
  result(url !== EXPECTED_URL, `real bundle's own URL is ${JSON.stringify(url ?? null)}, read from aapt2 output (${before.length} meta-data)`);
  const rewritten = rewriteRealManifest(pb, androidGood);
  const after = protoManifestMetaData(rewritten);
  const kept = before.filter(([k]) => !k.startsWith('expo.modules.updates.')).length;
  result(after.length === kept + androidGood.length, `real manifest rewritten: ${after.length} meta-data = ${kept} untouched + ${androidGood.length} from the plugin`);
  expect('real manifest with the plugin\'s updates meta-data', '--aab', aab('real-good', rewritten), 'pass');
} else {
  console.log('SKIP real-bundle checks (pass --real-aab <pre-1.0.9 native .aab>)');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${n - fails}/${n} passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);

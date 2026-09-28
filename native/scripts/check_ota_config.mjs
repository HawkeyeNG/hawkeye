#!/usr/bin/env node
/**
 * THE BUILT APP MUST POINT AT OUR OTA SERVER AND TRUST OUR KEY (design D9).
 *
 *   node native/scripts/check_ota_config.mjs --ipa  path/to/Hawkeye.ipa
 *   node native/scripts/check_ota_config.mjs --aab  path/to/app-release.aab
 *
 * Exit 0 = pass, 1 = the artifact is wrong, 2 = it could not be read.
 *
 * WHY THE ARTIFACT AND NOT app.json. `updates.url` and the certificate are
 * compiled into the binary, and nothing reads them again until a phone checks
 * for an update. app.json can be right while the build is wrong: eas-cli
 * rewrites `updates.url` ("Overwrote updates.url"), a plugin can drop a key, a
 * prebuild can be stale. A 1.0.9 build that ships with the EAS URL, or with no
 * certificate, or with a different one, can never take an update from
 * updates.hawkeye.com.ng, and the only fix is another store build.
 *
 * What it reads is what expo-updates itself reads at runtime:
 *   iOS      Payload/<App>.app/Expo.plist (binary or XML plist)
 *            EXUpdatesURL, EXUpdatesCodeSigningCertificate,
 *            EXUpdatesCodeSigningMetadata, EXUpdatesEnabled
 *   Android  base/manifest/AndroidManifest.xml in the bundle (aapt2's protobuf
 *            XML, not text), <meta-data> expo.modules.updates.EXPO_UPDATE_URL,
 *            .CODE_SIGNING_CERTIFICATE, .CODE_SIGNING_METADATA, .ENABLED
 *
 * The certificate is compared by the SHA-256 of its DER bytes against
 * native/certs/expo-updates-certificate.crt. The PEM text itself is not
 * compared: XML attribute normalisation can turn its newlines into spaces, and
 * that changes no byte of the certificate.
 *
 * Test: node native/scripts/test_check_ota_config.mjs (fixtures plus controls
 * that must fail, including a real 1.0.8 bundle when one is given).
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_URL = 'https://updates.hawkeye.com.ng/manifest';
// scripts/ota_manifest.mjs signs with exactly these. A build expecting another
// keyid rejects every update we publish.
export const EXPECTED_METADATA = { keyid: 'main', alg: 'rsa-v1_5-sha256' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_CERT = path.join(HERE, '..', 'certs', 'expo-updates-certificate.crt');

// ---- certificate --------------------------------------------------------------------------------
/** SHA-256 of the DER certificate inside a PEM string, or throws. Whitespace-insensitive. */
export function certFingerprint(pem) {
  const blocks = [...String(pem).matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
  if (blocks.length !== 1) throw new Error(`expected one certificate, found ${blocks.length}`);
  const b64 = blocks[0][1].replace(/\\n/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new Error('certificate body is not base64');
  return new X509Certificate(Buffer.from(b64, 'base64')).fingerprint256;
}

// ---- plists ---------------------------------------------------------------------------------------
/** Minimal bplist00 reader: the types Expo.plist can hold. */
export function parseBinaryPlist(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') throw new Error('not a binary plist');
  const t = buf.subarray(buf.length - 32);
  const offSize = t[6], refSize = t[7];
  const count = Number(t.readBigUInt64BE(8)), top = Number(t.readBigUInt64BE(16)), table = Number(t.readBigUInt64BE(24));
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[p + i]; return v; };
  const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offSize, offSize));
  const read = (ref, depth) => {
    if (depth > 32 || ref >= count) throw new Error('malformed binary plist');
    const p = offsets[ref], type = buf[p] >> 4, info = buf[p] & 0xf;
    const len = () => {
      if (info !== 0xf) return [info, p + 1];
      const n = 1 << (buf[p + 1] & 0xf);
      return [uint(p + 2, n), p + 2 + n];
    };
    switch (type) {
      case 0x0: return info === 0x9 ? true : info === 0x8 ? false : null;
      case 0x1: { const n = 1 << info; return n === 8 ? Number(buf.readBigInt64BE(p + 1)) : uint(p + 1, n); }
      case 0x2: return info === 2 ? buf.readFloatBE(p + 1) : buf.readDoubleBE(p + 1);
      case 0x3: return new Date((buf.readDoubleBE(p + 1) + 978307200) * 1000);
      case 0x4: { const [n, s] = len(); return buf.subarray(s, s + n); }
      case 0x5: { const [n, s] = len(); return buf.toString('latin1', s, s + n); }
      case 0x6: { const [n, s] = len(); return Buffer.from(buf.subarray(s, s + 2 * n)).swap16().toString('utf16le'); }
      case 0xa: { const [n, s] = len(); return Array.from({ length: n }, (_, i) => read(uint(s + i * refSize, refSize), depth + 1)); }
      case 0xd: {
        const [n, s] = len(), o = {};
        for (let i = 0; i < n; i++) {
          o[read(uint(s + i * refSize, refSize), depth + 1)] = read(uint(s + (n + i) * refSize, refSize), depth + 1);
        }
        return o;
      }
      default: throw new Error(`unsupported binary plist object type 0x${type.toString(16)}`);
    }
  };
  return read(top, 0);
}

/** Minimal XML plist reader (what prebuild writes; Xcode may or may not convert it). */
export function parseXmlPlist(text) {
  const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]));
  const body = text.replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->/g, '');
  const toks = [...body.matchAll(/<(\/?)([A-Za-z]+)(?:\s+[^>]*?)?\s*(\/?)>|([^<]+)/g)];
  let i = 0;
  const skipWs = () => { while (i < toks.length && toks[i][4] !== undefined && !toks[i][4].trim()) i++; };
  const value = () => {
    skipWs();
    const [, close, tag, selfClose] = toks[i++] || [];
    if (!tag || close) throw new Error('malformed XML plist');
    if (selfClose) return tag === 'true' ? true : tag === 'false' ? false : tag === 'string' ? '' : tag === 'dict' ? {} : tag === 'array' ? [] : null;
    if (tag === 'plist') { const v = value(); skipWs(); i++; return v; }
    if (tag === 'dict' || tag === 'array') {
      const out = tag === 'dict' ? {} : [];
      for (;;) {
        skipWs();
        if (toks[i] && toks[i][1] === '/') { i++; return out; }
        if (tag === 'array') { out.push(value()); continue; }
        const k = value();
        out[k] = value();
      }
    }
    let txt = '';
    while (toks[i] && toks[i][4] !== undefined) txt += toks[i++][4];
    i++; // closing tag
    if (tag === 'key' || tag === 'string') return ent(txt);
    if (tag === 'integer' || tag === 'real') return Number(txt);
    if (tag === 'data') return Buffer.from(txt.replace(/\s+/g, ''), 'base64');
    if (tag === 'date') return new Date(txt);
    throw new Error(`unsupported plist tag <${tag}>`);
  };
  return value();
}

export function parsePlist(buf) {
  return buf.subarray(0, 8).toString('latin1') === 'bplist00' ? parseBinaryPlist(buf) : parseXmlPlist(buf.toString('utf8'));
}

// ---- aapt2 protobuf XML (frameworks/base/tools/aapt2/Resources.proto) ---------------------------
function fields(buf) {
  const out = [];
  let p = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do { if (p >= buf.length) throw new Error('truncated protobuf'); b = buf[p++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return v;
  };
  while (p < buf.length) {
    const key = varint(), no = Math.floor(key / 8), wt = key % 8;
    if (wt === 0) out.push({ no, v: varint() });
    else if (wt === 2) { const n = varint(); if (p + n > buf.length) throw new Error('truncated protobuf'); out.push({ no, b: buf.subarray(p, p + n) }); p += n; }
    else if (wt === 1) p += 8;
    else if (wt === 5) p += 4;
    else throw new Error(`unsupported protobuf wire type ${wt}`);
  }
  return out;
}
const str = (f) => f.b.toString('utf8');

/** Every <meta-data android:name=… android:value=…> in a proto manifest, as [name, value][]. */
export function protoManifestMetaData(buf) {
  const found = [];
  const element = (el, depth) => {
    if (depth > 64) throw new Error('manifest nests too deep');
    const f = fields(el);
    const name = f.find((x) => x.no === 3);
    const attrs = {};
    for (const a of f.filter((x) => x.no === 4)) {
      const af = fields(a.b);
      const an = af.find((x) => x.no === 2);
      if (!an) continue;
      let val = af.find((x) => x.no === 3);
      val = val ? str(val) : undefined;
      if (!val) { // fall back to the compiled item: Item.str (2) or Item.raw_str (3), each { value = 1 }
        const item = af.find((x) => x.no === 6);
        const s = item && fields(item.b).find((x) => x.no === 2 || x.no === 3);
        const v = s && fields(s.b).find((x) => x.no === 1);
        if (v) val = str(v);
      }
      attrs[str(an)] = val;
    }
    if (name && str(name) === 'meta-data' && attrs.name !== undefined) found.push([attrs.name, attrs.value]);
    for (const c of f.filter((x) => x.no === 5)) {
      const node = fields(c.b).find((x) => x.no === 1);
      if (node) element(node.b, depth + 1);
    }
  };
  const root = fields(buf).find((x) => x.no === 1);
  if (!root) throw new Error('not an aapt2 protobuf manifest (no root element)');
  element(root.b, 0);
  return found;
}

// ---- the checks ---------------------------------------------------------------------------------
/**
 * @param cfg { url, cert, metadata, enabled } as the artifact carries them
 *            (metadata: object or JSON string; enabled: boolean, string or undefined)
 * @returns   [{ ok, what }]
 */
export function checkConfig(cfg, repoCertPem = fs.readFileSync(REPO_CERT, 'utf8')) {
  const r = [];
  const add = (ok, what) => r.push({ ok, what });
  add(cfg.url === EXPECTED_URL, `updates URL is ${JSON.stringify(cfg.url ?? null)}, must be ${EXPECTED_URL}`);
  const want = certFingerprint(repoCertPem);
  if (!cfg.cert) add(false, 'code-signing certificate is MISSING: the build would accept unsigned updates and reject ours');
  else {
    let got;
    try { got = certFingerprint(cfg.cert); } catch (e) { got = `unreadable (${e.message})`; }
    add(got === want, `code-signing certificate sha256 ${got}, must be ${want} (native/certs/expo-updates-certificate.crt)`);
  }
  let meta = cfg.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  const metaOk = !!meta && meta.keyid === EXPECTED_METADATA.keyid && meta.alg === EXPECTED_METADATA.alg;
  add(metaOk, `code-signing metadata ${JSON.stringify(meta ?? null)}, must be ${JSON.stringify(EXPECTED_METADATA)}`);
  const off = cfg.enabled === false || String(cfg.enabled).toLowerCase() === 'false';
  add(!off, `expo-updates enabled: ${cfg.enabled === undefined ? '(default: yes)' : cfg.enabled}`);
  return r;
}

function unzipList(zip) {
  return execFileSync('unzip', ['-Z1', zip], { maxBuffer: 64 << 20 }).toString('utf8').split('\n').filter(Boolean);
}
function unzipEntry(zip, entry) {
  // unzip treats its member argument as a wildcard pattern; escape the metacharacters.
  return execFileSync('unzip', ['-p', zip, entry.replace(/[[\]*?\\]/g, '\\$&')], { maxBuffer: 64 << 20 });
}

export function readIpa(ipa) {
  const entries = unzipList(ipa).filter((e) => /^Payload\/[^/]+\.app\/Expo\.plist$/.test(e));
  if (entries.length !== 1) throw new Error(`expected one Payload/*.app/Expo.plist in the ipa, found ${entries.length}`);
  const p = parsePlist(unzipEntry(ipa, entries[0]));
  return {
    source: entries[0],
    url: p.EXUpdatesURL, cert: p.EXUpdatesCodeSigningCertificate,
    metadata: p.EXUpdatesCodeSigningMetadata, enabled: p.EXUpdatesEnabled,
  };
}

export function readAab(aab) {
  const entry = 'base/manifest/AndroidManifest.xml';
  if (!unzipList(aab).includes(entry)) throw new Error(`${entry} is not in the bundle`);
  const md = protoManifestMetaData(unzipEntry(aab, entry));
  const one = (k) => {
    const hits = md.filter(([n]) => n === `expo.modules.updates.${k}`);
    if (hits.length > 1) throw new Error(`meta-data expo.modules.updates.${k} appears ${hits.length} times`);
    return hits[0]?.[1];
  };
  return {
    source: entry,
    url: one('EXPO_UPDATE_URL'), cert: one('CODE_SIGNING_CERTIFICATE'),
    metadata: one('CODE_SIGNING_METADATA'), enabled: one('ENABLED'),
  };
}

function main(argv) {
  const kind = argv[0], file = argv[1];
  if (!['--ipa', '--aab'].includes(kind) || !file || argv.length !== 2) {
    console.error('usage: check_ota_config.mjs --ipa <file.ipa> | --aab <file.aab>');
    return 2;
  }
  let cfg;
  try {
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
    cfg = kind === '--ipa' ? readIpa(file) : readAab(file);
  } catch (e) {
    console.log(`::error::OTA config gate could not read ${file}: ${e.message}`);
    return 2;
  }
  console.log(`OTA config gate: ${path.basename(file)} (${cfg.source})`);
  const results = checkConfig(cfg);
  for (const { ok, what } of results) console.log(ok ? `  ok    ${what}` : `::error::OTA config: ${what}`);
  if (results.every((x) => x.ok)) {
    console.log('  PASS: this build can take signed updates from updates.hawkeye.com.ng');
    return 0;
  }
  console.log('::error::This build cannot receive our OTA updates. Fix native/app.json `updates` (see docs/OTA-SELF-HOSTED.md) and rebuild; do NOT ship it.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

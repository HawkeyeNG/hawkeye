#!/usr/bin/env node
// Self-hosted Expo Updates (design D9): build, sign and verify Expo Updates protocol v1 responses,
// and serve them locally for tests. Driven by scripts/ota_publish_self.sh; see docs/OTA-SELF-HOSTED.md.
//
//   build     --dist D --expo-config F --platform P --runtime R --out O [--channel C] [--base URL] [--message M]
//   rollback  --platform P --runtime R --out O [--channel C]            signed rollBackToEmbedded directive
//   republish --manifest F --platform P --runtime R --out O [--channel C] [--base URL]
//                                                                       an archived update as a NEW update
//   verify    (--url URL | --file BODY [--headers CURL_D_FILE | --content-type T])
//             --platform P --runtime R [--channel C] [--assets] [--expect-id ID|none|directive]
//   serve     --root O/r2 [--port 8787] [--worker-all]                  worker.js + the bucket, on localhost
//
// Signing key: EXPO_UPDATES_PRIVATE_KEY (PEM text, CI) or EXPO_UPDATES_PRIVATE_KEY_FILE (path). It is
// never printed. The certificate and keyid/alg come from native/app.json (updates.codeSigning*).
//
// Two implementations on purpose: build signs with Expo's own @expo/code-signing-certificates
// (signBufferRSASHA256AndVerify, validateSelfSignedCertificate); verify re-implements the client's
// checks (expo-updates android CodeSigningConfiguration/CertificateChain) on Node's crypto, with its
// own multipart parser. A bug in one is not silently shared by the other.
import { createHash, randomUUID, randomBytes, X509Certificate, verify as cryptoVerify } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const NATIVE = path.join(REPO, 'native');
const requireNative = createRequire(path.join(NATIVE, 'package.json'));
const DEFAULT_BASE = 'https://updates.hawkeye.com.ng';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=60';

// ---------------------------------------------------------------------------------------------
function die(msg) { console.error(`ota_manifest: ${msg}`); process.exit(1); }
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
function need(o, ...keys) { for (const k of keys) if (!o[k] || o[k] === true) die(`--${k} is required`); }
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (buf) => createHash('sha256').update(buf).digest();
const md5hex = (buf) => createHash('md5').update(buf).digest('hex');
const SAFE_SEG = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
function checkTarget(o) {
  if (!['ios', 'android'].includes(o.platform)) die('--platform must be ios or android');
  if (!SAFE_SEG.test(o.runtime || '')) die('--runtime: bad value');
  o.channel = o.channel || 'production';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(o.channel)) die('--channel: bad value');
}

function appConfig() {
  const app = JSON.parse(fs.readFileSync(path.join(NATIVE, 'app.json'), 'utf8')).expo;
  const u = app.updates || {};
  if (!u.codeSigningCertificate) die('native/app.json has no updates.codeSigningCertificate');
  const certPath = path.resolve(NATIVE, u.codeSigningCertificate);
  const meta = u.codeSigningMetadata || {};
  return { app, certPath, certPem: fs.readFileSync(certPath, 'utf8'), keyid: meta.keyid || 'main', alg: meta.alg || 'rsa-v1_5-sha256' };
}

function privateKeyPem() {
  if (process.env.EXPO_UPDATES_PRIVATE_KEY) return process.env.EXPO_UPDATES_PRIVATE_KEY;
  const f = process.env.EXPO_UPDATES_PRIVATE_KEY_FILE;
  if (!f) die('set EXPO_UPDATES_PRIVATE_KEY_FILE (or EXPO_UPDATES_PRIVATE_KEY in CI)');
  const real = fs.realpathSync(f);
  if (real.startsWith(REPO + path.sep)) die('the private key is inside the repository; keep it in ~/hawkeye-secrets/expo-updates/');
  return fs.readFileSync(real, 'utf8');
}

// Expo's own code-signing library: the cert must be a valid self-signed code-signing certificate
// for THIS key, or nothing is signed (a wrong key would be rejected by every phone).
function signer(cfg) {
  const csc = requireNative('@expo/code-signing-certificates');
  const forge = requireNative('node-forge');
  const cert = csc.convertCertificatePEMToCertificate(cfg.certPem);
  const privateKey = csc.convertPrivateKeyPEMToPrivateKey(privateKeyPem());
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  csc.validateSelfSignedCertificate(cert, { privateKey, publicKey });
  const daysLeft = (cert.validity.notAfter - Date.now()) / 864e5;
  if (daysLeft < 120) console.error(`ota_manifest: WARNING the code-signing certificate expires in ${Math.floor(daysLeft)} days`);
  const { serializeDictionary } = requireNative('structured-headers');
  return (bodyString) => {
    const sig = csc.signBufferRSASHA256AndVerify(privateKey, cert, Buffer.from(bodyString, 'utf8'));
    return serializeDictionary(new Map([
      ['sig', [sig, new Map()]],
      ['keyid', [cfg.keyid, new Map()]],
      ['alg', [cfg.alg, new Map()]],
    ]));
  };
}

function multipart(parts) {
  const boundary = `hawkeye-ota-${randomBytes(12).toString('hex')}`;
  let s = '';
  for (const p of parts) {
    s += `--${boundary}\r\n`;
    for (const [k, v] of Object.entries(p.headers)) s += `${k}: ${v}\r\n`;
    s += `\r\n${p.body}\r\n`;
  }
  s += `--${boundary}--\r\n`;
  return { body: Buffer.from(s, 'utf8'), contentType: `multipart/mixed; boundary=${boundary}` };
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', html: 'text/html',
  css: 'text/css', js: 'application/javascript', txt: 'text/plain', pdf: 'application/pdf', lottie: 'application/json',
};

class Out {
  constructor(dir) {
    this.dir = dir; this.r2 = path.join(dir, 'r2'); this.objects = [];
    this.metaFile = path.join(this.r2, '.meta.json');
    fs.mkdirSync(this.r2, { recursive: true });
    this.meta = fs.existsSync(this.metaFile) ? JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) : {};
  }
  put(key, bytes, contentType, cacheControl, phase) {
    const file = path.join(this.r2, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    this.meta[key] = { contentType, cacheControl };
    this.objects.push({ key, file, contentType, cacheControl, phase, bytes: bytes.length });
  }
  finish(summary) {
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 1));
    const order = { asset: 0, archive: 1, pointer: 2 };   // the pointer LAST: never ahead of its assets
    this.objects.sort((a, b) => order[a.phase] - order[b.phase]);
    fs.writeFileSync(path.join(this.dir, 'plan.json'), JSON.stringify({ ...summary, objects: this.objects }, null, 1));
    fs.writeFileSync(path.join(this.dir, 'plan.tsv'),
      this.objects.map((o) => [o.phase, o.key, o.file, o.contentType, o.cacheControl].join('\t')).join('\n') + '\n');
  }
}

function signedManifestResponse(sign, manifest) {
  const body = JSON.stringify(manifest);
  return multipart([
    { headers: { 'content-disposition': 'form-data; name="manifest"', 'content-type': 'application/json; charset=utf-8', 'expo-signature': sign(body) }, body },
    { headers: { 'content-disposition': 'form-data; name="extensions"', 'content-type': 'application/json' }, body: JSON.stringify({ assetRequestHeaders: {} }) },
  ]);
}

function writeUpdate(o, out, manifest, response, extraArchive = {}) {
  const dir = `updates/${o.channel}/${o.runtime}/${o.platform}/${manifest.id}`;
  out.put(`${dir}/manifest.json`, Buffer.from(JSON.stringify(manifest), 'utf8'), 'application/json', SHORT, 'archive');
  for (const [name, bytes] of Object.entries(extraArchive)) out.put(`${dir}/${name}`, bytes, 'application/json', SHORT, 'archive');
  out.put(`${dir}/response`, response.body, response.contentType, SHORT, 'archive');
  out.put(`manifests/${o.channel}/${o.runtime}/${o.platform}`, response.body, response.contentType, 'no-store', 'pointer');
}

// ---------------------------------------------------------------------------------------------
function cmdBuild(o) {
  need(o, 'dist', 'expo-config', 'platform', 'runtime', 'out'); checkTarget(o);
  const base = (o.base || DEFAULT_BASE).replace(/\/+$/, '');
  const cfg = appConfig();
  const sign = signer(cfg);
  const meta = JSON.parse(fs.readFileSync(path.join(o.dist, 'metadata.json'), 'utf8'));
  const fm = meta.fileMetadata && meta.fileMetadata[o.platform];
  if (!fm || !fm.bundle) die(`no ${o.platform} bundle in ${o.dist}/metadata.json`);
  let expoClient = JSON.parse(fs.readFileSync(o['expo-config'], 'utf8'));
  if (expoClient.exp) expoClient = expoClient.exp;
  // runtimeVersion policy appVersion: the binary's runtime IS its version. Refuse a mismatch
  // rather than publish an update no build will ever accept (or one built from the wrong tree).
  const policy = expoClient.runtimeVersion && expoClient.runtimeVersion.policy;
  if (policy === 'appVersion' && expoClient.version !== o.runtime) die(`--runtime ${o.runtime} but the config's version is ${expoClient.version}`);
  const out = new Out(o.out);
  const asset = (rel, ext, isLaunch) => {
    const bytes = fs.readFileSync(path.join(o.dist, rel));
    const h = sha256(bytes);
    const fileExt = isLaunch ? (rel.endsWith('.hbc') ? 'hbc' : 'js') : (ext || '');
    const key = `assets/${h.toString('hex')}${fileExt ? `.${fileExt}` : ''}`;
    const contentType = isLaunch ? 'application/javascript' : (MIME[(ext || '').toLowerCase()] || 'application/octet-stream');
    out.put(key, bytes, contentType, IMMUTABLE, 'asset');
    const a = { hash: b64url(h), key: md5hex(bytes), contentType, url: `${base}/${key}` };
    if (!isLaunch && ext) a.fileExtension = `.${ext}`;   // the spec: omit it for the launch asset
    return a;
  };
  const launchAsset = asset(fm.bundle, null, true);
  const seen = new Set();
  const assets = [];
  for (const a of fm.assets || []) {
    if (seen.has(a.path)) continue; seen.add(a.path);
    assets.push(asset(a.path, a.ext, false));
  }
  const manifest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion: o.runtime,
    launchAsset,
    assets,
    metadata: {},
    extra: { expoClient, hawkeye: { channel: o.channel, message: o.message ? String(o.message).slice(0, 500) : '' } },
  };
  const response = signedManifestResponse(sign, manifest);
  selfCheck(response, cfg, o, manifest.id);
  writeUpdate(o, out, manifest, response);
  out.finish({ kind: 'manifest', id: manifest.id, createdAt: manifest.createdAt, platform: o.platform, runtime: o.runtime, channel: o.channel, assets: assets.length });
  console.log(JSON.stringify({ kind: 'manifest', id: manifest.id, createdAt: manifest.createdAt, platform: o.platform, runtime: o.runtime, channel: o.channel, assets: assets.length, bundle: launchAsset.url }));
}

function cmdRollback(o) {
  need(o, 'platform', 'runtime', 'out'); checkTarget(o);
  const cfg = appConfig();
  const sign = signer(cfg);
  // Devices on any update committed before commitTime go back to the build's embedded bundle.
  const directive = { type: 'rollBackToEmbedded', parameters: { commitTime: new Date().toISOString() } };
  const body = JSON.stringify(directive);
  const response = multipart([{ headers: { 'content-disposition': 'form-data; name="directive"', 'content-type': 'application/json; charset=utf-8', 'expo-signature': sign(body) }, body }]);
  selfCheck(response, cfg, o, 'directive');
  const out = new Out(o.out);
  const dir = `updates/${o.channel}/${o.runtime}/${o.platform}/rollback-${directive.parameters.commitTime.replace(/[:.]/g, '')}`;
  out.put(`${dir}/response`, response.body, response.contentType, SHORT, 'archive');
  out.put(`manifests/${o.channel}/${o.runtime}/${o.platform}`, response.body, response.contentType, 'no-store', 'pointer');
  out.finish({ kind: 'directive', type: directive.type, commitTime: directive.parameters.commitTime, platform: o.platform, runtime: o.runtime, channel: o.channel });
  console.log(JSON.stringify({ kind: 'directive', type: directive.type, commitTime: directive.parameters.commitTime, platform: o.platform, runtime: o.runtime }));
}

function cmdRepublish(o) {
  need(o, 'manifest', 'platform', 'runtime', 'out'); checkTarget(o);
  const cfg = appConfig();
  const sign = signer(cfg);
  const old = JSON.parse(fs.readFileSync(o.manifest, 'utf8'));
  if (old.runtimeVersion !== o.runtime) die(`archived manifest is for runtime ${old.runtimeVersion}, not ${o.runtime}`);
  // A client only moves to an update NEWER than the one it runs, so rolling back to an old update
  // means re-issuing it: same assets (immutable, already in the bucket), new id, new createdAt.
  const manifest = { ...old, id: randomUUID(), createdAt: new Date().toISOString(),
    extra: { ...(old.extra || {}), hawkeye: { ...((old.extra || {}).hawkeye || {}), republishedFrom: old.id } } };
  const response = signedManifestResponse(sign, manifest);
  selfCheck(response, cfg, o, manifest.id);
  const out = new Out(o.out);
  writeUpdate(o, out, manifest, response);
  out.finish({ kind: 'manifest', id: manifest.id, republishedFrom: old.id, createdAt: manifest.createdAt, platform: o.platform, runtime: o.runtime, channel: o.channel });
  console.log(JSON.stringify({ kind: 'manifest', id: manifest.id, republishedFrom: old.id, createdAt: manifest.createdAt, platform: o.platform, runtime: o.runtime }));
}

// ---------------------------------------------------------------------------------------------
// Verification: what expo-updates does with a response, re-implemented independently.
function parseContentType(ct) {
  const m = /^\s*multipart\/mixed\s*;.*?\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct || '');
  return m ? (m[1] || m[2]) : null;
}
function parseMultipart(body, boundary) {
  const s = body.toString('latin1');   // byte-preserving
  const d = `--${boundary}`;
  let pos = s.indexOf(d);
  if (pos < 0) throw new Error('no multipart boundary in body');
  const parts = [];
  for (;;) {
    pos += d.length;
    if (s.startsWith('--', pos)) return parts;   // close delimiter
    const eol = s.indexOf('\r\n', pos);
    if (eol < 0 || s.slice(pos, eol).trim() !== '') throw new Error('malformed delimiter line');
    const start = eol + 2;
    const next = s.indexOf(`\r\n${d}`, start);
    if (next < 0) throw new Error('multipart body has no closing delimiter');
    const raw = s.slice(start, next);
    let head = ''; let bodyStr = raw;
    if (raw.startsWith('\r\n')) bodyStr = raw.slice(2);
    else {
      const he = raw.indexOf('\r\n\r\n');
      if (he < 0) throw new Error('part without a header/body separator');
      head = raw.slice(0, he); bodyStr = raw.slice(he + 4);
    }
    const headers = {};
    for (const line of head.split('\r\n').filter(Boolean)) {
      const i = line.indexOf(':');
      if (i < 1) throw new Error(`bad part header line: ${line.slice(0, 60)}`);
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const name = /name="([^"]*)"/.exec(headers['content-disposition'] || '');
    parts.push({ name: name ? name[1] : null, headers, body: Buffer.from(bodyStr, 'latin1') });
    pos = next + 2;
  }
}

function certificateChecks(certPem) {
  const x = new X509Certificate(certPem);
  const now = Date.now();
  if (Date.parse(x.validFrom) > now || Date.parse(x.validTo) < now) throw new Error(`certificate not valid now (${x.validFrom} .. ${x.validTo})`);
  if (x.issuer !== x.subject || !x.verify(x.publicKey)) throw new Error('certificate is not self-signed');
  if (!(x.keyUsage || []).includes('1.3.6.1.5.5.7.3.3')) throw new Error('certificate lacks Extended Key Usage: Code Signing');
  const forge = requireNative('node-forge');
  const ku = forge.pki.certificateFromPem(certPem).getExtension('keyUsage');
  if (!ku || !ku.digitalSignature) throw new Error('certificate lacks Key Usage: Digital Signature');
  return x;
}

function checkSignature(part, x, keyid) {
  const { parseDictionary } = requireNative('structured-headers');
  const raw = part.headers['expo-signature'];
  if (!raw) throw new Error(`${part.name} part has no expo-signature (a code-signing build rejects it)`);
  const dict = parseDictionary(raw);
  const sig = dict.get('sig'); const kid = dict.get('keyid');
  if (!sig || typeof sig[0] !== 'string') throw new Error('expo-signature has no sig string');
  const gotKid = kid && typeof kid[0] === 'string' ? kid[0] : 'main';
  if (gotKid !== keyid) throw new Error(`keyid ${gotKid} is not the app's ${keyid}`);
  // The client verifies the part body's UTF-8 bytes with SHA256withRSA against the embedded cert.
  const ok = cryptoVerify('sha256', Buffer.from(part.body.toString('utf8'), 'utf8'), x.publicKey, Buffer.from(sig[0], 'base64'));
  if (!ok) throw new Error(`${part.name} signature does NOT verify against ${path.basename(appConfig().certPath)}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
function checkManifest(m, o, warn) {
  if (!UUID.test(m.id || '')) throw new Error('manifest id is not a UUID');
  if (!m.createdAt || new Date(m.createdAt).toISOString() !== m.createdAt) throw new Error('createdAt is not ISO 8601');
  if (m.runtimeVersion !== o.runtime) throw new Error(`runtimeVersion ${m.runtimeVersion} is not ${o.runtime}`);
  const chk = (a, where, launch) => {
    for (const k of ['key', 'contentType', 'url']) if (typeof a[k] !== 'string' || !a[k]) throw new Error(`${where}.${k} missing`);
    if (!B64URL_SHA256.test(a.hash || '')) throw new Error(`${where}.hash is not base64url SHA-256`);
    if (!/^https:\/\//.test(a.url) && !o.allowHttp) throw new Error(`${where}.url is not https`);
    if (launch && a.fileExtension) warn(`${where}.fileExtension present (the spec says omit it)`);
    if (!launch && a.fileExtension && !a.fileExtension.startsWith('.')) throw new Error(`${where}.fileExtension must start with "."`);
  };
  if (!m.launchAsset) throw new Error('no launchAsset');
  chk(m.launchAsset, 'launchAsset', true);
  if (!Array.isArray(m.assets)) throw new Error('assets is not an array');
  m.assets.forEach((a, i) => chk(a, `assets[${i}]`, false));
  if (typeof m.metadata !== 'object' || Object.values(m.metadata).some((v) => typeof v !== 'string')) throw new Error('metadata must map strings');
  if (!m.extra || typeof m.extra.expoClient !== 'object') throw new Error('extra.expoClient missing (Constants.expoConfig would be empty)');
  if (m.extra.expoClient.version !== o.runtime) warn(`extra.expoClient.version ${m.extra.expoClient.version} differs from the runtime`);
}

async function fetchAssets(m, o) {
  const all = [m.launchAsset, ...m.assets];
  let bytes = 0;
  for (const a of all) {
    const r = await fetch(a.url, { headers: { accept: a.contentType, 'accept-encoding': 'br, gzip' } });
    if (r.status !== 200) throw new Error(`asset ${a.url} -> HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (b64url(sha256(buf)) !== a.hash) throw new Error(`asset ${a.url}: SHA-256 does not match the manifest`);
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (ct !== a.contentType) o.warn(`asset ${a.url}: content-type ${ct} (manifest says ${a.contentType})`);
    bytes += buf.length;
  }
  return { count: all.length, bytes };
}

export function clientHeaders(o, cfg) {
  // What expo-updates 57 sends (android FileDownloader.createRequestForRemoteUpdate), plus
  // app.json requestHeaders and, because codeSigningCertificate is set, expo-expect-signature.
  return {
    accept: 'multipart/mixed,application/expo+json,application/json',
    'expo-platform': o.platform,
    'expo-protocol-version': '1',
    'expo-api-version': '1',
    'expo-updates-environment': 'BARE',
    'expo-json-error': 'true',
    'eas-client-id': randomUUID(),
    'expo-runtime-version': o.runtime,
    'expo-channel-name': o.channel,
    'expo-expect-signature': `sig, keyid="${cfg.keyid}", alg="${cfg.alg}"`,
  };
}

async function cmdVerify(o) {
  need(o, 'platform', 'runtime'); checkTarget(o);
  const cfg = appConfig();
  const warnings = [];
  o.warn = (w) => warnings.push(w);
  o.allowHttp = !!o['allow-http'];
  let status = 200; let headers = {}; let body;
  if (o.url) {
    const r = await fetch(o.url, { headers: clientHeaders(o, cfg) });
    status = r.status; r.headers.forEach((v, k) => { headers[k] = v; });
    body = Buffer.from(await r.arrayBuffer());
  } else if (o.file) {
    body = fs.readFileSync(o.file);
    if (o.headers) {
      const blocks = fs.readFileSync(o.headers, 'latin1').split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
      const lines = (blocks.pop() || '').trim().split(/\r?\n/);
      status = Number((lines.shift() || '').split(' ')[1]);
      for (const l of lines) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    } else headers = { 'content-type': o['content-type'] || '', 'expo-protocol-version': '1', 'expo-sfv-version': '0' };
  } else die('verify needs --url or --file');
  const result = { status };
  try {
    if (status === 204) {
      if (headers['expo-protocol-version'] !== '1') throw new Error('204 without expo-protocol-version: 1 (the client treats it as an error)');
      result.kind = 'none';
    } else {
      if (status !== 200) throw new Error(`HTTP ${status}: ${body.toString('utf8').slice(0, 200)}`);
      if (headers['expo-protocol-version'] !== '1') throw new Error('response lacks expo-protocol-version: 1 ("Legacy manifests are no longer supported")');
      if (headers['expo-sfv-version'] !== '0') o.warn('response lacks expo-sfv-version: 0');
      if (o.url && !/private|no-store|max-age=0/.test(headers['cache-control'] || '')) o.warn(`cache-control ${headers['cache-control']} lets a shared cache keep a per-header response`);
      const boundary = parseContentType(headers['content-type']);
      if (!boundary) throw new Error(`content-type ${headers['content-type']} is not multipart/mixed with a boundary`);
      const parts = parseMultipart(body, boundary);
      const x = certificateChecks(cfg.certPem);
      const mp = parts.find((p) => p.name === 'manifest');
      const dp = parts.find((p) => p.name === 'directive');
      if (!mp && !dp) throw new Error('multipart has neither a manifest nor a directive part');
      if (mp) {
        if (!/^application\/(expo\+)?json/.test(mp.headers['content-type'] || '')) throw new Error('manifest part content-type is not JSON');
        checkSignature(mp, x, cfg.keyid);
        const m = JSON.parse(mp.body.toString('utf8'));
        checkManifest(m, o, o.warn);
        Object.assign(result, { kind: 'manifest', id: m.id, createdAt: m.createdAt, runtimeVersion: m.runtimeVersion, assets: m.assets.length, launchAsset: m.launchAsset.url });
        const ep = parts.find((p) => p.name === 'extensions');
        if (ep) JSON.parse(ep.body.toString('utf8'));
        if (o.assets) result.fetched = await fetchAssets(m, o);
      }
      if (dp) {
        checkSignature(dp, x, cfg.keyid);
        const d = JSON.parse(dp.body.toString('utf8'));
        if (d.type !== 'rollBackToEmbedded' && d.type !== 'noUpdateAvailable') throw new Error(`unknown directive ${d.type}`);
        if (d.type === 'rollBackToEmbedded' && new Date(d.parameters && d.parameters.commitTime).toISOString() !== (d.parameters || {}).commitTime) throw new Error('rollBackToEmbedded without an ISO commitTime');
        Object.assign(result, { kind: mp ? 'manifest+directive' : 'directive', directive: d.type, commitTime: d.parameters && d.parameters.commitTime });
      }
    }
    const e = o['expect-id'];
    if (e) {
      const got = result.kind === 'none' ? 'none' : result.kind === 'directive' ? 'directive' : result.id;
      if (got !== e) throw new Error(`expected ${e}, the server gave ${got}`);
    }
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, ...result, warnings }));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, ...result, warnings }));
}

// ---------------------------------------------------------------------------------------------
// Local stand-in for Cloudflare: /manifest goes through the REAL worker.js with a bucket read from
// disk; every other path is the bucket's public custom domain (static, with the stored headers).
async function cmdServe(o) {
  need(o, 'root');
  const root = path.resolve(o.root);
  const port = Number(o.port || 8787);
  const { default: worker } = await import(pathToFileURL(path.join(HERE, 'ota_worker', 'worker.js')).href);
  const meta = () => { try { return JSON.parse(fs.readFileSync(path.join(root, '.meta.json'), 'utf8')); } catch { return {}; } };
  const fileFor = (key) => {
    const f = path.resolve(root, key);
    return f.startsWith(root + path.sep) && !key.startsWith('.') && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
  };
  const env = { OTA_BUCKET: { async get(key) {
    const f = fileFor(key); if (!f) return null;
    const m = meta()[key] || {};
    return { body: fs.readFileSync(f), httpMetadata: { contentType: m.contentType, cacheControl: m.cacheControl } };
  } } };
  const all = !!o['worker-all'];   // like a Worker Custom Domain: EVERY path goes through worker.js
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let status = 500;
    try {
      if (all || url.pathname === '/manifest') {
        const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers }), env, { waitUntil() {} });
        status = r.status;
        const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
        res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
      } else {
        const key = decodeURIComponent(url.pathname.slice(1));
        const f = fileFor(key);
        if (!f) { status = 404; res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found\n'); }
        else {
          status = 200; const m = meta()[key] || {};
          res.writeHead(200, { 'content-type': m.contentType || 'application/octet-stream', 'cache-control': m.cacheControl || 'no-cache' });
          res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(f));
        }
      }
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
    console.error(`${req.method} ${url.pathname} ${status} platform=${req.headers['expo-platform'] || '-'} runtime=${req.headers['expo-runtime-version'] || '-'}`);
  }).listen(port, '127.0.0.1', () => console.error(`ota_manifest: serving ${root} on http://127.0.0.1:${port}`));
}

function selfCheck(response, cfg, o, expectId) {
  // Verify what was just signed with the independent verifier, before anything is written.
  const boundary = parseContentType(response.contentType);
  const parts = parseMultipart(response.body, boundary);
  const x = certificateChecks(cfg.certPem);
  for (const p of parts.filter((q) => q.name === 'manifest' || q.name === 'directive')) checkSignature(p, x, cfg.keyid);
  const mp = parts.find((p) => p.name === 'manifest');
  if (mp) {
    const m = JSON.parse(mp.body.toString('utf8'));
    checkManifest(m, { ...o, allowHttp: /^http:\/\/127\.0\.0\.1[:/]/.test(o.base || '') }, (w) => console.error(`ota_manifest: WARNING ${w}`));
    if (m.id !== expectId) throw new Error('self-check: id mismatch');
  }
}

// ---------------------------------------------------------------------------------------------
const o = args(process.argv.slice(2));
const cmd = o._[0];
const run = { build: cmdBuild, rollback: cmdRollback, republish: cmdRepublish, verify: cmdVerify, serve: cmdServe }[cmd];
if (!run) die('usage: ota_manifest.mjs build|rollback|republish|verify|serve ... (see the header of this file)');
try { await run(o); } catch (e) { die(e && e.message ? e.message : String(e)); }

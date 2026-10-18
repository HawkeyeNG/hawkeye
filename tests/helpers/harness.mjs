/**
 * The scaffolding the pre-election review tests share, in one place: the
 * PASS/FAIL tally, the shipped app/ served over HTTP with a per-test /api
 * handler, Chromium, and a signed-in placeholder token.
 *
 * Nothing here asserts anything about the app — it only runs it.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const H = '/home/elrio/hawkeye';
export const APP = `${H}/app`;

/** check(label, got, want): `want` a value (deep-equal) or a predicate. */
export function tally() {
  let fail = 0;
  const check = (label, got, want = true) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
  };
  const finish = () => {
    console.log(fail ? `\n${fail} FAILED` : '\nall passed');
    process.exit(fail ? 1 : 0);
  };
  return { check, finish };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * Serve app/ on a free port. `route(u, req, res, json)` runs first and returns
 * true when it answered (or chose never to); `json()` answers and returns true.
 * An unclaimed /api/ path gets {}.
 */
export async function serveApp(route) {
  const server = http.createServer((req, res) => {
    const [u] = req.url.split('?');
    const json = (v, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); return true; };
    if (route && route(u, req, res, json)) return undefined;
    if (u.startsWith('/api/')) return json({});
    const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
    if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    return fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

export async function launch() {
  const { chromium } = createRequire(`${H}/tests/ui/`)('playwright-core');
  return chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
}

/** authgate.js parses the payload, so a placeholder must carry a real exp. */
export const jwt = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;

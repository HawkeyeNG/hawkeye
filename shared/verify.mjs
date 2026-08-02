// shared/verify.mjs — the anti-drift guard.
//
//   node shared/verify.mjs
//
// HARD-FAILS (exit 1) if native/ drifts from shared/tokens.mjs (native is the
// reference implementation). PRINTS, but does not fail on, the web's remaining
// convergence gaps — that list IS the Phase 2 worklist and shrinks as web/
// catches up. Run from the repo root.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BRAND, LIGHT, DARK, WEB_MAP, rgbHex } from "./tokens.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const camelToVar = (k) => "--" + k.replace(/([A-Z])/g, "-$1").toLowerCase();
let hardFail = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); hardFail++; };

// ---- 0. internal consistency of the spec itself --------------------------
console.log("\n[spec] internal consistency");
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
eq(rgbHex(LIGHT.ink), BRAND.ink) ? ok("LIGHT.ink == BRAND.ink") : bad(`LIGHT.ink ${rgbHex(LIGHT.ink)} != BRAND.ink ${BRAND.ink}`);
eq(rgbHex(LIGHT.goodInk), BRAND.leaf) ? ok("LIGHT.goodInk == BRAND.leaf") : bad(`LIGHT.goodInk ${rgbHex(LIGHT.goodInk)} != BRAND.leaf ${BRAND.leaf}`);
eq(rgbHex(LIGHT.surface), BRAND.mist) ? ok("LIGHT.surface == BRAND.mist") : bad(`LIGHT.surface ${rgbHex(LIGHT.surface)} != BRAND.mist ${BRAND.mist}`);

// ---- 1. native/src/global.css must equal CANONICAL triplets --------------
console.log("\n[native] src/global.css semantic triplets");
const css = read("native/src/global.css");
const darkAt = css.indexOf(".theme-dark");
const lightRegion = css.slice(0, darkAt);
const darkRegion = css.slice(darkAt);
const tripletOf = (region, varName) => {
  const m = region.match(new RegExp(varName + ":\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)"));
  return m ? [+m[1], +m[2], +m[3]] : null;
};
for (const [label, region, table] of [["light", lightRegion, LIGHT], ["dark", darkRegion, DARK]]) {
  for (const [key, want] of Object.entries(table)) {
    const v = camelToVar(key);
    const got = tripletOf(region, v);
    if (!got) { bad(`${label} ${v} not found in global.css`); continue; }
    if (got.join(",") !== want.join(",")) bad(`${label} ${v} = ${got.join(" ")} , spec wants ${want.join(" ")}`);
  }
}
if (!hardFail) ok("all light+dark triplets match spec");

// ---- 2. native/tailwind.config.js must carry the brand hexes -------------
console.log("\n[native] tailwind.config.js hawk.* brand");
const tw = read("native/tailwind.config.js");
for (const [k, hex] of Object.entries(BRAND)) {
  tw.toLowerCase().includes(hex.toLowerCase())
    ? ok(`hawk.${k} ${hex} present`)
    : bad(`hawk.${k} ${hex} missing from tailwind.config.js`);
}

// ---- 3. web convergence report (informational) ---------------------------
console.log("\n[web] app/styles.css convergence toward canonical");
const web = read("app/styles.css");
// Split on the real dark SELECTOR, not the bare attribute string — the latter
// also appears in a comment inside the light :root block and would truncate it.
const webLight = web.slice(0, web.indexOf(':root[data-theme="dark"]'));
const hexOf = (region, varName) => {
  const m = region.match(new RegExp(varName + ":\\s*(#[0-9a-fA-F]{3,8})"));
  return m ? m[1] : null;
};
// The web value can be a hex OR a var() alias delegating to another canonical
// token. Presence is read from the file, not assumed from the map's status —
// so once a formerly-missing var is added, it flips to aligned on its own.
const aliasOf = (region, varName) => {
  const m = region.match(new RegExp(varName + ":\\s*var\\((--[a-z0-9-]+)\\)"));
  return m ? m[1] : null;
};
const buckets = { ok: [], converge: [], missing: [], reconcile: [] };
for (const e of WEB_MAP) {
  if (e.status === "reconcile") { buckets.reconcile.push(`${e.webVar} — ${e.note}`); continue; }
  const alias = aliasOf(webLight, e.webVar);
  if (alias) { buckets.ok.push(`${e.webVar} = var(${alias})`); continue; }
  const cur = hexOf(webLight, e.webVar);
  if (cur == null) { buckets.missing.push(`${e.webVar} -> ${e.target}${e.note ? "  (" + e.note + ")" : ""}`); continue; }
  if (e.target && cur.toLowerCase() === e.target.toLowerCase()) buckets.ok.push(`${e.webVar} = ${cur}`);
  else buckets.converge.push(`${e.webVar}: ${cur} -> ${e.target}${e.note ? "  (" + e.note + ")" : ""}`);
}
console.log(`  already aligned : ${buckets.ok.length}`);
console.log(`  needs converge  : ${buckets.converge.length}`);
console.log(`  web missing     : ${buckets.missing.length}`);
console.log(`  reconcile (user): ${buckets.reconcile.length}`);
const dump = (title, arr) => { if (arr.length) { console.log(`\n  -- ${title} --`); arr.forEach((x) => console.log("     " + x)); } };
dump("repoint value (Phase 2)", buckets.converge);
dump("add to web (Phase 2)", buckets.missing);
dump("design decision (ask user)", buckets.reconcile);
dump("aligned", buckets.ok);

// ---- verdict -------------------------------------------------------------
console.log("");
if (hardFail) { console.error(`FAIL: ${hardFail} native/spec drift(s) — native must match shared/tokens.mjs.`); process.exit(1); }
console.log(`OK: native matches canonical. Web convergence: ${buckets.ok.length} aligned, ${buckets.converge.length + buckets.missing.length} gaps, ${buckets.reconcile.length} to decide.`);

/**
 * Read a native source file with its translated strings resolved back to
 * English.
 *
 * WHY THIS EXISTS. Several tests assert on what a screen SAYS by grepping its
 * .tsx for the literal sentence — "Report from your unit", "This account
 * already exists". Since the app was internationalised those sentences live in
 * native/src/lib/i18n/en.json and the source holds `{i18nT('key')}`, so the
 * greps stopped matching and three tests went red without anything about the
 * screens changing.
 *
 * The assertions were right; only the way to find out what a screen says had
 * moved. This resolves the indirection so they can go on asking the same
 * question. It is deliberately NOT a general renderer — it substitutes exactly
 * what the extractor writes, and leaves an unknown key visible as itself so a
 * missing translation shows up as a failure rather than as an empty string.
 */
import fs from 'node:fs';

const EN = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/native/src/lib/i18n/en.json', 'utf8'));

/** `{i18nT('key')}` and `prop={i18nT('key')}` -> the English text. */
export function resolveNativeText(src) {
  return String(src)
    .replace(/=\{i18nT\('([^']+)'\)\}/g, (m, k) => (k in EN ? '="' + EN[k] + '"' : m))
    .replace(/\{i18nT\('([^']+)'\)\}/g, (m, k) => (k in EN ? EN[k] : m));
}

/** readFileSync + resolve, for tests that used to read the raw file. */
export function readNative(path) {
  return resolveNativeText(fs.readFileSync(path, 'utf8'));
}

/** Every key the file references, for a test that wants to check coverage. */
export function keysIn(src) {
  return [...String(src).matchAll(/\{i18nT\('([^']+)'\)\}/g)].map((m) => m[1]);
}

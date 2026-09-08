/**
 * Language for everything the SERVER sends an observer: OTP codes, Telegram
 * pings, push notifications and the rows in the in-app alert feed.
 *
 * WHY THIS IS SEPARATE FROM app/i18n.js. That one translates what the browser
 * renders and reads the choice out of localStorage. The server cannot see
 * localStorage, and half of what it sends arrives when no browser is open at
 * all — a push at 4am, a Telegram message, an SMS. So the choice is also stored
 * on the observer row, and resolved here.
 *
 * WHY THE TEXT IS RESOLVED AT WRITE TIME, NOT AT READ TIME. A notification row
 * holds literal title/body, and one event fans out to many observers who may
 * each read a different language — `noteUnitSavers` writes one row per saver.
 * So the language has to be decided per recipient, at the moment the row is
 * written. Storing a key and translating on read would be tidier, but the feed
 * is also the payload of a push that has already left the building.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'i18n');

export const LANGS = ['en', 'ha', 'ig', 'yo'];
export const DEFAULT_LANG = 'en';

/* Loaded once at boot. Four small files; re-reading them per notification would
   be a file system call on the request path for no benefit. */
const BUNDLES = {};
for (const code of LANGS) {
  try {
    BUNDLES[code] = JSON.parse(fs.readFileSync(path.join(DIR, code + '.json'), 'utf8'));
    delete BUNDLES[code]._meta;
  } catch (e) {
    /* A missing or broken bundle must not stop the server booting — every
       lookup then falls through to English, which is the correct degradation
       for a translation file and the wrong thing to crash over. */
    console.error('[i18n] could not load ' + code + '.json:', e.message);
    BUNDLES[code] = {};
  }
}

export function known(code) {
  return LANGS.includes(String(code || ''));
}

/** Normalise anything a client sent us. Unknown or absent becomes null, not 'en'. */
export function normalise(code) {
  const c = String(code || '').toLowerCase().split('-')[0];
  return known(c) ? c : null;
}

/**
 * Translate. Falls back through the English bundle to the key itself, and
 * substitutes {placeholders} from `params`.
 *
 * A MISSING PLACEHOLDER LEAVES THE BRACES IN, on purpose: "{count} reports"
 * arriving with no count is a bug worth seeing in the output, whereas silently
 * rendering " reports" hides it and ships a sentence with a hole in it.
 */
export function t(lang, key, params = {}) {
  const code = known(lang) ? lang : DEFAULT_LANG;
  const s = (BUNDLES[code] && BUNDLES[code][key])
    || (BUNDLES[DEFAULT_LANG] && BUNDLES[DEFAULT_LANG][key]);
  if (s == null) return key;
  return String(s).replace(/\{(\w+)\}/g, (m, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
  ));
}

/** The observer's language, or English. */
export function langOf(observerId) {
  if (!observerId) return DEFAULT_LANG;
  try {
    const row = db.prepare('SELECT lang FROM observers WHERE id = ?').get(observerId);
    return normalise(row?.lang) || DEFAULT_LANG;
  } catch { return DEFAULT_LANG; }
}

/** Same, by phone hash — the identifier the Telegram and OTP paths carry. */
export function langOfHash(hash) {
  if (!hash) return DEFAULT_LANG;
  try {
    const row = db.prepare('SELECT lang FROM observers WHERE phone_hash = ?').get(hash);
    return normalise(row?.lang) || DEFAULT_LANG;
  } catch { return DEFAULT_LANG; }
}

/**
 * Bind a language once and translate many times: `const tr = forObserver(id)`.
 * Saves a query per string when a handler sends several.
 */
export function forObserver(observerId) {
  const lang = langOf(observerId);
  const fn = (key, params) => t(lang, key, params);
  fn.lang = lang;
  return fn;
}

/**
 * SMS ONLY: does this text fit the GSM-7 alphabet?
 *
 * It matters because it doubles the price and halves the length. A GSM-7
 * message is 160 characters per segment; one character outside the alphabet
 * forces the whole message to UCS-2 and 70 characters per segment. Hausa's
 * hooked letters, Igbo's subdotted vowels and every Yorùbá tone mark are
 * outside it, so a translated SMS is always UCS-2 — which is correct but worth
 * knowing before anyone budgets for SMS at national scale.
 *
 * Nothing branches on this today: SMS OTP is off (config.smsOtpEnabled), and
 * when it returns it should send the observer's language and pay for the
 * segments rather than send Hausa readers English to save money.
 */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\f^{}\\[~\]|€]*$/;
export function smsSegments(text) {
  const s = String(text || '');
  const gsm = GSM7.test(s);
  const per = gsm ? 160 : 70;
  return { gsm7: gsm, perSegment: per, segments: Math.max(1, Math.ceil(s.length / per)) };
}

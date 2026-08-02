// Hawkeye design tokens — THE canonical source of truth.
//
// WHY THIS FILE EXISTS
// --------------------
// The native app (native/) and the web/PWA/Capacitor stack (app/) are two
// separate rendering pipelines that do NOT share a runtime stylesheet:
//   - native drives colour off RGB *triplets* consumed via rgb(var(--x)) so
//     Tailwind opacity modifiers work (bg-card/80). See native/src/global.css.
//   - web drives colour off *hex* CSS vars consumed raw (color: var(--ink)).
//     See app/styles.css.
// Same var names, incompatible formats — so they can't import one CSS file.
// Instead, both are *verified against this spec*. Native is the reference
// implementation; web converges toward it. `shared/verify.mjs` reads both
// codebases and (a) HARD-FAILS if native ever drifts from CANONICAL, (b)
// reports the web's remaining convergence gaps as the Phase 2 worklist.
//
// EDITING RULE: change a value here and in native/src/global.css (or
// native/tailwind.config.js) together, never one silently. `node shared/verify.mjs`
// is the guard. Do not hand-edit the two codebases into agreement — edit the
// spec, then make them match it.

/** Fixed brand marks — same hex in every theme, both platforms. */
export const BRAND = {
  green: "#004225", // primary — header, key surfaces, CTAs
  leaf:  "#0b6b3a", // secondary green — good-ink / affirmative headings
  gold:  "#f5b301", // brand accent gold (NOT the hazard caution yellow)
  ink:   "#10221a", // darkest brand ink
  mist:  "#e8f2ec", // lightest brand wash — the light-theme screen background
};

// Semantic palette as RGB triplets [r,g,b]. This is native's native format
// (native/src/global.css). Web hex is derived from these via rgbHex().
// LIGHT is also the pre-hydration :root fallback on both platforms.
export const LIGHT = {
  surface:    [232, 242, 236], // screen background (= brand mist)
  card:       [255, 255, 255], // raised card
  ink:        [16, 34, 26],    // primary text (= brand ink)
  muted:      [82, 96, 88],    // secondary text
  faint:      [141, 156, 147], // tertiary text, icons
  line:       [226, 236, 230], // hairlines, dividers
  disabled:   [212, 212, 212], // dead buttons
  good:       [223, 242, 232], goodInk:    [11, 107, 58],  // affirmative / private / enforced
  bad:        [254, 233, 232], badInk:     [185, 28, 28],  // prohibition / danger / fraud
  warn:       [254, 243, 220], warnInk:    [180, 83, 9],   // informational notice / open / public
  caution:    [245, 217, 10],  cautionInk: [122, 62, 0],   // SAFETY OF PERSON ONLY — real hazard yellow
};

export const DARK = {
  surface:    [8, 20, 14],
  card:       [18, 36, 27],
  ink:        [232, 242, 236],
  muted:      [158, 176, 165],
  faint:      [110, 128, 118],
  line:       [32, 56, 43],
  disabled:   [48, 62, 54],
  good:       [16, 56, 36],  goodInk:    [110, 219, 160],
  bad:        [66, 24, 26],  badInk:     [252, 165, 165],
  warn:       [64, 44, 12],  warnInk:    [252, 211, 77],
  caution:    [107, 82, 0],  cautionInk: [250, 224, 20],
};

/** Typography + shape. DECIDED 2026-08-02: both platforms use Spline Sans as
 *  the display/heading face (web drops its old Lora serif); body stays Inter.
 *  Keep native/src/global.css --font-display and app/styles.css headings on
 *  this one stack. */
export const TYPE = {
  // Display / headings — both platforms. (native/src/global.css --font-display)
  display: "Spline Sans, Inter, ui-sans-serif, system-ui, sans-serif",
  body: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  radius: "14px",
};

/** [r,g,b] -> "#rrggbb" */
export function rgbHex([r, g, b]) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ---------------------------------------------------------------------------
// WEB CONVERGENCE MAP
// ---------------------------------------------------------------------------
// The web (app/styles.css) uses its OWN legacy var names, some of which don't
// map 1:1 onto the semantic set (e.g. web splits --bg=screen / --surface=card,
// native folds screen into `surface` and card into `card`). Each entry says
// where a web var should land once it converges on CANONICAL. `token` is the
// LIGHT-theme canonical key it should equal (or null for brand/web-only).
//
// status:
//   'converge'    — web var exists; repoint its VALUE to the target (a visible
//                   change, belongs in Phase 2). `target` is the hex to land on.
//   'ok'          — web already equals canonical; guard against future drift.
//   'reconcile'   — genuine design decision, do NOT auto-flip (display face,
//                   the mint --accent). Flag for the user.
//   'web-missing' — native has this token, web has no equivalent var; Phase 2
//                   should ADD it (e.g. the caution safety pair, --faint).
export const WEB_MAP = [
  // brand / greens
  { webVar: "--green",       token: null,      target: BRAND.green,          status: "converge", note: "web accent green #008751 -> brand #004225" },
  { webVar: "--bg",          token: "surface", target: rgbHex(LIGHT.surface), status: "converge", note: "screen bg -> brand mist" },
  { webVar: "--card",        token: "card",    target: rgbHex(LIGHT.card),    status: "ok" },
  { webVar: "--surface",     token: "card",    target: rgbHex(LIGHT.card),    status: "ok",       note: "web card-solid == native card" },
  { webVar: "--ink",         token: "ink",     target: rgbHex(LIGHT.ink),     status: "converge", note: "#14201a -> #10221a" },
  { webVar: "--muted",       token: "muted",   target: rgbHex(LIGHT.muted),   status: "converge", note: "#5b6b62 -> #526058" },
  { webVar: "--line",        token: "line",    target: rgbHex(LIGHT.line),    status: "converge", note: "#e3e8e4 -> #e2ece6" },
  // severity tints + inks
  { webVar: "--tint-ok",     token: "good",    target: rgbHex(LIGHT.good),    status: "converge" },
  { webVar: "--tint-danger", token: "bad",     target: rgbHex(LIGHT.bad),     status: "converge" },
  { webVar: "--tint-warn",   token: "warn",    target: rgbHex(LIGHT.warn),    status: "converge" },
  { webVar: "--text-danger", token: "badInk",  target: rgbHex(LIGHT.badInk),  status: "converge" },
  { webVar: "--text-warn",   token: "warnInk", target: rgbHex(LIGHT.warnInk), status: "converge", note: "#7a4506 -> #b45309" },
  // accents / design decisions
  { webVar: "--gold",        token: null,      target: BRAND.gold,           status: "converge", note: "#f5c518 -> brand gold #f5b301" },
  // DECIDED 2026-08-02: mint dropped. --accent is now an ALIAS -> var(--gold)
  // (brand gold pops on the dark-green hero/header, native's accent pattern);
  // brand-green CTAs come from --green on light surfaces.
  { webVar: "--accent",      token: null,      target: BRAND.gold,           status: "alias", note: "aliased to var(--gold) — brand gold accent that pops on green" },
  // native tokens the web is MISSING entirely
  { webVar: "--faint",       token: "faint",   target: rgbHex(LIGHT.faint),   status: "web-missing" },
  { webVar: "--disabled",    token: "disabled", target: rgbHex(LIGHT.disabled), status: "web-missing" },
  { webVar: "--caution",     token: "caution", target: rgbHex(LIGHT.caution), status: "web-missing", note: "SAFETY-OF-PERSON hazard yellow (incident report card)" },
  { webVar: "--caution-ink", token: "cautionInk", target: rgbHex(LIGHT.cautionInk), status: "web-missing" },
];

/** @type {import("tailwindcss").Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Hawkeye brand — keep in sync with app/styles.css on the web side
        // Semantic, theme-aware. Use these for anything that must read in both
        // themes; use hawk.* only for brand surfaces that stay put.
        surface: "rgb(var(--surface) / <alpha-value>)",
        card: "rgb(var(--card) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        disabled: "rgb(var(--disabled) / <alpha-value>)",
        // Tinted surfaces. bg-good / bg-bad / bg-warn darken with the theme, so
        // text-ink stays legible on them; text-good-ink / text-bad-ink /
        // text-warn-ink are the heading + icon colours that go on that tint.
        // Never reach for bg-emerald-50 / bg-red-50 / bg-amber-50 again — those
        // stay pale in dark mode and the body copy on them disappears.
        good: {
          DEFAULT: "rgb(var(--good) / <alpha-value>)",
          ink: "rgb(var(--good-ink) / <alpha-value>)",
        },
        bad: {
          DEFAULT: "rgb(var(--bad) / <alpha-value>)",
          ink: "rgb(var(--bad-ink) / <alpha-value>)",
        },
        warn: {
          DEFAULT: "rgb(var(--warn) / <alpha-value>)",
          ink: "rgb(var(--warn-ink) / <alpha-value>)",
        },
        // bg-caution / text-caution-ink — SAFETY OF PERSON ONLY, a real hazard
        // yellow. bg-warn is the informational notice and covers everything
        // else; see the comment on --caution in src/global.css before reaching
        // for this one, because "this is important" is not the same claim as
        // "this could get you hurt".
        caution: {
          DEFAULT: "rgb(var(--caution) / <alpha-value>)",
          ink: "rgb(var(--caution-ink) / <alpha-value>)",
        },
        hawk: {
          green: "#004225",
          leaf: "#0b6b3a",
          gold: "#f5b301",
          ink: "#10221a",
          mist: "#e8f2ec",
        },
      },
    },
  },
  plugins: [],
};

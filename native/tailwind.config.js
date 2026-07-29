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

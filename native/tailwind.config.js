/** @type {import("tailwindcss").Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Hawkeye brand — keep in sync with app/styles.css on the web side
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

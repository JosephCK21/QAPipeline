/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // App surfaces
        bg:             "#F4F5F7", // page background (Atlassian N20)
        surface:        "#FFFFFF", // cards, sidebar, navbar
        surfaceRaised:  "#FFFFFF",
        surfaceSoft:    "#F1F2F4", // hover/subtle panel
        surfaceSunken:  "#FAFBFC",

        // Borders
        borderSubtle:   "#DFE1E6",
        borderDefault:  "#C1C7D0",

        // Text
        text:           "#172B4D", // primary
        textSecondary:  "#5E6C84",
        textMuted:      "#8993A4",

        // Brand accent (Atlassian blue)
        brand:          "#0C66E4",
        brandHover:     "#0747A6",
        brandSoft:      "#E9F2FF",

        // Status colors (modern, WCAG-friendly)
        success:        "#00875A",
        successSoft:    "#E3FCEF",
        warning:        "#B65C00",
        warningSoft:    "#FFF7D6",
        danger:         "#C9372C",
        dangerSoft:     "#FFEBE6",
        info:           "#0065FF",
        infoSoft:       "#DEEBFF",
        purpleAccent:   "#5E4DB2",
        purpleSoft:     "#EAE6FF",

        // Legacy shims (kept so any missed references don't break layout)
        background:     "#F4F5F7",
        primary:        "#0C66E4",
        secondary:      "#C9372C",
        textPrimary:    "#172B4D",
        border:         "#DFE1E6",
      },
      fontFamily: {
        heading: ["Inter", "system-ui", "sans-serif"],
        body:    ["Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card:     "0 1px 2px rgba(9,30,66,0.08), 0 0 1px rgba(9,30,66,0.12)",
        cardHover:"0 4px 8px -2px rgba(9,30,66,0.12), 0 0 1px rgba(9,30,66,0.16)",
        raised:   "0 8px 24px -6px rgba(9,30,66,0.15), 0 2px 6px -2px rgba(9,30,66,0.08)",
      },
    },
  },
  plugins: [],
}

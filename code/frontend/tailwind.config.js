/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#FAFAFA",
        primary: "#2563FF",
        secondary: "#FF4F64",
        textPrimary: "#1A1A1A",
        textSecondary: "#6B7280",
        border: "#E5E7EB",
      },
      fontFamily: {
        heading: ["Montserrat", "sans-serif"],
        body: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
}

// Theme colors come from CSS variables (src/dashboard/styles.css), so dark mode is one set of overrides
// there instead of a dark: variant on every class. Stone runs the other way in the dark: 50 is still
// "a shade off the card", 900 is still "strongest text".
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const stone = Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => [n, v(`stone-${n}`)]));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/dashboard/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        stone,
        paper: v('paper'),
        surface: v('surface'),
        ink: v('ink'),
        visitors: '#8dbdf0',
        revenue: '#e07b5f',
        revenueSoft: v('revenue-soft'),
        ads: '#5fb88a',
        adsEst: '#f2c94c',
        visitorsSoft: v('visitors-soft'),
      },
      boxShadow: { card: '0 1px 2px rgba(28,25,23,0.04), 0 1px 1px rgba(28,25,23,0.02)' },
    },
  },
  plugins: [],
};

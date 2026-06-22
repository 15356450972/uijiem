/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          light: '#34d399',
          DEFAULT: '#10b981', // green theme
          dark: '#059669',
          glow: 'rgba(16, 185, 129, 0.15)',
        },
        dark: {
          bg: '#111113',       // deep black/grey background
          sidebar: '#18181c',  // sidebar background
          card: '#1e1e24',     // slightly lighter card background
          cardHover: '#26262e',
          input: '#1a1a20',    // input background
          border: '#2e2e38',   // subtle border
          text: '#f3f4f6',     // gray-100
          muted: '#9ca3af',    // gray-400
          subtle: '#4b5563',   // gray-600
        }
      },
    },
  },
  plugins: [],
}

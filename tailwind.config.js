/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        tier: {
          s: '#f59e0b',
          a: '#22c55e',
          b: '#3b82f6',
          c: '#f97316',
          d: '#ef4444',
        },
        wh40k: {
          dark: '#1a1a2e',
          darker: '#0f0f1a',
          accent: '#e94560',
          gold: '#ffd700',
        },
      },
      fontFamily: {
        display: ['"Black Ops One"', 'cursive'],
        body: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
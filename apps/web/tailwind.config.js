import forseeUi from '../../packages/ui/src/theme/tailwind-preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  // Colour tokens and keyframes of the host UI (and the prototype's tokens) live in the preset.
  presets: [forseeUi],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Button variants
        'btn-back': '#e6ebf2',
        'btn-back-hover': '#eef2f7',
        'btn-front': '#ffffff',
        'btn-front-hover': '#ffffff',
        'btn-border': '#d0d7e2',
        'btn-border-hover': '#c3cdd9',
        // Danger button
        'danger-back': '#9b1f1f',
        'danger-back-hover': '#b42525',
        'danger-front': '#d32f2f',
        'danger-front-hover': '#e14646',
        'danger-border': '#ab1b1b',
        'danger-border-hover': '#b72b2b',
        // Primary button
        'primary-back': '#184db8',
        'primary-back-hover': '#1e59cf',
        'primary-border': '#1b4ab0',
        'primary-border-hover': '#2b63d6',
        // Space button (green)
        'space-back': '#0a7f46',
        'space-back-hover': '#109e58',
        'space-front': '#0f9d58',
        'space-front-hover': '#25b269',
        'space-border': '#0c7a43',
        'space-border-hover': '#15995a',
        // Key colors
        'key-back': '#0a7f46',
        'key-back-hover': '#109e58',
        'key-front': '#0f9d58',
        'key-front-hover': '#25b269',
        'key-border': '#0c7a43',
        'key-border-hover': '#15995a',
        // Suggestion colors
        'suggestion-back': '#e6ebf2',
        'suggestion-back-hover': '#eef2f7',
        'suggestion-front': '#f5f7fa',
        'suggestion-front-hover': '#ffffff',
        'suggestion-border': '#d0d7e2',
        'suggestion-border-hover': '#c3cdd9',
        // Neutral button colors
        'neutral-back': '#dfe5ee',
        'neutral-back-hover': '#e8edf5',
        'neutral-front': '#e9edf2',
        'neutral-front-hover': '#f3f6fa',
        'neutral-border': '#d0d7e2',
        'neutral-border-hover': '#c3cdd9',
        // Primary button gradient colors
        'primary-gradient-start': '#2a78ff',
        'primary-gradient-end': '#1857e6',
        'primary-gradient-start-hover': '#4c8cff',
        'primary-gradient-end-hover': '#2a6ef2',
        // Warning/Modal colors
        'warning-bg': '#fff3cd',
        'warning-border': '#ffc107',
        'warning-text': '#856404',
        // UI colors
        'bg-main': '#f3f5f7',
        'border-light': '#e2e5e9',
        'text-dark': '#1a1f2b',
      },
    },
  },
  plugins: [],
};

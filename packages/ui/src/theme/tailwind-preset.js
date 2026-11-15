/**
 * Tailwind preset of `@forsee/ui`: the colour tokens and keyframes the host
 * UI components use. Apps add it to their Tailwind config:
 *
 *   import forseeUi from '@forsee/ui/tailwind-preset';
 *   export default {
 *     presets: [forseeUi],
 *     content: ['./src/**\/*.{ts,tsx}', '<path to>/packages/ui/src/**\/*.{ts,tsx}'],
 *   };
 *
 * The look is the prototype's (green letter keys with a raised face, a fill
 * that grows left to right while you dwell) on a high-contrast dark
 * background. Every text colour pair listed in `TEXT_CONTRAST_PAIRS` meets
 * WCAG AA (4.5:1); `tailwind-preset.test.ts` checks them.
 *
 * Plain JavaScript so that Tailwind can load it without a TypeScript step.
 */

/** Colour tokens (`bg-key`, `text-ink`, `border-fn-border`, ...). */
export const colors = {
  // Surfaces (darkest first)
  surface: '#0b0f17',
  'surface-raised': '#111827',
  'surface-overlay': '#1f2937',
  // Text
  ink: '#f8fafc',
  'ink-muted': '#cbd5e1',
  'ink-faint': '#9ca3af',
  // Letter keys (the prototype's green)
  key: '#0a7f46',
  'key-border': '#14a05a',
  'key-edge': '#065c32',
  // Space bar
  space: '#08703e',
  'space-border': '#14a05a',
  'space-edge': '#054d29',
  // Function keys (page switches, undo, back)
  fn: '#1d4ed8',
  'fn-border': '#4677f0',
  'fn-edge': '#163a9e',
  // Destructive keys (delete, clear)
  danger: '#b91c1c',
  'danger-border': '#e04848',
  'danger-edge': '#7f1414',
  // Neutral controls
  neutral: '#334155',
  'neutral-border': '#55657d',
  'neutral-edge': '#1e293b',
  // Speak (the primary action)
  speak: '#5b21b6',
  'speak-border': '#8b5cf6',
  'speak-edge': '#3b1580',
  // Prediction candidates
  prediction: '#1f2937',
  'prediction-border': '#64748b',
  'prediction-edge': '#0f172a',
  // Feedback
  dwell: '#fbbf24',
  focus: '#fde047',
  accent: '#fbbf24',
  // Pause overlay
  pause: '#020617',

  // Tokens ported from the prototype (`legacy/keyboard-ui/tailwind.config.js`),
  // kept for pages that still use them.
  'btn-back': '#e6ebf2',
  'btn-back-hover': '#eef2f7',
  'btn-front': '#ffffff',
  'btn-front-hover': '#ffffff',
  'btn-border': '#d0d7e2',
  'btn-border-hover': '#c3cdd9',
  'danger-back': '#9b1f1f',
  'danger-back-hover': '#b42525',
  'danger-front': '#d32f2f',
  'danger-front-hover': '#e14646',
  'danger-border-hover': '#b72b2b',
  'primary-back': '#184db8',
  'primary-back-hover': '#1e59cf',
  'primary-border': '#1b4ab0',
  'primary-border-hover': '#2b63d6',
  'space-back': '#0a7f46',
  'space-back-hover': '#109e58',
  'space-front': '#0f9d58',
  'space-front-hover': '#25b269',
  'space-border-hover': '#15995a',
  'key-back': '#0a7f46',
  'key-back-hover': '#109e58',
  'key-front': '#0f9d58',
  'key-front-hover': '#25b269',
  'key-border-hover': '#15995a',
  'suggestion-back': '#e6ebf2',
  'suggestion-back-hover': '#eef2f7',
  'suggestion-front': '#f5f7fa',
  'suggestion-front-hover': '#ffffff',
  'suggestion-border': '#d0d7e2',
  'suggestion-border-hover': '#c3cdd9',
  'neutral-back': '#dfe5ee',
  'neutral-back-hover': '#e8edf5',
  'neutral-front': '#e9edf2',
  'neutral-front-hover': '#f3f6fa',
  'neutral-border-hover': '#c3cdd9',
  'primary-gradient-start': '#2a78ff',
  'primary-gradient-end': '#1857e6',
  'primary-gradient-start-hover': '#4c8cff',
  'primary-gradient-end-hover': '#2a6ef2',
  'warning-bg': '#fff3cd',
  'warning-border': '#ffc107',
  'warning-text': '#856404',
  'bg-main': '#f3f5f7',
  'border-light': '#e2e5e9',
  'text-dark': '#1a1f2b',
};

/**
 * Every foreground/background pair the host UI uses for text, as
 * `[foreground token, background token]`. All must reach 4.5:1.
 */
export const TEXT_CONTRAST_PAIRS = [
  ['ink', 'surface'],
  ['ink', 'surface-raised'],
  ['ink', 'surface-overlay'],
  ['ink-muted', 'surface'],
  ['ink-muted', 'surface-raised'],
  ['ink-faint', 'surface-raised'],
  ['ink', 'key'],
  ['ink', 'space'],
  ['ink', 'fn'],
  ['ink', 'danger'],
  ['ink', 'neutral'],
  ['ink', 'speak'],
  ['ink', 'prediction'],
  ['ink', 'pause'],
  ['ink-muted', 'pause'],
  ['accent', 'surface-raised'],
  ['text-dark', 'bg-main'],
];

/** The Tailwind preset. */
const preset = {
  theme: {
    extend: {
      colors,
      keyframes: {
        'forsee-fired': {
          '0%': { boxShadow: '0 0 0 0 rgba(253, 224, 71, 0.95)' },
          '100%': { boxShadow: '0 0 0 14px rgba(253, 224, 71, 0)' },
        },
        'forsee-caret': {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // The prototype's fill, for any page that still animates by time.
        'dwell-fill': {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
      },
      animation: {
        'forsee-fired': 'forsee-fired 320ms ease-out',
        'forsee-caret': 'forsee-caret 1.1s step-end infinite',
        'dwell-fill': 'dwell-fill var(--dwell-time, 1000ms) linear forwards',
      },
      fontFamily: {
        ui: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
};

export default preset;

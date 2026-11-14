import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import preset, { TEXT_CONTRAST_PAIRS, colors } from './tailwind-preset.js';

describe('tailwind preset', () => {
  it('exposes its colours and keyframes through theme.extend', () => {
    expect(preset.theme.extend.colors).toBe(colors);
    expect(Object.keys(preset.theme.extend.keyframes as object)).toContain('forsee-fired');
  });

  it.each(TEXT_CONTRAST_PAIRS)('%s on %s meets WCAG AA (4.5:1)', (fg, bg) => {
    const foreground = colors[fg];
    const background = colors[bg];
    expect(foreground, fg).toBeDefined();
    expect(background, bg).toBeDefined();
    expect(contrastRatio(foreground ?? '', background ?? '')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text readable under the dwell fill (35% black over every key colour)', () => {
    const darken = (hex: string): string => {
      const n = parseInt(hex.slice(1), 16);
      const parts = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(c * 0.65));
      return `#${parts.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    };
    for (const face of ['key', 'space', 'fn', 'danger', 'neutral', 'speak', 'prediction']) {
      const colour = colors[face] ?? '';
      expect(contrastRatio(colors.ink ?? '', darken(colour)), face).toBeGreaterThan(
        contrastRatio(colors.ink ?? '', colour) - 1e-9,
      );
    }
  });
});

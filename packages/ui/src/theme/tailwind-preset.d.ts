/** Types of `tailwind-preset.js` (plain JavaScript so Tailwind can load it directly). */

export declare const colors: Readonly<Record<string, string>>;

export declare const TEXT_CONTRAST_PAIRS: readonly (readonly [string, string])[];

declare const preset: {
  readonly theme: { readonly extend: Readonly<Record<string, unknown>> };
};
export default preset;

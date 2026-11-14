import type { ReactNode } from 'react';

/**
 * The built-in icon set: simple stroked 24 x 24 glyphs drawn for this
 * project (MIT), covering every `icon` the built-in layouts use plus the
 * action bar's own. Unknown names render nothing, so callers fall back to
 * the text label.
 */
const ICON_PATHS: Readonly<Record<string, readonly string[]>> = {
  backspace: ['M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z', 'M12 9.5l5 5', 'M17 9.5l-5 5'],
  shift: ['M12 3.5l8 8.5h-4.5v7.5h-7V12H4z'],
  undo: ['M8.5 5L4 9.5 8.5 14', 'M4 9.5h10a6 6 0 0 1 0 12h-4'],
  speak: ['M3.5 9v6H8l5 4.5v-15L8 9z', 'M16.5 9a4.2 4.2 0 0 1 0 6', 'M19 6a8.4 8.4 0 0 1 0 12'],
  clear: ['M4 6.5h16', 'M9.5 6.5V4h5v2.5', 'M6.5 6.5l1 13.5h9l1-13.5', 'M10 10.5v6', 'M14 10.5v6'],
  back: ['M10 5l-7 7 7 7', 'M3.5 12H21'],
  stop: ['M6.5 6.5h11v11h-11z'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['M7 4.5l12 7.5-12 7.5z'],
  faster: ['M4 6l7 6-7 6', 'M12 6l7 6-7 6'],
  slower: ['M20 6l-7 6 7 6', 'M12 6l-7 6 7 6'],
  settings: [
    'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
    'M12 2.5v3',
    'M12 18.5v3',
    'M2.5 12h3',
    'M18.5 12h3',
    'M5.3 5.3l2.1 2.1',
    'M16.6 16.6l2.1 2.1',
    'M5.3 18.7l2.1-2.1',
    'M16.6 7.4l2.1-2.1',
  ],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M4.5 12.5l5 5 10-11'],
  alert: ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5', 'M12 17.5v.01'],
  previous: ['M15 5l-7 7 7 7'],
  next: ['M9 5l7 7-7 7'],
};

/** Names of the built-in icons. */
export const ICON_NAMES: readonly string[] = Object.freeze(Object.keys(ICON_PATHS));

/** True when `name` is a built-in icon. */
export function hasIcon(name: string | undefined): name is string {
  return name !== undefined && Object.hasOwn(ICON_PATHS, name);
}

/** Props of `Icon`. */
export interface IconProps {
  readonly name: string;
  /** Size in CSS pixels (width and height). Default 24. */
  readonly size?: number;
  readonly className?: string;
}

/** A built-in icon (decorative: `aria-hidden`), or null for an unknown name. */
export function Icon({ name, size = 24, className }: IconProps): ReactNode {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-icon={name}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

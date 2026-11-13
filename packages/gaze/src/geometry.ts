import type { Point, Rect } from '@forsee/plugin-api';

/** Small geometry helpers shared by the hit tester and the key distribution. */

/** True when `p` is inside `rect` (half-open: `x <= p.x < x + width`, likewise for y). */
export function rectContains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height;
}

/** Euclidean distance from `p` to the nearest point of `rect` (0 inside or on the edge). */
export function rectDistance(rect: Rect, p: Point): number {
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/** Area of `rect`. */
export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

/** Centre of `rect`. */
export function rectCentre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** True when both coordinates are finite numbers. */
export function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

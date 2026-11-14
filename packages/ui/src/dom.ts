import type { Disposable, Rect } from '@forsee/plugin-api';

/**
 * How the UI measures elements, injected so that tests (jsdom has no
 * layout) and unusual hosts can supply their own. Rectangles are app
 * viewport CSS pixels (the coordinate convention of `TargetDescriptor`).
 */
export interface UiDomEnvironment {
  /** The element's rectangle in app viewport CSS pixels. */
  measure(element: Element): Rect;
  /**
   * Calls `onChange` whenever the element's size or position may have
   * changed (element resize, window resize, any scroll). The callback
   * re-measures; it may be called when nothing changed.
   */
  observe(element: Element, onChange: () => void): Disposable;
}

/** Measures with `getBoundingClientRect`. */
export function measureElement(element: Element): Rect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Observes with a `ResizeObserver` (when the runtime has one) plus window
 * `resize` and capturing `scroll` listeners, so moving an element by
 * scrolling an ancestor is noticed too.
 */
export function observeElement(element: Element, onChange: () => void): Disposable {
  const cleanups: (() => void)[] = [];
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => onChange());
    observer.observe(element);
    cleanups.push(() => observer.disconnect());
  }
  const view = element.ownerDocument.defaultView;
  if (view) {
    const listener = (): void => onChange();
    view.addEventListener('resize', listener);
    view.addEventListener('scroll', listener, true);
    cleanups.push(() => {
      view.removeEventListener('resize', listener);
      view.removeEventListener('scroll', listener, true);
    });
  }
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    },
  };
}

/** The real browser environment. */
export const browserDomEnvironment: UiDomEnvironment = Object.freeze({
  measure: measureElement,
  observe: observeElement,
});

/** True when both rectangles have the same coordinates. */
export function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * A measured element as an external store, for `useSyncExternalStore`.
 * `attach` is a React 19 ref callback (it returns its own cleanup): it
 * measures at once and re-measures on every observed change, notifying
 * subscribers only when the rectangle actually changed.
 */
export class MeasuredRectStore {
  private rect: Rect | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly dom: UiDomEnvironment) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): Rect | null => this.rect;

  readonly attach = (element: Element | null): (() => void) | undefined => {
    if (!element) return undefined;
    const update = (): void => this.set(this.dom.measure(element));
    update();
    const observation = this.dom.observe(element, update);
    return () => {
      observation.dispose();
      this.set(null);
    };
  };

  /** Replaces the rectangle, notifying subscribers if it changed. */
  set(next: Rect | null): void {
    if (sameRect(this.rect, next)) return;
    this.rect =
      next === null ? null : { x: next.x, y: next.y, width: next.width, height: next.height };
    for (const listener of [...this.listeners]) listener();
  }
}

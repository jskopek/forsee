import type { TargetHandle, TargetPatch, TargetRegistry } from '@forsee/gaze';
import type { TargetDescriptor } from '@forsee/plugin-api';
import { useLayoutEffect, useState } from 'react';
import { useHostUi, useOccluded } from './provider';

/** Live handles of the targets a component registered, by target id. */
export class TargetHandles {
  private readonly handles = new Map<
    string,
    { handle: TargetHandle; descriptor: TargetDescriptor }
  >();
  private registry: TargetRegistry | null = null;

  get(id: string): TargetHandle | undefined {
    return this.handles.get(id)?.handle;
  }

  ids(): IterableIterator<string> {
    return this.handles.keys();
  }

  /** Runs `fn` in one registry batch (one change notification); runs it plainly without a registry. */
  batch(fn: () => void): void {
    if (this.registry) this.registry.batch(fn);
    else fn();
  }

  /**
   * Makes the registered set equal `descriptors`, in one registry batch:
   * disposes targets that are gone, updates changed ones (only the fields
   * that differ), registers new ones. Fields set later through a handle
   * and absent from `descriptors` (for example `likelihood`) are left alone.
   */
  sync(registry: TargetRegistry, descriptors: readonly TargetDescriptor[]): void {
    if (this.registry !== registry) this.clear();
    this.registry = registry;
    const wanted = new Map(descriptors.map((d) => [d.id, d] as const));
    registry.batch(() => {
      for (const [id, entry] of [...this.handles]) {
        if (wanted.has(id)) continue;
        entry.handle.dispose();
        this.handles.delete(id);
      }
      const fresh: TargetDescriptor[] = [];
      for (const descriptor of descriptors) {
        const entry = this.handles.get(descriptor.id);
        if (!entry) {
          fresh.push(descriptor);
          continue;
        }
        const patch = diffDescriptors(entry.descriptor, descriptor);
        if (patch) entry.handle.update(patch);
        entry.descriptor = descriptor;
      }
      if (fresh.length > 0) {
        const handles = registry.registerAll(fresh);
        fresh.forEach((descriptor, i) => {
          const handle = handles[i];
          if (handle) this.handles.set(descriptor.id, { handle, descriptor });
        });
      }
    });
  }

  /** Disposes every handle (one batch). */
  clear(): void {
    const registry = this.registry;
    const dispose = (): void => {
      for (const entry of this.handles.values()) entry.handle.dispose();
      this.handles.clear();
    };
    if (registry) registry.batch(dispose);
    else dispose();
  }
}

const FIELDS = [
  'rect',
  'dwellClass',
  'role',
  'likelihood',
  'command',
  'text',
  'label',
  'afterActivate',
  'disabled',
] as const satisfies readonly Exclude<keyof TargetDescriptor, 'id'>[];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields of `next` that differ from `previous`, or null when nothing changed. */
export function diffDescriptors(
  previous: TargetDescriptor,
  next: TargetDescriptor,
): TargetPatch | null {
  const patch: Record<string, unknown> = {};
  let changed = false;
  for (const field of FIELDS) {
    if (sameValue(previous[field], next[field])) continue;
    patch[field] = next[field];
    changed = true;
  }
  return changed ? patch : null;
}

const NONE: readonly TargetDescriptor[] = Object.freeze([]);

/**
 * Keeps `descriptors` registered with the gaze target registry while the
 * component is mounted, synchronising in one batch whenever the array
 * changes (pass a memoised array). Registers nothing without a pipeline
 * or while an overlay occludes this part of the screen. Returns the live
 * handles, for cheap imperative updates such as likelihoods.
 */
export function useTargetRegistrations(
  descriptors: readonly TargetDescriptor[] | null,
  registryOverride?: TargetRegistry,
): TargetHandles {
  const { services } = useHostUi();
  const registry = registryOverride ?? services.gaze?.targets;
  const occluded = useOccluded();
  const [handles] = useState(() => new TargetHandles());
  const effective = occluded || descriptors === null ? NONE : descriptors;

  useLayoutEffect(() => {
    if (registry) handles.sync(registry, effective);
  }, [handles, registry, effective]);

  useLayoutEffect(() => () => handles.clear(), [handles, registry]);

  return handles;
}

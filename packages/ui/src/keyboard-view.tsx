import type { ActivationOutcome } from '@forsee/gaze';
import {
  isGroupKey,
  keyIdOfTarget,
  targetsForView,
  type KeyRect,
  type LayoutView,
} from '@forsee/layouts';
import type {
  ActivateEvent,
  Disposable,
  KeyAction,
  LayoutKey,
  TargetDescriptor,
} from '@forsee/plugin-api';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createActivationAdapter } from './activation-adapter';
import type { ActivationAdapter, KeyboardViewProps } from './contracts';
import { useMeasuredRect } from './use-measured-rect';
import { Icon, hasIcon } from './icons';
import { useHostUi, useOccluded } from './provider';
import { useTargetRegistrations, type TargetHandles } from './registration';
import { TargetFace, type TargetAppearance } from './target-face';

/** Short names of the steps of an escalating key, shown while it repeats. */
const STEP_LABELS: Readonly<Record<string, string>> = {
  'composition.deleteGrapheme': 'Delete letter',
  'composition.deleteWord': 'Delete word',
  'composition.clear': 'Clear all',
  'composition.undo': 'Undo',
};

/** The visible label of a key action step. */
export function stepLabel(action: KeyAction): string {
  return STEP_LABELS[action.command] ?? action.command.split('.').pop() ?? action.command;
}

function findKey(view: LayoutView, keyId: string): LayoutKey | undefined {
  for (const row of view.rows) for (const key of row.keys) if (key.id === keyId) return key;
  return undefined;
}

/** Colour scheme of a key, from what it does. */
export function keyAppearance(key: LayoutKey): TargetAppearance {
  if (isGroupKey(key)) return 'key';
  if (key.spacer === true) return 'plain';
  const command =
    key.behaviour?.type === 'escalate' ? key.behaviour.steps[0]?.command : key.action.command;
  if (command === 'composition.insert') {
    const text = key.action.args?.text;
    return typeof text === 'string' && text.trim() === '' ? 'space' : 'key';
  }
  if (command === undefined) return 'neutral';
  if (command.startsWith('speech.')) return 'speak';
  if (
    command === 'composition.clear' ||
    command === 'composition.deleteWord' ||
    command === 'composition.deleteGrapheme'
  ) {
    return 'danger';
  }
  return 'function';
}

/** Font size (CSS px) that fits `label` on one line in a `width` x `height` box. */
export function fitFontPx(label: string, width: number, height: number, share = 0.46): number {
  const chars = Math.max(1, Array.from(label).length);
  const byHeight = height * share;
  const byWidth = (width * 0.84) / (chars * 0.62);
  return Math.max(11, Math.round(Math.min(byHeight, byWidth, 72)));
}

interface Escalation {
  readonly targetId: string;
  readonly keyId: string;
  /** Repeat index that fires next while gaze stays. */
  readonly next: number;
}

interface PlacedKey {
  readonly keyRect: KeyRect;
  readonly descriptor: TargetDescriptor;
}

function KeyContent({
  keyRect,
  hint,
}: {
  readonly keyRect: KeyRect;
  readonly hint: string | null;
}): ReactNode {
  const { key, rect } = keyRect;
  const label = key.label;
  const icon = hasIcon(key.icon) ? key.icon : undefined;
  if (icon !== undefined) {
    const iconPx = Math.max(16, Math.round(Math.min(rect.height * 0.36, rect.width * 0.42, 56)));
    const shown = hint ?? label;
    const textPx = Math.max(
      11,
      Math.round(Math.min(rect.height * 0.17, fitFontPx(shown, rect.width, rect.height, 0.17))),
    );
    return (
      <>
        <Icon name={icon} size={iconPx} />
        <span className="whitespace-nowrap" style={{ fontSize: `${textPx}px` }}>
          {shown}
        </span>
      </>
    );
  }
  const shown = hint ?? label;
  return (
    <span
      className="whitespace-nowrap"
      style={{
        fontSize: `${fitFontPx(shown, rect.width, rect.height, Array.from(shown).length > 1 ? 0.3 : 0.46)}px`,
      }}
    >
      {shown}
    </span>
  );
}

/**
 * Renders a layout through its `LayoutRuntime` as absolutely positioned gaze
 * targets, so what is registered is exactly what is drawn.
 *
 * - Measures its own box (app viewport CSS pixels), computes the key
 *   rectangles with the layouts geometry (gap, edge enlargement) and keeps
 *   one target per key registered; on every view change (page, group) or
 *   resize the whole set is re-registered in one registry batch.
 * - Activations go through `createActivationAdapter`: groups open and the
 *   automatic back key closes them, page keys switch pages, `returnToPage`
 *   applies, escalating keys pick their step from `repeatIndex`. While an
 *   escalating key repeats, its dwell class follows
 *   `runtime.dwellClassFor(keyId, next)` and the key shows the next step
 *   ("Delete word").
 * - Letter keys get a `likelihood` from the shared prediction session's
 *   next-letter probabilities (adaptive dwell): one batched handle update
 *   per prediction result, no re-registration and no re-render.
 * - Registers `layout.showPage` and `layout.back` for its runtime.
 */
export function KeyboardView({
  runtime,
  targets,
  gapPx = 8,
  edgeGrowthPx = 12,
  edges,
  registerLayoutCommands = true,
  adaptiveDwell = true,
  className = '',
}: KeyboardViewProps): ReactNode {
  const { services, hub, feed, reportError } = useHostUi();
  const { kernel } = services;

  const subscribeView = useCallback(
    (onChange: () => void) => {
      const subscription = runtime.onDidChangeView(onChange);
      return () => subscription.dispose();
    },
    [runtime],
  );
  const view = useSyncExternalStore(subscribeView, () => runtime.view);

  const [bounds, boundsRef] = useMeasuredRect();
  const [escalation, setEscalation] = useState<Escalation | null>(null);

  const edgeTop = edges?.top;
  const edgeRight = edges?.right;
  const edgeBottom = edges?.bottom;
  const edgeLeft = edges?.left;
  const placed = useMemo(() => {
    if (!bounds) return null;
    return targetsForView(view, bounds, {
      gapPx,
      edgeGrowthPx,
      edges: {
        ...(edgeTop === undefined ? {} : { top: edgeTop }),
        ...(edgeRight === undefined ? {} : { right: edgeRight }),
        ...(edgeBottom === undefined ? {} : { bottom: edgeBottom }),
        ...(edgeLeft === undefined ? {} : { left: edgeLeft }),
      },
    });
  }, [view, bounds, gapPx, edgeGrowthPx, edgeTop, edgeRight, edgeBottom, edgeLeft]);

  const keys = useMemo<readonly PlacedKey[] | null>(() => {
    if (!placed) return null;
    return placed.keyRects.map((keyRect, i) => {
      const base = placed.targets[i]!;
      const escalating = escalation?.targetId === base.id ? escalation : null;
      const descriptor: TargetDescriptor = escalating
        ? { ...base, dwellClass: runtime.dwellClassFor(escalating.keyId, escalating.next) }
        : base;
      return { keyRect, descriptor };
    });
  }, [placed, escalation, runtime]);

  const descriptors = useMemo(() => keys?.map((k) => k.descriptor) ?? null, [keys]);
  const handles = useTargetRegistrations(descriptors, targets);
  const occluded = useOccluded();

  // Adaptive dwell: likelihoods from the shared prediction session. Runs
  // after the registration effect above, and again when the keys come back
  // from occlusion (they are then registered afresh, without likelihoods).
  useLayoutEffect(() => {
    if (!adaptiveDwell || !feed || !keys || occluded) return undefined;
    const applied = new Map<string, number | undefined>();
    const apply = (): void => applyLikelihoods(handles, keys, feed.get().result?.letters, applied);
    apply();
    return feed.subscribe(apply);
  }, [adaptiveDwell, feed, keys, handles, occluded]);

  // The activation adapter (created in an effect so Strict Mode's double
  // mount never uses a disposed one).
  const adapterRef = useRef<ActivationAdapter | null>(null);
  useEffect(() => {
    const adapter = createActivationAdapter({
      runtime,
      keyIdOf: (id) => keyIdOfTarget(runtime.view.layoutId, runtime.view.pageId, id),
      execute: (command, args, source) => kernel.commands.execute(command, args, source),
      reportError,
    });
    adapterRef.current = adapter;
    return () => {
      adapter.dispose();
      if (adapterRef.current === adapter) adapterRef.current = null;
    };
  }, [runtime, kernel, reportError]);

  // Escalation ends when gaze leaves the key (listening only while one is
  // armed, so ordinary engage changes never touch the keyboard's state).
  const escalatingId = escalation?.targetId;
  useEffect(() => {
    if (escalatingId === undefined) return undefined;
    const subscription = hub.onAnyEngage((event) => {
      if (event.targetId !== escalatingId) setEscalation(null);
    });
    return () => subscription.dispose();
  }, [hub, escalatingId]);

  // The layout commands, for other code that wants to switch pages.
  useEffect(() => {
    if (!registerLayoutCommands) return undefined;
    const registered: Disposable[] = [];
    if (!kernel.commands.has('layout.showPage')) {
      registered.push(
        kernel.commands.register(
          'layout.showPage',
          (args) => {
            runtime.showPage(args.page);
          },
          { title: 'Show keyboard page' },
        ),
      );
    }
    if (!kernel.commands.has('layout.back')) {
      registered.push(
        kernel.commands.register('layout.back', () => runtime.back(), { title: 'Keyboard back' }),
      );
    }
    return () => {
      for (const r of registered) r.dispose();
    };
  }, [registerLayoutCommands, kernel, runtime]);

  const onKeyActivation = useCallback(
    (event: ActivateEvent, outcome: ActivationOutcome) => {
      const adapter = adapterRef.current;
      if (!adapter) return;
      const before = runtime.view;
      const keyId = keyIdOfTarget(before.layoutId, before.pageId, event.targetId);
      const key = keyId === undefined ? undefined : findKey(before, keyId);
      void adapter.handle(event, outcome);
      if (keyId !== undefined && key && !isGroupKey(key) && key.spacer !== true) {
        // Only dwell repeats while gaze stays; a click or key press never arms the next step.
        if (
          event.method === 'dwell' &&
          key.behaviour?.type === 'escalate' &&
          runtime.view === before
        ) {
          setEscalation({ targetId: event.targetId, keyId, next: event.repeatIndex + 1 });
        }
      }
    },
    [runtime],
  );

  const hintFor = (keyRect: KeyRect, targetId: string): string | null => {
    if (escalation?.targetId !== targetId) return null;
    const key = keyRect.key;
    if (isGroupKey(key) || key.behaviour?.type !== 'escalate') return null;
    const steps = key.behaviour.steps;
    const step = steps[Math.min(escalation.next, steps.length - 1)];
    return step ? stepLabel(step) : null;
  };

  return (
    <div
      ref={boundsRef}
      data-forsee-measure="keyboard"
      data-layout-id={view.layoutId}
      data-page-id={view.pageId}
      className={`relative h-full w-full ${className}`}
      role="group"
      aria-label={view.openGroup ? `Keyboard: ${view.openGroup.label}` : 'Keyboard'}
    >
      {bounds &&
        keys?.map(({ keyRect, descriptor }) => (
          <TargetFace
            key={descriptor.id}
            id={descriptor.id}
            descriptor={descriptor}
            onActivation={onKeyActivation}
            appearance={keyAppearance(keyRect.key)}
            accessibleName={hintFor(keyRect, descriptor.id) ?? keyRect.key.label}
            position="absolute"
            style={{
              left: `${keyRect.rect.x - bounds.x}px`,
              top: `${keyRect.rect.y - bounds.y}px`,
              width: `${keyRect.rect.width}px`,
              height: `${keyRect.rect.height}px`,
            }}
          >
            <KeyContent keyRect={keyRect} hint={hintFor(keyRect, descriptor.id)} />
          </TargetFace>
        ))}
    </div>
  );
}

const LETTER = /^\p{L}$/u;

/**
 * Sets each letter key's likelihood from `letters` (or clears it when there
 * are none), in one registry batch, skipping keys whose value is unchanged
 * (`applied` remembers what was set).
 */
function applyLikelihoods(
  handles: TargetHandles,
  keys: readonly PlacedKey[],
  letters: Readonly<Record<string, number>> | undefined,
  applied: Map<string, number | undefined>,
): void {
  const known = letters !== undefined && Object.keys(letters).length > 0;
  const changes: [string, number | undefined][] = [];
  for (const { descriptor } of keys) {
    const text = descriptor.text;
    if (text === undefined || !LETTER.test(text)) continue;
    const value = known ? Math.min(1, Math.max(0, letters[text.toLowerCase()] ?? 0)) : undefined;
    if (applied.has(descriptor.id) && applied.get(descriptor.id) === value) continue;
    changes.push([descriptor.id, value]);
  }
  if (changes.length === 0) return;
  handles.batch(() => {
    for (const [id, value] of changes) {
      const handle = handles.get(id);
      if (!handle) continue;
      handle.update({ likelihood: value });
      applied.set(id, value);
    }
  });
}

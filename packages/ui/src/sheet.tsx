import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { GazeTarget } from './gaze-target';
import { Icon } from './icons';
import { OverlayScopeContext, useHostUi } from './provider';
import { useRestZone } from './rest-zone';

/** Props of `Sheet`. */
export interface SheetProps {
  /** Heading, also the dialog's accessible name. */
  readonly title: string;
  /** Called by the Close target and the Escape key. */
  readonly onClose: () => void;
  /** Target id prefix. Default `sheet`; the Close target is `<id>/close`. */
  readonly id?: string;
  /** Close label. Default `Close`. */
  readonly closeLabel?: string;
  readonly children?: ReactNode;
  readonly className?: string;
}

function SheetBody({
  title,
  onClose,
  id,
  closeLabel,
  children,
  className,
}: Required<Omit<SheetProps, 'children'>> & { readonly children?: ReactNode }): ReactNode {
  const { occlusion } = useHostUi();
  // Everything outside the sheet stops being a gaze target while it is open.
  useLayoutEffect(() => occlusion.acquire(), [occlusion]);
  const [, panelRef] = useRestZone(`${id}/panel`);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Move keyboard focus into the sheet, onto its Close button.
    const close = dialogRef.current?.querySelector<HTMLElement>(`[data-target-id="${id}/close"]`);
    close?.focus({ preventScroll: true });
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const titleId = `${id}-title`;
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-sheet={id}
      className="fixed inset-0 z-40 bg-pause/90 font-ui text-ink"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        paddingRight: 'calc(env(safe-area-inset-right, 0px) + 12px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
        paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 12px)',
      }}
    >
      <div
        ref={panelRef}
        data-forsee-measure={`${id}/panel`}
        className={`flex h-full w-full flex-col gap-[clamp(0.75rem,2vh,1.25rem)] rounded-2xl border-2 border-neutral-border bg-surface-raised p-[clamp(0.75rem,2vh,1.5rem)] ${className}`}
      >
        <header className="flex shrink-0 items-center justify-between gap-6">
          <h2 id={titleId} className="text-[clamp(1.5rem,4vh,2.25rem)] font-bold">
            {title}
          </h2>
          <GazeTarget
            id={`${id}/close`}
            dwellClass="function"
            label={closeLabel}
            appearance="neutral"
            onActivate={() => onClose()}
            className="h-[clamp(3.5rem,10vh,5rem)] w-[clamp(9rem,18vw,13rem)]"
          >
            <span className="flex items-center gap-2 text-[clamp(1.1rem,2.6vh,1.5rem)]">
              <Icon name="close" size={28} />
              {closeLabel}
            </span>
          </GazeTarget>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * A full-screen dialog for settings and lists, operable by dwell, click,
 * tap and keyboard. While it is open every gaze target outside it is
 * unregistered (so nothing underneath can be selected), its panel is a rest
 * zone (gaze between its controls selects nothing), keyboard focus moves to
 * its large Close target, and Escape closes it. Render it in `AppFrame`'s
 * `overlay` and set `AppFrame`'s `inert` while it is open.
 */
export function Sheet({
  title,
  onClose,
  id = 'sheet',
  closeLabel = 'Close',
  children,
  className = '',
}: SheetProps): ReactNode {
  return (
    <OverlayScopeContext.Provider value={true}>
      <SheetBody
        title={title}
        onClose={onClose}
        id={id}
        closeLabel={closeLabel}
        className={className}
      >
        {children}
      </SheetBody>
    </OverlayScopeContext.Provider>
  );
}

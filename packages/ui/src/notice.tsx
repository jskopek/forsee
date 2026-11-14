import type { ReactNode } from 'react';
import { GazeTarget } from './gaze-target';
import { Icon } from './icons';

/** An extra action on a notice ("Put text back"). */
export interface NoticeAction {
  readonly id: string;
  readonly label: string;
  readonly onActivate: () => void;
}

/** Props of `NoticeCard`. */
export interface NoticeCardProps {
  /** Target id prefix (`<id>/dismiss`, `<id>/<action id>`). */
  readonly id: string;
  readonly tone?: 'warning' | 'error' | 'info';
  readonly title: string;
  /** A short message; long text is clipped to two lines (the full text is in the accessible name). */
  readonly message?: string;
  readonly actions?: readonly NoticeAction[];
  readonly onDismiss: () => void;
  /** Shown as a small "1 of 3" when more notices wait behind this one. */
  readonly position?: { readonly index: number; readonly count: number };
  readonly className?: string;
}

const TONE: Readonly<Record<NonNullable<NoticeCardProps['tone']>, string>> = {
  warning: 'border-accent',
  error: 'border-danger-border',
  info: 'border-neutral-border',
};

/**
 * One unobtrusive notice: a title, a short message and large targets to act
 * on it or dismiss it by dwell, click, tap or keyboard. It is meant for a
 * region beside the text (never over keys), so it stays readable for a
 * partner without blocking typing.
 */
export function NoticeCard({
  id,
  tone = 'warning',
  title,
  message,
  actions = [],
  onDismiss,
  position,
  className = '',
}: NoticeCardProps): ReactNode {
  return (
    <section
      role="status"
      aria-label={message ? `${title}: ${message}` : title}
      data-notice={id}
      className={`flex h-full min-h-0 items-stretch gap-3 rounded-2xl border-2 bg-surface-overlay p-2 ${TONE[tone]} ${className}`}
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 pl-2">
        <p className="flex items-center gap-2 text-[clamp(0.9rem,2.1vh,1.15rem)] font-bold">
          <Icon name="alert" size={20} className="shrink-0 text-accent" />
          <span className="truncate">{title}</span>
          {position && position.count > 1 && (
            <span className="shrink-0 text-[0.8em] font-normal text-ink-muted">
              {position.index + 1} of {position.count}
            </span>
          )}
        </p>
        {message !== undefined && (
          <p className="line-clamp-2 break-words text-[clamp(0.85rem,2vh,1.1rem)] text-ink-muted">
            {message}
          </p>
        )}
      </div>
      {actions.map((action) => (
        <GazeTarget
          key={action.id}
          id={`${id}/${action.id}`}
          dwellClass="function"
          label={action.label}
          appearance="function"
          onActivate={() => action.onActivate()}
          className="h-full min-h-[3rem] w-[clamp(5.5rem,10vw,8rem)] shrink-0 px-2 text-[clamp(0.85rem,2vh,1.05rem)]"
        >
          <span className="text-center leading-tight">{action.label}</span>
        </GazeTarget>
      ))}
      <GazeTarget
        id={`${id}/dismiss`}
        dwellClass="function"
        label={`Dismiss: ${title}`}
        appearance="neutral"
        onActivate={() => onDismiss()}
        className="h-full min-h-[3rem] w-[clamp(5rem,9vw,7rem)] shrink-0 px-2 text-[clamp(0.85rem,2vh,1.05rem)]"
      >
        <Icon name="close" size={22} />
        <span>Dismiss</span>
      </GazeTarget>
    </section>
  );
}

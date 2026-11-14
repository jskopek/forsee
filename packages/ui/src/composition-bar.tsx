import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useComposition } from './provider';
import { useRestZone } from './rest-zone';

/** Props of `CompositionBar`. */
export interface CompositionBarProps {
  /** Shown while nothing is written. */
  readonly placeholder?: string;
  /** Rest-target id. Default `composition/bar`. */
  readonly id?: string;
  readonly className?: string;
}

/**
 * The text being written, large, with a caret and the partial word
 * emphasised. The whole bar is a rest zone: looking at your own text never
 * selects anything and resets any dwell in progress. It keeps the end of
 * the text in view as it grows.
 */
export function CompositionBar({
  placeholder = 'Look at a letter to start writing',
  id = 'composition/bar',
  className = '',
}: CompositionBarProps): ReactNode {
  const state = useComposition();
  const [, zoneRef] = useRestZone(id);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { text, partialWord } = state;
  const before = text.slice(0, text.length - partialWord.length);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <section
      ref={zoneRef}
      data-forsee-measure="composition"
      aria-label="Message"
      className={`flex h-full min-h-0 items-stretch rounded-2xl border-2 border-neutral-border bg-surface-raised px-5 py-3 text-ink ${className}`}
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-hidden break-words font-ui text-[clamp(1.5rem,4.2vh,3rem)] font-medium leading-tight"
      >
        <output aria-live="polite" className="block">
          {text === '' ? (
            <span className="inline-block max-w-[calc(100%-0.5em)] truncate align-bottom text-ink-faint">
              {placeholder}
            </span>
          ) : (
            <>
              <span className="whitespace-pre-wrap">{before}</span>
              {partialWord !== '' && (
                <span
                  data-part="partial-word"
                  className="whitespace-pre-wrap rounded-md text-accent underline decoration-4 underline-offset-[0.2em]"
                >
                  {partialWord}
                </span>
              )}
            </>
          )}
          <span
            aria-hidden="true"
            data-part="caret"
            className="ml-0.5 inline-block h-[1.1em] w-[0.12em] translate-y-[0.15em] rounded-sm bg-accent animate-forsee-caret motion-reduce:animate-none"
          />
        </output>
      </div>
    </section>
  );
}

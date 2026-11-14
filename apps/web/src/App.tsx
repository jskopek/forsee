import { useEffect, useState, type ReactNode } from 'react';
import { MainScreen } from './MainScreen';
import type { ForseeRuntime } from './runtime';

type BootState =
  | { readonly status: 'booting' }
  | { readonly status: 'ready'; readonly runtime: ForseeRuntime }
  | { readonly status: 'failed'; readonly error: unknown };

/**
 * Waits for the runtime, then shows the main screen. While booting (tens of
 * milliseconds) the screen stays dark; a "Starting" message fades in only if
 * it takes noticeably longer, so a normal start never flashes.
 */
export function App({ boot }: { readonly boot: Promise<ForseeRuntime> }): ReactNode {
  const [state, setState] = useState<BootState>({ status: 'booting' });
  useEffect(() => {
    let live = true;
    boot.then(
      (runtime) => {
        if (live) setState({ status: 'ready', runtime });
      },
      (error: unknown) => {
        if (live) setState({ status: 'failed', error });
      },
    );
    return () => {
      live = false;
    };
  }, [boot]);

  if (state.status === 'ready') return <MainScreen runtime={state.runtime} />;
  if (state.status === 'failed') return <FailureScreen error={state.error} />;
  return <BootScreen />;
}

function BootScreen(): ReactNode {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-surface font-ui text-ink"
      aria-busy="true"
    >
      <p
        className="forsee-boot-message text-[clamp(1.5rem,4vh,2.5rem)] font-semibold"
        role="status"
      >
        Starting Forsee…
      </p>
    </div>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function FailureScreen({ error }: { readonly error: unknown }): ReactNode {
  return (
    <div
      role="alert"
      className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-surface p-8 text-center font-ui text-ink"
    >
      <h1 className="text-[clamp(1.75rem,5vh,3rem)] font-bold">Forsee could not start</h1>
      <p className="max-w-[48ch] text-[clamp(1rem,2.6vh,1.4rem)] text-ink-muted">
        Something went wrong while opening the app on this device. Reloading the page usually helps.
        If it keeps happening, please report the message below.
      </p>
      <pre className="max-w-full overflow-auto whitespace-pre-wrap rounded-xl bg-surface-raised px-4 py-3 text-left text-base text-ink">
        {messageOf(error)}
      </pre>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="min-h-[4rem] min-w-[12rem] rounded-xl border-2 border-fn-border bg-fn px-6 text-xl font-semibold text-ink focus-visible:ring-4 focus-visible:ring-focus"
      >
        Reload
      </button>
    </div>
  );
}

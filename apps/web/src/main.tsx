import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { phoneGazeUrlFromSearch } from '@forsee/gaze-web';
import { App } from './App';
import { createForseeRuntime, type ForseeRuntime } from './runtime';
import './index.css';

declare global {
  interface Window {
    /** The running app, for the browser console in development builds only. */
    forsee?: ForseeRuntime;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// One runtime per page load, booted outside React so that Strict Mode's
// double mount never starts two of them on the same storage.
// `?gaze=phone` opts in to the Phone Gaze engine (sidecars/phone-gaze) as the gaze source.
const boot = createForseeRuntime({
  appVersion: __FORSEE_VERSION__,
  phoneGazeUrl: phoneGazeUrlFromSearch(window.location.search),
});
if (import.meta.env.DEV) {
  void boot.then((runtime) => {
    window.forsee = runtime;
  });
}

const root = createRoot(container);
root.render(
  <StrictMode>
    <App boot={boot} />
  </StrictMode>,
);

// Development: a hot update that replaces this module must not leave the old
// runtime's listeners, timers and pointer handlers behind.
import.meta.hot?.dispose(() => {
  root.unmount();
  void boot.then((runtime) => runtime.dispose()).catch(() => undefined);
});

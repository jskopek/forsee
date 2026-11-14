import { CORE_PACKAGE } from '@forsee/core';

export function App() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-2 bg-bg-main text-text-dark">
      <h1 className="text-4xl font-bold">Forsee</h1>
      <p className="text-sm">Workspace linked: {CORE_PACKAGE}</p>
    </main>
  );
}

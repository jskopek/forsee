/**
 * Development harness for the application runtime (no React): boots
 * `createForseeRuntime()` in a real browser, exposes it as `window.forsee`
 * and offers a few plain buttons. Served by `vite` at `/dev-runtime.html`;
 * not part of the production build.
 */
import { createForseeRuntime, type ForseeRuntime } from './src/runtime';

declare global {
  interface Window {
    forsee?: ForseeRuntime;
    forseeBoot?: Promise<unknown>;
  }
}

const logElement = document.getElementById('log');
const compositionElement = document.getElementById('composition');

function log(message: string): void {
  console.log(`[forsee-dev] ${message}`);
  if (logElement) logElement.textContent += `${message}\n`;
}

function button(id: string, onClick: () => Promise<void> | void): void {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) return;
  element.disabled = false;
  element.addEventListener('click', () => {
    Promise.resolve(onClick()).catch((error: unknown) => log(`error: ${String(error)}`));
  });
}

async function boot(): Promise<Record<string, unknown>> {
  const started = performance.now();
  const runtime = await createForseeRuntime({
    onError: (entry) => {
      console.error('[forsee-dev] runtime error', entry.context, entry.error);
      log(`runtime error in ${entry.context}: ${String(entry.error)}`);
    },
  });
  window.forsee = runtime;
  const { kernel } = runtime;
  const bootMs = Math.round(performance.now() - started);
  log(
    `booted in ${bootMs} ms: storage=${runtime.profile.storage} persistent=${runtime.profile.persistent} created=${runtime.profile.created}`,
  );
  if (runtime.profile.warning) log(`warning: ${runtime.profile.warning}`);
  for (const issue of runtime.startupIssues) log(`startup issue (${issue.part}): ${issue.message}`);
  const g = globalThis as { speechSynthesis?: SpeechSynthesis };
  const allVoices = g.speechSynthesis?.getVoices() ?? [];
  const local = await runtime.speech.listVoices();
  log(
    `speechSynthesis present=${Boolean(g.speechSynthesis)}; browser voices=${allVoices.length}; local voices offered=${local.length}; speech available=${runtime.speech.available}; locked=${runtime.speech.locked}`,
  );
  log(
    `layout=${runtime.layout.definition.id}; plugins: ${runtime.pluginHost
      .list()
      .map((p) => `${p.manifest.id}=${p.state}`)
      .join(', ')}`,
  );
  log(`restored composition: ${JSON.stringify(kernel.composition.text)}`);

  const showComposition = (): void => {
    if (compositionElement) compositionElement.textContent = kernel.composition.text;
  };
  kernel.bus.on('composition.changed', showComposition);
  showComposition();
  kernel.bus.on('speech.unavailable', (e) => log(`speech unavailable (${e.reason}): ${e.text}`));
  runtime.speech.engine.events.on('speech', (e) => log(`speech event: ${JSON.stringify(e)}`));

  button('type-hello', async () => {
    await kernel.commands.execute('composition.insert', { text: 'hello' }, 'keyboard');
  });
  button('speak', async () => {
    runtime.speech.unlock();
    const result = await kernel.commands.execute('composition.speak', undefined, 'keyboard');
    log(`speak: ${JSON.stringify(result)}`);
  });
  button('history', () => {
    const recent = kernel.conversation.listRecent(20);
    log(`history (${recent.length}): ${recent.map((u) => u.body).join(' | ')}`);
  });

  return {
    bootMs,
    storage: runtime.profile.storage,
    persistent: runtime.profile.persistent,
    created: runtime.profile.created,
    warning: runtime.profile.warning ?? null,
    startupIssues: runtime.startupIssues,
    speechSynthesis: Boolean(g.speechSynthesis),
    browserVoices: allVoices.length,
    localVoices: local.length,
    speechAvailable: runtime.speech.available,
    layout: runtime.layout.definition.id,
    plugins: runtime.pluginHost.list().map((p) => [p.manifest.id, p.state]),
    errors: runtime.errors.list().map((e) => `${e.context}: ${String(e.error)}`),
  };
}

window.forseeBoot = boot().catch((error: unknown) => {
  log(`boot failed: ${String(error)}`);
  throw error;
});

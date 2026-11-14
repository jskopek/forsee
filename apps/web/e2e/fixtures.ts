import { expect, test as base, type Locator, type Page } from '@playwright/test';

/** One utterance the fake speech synthesis was asked to say. */
export interface SpokenUtterance {
  readonly text: string;
  readonly voice: string | null;
  readonly rate: number;
}

declare global {
  interface Window {
    /** Utterances the fake synthesis received, in order (set by `installFakeSpeech`). */
    __forseeSpoken?: SpokenUtterance[];
  }
}

/**
 * Headless Chromium has no speech voices, so tests that need to observe
 * speech replace `speechSynthesis` and `SpeechSynthesisUtterance` before the
 * app loads: two local voices, `speak` records the utterance and fires
 * `start`, then `end` after `speakMs`; `cancel` interrupts. With
 * `needsActivation` it refuses (`not-allowed`, nothing recorded) until the
 * page has had a user gesture, as Chrome and Safari do.
 */
function fakeSpeech({
  speakMs,
  needsActivation,
}: {
  readonly speakMs: number;
  readonly needsActivation: boolean;
}): void {
  type Handler = ((event: unknown) => void) | null;
  class FakeUtterance {
    text: string;
    voice: { name: string } | null = null;
    lang = '';
    rate = 1;
    pitch = 1;
    volume = 1;
    onstart: Handler = null;
    onend: Handler = null;
    onerror: Handler = null;
    onboundary: Handler = null;
    constructor(text = '') {
      this.text = text;
    }
  }
  const voice = (name: string, isDefault: boolean) => ({
    name: `Fake ${name}`,
    voiceURI: `fake-${name.toLowerCase()}`,
    lang: 'en-GB',
    localService: true,
    default: isDefault,
  });
  const voices = [voice('Daniel', true), voice('Serena', false)];
  const spoken: SpokenUtterance[] = [];
  let current: FakeUtterance | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  // What browsers count as a user gesture (`navigator.userActivation` cannot
  // be used: Playwright's own evaluate calls count as gestures).
  let activated = false;
  for (const type of ['pointerdown', 'keydown', 'touchend']) {
    window.addEventListener(type, () => (activated = true), { capture: true });
  }
  const synthesis = {
    get speaking() {
      return current !== null;
    },
    pending: false,
    paused: false,
    getVoices: () => voices,
    speak(utterance: FakeUtterance) {
      if (needsActivation && !activated) {
        setTimeout(() => utterance.onerror?.({ type: 'error', error: 'not-allowed' }), 5);
        return;
      }
      spoken.push({
        text: utterance.text,
        voice: utterance.voice?.name ?? null,
        rate: utterance.rate,
      });
      if (current) synthesis.cancel();
      current = utterance;
      setTimeout(() => {
        if (current !== utterance) return;
        utterance.onstart?.({ type: 'start' });
        timer = setTimeout(() => {
          if (current !== utterance) return;
          current = null;
          utterance.onend?.({ type: 'end' });
        }, speakMs);
      }, 10);
    },
    cancel() {
      const utterance = current;
      current = null;
      if (timer !== undefined) clearTimeout(timer);
      utterance?.onerror?.({ type: 'error', error: 'interrupted' });
    },
    pause: () => undefined,
    resume: () => undefined,
    addEventListener(_type: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
  });
  window.__forseeSpoken = spoken;
}

/** Replaces the browser's speech synthesis with the recording fake (call before `goto`). */
export async function installFakeSpeech(
  page: Page,
  options: { readonly speakMs?: number; readonly needsActivation?: boolean } = {},
): Promise<void> {
  await page.addInitScript(fakeSpeech, {
    speakMs: options.speakMs ?? 400,
    needsActivation: options.needsActivation ?? false,
  });
}

/** Texts the fake synthesis was asked to say (the silent unlock primer left out). */
export async function spokenTexts(page: Page): Promise<string[]> {
  const spoken = await page.evaluate(() => window.__forseeSpoken ?? []);
  return spoken.map((u) => u.text).filter((text) => text !== '');
}

export async function spoken(page: Page): Promise<SpokenUtterance[]> {
  const all = await page.evaluate(() => window.__forseeSpoken ?? []);
  return all.filter((u) => u.text !== '');
}

/**
 * Every test fails on a console error, an uncaught exception, or a request
 * to another origin (the offline promise: nothing leaves the device).
 */
export const test = base.extend<{ guard: undefined }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      const origin = new URL(baseURL ?? 'http://localhost').origin;
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
      });
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.protocol === 'data:' || url.protocol === 'blob:') return;
        if (url.origin !== origin) problems.push(`request to another origin: ${request.url()}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
      });
      await use(undefined);
      expect(problems, 'console errors, page errors, failed or foreign requests').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Opens the app and waits until the keyboard is on screen. */
export async function openApp(page: Page, path = './'): Promise<void> {
  await page.goto(path);
  await expect(keyboard(page).getByRole('button').first()).toBeVisible();
}

export function keyboard(page: Page): Locator {
  return page.locator('[data-region="keyboard"]');
}

/** A key of the visible keyboard page by its exact accessible name ("h", "Speak"). */
export function key(page: Page, name: string): Locator {
  return keyboard(page).getByRole('button', { name, exact: true });
}

/** The Speak button in the control bar (keyboards have no Speak key). */
export function speakButton(page: Page): Locator {
  return page
    .getByRole('complementary', { name: 'Controls' })
    .getByRole('button', { name: 'Speak', exact: true });
}

/** The message being written (the composition bar's text, without the placeholder). */
export function message(page: Page): Locator {
  return page.locator('[data-forsee-measure="composition"] output');
}

export async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('target is not visible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Rests the real mouse on `target` for `ms` (real timers), then stays there. */
export async function hover(page: Page, target: Locator, ms: number): Promise<void> {
  const { x, y } = await centreOf(target);
  await page.mouse.move(x, y, { steps: 3 });
  await page.waitForTimeout(ms);
}

/** Moves the mouse onto the text bar, a rest zone where nothing is selected. */
export async function rest(page: Page, ms = 150): Promise<void> {
  const { x, y } = await centreOf(page.locator('[data-forsee-measure="composition"]'));
  await page.mouse.move(x, y, { steps: 2 });
  await page.waitForTimeout(ms);
}

/** Dwells on `target` (`ms` plus margin for sample timing), then rests the eyes on the text bar. */
export async function dwell(page: Page, target: Locator, ms: number): Promise<void> {
  await hover(page, target, ms + 350);
  await rest(page);
}

/**
 * Rests the mouse on `target` until `done()` is true (checked every 25 ms),
 * then looks away at once, like a user who sees the key fire. Fails if it
 * takes longer than `maxMs`. Returns how long the dwell took.
 */
export async function dwellUntil(
  page: Page,
  target: Locator,
  done: () => Promise<boolean>,
  maxMs: number,
): Promise<number> {
  const { x, y } = await centreOf(target);
  await page.mouse.move(x, y, { steps: 3 });
  const started = Date.now();
  while (!(await done())) {
    if (Date.now() - started > maxMs) {
      await rest(page);
      throw new Error(`dwell did not complete within ${maxMs} ms`);
    }
    await page.waitForTimeout(25);
  }
  const took = Date.now() - started;
  await rest(page);
  return took;
}

/** Dwells on a key until the message changes; returns the new message text. */
export async function dwellType(page: Page, target: Locator, maxMs = 3000): Promise<string> {
  const before = await message(page).textContent();
  await dwellUntil(page, target, async () => (await message(page).textContent()) !== before, maxMs);
  return (await message(page).textContent()) ?? '';
}

/**
 * Shortens dwell with the app's own Faster control (clicked, as a carer
 * would), `times` steps of 100 ms; returns the letter dwell shown.
 */
export async function faster(page: Page, times: number): Promise<number> {
  const button = page.getByRole('button', { name: 'Faster', exact: true });
  for (let i = 0; i < times; i += 1) await button.click();
  await rest(page);
  const shown = await page.locator('[aria-label="Dwell speed"] output').textContent();
  const seconds = Number(/([\d.]+) s/.exec(shown ?? '')?.[1]);
  return Math.round(seconds * 1000);
}

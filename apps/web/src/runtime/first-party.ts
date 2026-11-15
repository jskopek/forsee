import type { FirstPartyPlugin } from '@forsee/plugin-host';
import { keyboardsPlugin } from '@forsee/plugin-keyboards';
import { createNgramPredictionPlugin } from '@forsee/plugin-prediction-ngram';
import { quickfirePlugin } from '@forsee/plugin-quickfire';
import type { FirstPartyPluginContext } from './types';

/**
 * The first-party plugins the app ships, activated by the plugin host on the
 * same `ForseeApi` community plugins get: the standard keyboards (required:
 * it cannot be turned off, so there is always a keyboard), word prediction
 * and quick-fire replies.
 */
export function defaultFirstPartyPlugins(context: FirstPartyPluginContext): FirstPartyPlugin[] {
  return [
    { ...keyboardsPlugin, required: true },
    createNgramPredictionPlugin({ clock: context.clock, locale: context.locale }),
    quickfirePlugin,
  ];
}

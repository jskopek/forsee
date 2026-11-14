import type { FirstPartyPlugin } from '@forsee/plugin-host';
import { createNgramPredictionPlugin } from '@forsee/plugin-prediction-ngram';
import { quickfirePlugin } from '@forsee/plugin-quickfire';
import type { FirstPartyPluginContext } from './types';

/**
 * The first-party plugins the app ships, activated by the plugin host on the
 * same `ForseeApi` community plugins get: word prediction and quick-fire
 * replies.
 */
export function defaultFirstPartyPlugins(context: FirstPartyPluginContext): FirstPartyPlugin[] {
  return [
    createNgramPredictionPlugin({ clock: context.clock, locale: context.locale }),
    quickfirePlugin,
  ];
}

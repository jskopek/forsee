# plugins

First-party and sample plugins, one package per plugin (stage C). Each has a `manifest.json` checked by the plugin host's validator in its tests, and a `PluginModule` that uses only `ForseeApi`.

| Package            | Plugin id                 | What it does                                                                                               |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `keyboards`        | `forsee.keyboards`        | The standard keyboard layouts (QWERTY, alphabetical, QWERTZ, large groups); required, cannot be turned off |
| `prediction-ngram` | `forsee.prediction-ngram` | The offline n-gram word predictor, registered with `api.register.predictionProvider`; learns your words    |
| `quickfire`        | `forsee.quickfire`        | One-dwell interjections: a phrase set and a command that speaks one, interrupting current speech           |

The app runtime (`apps/web/src/runtime/first-party.ts`) activates them through the plugin host. See [the v1 plan](../docs/V1_PLAN.md).

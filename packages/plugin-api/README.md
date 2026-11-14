# @forsee/plugin-api

The public contract of Forsee: the plugin manifest, permission scopes, contribution types, the shared data types and `ForseeApi`, the object a plugin receives in `activate(api)`.

## Status: provisional

**The plugin API is provisional until the first end-to-end release of Forsee.** Until then it may change, including in ways that break plugins, without a change to `API_VERSION`. The exported constant `API_STABILITY` is `'provisional'` while this holds and will become `'stable'` at that release; from then on, breaking changes bump `API_VERSION`.

Changes are still made additively where possible, and each one is recorded in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) under Decisions.

## What is here

| File               | Contents                                                             |
| ------------------ | -------------------------------------------------------------------- |
| `manifest.ts`      | `PluginManifest`, permission scopes, `API_VERSION`, `API_STABILITY`  |
| `api.ts`           | `ForseeApi` and its sub-APIs, with the permission each method needs  |
| `commands.ts`      | Built-in command ids and their arguments (`CommandArgsMap`)          |
| `events.ts`        | Events a plugin can subscribe to, and the permission each needs      |
| `speech.ts`        | Voices, utterances, providers; the voice id scheme (`formatVoiceId`) |
| `contributions.ts` | One contribution type per extension point                            |
| `rpc.ts`           | The message envelopes sandboxed plugins use                          |
| `common.ts`        | Coordinates, time, ids, errors: conventions every other type follows |

Types and a few constants and pure helpers only; no runtime dependencies, no DOM, no Node.

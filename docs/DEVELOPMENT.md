# Development

The TypeScript workspace lives at the repository root next to the legacy Django app (`app/`, `conversations/`, `templates/`) and the old React prototype (`keyboard-ui/`, npm, not part of the workspace). The plan is in [V1_PLAN.md](V1_PLAN.md); package contracts, conventions and the dependency graph are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

Requires Node 22 and pnpm 10 (`corepack enable` picks the pinned version).

```sh
pnpm install
pnpm --filter @forsee/web dev     # web app at http://localhost:5173
```

## Checks

| Command             | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `pnpm lint`         | ESLint (typescript-eslint, type-aware)                    |
| `pnpm format:check` | Prettier check (`pnpm format` fixes)                      |
| `pnpm typecheck`    | `tsc -b` over every project reference                     |
| `pnpm test`         | Vitest unit tests, whole workspace                        |
| `pnpm build`        | `tsc -b`, then each package's `build` script (web: Vite)  |
| `pnpm e2e`          | Builds `apps/web`, runs Playwright against `vite preview` |
| `pnpm check`        | lint + typecheck + test + build                           |

Playwright needs Chromium: `pnpm exec playwright install --with-deps chromium` (run in `apps/web`). If a browser is already installed, set `PW_CHROMIUM_PATH` to its executable instead.

## Layout

```
apps/       shells (web, desktop, mobile)
packages/   libraries, all named @forsee/<dir>
plugins/    first-party and sample plugins
tools/      build and evaluation tooling
sidecars/   native driver processes
directory/  community plugin directory format
```

`pnpm-workspace.yaml` covers `apps/*`, `packages/*`, `plugins/*`, `tools/*` and `sidecars/*`.

### Packages reference each other by source

Each package's `exports` points at `src/index.ts`. Vite, Vitest and `tsc` all resolve `@forsee/x` straight to source, so nothing needs building during development or tests. To depend on a package, add `"@forsee/x": "workspace:*"` to `dependencies`, then add `{ "path": "../x" }` to the `references` in your `tsconfig.json`. The root `tsconfig.json` lists every project; `tsc -b` typechecks them in dependency order and emits only declarations (`dist/`, git-ignored).

### Engine packages: no DOM, no Node

`plugin-api`, `core`, `gaze`, `prediction`, `speech`, `storage`, `layouts` and `inference` run in a browser, a worker, Node tests and both shells. Their `tsconfig.json` sets `lib: ["ES2022"]` and `types: []`, so DOM and Node types are absent, and ESLint rejects imports of `react`, `electron`, `node:*` and Node built-ins, and uses of globals such as `window`, `document`, `fetch`, `process`. Anything platform-specific goes through `HostBridge` (`packages/host`). `host`, `gaze-web`, `plugin-host` and `ui` may use DOM types.

### Tests

Put unit tests next to the code as `src/**/*.test.ts` (or `.tsx`); the root `vitest.config.js` picks them up, default environment is Node. Import `describe`, `it`, `expect` from `vitest`. Browser end-to-end tests live in `apps/web/e2e`. Tests that need several packages working together (real kernel, speech engine, prediction engine, layouts and plugin host) live in `packages/integration-tests`, a private test-only package.

### Runtime harness

`pnpm --filter @forsee/web dev`, then open `http://localhost:5173/dev-runtime.html`: a page without React that boots the application runtime (`apps/web/src/runtime`) in the real browser, exposes it as `window.forsee` and has buttons to type, speak and show history. It is for development only and is not in the production build.

### Styling

`apps/web` uses Tailwind CSS 3.4. Colour tokens and the dwell-fill animation are ported from the prototype into `apps/web/tailwind.config.js` and `apps/web/src/index.css`.

## Adding a package

1. Create `packages/<name>/` with `package.json` (`name: "@forsee/<name>"`, `private`, `license: MIT`, `type: module`, `exports: { ".": "./src/index.ts" }`).
2. Copy a `tsconfig.json` from a similar package (engine or DOM) and keep `extends`, `rootDir`, `outDir`.
3. Add `src/index.ts` and `src/index.test.ts`.
4. Add `{ "path": "./packages/<name>" }` to the root `tsconfig.json`.
5. Run `pnpm install`, then `pnpm check`.

# Development

The TypeScript workspace lives at the repository root. The first prototype (the Django app and the old React `keyboard-ui`) is kept in `legacy/` for reference and is not part of the workspace. The plan is in [V1_PLAN.md](V1_PLAN.md); package contracts, conventions and the dependency graph are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

Requires Node 22 and pnpm 10 (`corepack enable` picks the pinned version).

```sh
pnpm install
pnpm --filter @forsee/web dev     # web app at http://localhost:5173
```

In a development build the running app is `window.forsee` in the browser console (the `ForseeRuntime`).

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

### End-to-end tests

`apps/web/e2e` drives the built app in real Chromium with a real mouse and real timers (`fixtures.ts` has the helpers). Every test fails on a console error, an uncaught exception, a failed request, or a request to any origin other than the app's own (the offline promise). Headless Chromium has no speech voices, so most tests install a recording fake `speechSynthesis` (`installFakeSpeech`); one test runs without it and checks that the app degrades (the text is kept and shown). `lan.spec.ts` opens the app over plain HTTP on a non-local name, as a tablet on the LAN would.

- `FORSEE_E2E_PORT` (default 4173): the `vite preview` port. The run refuses to reuse a server already on that port, so pick another when one is taken.
- `FORSEE_SCREENSHOTS=1`: `screens.spec.ts` writes its screenshots to `apps/web/docs/` (otherwise to `test-results/`). Look at them before committing.
- The smallest target of each layout at 1024 x 768 is printed by `screens.spec.ts` and attached to its report.

## Running the app

```sh
pnpm --filter @forsee/web dev       # development server, http://localhost:5173
pnpm --filter @forsee/web build     # production build in apps/web/dist
pnpm --filter @forsee/web preview   # serves the build, http://localhost:4173
```

The build works from a sub-path: `FORSEE_BASE=/forsee/ pnpm --filter @forsee/web build` makes every URL start with `/forsee/` (default `/`).

### Opening the app on other devices

To open the app from an iPad, a Vision Pro or another computer on the same network, serve it on all interfaces and open the **Network** address it prints (for example `http://192.168.1.20:4173/`):

```sh
pnpm --filter @forsee/web build
pnpm --filter @forsee/web preview --host   # the production build; best for device tests
pnpm --filter @forsee/web dev --host       # the development server, with hot reload
```

Pass `--host` straight after the script name: with pnpm 10, `dev -- --host` hands Vite a literal `--`, after which Vite ignores `--host`. Use the IP address; Vite refuses other host names (such as `my-mac.local`) unless they are added to `preview.allowedHosts` / `server.allowedHosts` in `apps/web/vite.config.ts`.

Speech and persistent storage generally need a **secure context** (HTTPS, or `localhost` on the same machine). A LAN address over plain HTTP is not one. What the app does there (checked in Chromium by `e2e/lan.spec.ts`; Safari not yet checked, see [MVP_STATUS.md](MVP_STATUS.md)):

- **Storage:** the Origin Private File System is not offered outside a secure context (`navigator.storage` is missing), so the runtime uses **IndexedDB** for the profile. It is persistent (the half-written message, history, learned words and settings survive a reload), but the browser cannot be asked to protect it from eviction (`navigator.storage.persist()` is also missing), so it can be cleared under storage pressure. If IndexedDB is unavailable too (some private windows), the app runs on memory and shows "Nothing is being saved".
- **Ids:** `crypto.randomUUID` is missing; ids come from `crypto.getRandomValues` instead (fixed during the MVP assembly: the app could not open its profile over plain HTTP before).
- **Speech:** `speechSynthesis` still exists, and speaking works as on `localhost` once the page has had a click or tap; it uses the device's offline voices. Browsers that hide it, or have no voices, get the "Could not speak" notice with the text kept.
- Each address is its own origin, so the profile at `http://192.168.1.20:4173` is separate from the one at `http://localhost:4173`.
- Installing to the home screen: Safari's "Add to Home Screen" works from any address; Chrome on Android offers installation only on HTTPS.

### Publishing to GitHub Pages

`.github/workflows/pages.yml` builds `apps/web` with `FORSEE_BASE=/<repository name>/` and deploys it to GitHub Pages. It runs **only when started by hand** (Actions → Pages → Run workflow); publishing the app is the repository owner's decision. One-time setting before the first run: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is served over HTTPS, so speech and OPFS storage work there.

The hosted app needs the network to load the first time; after that it makes no network requests (every end-to-end test fails on a request to another origin, and one checks that a whole session makes no request at all; the browser itself may fetch the tab icon again). There is no service worker yet, so opening it again without a network relies on the browser's cache and may fail; it does not stop working once open. The web app manifest (`apps/web/public/manifest.webmanifest`, icons drawn for this project) lets it be added to a tablet's home screen and run full-screen.

## Layout

```
apps/       shells: web today (its runtime in apps/web/src/runtime, its React entry in apps/web/src)
packages/   libraries, all named @forsee/<dir>
plugins/    first-party plugins, one package each (@forsee/plugin-<name>): prediction-ngram, quickfire
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

`apps/web` uses Tailwind CSS 3.4. The colour tokens, keyframes (dwell feedback, fired flash, caret) and font stack live in the `@forsee/ui` preset, `packages/ui/src/theme/tailwind-preset.js` (its test checks text contrast); `apps/web/tailwind.config.js` only adds the preset and scans `packages/ui/src` for class names. `apps/web/src/index.css` has the page-level rules (no scrolling, the boot message). System fonts only.

## Adding a package

1. Create `packages/<name>/` with `package.json` (`name: "@forsee/<name>"`, `private`, `license: MIT`, `type: module`, `exports: { ".": "./src/index.ts" }`).
2. Copy a `tsconfig.json` from a similar package (engine or DOM) and keep `extends`, `rootDir`, `outDir`.
3. Add `src/index.ts` and `src/index.test.ts`.
4. Add `{ "path": "./packages/<name>" }` to the root `tsconfig.json`.
5. Run `pnpm install`, then `pnpm check`.

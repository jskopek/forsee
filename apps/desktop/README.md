# desktop

The Forsee app for macOS and Windows: an Electron shell around the web app
(`apps/web`).

```sh
pnpm desktop        # build the web app and open it in the desktop shell
```

- `src/main.ts`: window, the private `app://forsee/` origin the web app is
  served from, permissions, menu and auto-update.
- `electron-builder.yml`: packaging (Mac `.dmg` + `.zip`, Windows installer).
- `scripts/`: bundling the main process, setting the version, and fixing the
  updater's metadata after Windows signing.

Releases are built by `.github/workflows/release.yml`; see
[docs/RELEASING.md](../../docs/RELEASING.md).

Not yet here (work package B11 in the v1 plan): profile folder on disk,
sidecar launch, the partner display window. The web app keeps its data in the
app's own browser storage, which survives restarts and updates.

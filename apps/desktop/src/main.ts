/**
 * Forsee desktop shell (macOS and Windows).
 *
 * Loads the built web app (`apps/web/dist`, packaged as `resources/web`) from
 * a private `app://forsee/` origin, so storage (OPFS, IndexedDB) keeps the
 * same origin across launches and updates, and the page is a secure context.
 *
 * Updates: checked from GitHub Releases shortly after launch and every few
 * hours, downloaded in the background, and installed when the app quits.
 * The app never restarts on its own: someone may be in the middle of a
 * sentence. "Restart to Update" in the menu installs at once.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  powerSaveBlocker,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const SCHEME = 'app';
const HOST = 'forsee';
const ORIGIN = `${SCHEME}://${HOST}`;
const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Speech must work for someone who only uses their eyes. Browsers allow
// speech and sound only after a click or key press, which a dwell is not.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** Where the built web app lives: inside the package, or next to the source in development. */
function webRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(app.getAppPath(), '../web/dist');
}

function serveWebApp(): void {
  const root = webRoot();
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative === '' ? 'index.html' : relative);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    // Unknown paths fall back to the app itself (single-page app).
    const target = existsSync(file) ? file : path.join(root, 'index.html');
    return net.fetch(pathToFileURL(target).toString());
  });
}

// ---------------------------------------------------------------------------
// Window state: remember full screen between launches.

interface WindowState {
  fullScreen: boolean;
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>;
    return { fullScreen: raw.fullScreen === true };
  } catch {
    return { fullScreen: false };
  }
}

function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // Not worth interrupting anyone over.
  }
}

let mainWindow: BrowserWindow | undefined;

function createWindow(): void {
  const state = loadWindowState();
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Forsee',
    backgroundColor: '#0b0f17',
    fullscreen: state.fullScreen,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = window;

  window.once('ready-to-show', () => {
    if (!state.fullScreen) window.maximize();
    window.show();
  });
  window.on('enter-full-screen', () => saveWindowState({ fullScreen: true }));
  window.on('leave-full-screen', () => saveWindowState({ fullScreen: false }));
  window.on('closed', () => {
    mainWindow = undefined;
  });

  // Stay inside the app; open anything else in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  void window.loadURL(`${ORIGIN}/index.html`);
}

/** Camera and microphone (for later webcam gaze and voice) for the app itself; nothing else. */
function setPermissions(): void {
  const allowed = new Set([
    'media',
    'speaker-selection',
    'fullscreen',
    'clipboard-sanitized-write',
  ]);
  const isApp = (origin: string): boolean => origin === ORIGIN || origin.startsWith(`${ORIGIN}/`);
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowed.has(permission) && isApp(webContents.getURL()));
  });
  defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return allowed.has(permission) && isApp(requestingOrigin);
  });
}

// ---------------------------------------------------------------------------
// Updates

type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'unavailable';
let updateState: UpdateState = 'idle';
let manualCheck = false;
let readyVersion: string | undefined;

function setUpdateState(next: UpdateState): void {
  updateState = next;
  buildMenu();
}

function setUpUpdates(): void {
  if (!app.isPackaged) {
    updateState = 'unavailable';
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => setUpdateState('checking'));
  autoUpdater.on('update-not-available', () => {
    setUpdateState('idle');
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox({
        type: 'info',
        message: 'Forsee is up to date.',
        detail: `You have version ${app.getVersion()}.`,
      });
    }
  });
  autoUpdater.on('update-available', () => setUpdateState('downloading'));
  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version;
    setUpdateState('ready');
    if (manualCheck) {
      manualCheck = false;
      void promptRestart();
    }
  });
  autoUpdater.on('error', (error) => {
    console.error('Update failed:', error);
    setUpdateState('idle');
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Could not check for updates.',
        detail: 'Check the internet connection and try again later. Forsee works offline as usual.',
      });
    }
  });

  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS);
}

async function checkForUpdates(manual: boolean): Promise<void> {
  if (updateState === 'unavailable') return;
  if (updateState === 'ready') {
    if (manual) await promptRestart();
    return;
  }
  if (updateState === 'checking' || updateState === 'downloading') return;
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // Reported through the 'error' event.
  }
}

async function promptRestart(): Promise<void> {
  const options = {
    type: 'info' as const,
    buttons: ['Restart Now', 'Later'],
    defaultId: 1,
    cancelId: 1,
    message: `Forsee ${readyVersion ?? ''} is ready to install.`,
    detail: 'It will install the next time Forsee is closed, or restart now to install it.',
  };
  const result =
    mainWindow === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(mainWindow, options);
  if (result.response === 0) autoUpdater.quitAndInstall();
}

// ---------------------------------------------------------------------------
// Menu

function updateMenuItem(): MenuItemConstructorOptions {
  switch (updateState) {
    case 'ready':
      return { label: 'Restart to Update…', click: () => void promptRestart() };
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false };
    case 'downloading':
      return { label: 'Downloading Update…', enabled: false };
    case 'unavailable':
      return { label: 'Updates Off in Development', enabled: false };
    case 'idle':
      return { label: 'Check for Updates…', click: () => void checkForUpdates(true) };
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              updateMenuItem(),
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: 'File',
            submenu: [{ role: 'quit' }],
          } satisfies MenuItemConstructorOptions,
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [updateMenuItem(), { type: 'separator' } as const]),
        {
          label: 'Forsee Website',
          click: () => void shell.openExternal('https://github.com/jskopek/forsee'),
        },
        ...(isMac ? [] : [{ role: 'about' } as const]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Start-up

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.setAboutPanelOptions({
    applicationName: 'Forsee',
    applicationVersion: app.getVersion(),
    copyright: 'MIT licensed. Made by the Forsee contributors.',
    website: 'https://github.com/jskopek/forsee',
  });

  void app.whenReady().then(() => {
    serveWebApp();
    setPermissions();
    buildMenu();
    createWindow();
    setUpUpdates();
    // Keep the screen awake while Forsee is open: it is someone's voice.
    powerSaveBlocker.start('prevent-display-sleep');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

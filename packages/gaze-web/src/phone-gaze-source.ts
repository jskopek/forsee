import type { Clock } from '@forsee/core';
import type {
  ActivateEvent,
  Disposable,
  GazeSample,
  GazeSource,
  GazeSourceCapabilities,
  Point,
  SourceError,
  TargetDescriptor,
} from '@forsee/plugin-api';

/**
 * Gaze from the Phone Gaze engine (`sidecars/phone-gaze`): an iPhone films
 * the user's eyes and a Python engine on the Mac publishes where they look on
 * `ws://127.0.0.1:8765/gaze`. The message shapes are specified in
 * `sidecars/phone-gaze/docs/INTERFACES.md` ("Gaze WebSocket for Forsee"):
 *
 * - server -> app, once on connect:
 *   `{type: "hello", version: 1, screen: {width, height, scale, ...} | null}`
 * - server -> app, per sample:
 *   `{type: "gaze", x, y, t, confidence, valid, nx?, ny?, latency_ms?, fixation?}`
 *   with `x`/`y` in main-display points (origin top left) and `t` in seconds
 *   on the engine's monotonic clock.
 * - app -> server, on every selection:
 *   `{type: "lookpoint", x, y, t?}` (screen points; `t` engine seconds) so the
 *   engine can correct drift.
 *
 * Unknown message types and extra fields are ignored.
 */

/** Default engine address. */
export const PHONE_GAZE_DEFAULT_URL = 'ws://127.0.0.1:8765/gaze';
/** Protocol version this source speaks. */
export const PHONE_GAZE_PROTOCOL_VERSION = 1;

// ------------------------------------------------------------------ transport

/** Callbacks a connection reports to. */
export interface PhoneGazeSocketHandlers {
  onOpen(): void;
  /** One text message (other payloads are passed as is and ignored). */
  onMessage(data: unknown): void;
  /** The connection closed, or never opened. Called at most once. */
  onClose(info: { readonly code: number; readonly reason: string }): void;
}

/** One open (or opening) connection. */
export interface PhoneGazeConnection {
  /** Sends a text message; returns false if the connection is not open. */
  send(text: string): boolean;
  /** Closes it. No handler is called afterwards. */
  close(): void;
}

/**
 * Opens a connection. The browser one wraps `WebSocket`; tests use
 * `FakePhoneGazeServer` from `@forsee/gaze-web/testing`. May throw (for
 * example when the browser has no WebSocket); the source then reports
 * `unavailable`.
 */
export type PhoneGazeConnector = (
  url: string,
  handlers: PhoneGazeSocketHandlers,
) => PhoneGazeConnection;

/** The real browser connector. */
export function browserPhoneGazeConnector(): PhoneGazeConnector {
  return (url, handlers) => {
    if (typeof WebSocket === 'undefined') throw new Error('This browser has no WebSocket.');
    const socket = new WebSocket(url);
    let closed = false;
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      handlers.onClose({ code, reason });
    };
    socket.onopen = () => {
      if (!closed) handlers.onOpen();
    };
    socket.onmessage = (event: MessageEvent) => {
      if (!closed) handlers.onMessage(event.data);
    };
    // An error is always followed by close; report the close only.
    socket.onerror = () => undefined;
    socket.onclose = (event: CloseEvent) => close(event.code, event.reason);
    return {
      send: (text) => {
        if (closed || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(text);
        return true;
      },
      close: () => {
        closed = true;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      },
    };
  };
}

// ------------------------------------------------------------------ screen placement

/** The engine's screen (`ScreenInfo.to_dict()`); only the fields this source reads. */
export interface PhoneGazeScreen {
  /** Points. */
  readonly width: number;
  readonly height: number;
  /** Backing pixels per point (2 on Retina). */
  readonly scale?: number;
}

/**
 * Where the app viewport is on the engine's screen: `left`/`top` are the
 * screen point of viewport CSS pixel (0, 0); `pointsPerCssPx` is the size of
 * one CSS pixel in points (1 at 100 % browser zoom).
 */
export interface ViewportPlacement {
  readonly left: number;
  readonly top: number;
  readonly pointsPerCssPx: number;
}

/** Computes the placement, called for every sample (the window may move). */
export type ViewportPlacementProvider = (screen: PhoneGazeScreen | null) => ViewportPlacement;

/** The part of `Window` the browser placement reads. */
export interface WindowGeometry {
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
}

/**
 * Viewport placement from the browser window's geometry. Exact in
 * fullscreen (the recommended set-up) and at 100 % zoom; in a normal window
 * it assumes the browser chrome is on top and the side borders are equal,
 * which holds for Safari, Chrome and Firefox on macOS. Browser zoom is
 * derived as `devicePixelRatio / screen.scale`.
 */
export function placementFromWindow(win: WindowGeometry, screen: PhoneGazeScreen | null) {
  const scale = screen?.scale && screen.scale > 0 ? screen.scale : win.devicePixelRatio;
  let zoom = win.devicePixelRatio > 0 && scale > 0 ? win.devicePixelRatio / scale : 1;
  if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) zoom = 1;
  const contentWidth = win.innerWidth * zoom;
  const contentHeight = win.innerHeight * zoom;
  const side = Math.max(0, (win.outerWidth - contentWidth) / 2);
  const top = Math.max(0, win.outerHeight - contentHeight - side);
  return {
    left: win.screenX + side,
    top: win.screenY + top,
    pointsPerCssPx: zoom,
  } satisfies ViewportPlacement;
}

/** The browser's placement provider (identity placement outside a browser). */
export function browserViewportPlacement(
  win: WindowGeometry | undefined = typeof window === 'undefined' ? undefined : window,
): ViewportPlacementProvider {
  if (!win) return () => ({ left: 0, top: 0, pointsPerCssPx: 1 });
  return (screen) => placementFromWindow(win, screen);
}

/** Screen points to viewport CSS pixels. */
export function screenToViewport(point: Point, placement: ViewportPlacement): Point {
  return {
    x: (point.x - placement.left) / placement.pointsPerCssPx,
    y: (point.y - placement.top) / placement.pointsPerCssPx,
  };
}

/** Viewport CSS pixels to screen points. */
export function viewportToScreen(point: Point, placement: ViewportPlacement): Point {
  return {
    x: point.x * placement.pointsPerCssPx + placement.left,
    y: point.y * placement.pointsPerCssPx + placement.top,
  };
}

// ------------------------------------------------------------------ clock mapping

/**
 * Maps engine timestamps (seconds, engine monotonic clock) to host monotonic
 * milliseconds. The offset is the lower envelope of
 * `arrival - latency_ms - t * 1000` over recent samples: the fastest delivery
 * seen is taken as transit-free. It may rise by `driftMsPerSecond` per
 * second of host time so clock drift is followed, and it is reset when it
 * disagrees by more than `resetMs` (the engine restarted).
 */
export class EngineClockMapper {
  private offset: number | null = null;
  private lastArrival = 0;
  private lastT = -Infinity;

  constructor(
    private readonly driftMsPerSecond = 1,
    private readonly resetMs = 5000,
  ) {}

  /** True once a sample has been seen. */
  get synced(): boolean {
    return this.offset !== null;
  }

  /**
   * Records a sample that arrived at host time `arrivalMs` and returns its
   * observation time on the host clock: never after `arrivalMs` and never
   * before the previous result.
   */
  observe(engineSeconds: number, arrivalMs: number, latencyMs?: number): number {
    const candidate = arrivalMs - (latencyMs ?? 0) - engineSeconds * 1000;
    if (this.offset === null || Math.abs(candidate - this.offset) > this.resetMs) {
      this.offset = candidate;
    } else if (candidate < this.offset) {
      this.offset = candidate;
    } else {
      const allowance = (Math.max(0, arrivalMs - this.lastArrival) / 1000) * this.driftMsPerSecond;
      this.offset += Math.min(candidate - this.offset, allowance);
    }
    this.lastArrival = arrivalMs;
    const t = Math.max(this.lastT, Math.min(arrivalMs, engineSeconds * 1000 + this.offset));
    this.lastT = t;
    return t;
  }

  /** Host milliseconds to engine seconds, or null before the first sample. */
  toEngine(hostMs: number): number | null {
    return this.offset === null ? null : (hostMs - this.offset) / 1000;
  }

  reset(): void {
    this.offset = null;
    this.lastArrival = 0;
    this.lastT = -Infinity;
  }
}

// ------------------------------------------------------------------ the source

/** Connection state of a `PhoneGazeSource`. */
export type PhoneGazeStatus = 'stopped' | 'connecting' | 'connected' | 'waiting-to-retry';

/** Options of `createPhoneGazeSource`. */
export interface PhoneGazeSourceOptions {
  readonly clock: Clock;
  /** Default `ws://127.0.0.1:8765/gaze`. Only loopback hosts are allowed. */
  readonly url?: string;
  /** Default `"phone-gaze"`. */
  readonly id?: string;
  /**
   * `gaze` (default): Forsee filters and detects fixations on top of the
   * engine's own filtering. `pointer`: samples pass straight through (less
   * lag, more jitter).
   */
  readonly kind?: 'gaze' | 'pointer';
  /** Defaults to the browser's `WebSocket`. */
  readonly connector?: PhoneGazeConnector;
  /** Defaults to the browser window's geometry. */
  readonly placement?: ViewportPlacementProvider;
  /** First reconnect delay, ms (default 500); doubles per failure. */
  readonly reconnectMs?: number;
  /** Longest reconnect delay, ms (default 10000). */
  readonly maxReconnectMs?: number;
  /**
   * After this many ms without a gaze message, one invalid sample is emitted
   * so dwell does not keep running on a stale position (default 400; 0 off).
   */
  readonly staleMs?: number;
}

/** The phone gaze source: a `GazeSource` that can also report selections back. */
export interface PhoneGazeSource extends GazeSource {
  readonly status: PhoneGazeStatus;
  /** The engine's screen from its last `hello`, or null. */
  readonly screen: PhoneGazeScreen | null;
  /**
   * Tells the engine the user is looking at `point` (app viewport CSS
   * pixels), for drift correction. `t` is host ms (default now). Returns
   * false when not connected.
   */
  reportLookPoint(point: Point, t?: number): boolean;
}

/** True for `ws:`/`wss:` URLs whose host is loopback. */
export function isLoopbackGazeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseScreen(value: unknown): PhoneGazeScreen | null {
  if (!isRecord(value)) return null;
  const width = num(value.width);
  const height = num(value.height);
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return null;
  const scale = num(value.scale);
  return scale !== undefined && scale > 0 ? { width, height, scale } : { width, height };
}

class PhoneGazeSourceImpl implements PhoneGazeSource {
  readonly capabilities: GazeSourceCapabilities = { calibrate: false, hover: true };
  readonly id: string;
  readonly kind: 'gaze' | 'pointer';
  status: PhoneGazeStatus = 'stopped';
  screen: PhoneGazeScreen | null = null;

  private readonly url: string;
  private readonly connector: PhoneGazeConnector;
  private readonly placement: ViewportPlacementProvider;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly staleMs: number;
  private readonly mapper = new EngineClockMapper();

  private session: {
    readonly onSample: (sample: GazeSample) => void;
    readonly onError: (error: SourceError) => void;
  } | null = null;
  private connection: PhoneGazeConnection | null = null;
  private retryTimer: Disposable | null = null;
  private staleTimer: Disposable | null = null;
  private failures = 0;
  /** Incremented per connection attempt and on stop; stale callbacks compare against it. */
  private attempt = 0;
  /** True while an outage has been reported and no hello has arrived since. */
  private outageReported = false;
  private lastPoint: Point = { x: 0, y: 0 };
  private lastT = -Infinity;
  private lastValid = false;

  constructor(
    private readonly clock: Clock,
    options: PhoneGazeSourceOptions,
  ) {
    this.url = options.url ?? PHONE_GAZE_DEFAULT_URL;
    if (!isLoopbackGazeUrl(this.url)) {
      throw new Error(`Phone gaze URL must be ws:// on localhost or 127.0.0.1, got "${this.url}".`);
    }
    this.id = options.id ?? 'phone-gaze';
    this.kind = options.kind ?? 'gaze';
    this.connector = options.connector ?? browserPhoneGazeConnector();
    this.placement = options.placement ?? browserViewportPlacement();
    this.reconnectMs = options.reconnectMs ?? 500;
    this.maxReconnectMs = options.maxReconnectMs ?? 10_000;
    this.staleMs = options.staleMs ?? 400;
    for (const [name, value] of [
      ['reconnectMs', this.reconnectMs],
      ['maxReconnectMs', this.maxReconnectMs],
      ['staleMs', this.staleMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
    }
  }

  start(onSample: (sample: GazeSample) => void, onError: (error: SourceError) => void): void {
    if (this.session)
      throw new Error(`The ${this.id} source is already started; call stop() first`);
    this.session = { onSample, onError };
    this.failures = 0;
    this.outageReported = false;
    this.lastValid = false;
    this.lastT = -Infinity;
    this.connect();
  }

  stop(): void {
    this.session = null;
    this.attempt++;
    this.status = 'stopped';
    this.retryTimer?.dispose();
    this.retryTimer = null;
    this.staleTimer?.dispose();
    this.staleTimer = null;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  reportLookPoint(point: Point, t?: number): boolean {
    if (!this.connection || this.status !== 'connected') return false;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    const screenPoint = viewportToScreen(point, this.placement(this.screen));
    const engineT = this.mapper.toEngine(t ?? this.clock.now());
    const message: Record<string, number | string> = {
      type: 'lookpoint',
      x: screenPoint.x,
      y: screenPoint.y,
    };
    if (engineT !== null) message.t = engineT;
    return this.connection.send(JSON.stringify(message));
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    const session = this.session;
    if (!session) return;
    this.status = 'connecting';
    this.mapper.reset();
    const attempt = ++this.attempt;
    const current = (): boolean => this.session === session && this.attempt === attempt;
    let connection: PhoneGazeConnection;
    try {
      connection = this.connector(this.url, {
        onOpen: () => undefined,
        onMessage: (data) => {
          if (current()) this.handleMessage(data);
        },
        onClose: (info) => {
          if (current()) this.handleClose(info.reason);
        },
      });
    } catch (error) {
      this.fail({
        code: 'unavailable',
        message: `Cannot open the phone gaze connection: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: false,
      });
      return;
    }
    // A connector may report a synchronous close; only keep a live one.
    if (current() && this.status === 'connecting') this.connection = connection;
  }

  private handleClose(reason: string): void {
    this.connection = null;
    this.staleTimer?.dispose();
    this.staleTimer = null;
    this.emitInvalid();
    if (!this.outageReported) {
      this.outageReported = true;
      this.session?.onError({
        code: 'disconnected',
        message:
          `Phone Gaze engine not reachable at ${this.url}` +
          (reason ? ` (${reason})` : '') +
          '. Start it with "python -m phonegaze"; retrying.',
        recoverable: true,
      });
    }
    if (!this.session) return;
    const delay = Math.min(this.maxReconnectMs, this.reconnectMs * 2 ** this.failures);
    this.failures = Math.min(this.failures + 1, 30);
    this.status = 'waiting-to-retry';
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private fail(error: SourceError): void {
    const session = this.session;
    this.stop();
    session?.onError(error);
  }

  // ---------------------------------------------------------------- messages

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type === 'hello') this.handleHello(message);
    else if (message.type === 'gaze') this.handleGaze(message);
  }

  private handleHello(message: Record<string, unknown>): void {
    const version = num(message.version);
    if (version !== PHONE_GAZE_PROTOCOL_VERSION) {
      this.fail({
        code: 'internal',
        message: `Phone Gaze engine speaks protocol version ${String(message.version)}; this app supports ${PHONE_GAZE_PROTOCOL_VERSION}.`,
        recoverable: false,
      });
      return;
    }
    this.screen = parseScreen(message.screen);
    this.status = 'connected';
    this.failures = 0;
    this.outageReported = false;
    this.armStaleTimer();
  }

  private handleGaze(message: Record<string, unknown>): void {
    if (this.status !== 'connected') return; // Samples before hello are not trusted.
    const x = num(message.x);
    const y = num(message.y);
    const t = num(message.t);
    if (x === undefined || y === undefined || t === undefined) return;
    const latency = num(message.latency_ms);
    const observed = this.mapper.observe(t, this.clock.now(), latency);
    const confidence = Math.min(1, Math.max(0, num(message.confidence) ?? 0));
    const valid = message.valid === true;
    const point = valid ? screenToViewport({ x, y }, this.placement(this.screen)) : this.lastPoint;
    if (valid) this.lastPoint = point;
    this.armStaleTimer();
    this.emit({ x: point.x, y: point.y, t: observed, confidence: valid ? confidence : 0, valid });
  }

  private emit(sample: GazeSample): void {
    const t = Math.max(sample.t, this.lastT);
    this.lastT = t;
    this.lastValid = sample.valid;
    this.session?.onSample(t === sample.t ? sample : { ...sample, t });
  }

  /** One invalid sample at the last position, unless the last one was already invalid. */
  private emitInvalid(): void {
    if (!this.session || !this.lastValid) return;
    this.emit({ ...this.lastPoint, t: this.clock.now(), confidence: 0, valid: false });
  }

  private armStaleTimer(): void {
    this.staleTimer?.dispose();
    this.staleTimer = null;
    if (this.staleMs <= 0) return;
    this.staleTimer = this.clock.setTimeout(() => {
      this.staleTimer = null;
      this.emitInvalid();
    }, this.staleMs);
  }
}

/**
 * The Phone Gaze source. `kind` defaults to `gaze`, capabilities are
 * `{calibrate: false, hover: true}` (calibration runs in the engine's own
 * web UI). Errors: `disconnected` (recoverable, once per outage, while it
 * reconnects with exponential backoff), `unavailable` (no WebSocket) and
 * `internal` (wrong protocol version); the last two stop the source.
 * Throws at creation for a non-loopback URL or bad option.
 */
export function createPhoneGazeSource(options: PhoneGazeSourceOptions): PhoneGazeSource {
  return new PhoneGazeSourceImpl(options.clock, options);
}

// ------------------------------------------------------------------ wiring helpers

/** The parts of the gaze pipeline and target registry `reportSelections` needs. */
export interface SelectionFeed {
  onActivate(listener: (event: ActivateEvent) => void): Disposable;
}
export interface TargetLookup {
  get(id: string): TargetDescriptor | undefined;
}

/**
 * Sends every activation back to the engine as a look-point: the centre of
 * the activated target (where the user meant to look), or the activation
 * point when the target is gone.
 */
export function reportSelections(
  feed: SelectionFeed,
  targets: TargetLookup,
  source: Pick<PhoneGazeSource, 'reportLookPoint'>,
): Disposable {
  return feed.onActivate((event) => {
    const rect = targets.get(event.targetId)?.rect;
    const point = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : event.point;
    source.reportLookPoint(point, event.t);
  });
}

/**
 * Reads the opt-in from a page's query string: `?gaze=phone` uses the default
 * engine address, `&gazePort=9000` another port on 127.0.0.1, and
 * `?gazeUrl=ws://127.0.0.1:9000/gaze` a full URL (implies `gaze=phone`).
 * Returns null when not asked for.
 */
export function phoneGazeUrlFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const url = params.get('gazeUrl');
  if (url) return url;
  if (params.get('gaze') !== 'phone') return null;
  const port = params.get('gazePort');
  if (port && /^\d{1,5}$/.test(port)) return `ws://127.0.0.1:${port}/gaze`;
  return PHONE_GAZE_DEFAULT_URL;
}

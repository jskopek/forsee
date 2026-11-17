import { CompositionBuffer, FakeClock } from '@forsee/core';
import {
  DEFAULT_DWELL_CONFIG,
  createGazePipeline,
  createTargetRegistry,
  type GazePipeline,
} from '@forsee/gaze';
import type {
  ActivateEvent,
  Disposable,
  GazeSample,
  SelectionMethodId,
  SourceError,
  TargetDescriptor,
} from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import {
  EngineClockMapper,
  createPhoneGazeSource,
  isLoopbackGazeUrl,
  phoneGazeUrlFromSearch,
  placementFromWindow,
  reportSelections,
  screenToViewport,
  viewportToScreen,
  type PhoneGazeSourceOptions,
  type ViewportPlacement,
} from './phone-gaze-source';
import { FakePhoneGazeServer } from './testing';

/** Viewport at screen point (100, 50), 100 % zoom. */
const PLACEMENT: ViewportPlacement = { left: 100, top: 50, pointsPerCssPx: 1 };

function setup(options: Partial<PhoneGazeSourceOptions> = {}) {
  const clock = new FakeClock({ now: 10_000 });
  const server = new FakePhoneGazeServer();
  let placement = PLACEMENT;
  const source = createPhoneGazeSource({
    clock,
    connector: server.connector,
    placement: () => placement,
    ...options,
  });
  const samples: GazeSample[] = [];
  const errors: SourceError[] = [];
  const start = (): void =>
    source.start(
      (s) => samples.push(s),
      (e) => errors.push(e),
    );
  return {
    clock,
    server,
    source,
    samples,
    errors,
    start,
    setPlacement: (p: ViewportPlacement) => (placement = p),
  };
}

describe('phone gaze source', () => {
  it('declares itself and connects to the default engine address', () => {
    const { source, server, start } = setup();
    expect(source.id).toBe('phone-gaze');
    expect(source.kind).toBe('gaze');
    expect(source.capabilities).toEqual({ calibrate: false, hover: true });
    expect(source.status).toBe('stopped');
    start();
    expect(server.last.url).toBe('ws://127.0.0.1:8765/gaze');
    expect(source.status).toBe('connecting');
    server.last.acceptWithHello();
    expect(source.status).toBe('connected');
    expect(source.screen).toEqual({ width: 1512, height: 982, scale: 2 });
  });

  it('converts screen points to viewport CSS pixels and stamps host time', () => {
    const { clock, server, samples, start } = setup();
    start();
    server.last.acceptWithHello();
    // Engine clock at 500 s; arrives at host 10 000 ms with 30 ms latency.
    server.last.gaze(400, 300, 500.0, { latency_ms: 30, nx: 0.2, ny: 0.3, fixation: true });
    expect(samples).toEqual([{ x: 300, y: 250, t: 9970, confidence: 0.9, valid: true }]);
    clock.advance(16);
    server.last.gaze(410, 310, 500.016, { latency_ms: 30 });
    expect(samples[1]).toEqual({ x: 310, y: 260, t: 9986, confidence: 0.9, valid: true });
  });

  it('follows the browser window when it moves and applies browser zoom', () => {
    const { server, samples, start, setPlacement } = setup();
    start();
    server.last.acceptWithHello();
    setPlacement({ left: 0, top: 0, pointsPerCssPx: 1.25 });
    server.last.gaze(500, 250, 1);
    expect(samples[0]).toMatchObject({ x: 400, y: 200 });
  });

  it('repeats the last valid position for invalid samples, with confidence 0', () => {
    const { server, samples, start } = setup();
    start();
    server.last.acceptWithHello();
    server.last.gaze(400, 300, 1);
    server.last.sendJson({ type: 'gaze', x: 0, y: 0, t: 1.01, confidence: 0.5, valid: false });
    expect(samples[1]).toMatchObject({ x: 300, y: 250, valid: false, confidence: 0 });
  });

  it('ignores samples before hello, malformed messages and unknown types', () => {
    const { server, samples, errors, start } = setup();
    start();
    server.last.accept();
    server.last.gaze(1, 1, 1);
    server.last.acceptWithHello();
    server.last.sendRaw('not json');
    server.last.sendRaw(new ArrayBuffer(4));
    server.last.sendJson([1, 2]);
    server.last.sendJson({ type: 'gaze', x: 'a', y: 1, t: 1 });
    server.last.sendJson({ type: 'status', anything: true });
    server.last.sendJson({ type: 'gaze', x: 1, y: 1, t: 1, confidence: 7, valid: true });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.confidence).toBe(1);
    expect(errors).toEqual([]);
  });

  it('keeps time non-decreasing and never later than arrival', () => {
    const { clock, server, samples, start } = setup();
    start();
    server.last.acceptWithHello();
    server.last.gaze(0, 0, 100);
    clock.advance(10);
    server.last.gaze(0, 0, 99.9); // Out of order from the engine.
    clock.advance(10);
    server.last.gaze(0, 0, 100.02, { latency_ms: 0 });
    const ts = samples.map((s) => s.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1] ?? 0);
    expect(ts[2]).toBeLessThanOrEqual(clock.now());
  });

  it('reports a recoverable disconnect once per outage and reconnects with backoff', () => {
    const { clock, server, errors, source, start } = setup({
      reconnectMs: 100,
      maxReconnectMs: 400,
    });
    start();
    server.last.drop('refused');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'disconnected', recoverable: true });
    expect(errors[0]?.message).toContain('refused');
    expect(source.status).toBe('waiting-to-retry');

    const connectsAt: number[] = [];
    const t0 = clock.now();
    for (let i = 0; i < 4; i++) {
      const before = server.sockets.length;
      while (server.sockets.length === before) clock.advance(10);
      connectsAt.push(clock.now() - t0);
      server.last.drop();
    }
    // 100, +200, +400, +400 (capped).
    expect(connectsAt).toEqual([100, 300, 700, 1100]);
    expect(errors).toHaveLength(1);

    // A successful hello ends the outage and resets the backoff.
    clock.advance(400);
    server.last.acceptWithHello();
    expect(source.status).toBe('connected');
    server.last.drop();
    expect(errors).toHaveLength(2);
    const before = server.sockets.length;
    clock.advance(100);
    expect(server.sockets.length).toBe(before + 1);
  });

  it('emits one invalid sample when the connection drops mid-stream', () => {
    const { server, samples, start } = setup();
    start();
    server.last.acceptWithHello();
    server.last.gaze(400, 300, 1);
    server.last.drop();
    expect(samples.at(-1)).toMatchObject({ x: 300, y: 250, valid: false });
    expect(samples).toHaveLength(2);
  });

  it('emits one invalid sample when samples stop arriving', () => {
    const { clock, server, samples, start } = setup({ staleMs: 300 });
    start();
    server.last.acceptWithHello();
    server.last.gaze(400, 300, 1);
    clock.advance(299);
    expect(samples).toHaveLength(1);
    clock.advance(1);
    expect(samples[1]).toMatchObject({ valid: false, t: clock.now() });
    clock.advance(5000);
    expect(samples).toHaveLength(2);
  });

  it('stops cleanly: closes the socket, cancels timers, delivers nothing more', () => {
    const { clock, server, samples, errors, source, start } = setup();
    start();
    const socket = server.last.acceptWithHello();
    socket.gaze(400, 300, 1);
    source.stop();
    expect(socket.closedByClient).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    socket.gaze(1, 1, 2);
    socket.drop();
    clock.advance(60_000);
    expect(samples).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(server.sockets).toHaveLength(1);
    expect(source.status).toBe('stopped');
  });

  it('can stop while waiting to retry, and start again', () => {
    const { clock, server, source, start } = setup();
    start();
    server.last.drop();
    source.stop();
    expect(clock.pendingTimers).toBe(0);
    expect(() => {
      start();
    }).not.toThrow();
    expect(server.sockets).toHaveLength(2);
    expect(() => {
      start();
    }).toThrow(/already started/);
  });

  it('stops itself with a non-recoverable error on a protocol version mismatch', () => {
    const { clock, server, errors, source, start } = setup();
    start();
    server.last.acceptWithHello(null, 2);
    expect(errors).toEqual([expect.objectContaining({ code: 'internal', recoverable: false })]);
    expect(source.status).toBe('stopped');
    expect(server.last.closedByClient).toBe(true);
    clock.advance(60_000);
    expect(server.sockets).toHaveLength(1);
  });

  it('reports unavailable when no WebSocket can be created', () => {
    const { server, errors, source, start } = setup();
    server.throwOnConnect = new Error('no WebSocket');
    start();
    expect(errors).toEqual([expect.objectContaining({ code: 'unavailable', recoverable: false })]);
    expect(source.status).toBe('stopped');
  });

  it('rejects non-loopback URLs and bad options at creation', () => {
    expect(() => setup({ url: 'ws://10.0.0.5:8765/gaze' })).toThrow(/localhost/);
    expect(() => setup({ url: 'http://127.0.0.1:8765/gaze' })).toThrow();
    expect(() => setup({ reconnectMs: -1 })).toThrow(/reconnectMs/);
    expect(() => setup({ url: 'ws://localhost:9000/gaze' })).not.toThrow();
  });

  it('sends look-points back in screen points with engine time', () => {
    const { clock, server, source, start } = setup();
    expect(source.reportLookPoint({ x: 1, y: 1 })).toBe(false);
    start();
    server.last.acceptWithHello();
    expect(source.reportLookPoint({ x: 1, y: 1 })).toBe(true); // No clock sync yet: no t.
    server.last.gaze(400, 300, 500, { latency_ms: 0 }); // Host 10 000 ms == engine 500 s.
    clock.advance(100);
    expect(source.reportLookPoint({ x: 20, y: 30 })).toBe(true);
    expect(source.reportLookPoint({ x: 20, y: 30 }, 10_050)).toBe(true);
    expect(source.reportLookPoint({ x: Number.NaN, y: 30 })).toBe(false);
    expect(server.last.sent).toEqual([
      { type: 'lookpoint', x: 101, y: 51 },
      { type: 'lookpoint', x: 120, y: 80, t: 500.1 },
      { type: 'lookpoint', x: 120, y: 80, t: 500.05 },
    ]);
  });

  it('sends the target rectangle, kind and id in screen points, additively', () => {
    const { clock, server, source, start, setPlacement } = setup();
    start();
    server.last.acceptWithHello();
    server.last.gaze(400, 300, 500, { latency_ms: 0 });
    setPlacement({ left: 100, top: 50, pointsPerCssPx: 2 });
    clock.advance(100);
    expect(
      source.reportLookPoint({ x: 20, y: 30 }, undefined, {
        id: 's7',
        kind: 'dwell',
        rect: { x: 10, y: 20, width: 20, height: 20 },
      }),
    ).toBe(true);
    // A bad rectangle is left out; the look-point still goes.
    expect(
      source.reportLookPoint({ x: 20, y: 30 }, undefined, {
        kind: 'click',
        rect: { x: 10, y: 20, width: Number.NaN, height: 20 },
      }),
    ).toBe(true);
    expect(server.last.sent).toEqual([
      {
        type: 'lookpoint',
        x: 140,
        y: 110,
        t: 500.1,
        id: 's7',
        kind: 'dwell',
        rect: { x: 120, y: 90, width: 40, height: 40 },
      },
      { type: 'lookpoint', x: 140, y: 110, t: 500.1, kind: 'click' },
    ]);
  });

  it('takes a look-point back with lookpoint.undo, only when connected', () => {
    const { server, source, start } = setup();
    expect(source.reportUndo('s1')).toBe(false);
    start();
    server.last.acceptWithHello();
    expect(source.reportUndo('s1')).toBe(true);
    expect(server.last.sent).toEqual([{ type: 'lookpoint.undo', id: 's1' }]);
  });

  it('feeds a real gaze pipeline: dwell on a key fires it, and the selection goes back', async () => {
    const clock = new FakeClock({ now: 10_000 });
    const server = new FakePhoneGazeServer();
    const targets = createTargetRegistry();
    targets.register({
      id: 'keyboard/key-a',
      rect: { x: 100, y: 100, width: 60, height: 60 },
      dwellClass: 'letter',
      text: 'a',
      command: { command: 'composition.insert', args: { text: 'a' } },
    });
    const execute = vi.fn(() => Promise.resolve(true));
    const pipeline: GazePipeline = createGazePipeline({
      clock,
      targets,
      dwell: {
        ...DEFAULT_DWELL_CONFIG,
        adaptive: { ...DEFAULT_DWELL_CONFIG.adaptive, enabled: false },
      },
      executeCommand: execute,
    });
    const source = createPhoneGazeSource({
      clock,
      connector: server.connector,
      placement: () => PLACEMENT,
    });
    const sub = reportSelections(pipeline, targets, source);
    pipeline.setSource(source);
    server.last.acceptWithHello();
    // Look at (232, 182) screen = (132, 132) viewport, slightly off the key centre (130, 130).
    for (let i = 0; i < 150; i++) {
      server.last.gaze(232, 182, 1 + i * 0.016, { latency_ms: 20 });
      clock.advance(16);
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(execute).toHaveBeenCalled();
    expect(server.last.sent[0]).toMatchObject({
      type: 'lookpoint',
      x: 230,
      y: 180,
      id: 's1',
      kind: 'dwell',
      rect: { x: 200, y: 150, width: 60, height: 60 },
    });
    sub.dispose();
    pipeline.dispose();
    expect(server.liveCount).toBe(0);
  });
});

/** A selection feed and target lookup driven by hand, plus what was reported. */
function selectionRig() {
  const clock = new FakeClock({ now: 1000 });
  const listeners = new Set<(event: ActivateEvent) => void>();
  const feed = {
    onActivate(listener: (event: ActivateEvent) => void): Disposable {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };
  const rects: Record<string, TargetDescriptor> = {
    a: { id: 'a', rect: { x: 0, y: 0, width: 50, height: 40 }, dwellClass: 'letter' },
    b: { id: 'b', rect: { x: 60, y: 0, width: 50, height: 40 }, dwellClass: 'letter' },
    back: { id: 'back', rect: { x: 200, y: 0, width: 90, height: 40 }, dwellClass: 'function' },
  };
  const targets = { get: (id: string) => rects[id] };
  const reported: { type: string; id?: string; kind?: string; rect?: unknown }[] = [];
  const source = {
    reportLookPoint: (_point: unknown, _t?: number, details?: { id?: string; kind?: string }) => {
      reported.push({ type: 'lookpoint', ...details });
      return true;
    },
    reportUndo: (id: string) => {
      reported.push({ type: 'undo', id });
      return true;
    },
  };
  const composition = new CompositionBuffer();
  const activate = (targetId: string, method: SelectionMethodId = 'dwell'): void => {
    const event: ActivateEvent = {
      type: 'activate',
      targetId,
      method,
      repeatIndex: 0,
      point: { x: 0, y: 0 },
      distribution: { entries: [] },
      t: clock.now(),
    };
    for (const listener of [...listeners]) listener(event);
  };
  const sub = reportSelections(feed, targets, source, { edits: composition.events, clock });
  const undos = () => reported.filter((r) => r.type === 'undo').map((r) => r.id);
  return { clock, activate, composition, reported, undos, sub, listeners };
}

describe('reportSelections', () => {
  it('reports rect, kind and an id per selection', () => {
    const { activate, reported } = selectionRig();
    activate('a');
    activate('b', 'direct');
    expect(reported).toEqual([
      {
        type: 'lookpoint',
        id: 's1',
        kind: 'dwell',
        rect: { x: 0, y: 0, width: 50, height: 40 },
      },
      {
        type: 'lookpoint',
        id: 's2',
        kind: 'click',
        rect: { x: 60, y: 0, width: 50, height: 40 },
      },
    ]);
  });

  it('a backspace straight after a selection takes it back, not the backspace itself', () => {
    const { clock, activate, composition, undos } = selectionRig();
    activate('a');
    composition.insert('a');
    clock.advance(900);
    activate('back'); // listener before the command ran
    clock.advance(20);
    composition.deleteGrapheme();
    expect(undos()).toEqual(['s1']);
  });

  it('works when the command runs before the activation is reported', () => {
    const { clock, activate, composition, undos } = selectionRig();
    activate('a');
    composition.insert('a');
    clock.advance(900);
    composition.insert('b');
    activate('b');
    clock.advance(900);
    composition.deleteGrapheme(); // the backspace's command first ...
    activate('back'); // ... then its activation
    clock.advance(900);
    composition.deleteGrapheme(); // a second backspace takes back the selection before
    activate('back');
    expect(undos()).toEqual(['s2', 's1']);
  });

  it('typing, clearing and late removals take nothing back', () => {
    const { clock, activate, composition, undos } = selectionRig();
    activate('a');
    composition.insert('a');
    clock.advance(900);
    activate('b');
    composition.insert('b');
    composition.clear();
    expect(undos()).toEqual([]);
    clock.advance(6000);
    composition.insert('c');
    composition.undo();
    expect(undos()).toEqual([]);
  });

  it('needs a clock with edits, and disposes both subscriptions', () => {
    const feed = { onActivate: () => ({ dispose: () => undefined }) };
    const source = { reportLookPoint: () => true, reportUndo: () => true };
    expect(() =>
      reportSelections(feed, { get: () => undefined }, source, {
        edits: new CompositionBuffer().events,
      }),
    ).toThrow(/clock/);
    const { sub, listeners, composition, activate, clock, undos } = selectionRig();
    sub.dispose();
    expect(listeners.size).toBe(0);
    activate('a');
    clock.advance(900);
    composition.insert('x');
    composition.deleteGrapheme();
    expect(undos()).toEqual([]);
  });
});

describe('phone gaze helpers', () => {
  it('converts between screen and viewport both ways', () => {
    const p = { left: 30, top: 80, pointsPerCssPx: 1.1 };
    const back = screenToViewport(viewportToScreen({ x: 12, y: 34 }, p), p);
    expect(back.x).toBeCloseTo(12);
    expect(back.y).toBeCloseTo(34);
  });

  it('places a fullscreen window exactly', () => {
    const win = {
      screenX: 0,
      screenY: 0,
      outerWidth: 1512,
      outerHeight: 982,
      innerWidth: 1512,
      innerHeight: 982,
      devicePixelRatio: 2,
    };
    expect(placementFromWindow(win, { width: 1512, height: 982, scale: 2 })).toEqual({
      left: 0,
      top: 0,
      pointsPerCssPx: 1,
    });
  });

  it('accounts for browser chrome on top and for zoom', () => {
    const win = {
      screenX: 200,
      screenY: 40,
      outerWidth: 1000,
      outerHeight: 800,
      innerWidth: 800,
      innerHeight: 576,
      devicePixelRatio: 2.5,
    };
    // Zoom 125 %: content 1000 x 720 points, so chrome is 80 points on top.
    expect(placementFromWindow(win, { width: 1512, height: 982, scale: 2 })).toEqual({
      left: 200,
      top: 120,
      pointsPerCssPx: 1.25,
    });
    // Without a screen scale, zoom is assumed to be 100 %.
    expect(placementFromWindow({ ...win, devicePixelRatio: 2 }, null).pointsPerCssPx).toBe(1);
  });

  it('maps engine time with the fastest delivery and follows drift slowly', () => {
    const m = new EngineClockMapper(1, 5000);
    expect(m.toEngine(0)).toBeNull();
    expect(m.observe(1, 1050)).toBe(1050); // offset 50
    expect(m.observe(2, 2040)).toBe(2040); // faster: offset 40
    expect(m.observe(3, 3100)).toBeCloseTo(3041.06); // slower: offset rises 1 ms/s (1.06 s here)
    expect(m.toEngine(3041.06)).toBeCloseTo(3);
    expect(m.observe(1000, 4000)).toBe(4000); // engine restarted: re-sync
  });

  it('checks loopback URLs', () => {
    expect(isLoopbackGazeUrl('ws://127.0.0.1:8765/gaze')).toBe(true);
    expect(isLoopbackGazeUrl('ws://[::1]:8765/gaze')).toBe(true);
    expect(isLoopbackGazeUrl('wss://localhost/gaze')).toBe(true);
    expect(isLoopbackGazeUrl('ws://example.com/gaze')).toBe(false);
    expect(isLoopbackGazeUrl('ws://127.0.0.1.evil.com/gaze')).toBe(false);
    expect(isLoopbackGazeUrl('nonsense')).toBe(false);
  });

  it('reads the opt-in from the query string', () => {
    expect(phoneGazeUrlFromSearch('')).toBeNull();
    expect(phoneGazeUrlFromSearch('?gaze=pointer')).toBeNull();
    expect(phoneGazeUrlFromSearch('?gaze=phone')).toBe('ws://127.0.0.1:8765/gaze');
    expect(phoneGazeUrlFromSearch('?gaze=phone&gazePort=9001')).toBe('ws://127.0.0.1:9001/gaze');
    expect(phoneGazeUrlFromSearch('?gazeUrl=ws://localhost:1/gaze')).toBe('ws://localhost:1/gaze');
  });
});

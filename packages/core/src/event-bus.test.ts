import { describe, expect, it, vi } from 'vitest';
import { CancellationSource, NEVER_CANCELLED } from './cancellation';
import { DisposableStore, disposeAll, NOOP_DISPOSABLE, toDisposable } from './disposable';
import { ForseeError, isForseeError } from './errors';
import { EventBus } from './event-bus';

interface Events {
  a: number;
  b: string;
}

describe('EventBus', () => {
  it('delivers typed payloads in subscription order', () => {
    const bus = new EventBus<Events>();
    const seen: string[] = [];
    bus.on('a', (n) => seen.push(`1:${n}`));
    bus.on('a', (n) => seen.push(`2:${n}`));
    bus.on('b', (s) => seen.push(`b:${s}`));
    bus.emit('a', 7);
    bus.emit('b', 'x');
    expect(seen).toEqual(['1:7', '2:7', 'b:x']);
  });

  it('isolates listener errors: others still run and the error is reported', () => {
    const onListenerError = vi.fn();
    const bus = new EventBus<Events>({ onListenerError });
    const after = vi.fn();
    bus.on('a', () => {
      throw new Error('boom');
    });
    bus.on('a', after);
    expect(() => bus.emit('a', 1)).not.toThrow();
    expect(after).toHaveBeenCalledWith(1);
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), 'event:a');
  });

  it('isolates errors in onAny listeners too', () => {
    const onListenerError = vi.fn();
    const bus = new EventBus<Events>({ onListenerError });
    const seen: unknown[] = [];
    bus.onAny(() => {
      throw new Error('any');
    });
    bus.onAny((type, payload) => seen.push([type, payload]));
    bus.emit('b', 'y');
    expect(seen).toEqual([['b', 'y']]);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('dispose of a subscription stops delivery and is idempotent', () => {
    const bus = new EventBus<Events>();
    const fn = vi.fn();
    const sub = bus.on('a', fn);
    sub.dispose();
    sub.dispose();
    bus.emit('a', 1);
    expect(fn).not.toHaveBeenCalled();
    expect(bus.listenerCount('a')).toBe(0);
  });

  it('subscribing the same function twice gives two subscriptions', () => {
    const bus = new EventBus<Events>();
    const fn = vi.fn();
    const one = bus.on('a', fn);
    bus.on('a', fn);
    bus.emit('a', 1);
    one.dispose();
    bus.emit('a', 2);
    expect(fn.mock.calls).toEqual([[1], [1], [2]]);
  });

  it('does not call listeners added during an emit, and skips ones removed during it', () => {
    const bus = new EventBus<Events>();
    const late = vi.fn();
    const removed = vi.fn();
    let sub2 = NOOP_DISPOSABLE;
    bus.on('a', () => {
      bus.on('a', late);
      sub2.dispose();
    });
    sub2 = bus.on('a', removed);
    bus.emit('a', 1);
    expect(late).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    bus.emit('a', 2);
    expect(late).toHaveBeenCalledWith(2);
  });

  it('once fires a single time', () => {
    const bus = new EventBus<Events>();
    const fn = vi.fn();
    bus.once('a', fn);
    bus.emit('a', 1);
    bus.emit('a', 2);
    expect(fn.mock.calls).toEqual([[1]]);
  });

  it('is inert after dispose', () => {
    const bus = new EventBus<Events>();
    const fn = vi.fn();
    bus.on('a', fn);
    bus.dispose();
    bus.on('a', fn);
    bus.emit('a', 1);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('disposables', () => {
  it('toDisposable runs once', () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    d.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('DisposableStore disposes in reverse order and disposes late additions immediately', () => {
    const order: number[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push(1)));
    store.add(toDisposable(() => order.push(2)));
    store.dispose();
    expect(order).toEqual([2, 1]);
    expect(store.disposed).toBe(true);
    store.add(toDisposable(() => order.push(3)));
    expect(order).toEqual([2, 1, 3]);
  });

  it('DisposableStore.delete removes without disposing', () => {
    const fn = vi.fn();
    const store = new DisposableStore();
    const d = store.add(toDisposable(fn));
    store.delete(d);
    store.dispose();
    expect(fn).not.toHaveBeenCalled();
  });

  it('disposeAll disposes everything and rethrows', () => {
    const fn = vi.fn();
    const bad = toDisposable(() => {
      throw new Error('one');
    });
    const bad2 = toDisposable(() => {
      throw new Error('two');
    });
    expect(() => disposeAll([bad, toDisposable(fn)])).toThrow('one');
    expect(fn).toHaveBeenCalled();
    expect(() =>
      disposeAll([
        bad2,
        toDisposable(() => {
          throw new Error('three');
        }),
      ]),
    ).toThrow(AggregateError);
  });
});

describe('CancellationSource', () => {
  it('notifies listeners once and immediately after cancellation', () => {
    const source = new CancellationSource();
    const fn = vi.fn();
    source.token.onCancel(fn);
    expect(source.token.cancelled).toBe(false);
    source.cancel();
    source.cancel();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(source.token.cancelled).toBe(true);
    const late = vi.fn();
    source.token.onCancel(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('lets listeners unsubscribe and reports listener errors', () => {
    const report = vi.fn();
    const source = new CancellationSource(report);
    const fn = vi.fn();
    source.token.onCancel(fn).dispose();
    source.token.onCancel(() => {
      throw new Error('x');
    });
    source.cancel();
    expect(fn).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'cancellation');
  });

  it('NEVER_CANCELLED never fires', () => {
    const fn = vi.fn();
    NEVER_CANCELLED.onCancel(fn).dispose();
    expect(NEVER_CANCELLED.cancelled).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ForseeError', () => {
  it('carries a code and serialises to data', () => {
    const e = new ForseeError('not-found', 'missing', { details: { key: 'x' } });
    expect(isForseeError(e)).toBe(true);
    expect(isForseeError(e, 'not-found')).toBe(true);
    expect(isForseeError(e, 'duplicate')).toBe(false);
    expect(isForseeError(new Error('x'))).toBe(false);
    expect(e.toData()).toEqual({ code: 'not-found', message: 'missing', details: { key: 'x' } });
    expect(JSON.parse(JSON.stringify(e.toData()))).toEqual(e.toData());
  });
});

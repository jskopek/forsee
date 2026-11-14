import { describe, expect, it, vi } from 'vitest';
import { MemoryFileSystem } from './memory-fs';
import { FileSystemError, splitProfilePath } from './platform';
import { FakeClock, SequentialIdSource } from './testing';
import { decodeUtf8, encodeUtf8 } from './utf8';

describe('splitProfilePath', () => {
  it.each([
    ['', []],
    ['a', ['a']],
    ['history/2026-11.jsonl', ['history', '2026-11.jsonl']],
  ])('accepts %j', (path, segments) => {
    expect(splitProfilePath(path)).toEqual(segments);
  });

  it.each(['/a', 'a/', 'a//b', '../a', 'a/./b', 'a\\b', 'a/..'])('rejects %j', (path) => {
    expect(() => splitProfilePath(path)).toThrow(FileSystemError);
  });
});

describe('MemoryFileSystem', () => {
  it('writes and reads text and bytes, creating parents', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeText('state/composition.json', '{"v":1} é😀');
    expect(await fs.readText('state/composition.json')).toBe('{"v":1} é😀');
    const bytes = new Uint8Array([1, 2, 3]);
    await fs.writeBytes('phrases/audio/a.wav', bytes);
    bytes[0] = 9;
    const read = await fs.readBytes('phrases/audio/a.wav');
    expect([...read]).toEqual([1, 2, 3]);
    read[1] = 9;
    expect([...(await fs.readBytes('phrases/audio/a.wav'))]).toEqual([1, 2, 3]);
  });

  it('appends, creating the file if missing', async () => {
    const fs = new MemoryFileSystem();
    await fs.appendText('history/x.jsonl', 'a\n');
    await fs.appendText('history/x.jsonl', 'b\n');
    expect(await fs.readText('history/x.jsonl')).toBe('a\nb\n');
  });

  it('lists sorted entries and checks existence', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeText('b.json', '');
    await fs.writeText('a/c.json', '');
    expect(await fs.list('')).toEqual([
      { name: 'a', kind: 'directory' },
      { name: 'b.json', kind: 'file' },
    ]);
    expect(await fs.exists('a')).toBe(true);
    expect(await fs.exists('a/c.json')).toBe(true);
    expect(await fs.exists('nope')).toBe(false);
    expect(await fs.exists('')).toBe(true);
  });

  it('rejects with typed errors', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeText('a/b', 'x');
    await expect(fs.readText('missing')).rejects.toMatchObject({ code: 'not-found' });
    await expect(fs.readText('a')).rejects.toMatchObject({ code: 'is-directory' });
    await expect(fs.list('a/b')).rejects.toMatchObject({ code: 'not-directory' });
    await expect(fs.list('zzz')).rejects.toMatchObject({ code: 'not-found' });
    await expect(fs.writeText('a/b/c', 'x')).rejects.toMatchObject({ code: 'not-directory' });
    await expect(fs.writeText('a', 'x')).rejects.toMatchObject({ code: 'is-directory' });
    await expect(fs.writeText('../x', 'x')).rejects.toMatchObject({ code: 'invalid-path' });
    await expect(fs.appendText('a', 'x')).rejects.toMatchObject({ code: 'is-directory' });
  });

  it('deletes files and directories', async () => {
    const fs = new MemoryFileSystem();
    await fs.writeText('d/f', 'x');
    await expect(fs.delete('d')).rejects.toMatchObject({ code: 'not-empty' });
    await fs.delete('d/f');
    await fs.delete('d');
    await fs.delete('never/existed');
    await fs.writeText('e/f/g', 'x');
    await fs.delete('e', { recursive: true });
    expect(await fs.list('')).toEqual([]);
    await expect(fs.delete('')).rejects.toMatchObject({ code: 'invalid-path' });
  });
});

describe('UTF-8', () => {
  it.each<[string, number[]]>([
    ['', []],
    ['ab', [0x61, 0x62]],
    ['é', [0xc3, 0xa9]],
    ['€', [0xe2, 0x82, 0xac]],
    ['😀', [0xf0, 0x9f, 0x98, 0x80]],
  ])('encodes %j', (text, bytes) => {
    expect([...encodeUtf8(text)]).toEqual(bytes);
    expect(decodeUtf8(Uint8Array.from(bytes))).toBe(text);
  });

  it('round-trips mixed text', () => {
    const text = 'mixed é€😀 text';
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
  });

  it('replaces lone surrogates and invalid bytes with U+FFFD', () => {
    expect(decodeUtf8(encodeUtf8('a\ud800b'))).toBe('a�b');
    expect(decodeUtf8(new Uint8Array([0x61, 0xff, 0x62]))).toBe('a�b');
    expect(decodeUtf8(new Uint8Array([0xe2, 0x82]))).toBe('��');
    expect(decodeUtf8(new Uint8Array([0xc0, 0x80]))).toBe('��');
  });
});

describe('FakeClock', () => {
  it('advances monotonic and wall time together and fires timers in order', () => {
    const clock = new FakeClock({ now: 10, wall: 5000 });
    const fired: string[] = [];
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 5);
    clock.setTimeout(() => fired.push(`c@${clock.now()}`), 20);
    clock.advance(30);
    expect(fired).toEqual(['a@15', 'b@30', 'c@30']);
    expect(clock.now()).toBe(40);
    expect(clock.wallNow()).toBe(5030);
  });

  it('cancels timers and runs intervals', () => {
    const clock = new FakeClock();
    const once = vi.fn();
    clock.setTimeout(once, 10).dispose();
    const tick = vi.fn();
    const interval = clock.setInterval(tick, 10);
    clock.advance(35);
    expect(tick).toHaveBeenCalledTimes(3);
    interval.dispose();
    clock.advance(100);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(once).not.toHaveBeenCalled();
    expect(clock.pendingTimers).toBe(0);
    expect(() => clock.setInterval(tick, 0)).toThrow(RangeError);
  });

  it('fires timers scheduled by timers within the same advance', () => {
    const clock = new FakeClock();
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now());
      clock.setTimeout(() => fired.push(clock.now()), 5);
    }, 5);
    clock.advance(20);
    expect(fired).toEqual([5, 10]);
  });

  it('skews wall time independently and refuses to go backwards', () => {
    const clock = new FakeClock({ wall: 1000 });
    clock.setWallTime(10);
    expect(clock.wallNow()).toBe(10);
    expect(clock.now()).toBe(0);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });
});

describe('SequentialIdSource', () => {
  it('produces deterministic v4-shaped uuids and seeded randoms', () => {
    const a = new SequentialIdSource(42);
    const b = new SequentialIdSource(42);
    expect(a.uuid()).toBe('00000000-0000-4000-8000-000000000001');
    expect(a.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const ra = [a.random(), a.random()];
    expect(ra).toEqual([b.random(), b.random()]);
    for (const r of ra) expect(r >= 0 && r < 1).toBe(true);
  });
});

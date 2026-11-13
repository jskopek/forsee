import {
  FakeClock,
  HybridLogicalClock,
  MemoryFileSystem,
  SequentialIdSource,
  type ProfileFileSystem,
} from '@forsee/core';
import type { HistoryRecord, TombstoneRecord, UtteranceRecord } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { FileStore } from './file-store';
import { HistoryLog, monthKey } from './history';

function setup() {
  const files = new MemoryFileSystem();
  const errors: string[] = [];
  const store = new FileStore(files, { reportError: (_e, ctx) => errors.push(ctx) });
  const history = new HistoryLog(store);
  const ids = new SequentialIdSource();
  return { files, store, history, ids, errors };
}

function utterance(
  ids: SequentialIdSource,
  device: string,
  wall: number,
  body: string,
  counter = 0,
): UtteranceRecord {
  const clock = new FakeClock({ wall });
  const hlc = new HybridLogicalClock(clock, device);
  let stamp = hlc.now();
  for (let i = 0; i < counter; i += 1) stamp = hlc.now();
  return {
    schemaVersion: 1,
    kind: 'utterance',
    id: ids.uuid(),
    deviceId: device,
    hlc: stamp,
    createdAt: wall,
    sender: 'user',
    body,
  };
}

function tombstone(
  ids: SequentialIdSource,
  device: string,
  wall: number,
  targetId: string,
): TombstoneRecord {
  const stamp = new HybridLogicalClock(new FakeClock({ wall }), device).now();
  return {
    schemaVersion: 1,
    kind: 'tombstone',
    id: ids.uuid(),
    deviceId: device,
    hlc: stamp,
    createdAt: wall,
    targetId,
  };
}

/** Counts files read through the file system. */
function countReads(files: MemoryFileSystem): { reads: string[] } {
  const reads: string[] = [];
  const original = files.readText.bind(files);
  files.readText = (path: string) => {
    reads.push(path);
    return original(path);
  };
  return { reads };
}

const NOV = Date.UTC(2026, 10, 15, 10);
const DEC = Date.UTC(2026, 11, 2, 10);

describe('monthKey', () => {
  it('uses UTC calendar months', () => {
    expect(monthKey(Date.UTC(2026, 0, 1))).toBe('2026-01');
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12');
    expect(monthKey(Date.UTC(2027, 0, 1))).toBe('2027-01');
  });
});

describe('HistoryLog', () => {
  it('appends as JSON lines, one file per month, across a month boundary', async () => {
    const { files, history, ids } = setup();
    const lastOfNov = utterance(ids, 'd1', Date.UTC(2026, 10, 30, 23, 59, 59, 999), 'end of Nov');
    const firstOfDec = utterance(ids, 'd1', Date.UTC(2026, 11, 1, 0, 0, 0, 0), 'start of Dec');
    await history.append([lastOfNov, firstOfDec]);
    expect((await files.list('history')).map((e) => e.name)).toEqual([
      '2026-11.jsonl',
      '2026-12.jsonl',
    ]);
    const novText = await files.readText('history/2026-11.jsonl');
    expect(novText.endsWith('\n')).toBe(true);
    expect(JSON.parse(novText.trim())).toEqual(lastOfNov);
    expect(await history.loadRecent(10)).toEqual([lastOfNov, firstOfDec]);
  });

  it('orders by hybrid logical clock across two devices, not by file order', async () => {
    const { history, ids } = setup();
    const a1 = utterance(ids, 'devA', NOV, 'a1');
    const b1 = utterance(ids, 'devB', NOV, 'b1'); // same ms: device id breaks the tie
    const a2 = utterance(ids, 'devA', NOV + 1000, 'a2');
    await history.append([a2, b1]);
    await history.append([a1]);
    expect((await history.loadRecent(10)).map((r) => (r as UtteranceRecord).body)).toEqual([
      'a1',
      'b1',
      'a2',
    ]);
    expect((await history.listRecent(2)).map((r) => r.body)).toEqual(['b1', 'a2']);
  });

  it('applies tombstones appended later without rewriting any file', async () => {
    const { files, history, ids } = setup();
    const a = utterance(ids, 'd', NOV, 'secret');
    const b = utterance(ids, 'd', NOV + 10, 'fine');
    await history.append([a, b]);
    const before = await files.readText('history/2026-11.jsonl');
    const t = tombstone(ids, 'd', DEC, a.id); // deleted a month later
    await history.append([t]);
    expect(await files.readText('history/2026-11.jsonl')).toBe(before);
    expect(await files.exists('history/2026-12.jsonl')).toBe(true);

    expect((await history.listRecent(10)).map((r) => r.body)).toEqual(['fine']);
    expect((await history.listRange(0, DEC + 1)).map((r) => (r as UtteranceRecord).body)).toEqual([
      'fine',
    ]);
    // The kernel still receives every kind and applies tombstones itself.
    const raw = await history.loadRecent(10);
    expect(raw.map((r) => r.kind)).toEqual(['utterance', 'utterance', 'tombstone']);
  });

  it('listRange is half-open on createdAt', async () => {
    const { history, ids } = setup();
    const records = [0, 1, 2].map((i) => utterance(ids, 'd', NOV + i * 1000, `r${i}`));
    await history.append(records);
    const bodies = async (from: number, to: number) =>
      (await history.listRange(from, to)).map((r) => (r as UtteranceRecord).body);
    expect(await bodies(NOV, NOV + 2000)).toEqual(['r0', 'r1']);
    expect(await bodies(NOV + 1000, NOV + 1001)).toEqual(['r1']);
    expect(await bodies(NOV + 5, NOV + 5)).toEqual([]);
  });

  it('skips and reports a truncated last line, and the next append starts a fresh line', async () => {
    const { files, history, ids, errors } = setup();
    const a = utterance(ids, 'd', NOV, 'one');
    await history.append([a]);
    // A crash mid-append: half a record, no newline.
    await files.appendText('history/2026-11.jsonl', '{"schemaVersion":1,"kind":"utter');

    const fresh = setup();
    await fresh.files.writeText(
      'history/2026-11.jsonl',
      await files.readText('history/2026-11.jsonl'),
    );
    expect(await fresh.history.loadRecent(10)).toEqual([a]);
    expect(fresh.errors).toEqual(['storage.log.corrupt:history/2026-11.jsonl']);

    const b = utterance(ids, 'd', NOV + 5, 'two');
    await fresh.history.append([b]);
    fresh.history.invalidate();
    expect(await fresh.history.loadRecent(10)).toEqual([a, b]);
    expect(errors).toEqual([]);
  });

  it('skips a corrupt line in the middle and unrecognised records, reporting each', async () => {
    const { files, history, ids, errors } = setup();
    const a = utterance(ids, 'd', NOV, 'a');
    const b = utterance(ids, 'd', NOV + 1, 'b');
    await files.writeText(
      'history/2026-11.jsonl',
      [
        JSON.stringify(a),
        'garbage',
        '',
        JSON.stringify({ schemaVersion: 1, kind: 'weird' }),
        JSON.stringify(b),
        '',
      ].join('\n'),
    );
    expect(await history.loadRecent(10)).toEqual([a, b]);
    expect(errors).toEqual([
      'storage.log.corrupt:history/2026-11.jsonl',
      'storage.history.invalid-record:history/2026-11.jsonl',
    ]);
  });

  it('drops duplicate ids, for example from a file-sync copy', async () => {
    const { files, history, ids } = setup();
    const a = utterance(ids, 'd', NOV, 'a');
    const line = JSON.stringify(a) + '\n';
    await files.writeText('history/2026-11.jsonl', line + line);
    expect(await history.loadRecent(10)).toEqual([a]);
  });

  it('listRecent and loadRecent read only as many months as needed', async () => {
    const { files, history, ids } = setup();
    const months = [0, 1, 2, 3, 4].map((m) => Date.UTC(2026, m, 10));
    for (const [i, wall] of months.entries()) {
      await history.append([
        utterance(ids, 'd', wall, `m${i}a`),
        utterance(ids, 'd', wall + 1, `m${i}b`),
      ]);
    }
    const reopened = new HistoryLog(new FileStore(files));
    const { reads } = countReads(files);
    expect((await reopened.listRecent(3)).map((r) => r.body)).toEqual(['m3b', 'm4a', 'm4b']);
    expect(reads).toEqual(['history/2026-05.jsonl', 'history/2026-04.jsonl']);

    reads.length = 0;
    const again = new HistoryLog(new FileStore(files));
    expect(await again.loadRecent(2)).toHaveLength(2);
    expect(reads).toEqual(['history/2026-05.jsonl']);
  });

  it('keeps reading older months while tombstones leave too few live utterances', async () => {
    const { files, history, ids } = setup();
    const old = utterance(ids, 'd', Date.UTC(2026, 0, 5), 'old');
    const mid = utterance(ids, 'd', Date.UTC(2026, 1, 5), 'mid');
    const gone = utterance(ids, 'd', Date.UTC(2026, 2, 5), 'gone');
    await history.append([old, mid, gone, tombstone(ids, 'd', Date.UTC(2026, 2, 6), gone.id)]);
    const reopened = new HistoryLog(new FileStore(files));
    expect((await reopened.listRecent(2)).map((r) => r.body)).toEqual(['old', 'mid']);
  });

  it('serves repeat reads from the cache until invalidated', async () => {
    const { files, history, ids } = setup();
    await history.append([utterance(ids, 'd', NOV, 'a')]);
    const reopened = new HistoryLog(new FileStore(files));
    const { reads } = countReads(files);
    await reopened.listRecent(5);
    await reopened.listRecent(5);
    expect(reads).toHaveLength(1);
    // Appends are visible at once without another read.
    await reopened.append([utterance(ids, 'd', NOV + 1, 'b')]);
    expect((await reopened.listRecent(5)).map((r) => r.body)).toEqual(['a', 'b']);
    expect(reads).toHaveLength(1);
    // An external change shows up after invalidation.
    await files.appendText(
      'history/2026-11.jsonl',
      JSON.stringify(utterance(ids, 'other', NOV + 2, 'c')) + '\n',
    );
    expect((await reopened.listRecent(5)).map((r) => r.body)).toEqual(['a', 'b']);
    reopened.invalidate();
    expect((await reopened.listRecent(5)).map((r) => r.body)).toEqual(['a', 'b', 'c']);
  });

  it('bounds the number of cached months', async () => {
    const { files, ids } = setup();
    const writer = new HistoryLog(new FileStore(files));
    for (let m = 0; m < 4; m += 1) {
      await writer.append([utterance(ids, 'd', Date.UTC(2026, m, 3), `m${m}`)]);
    }
    const reader = new HistoryLog(new FileStore(files), { maxCachedMonths: 2 });
    const { reads } = countReads(files);
    await reader.loadRecent(100); // reads all four, keeps two
    reads.length = 0;
    await reader.loadRecent(1); // newest month is cached
    expect(reads).toEqual([]);
  });

  it('rejects an invalid record before writing anything', async () => {
    const { files, history } = setup();
    await expect(
      history.append([{ kind: 'utterance' } as unknown as HistoryRecord]),
    ).rejects.toMatchObject({ code: 'invalid-document' });
    expect(await files.exists('history')).toBe(false);
  });

  it('invalidates the month if the write fails', async () => {
    const files = new MemoryFileSystem();
    const ids = new SequentialIdSource();
    const history = new HistoryLog(new FileStore(files));
    await history.append([utterance(ids, 'd', NOV, 'a')]);
    await history.loadRecent(1);
    const failing: ProfileFileSystem = files;
    const original = failing.appendText.bind(failing);
    failing.appendText = () => Promise.reject(new Error('disk full'));
    await expect(history.append([utterance(ids, 'd', NOV + 1, 'lost')])).rejects.toThrow(
      'disk full',
    );
    failing.appendText = original;
    expect((await history.listRecent(5)).map((r) => r.body)).toEqual(['a']);
  });

  it('returns nothing for a non-positive limit or an empty profile', async () => {
    const { history } = setup();
    expect(await history.loadRecent(0)).toEqual([]);
    expect(await history.listRecent(-1)).toEqual([]);
    expect(await history.loadRecent(5)).toEqual([]);
    expect(await history.listRange(0, 10)).toEqual([]);
  });
});

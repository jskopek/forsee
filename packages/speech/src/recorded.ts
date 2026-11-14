import { splitProfilePath } from '@forsee/core';
import type { SpeechEvents, SpeechHandle, Utterance, VoiceProvider } from '@forsee/plugin-api';
import type { AudioPlayer, RecordedMessageProviderFactory } from './contracts';
import { createSpeechSession } from './session';

/** Id of the recorded-message provider. */
export const RECORDED_MESSAGE_PROVIDER_ID = 'forsee.recorded';

const MIME_TYPES: Readonly<Record<string, string>> = {
  wav: 'audio/wav',
  wave: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

/** Audio MIME type from a file name's extension; the player may still sniff the bytes. */
export function mimeTypeOf(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && MIME_TYPES[extension]) ?? 'application/octet-stream';
}

/**
 * The recorded-message provider (`forsee.recorded`, message banking): plays
 * the audio file named by `Utterance.recording` (a profile-relative path such
 * as `phrases/audio/hello.wav`) instead of synthesising `text`.
 *
 * It offers no voices. A missing, unreadable, empty or unplayable recording
 * ends the utterance with `error` before `start`, which is the engine's cue
 * to fall back to synthesising the text. The player's volume is the
 * player's own; `rate`, `pitch` and `volume` of the utterance do not apply
 * to recordings.
 */
export const createRecordedMessageProvider: RecordedMessageProviderFactory = (options) =>
  new RecordedMessageProvider(options.readFile, options.player, options);

class RecordedMessageProvider implements VoiceProvider {
  readonly id: string;
  private active: SpeechHandle | undefined;

  constructor(
    private readonly readFile: (path: string) => Promise<Uint8Array>,
    private readonly player: AudioPlayer,
    private readonly options: Parameters<RecordedMessageProviderFactory>[0],
  ) {
    this.id = options.id ?? RECORDED_MESSAGE_PROVIDER_ID;
  }

  listVoices(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  stop(): void {
    this.active?.stop();
  }

  speak(utterance: Utterance, events: SpeechEvents): SpeechHandle {
    this.active?.stop();
    let playback: { stop(): void } | undefined;
    let cancelled = false;
    const session = createSpeechSession(utterance.id, events, this.options.clock, () => {
      cancelled = true;
      playback?.stop();
    });
    this.active = session.handle;
    const release = (): void => {
      if (this.active === session.handle) this.active = undefined;
    };
    void session.handle.done.then(release);

    const path = utterance.recording;
    if (path === undefined) {
      session.fail('The utterance has no recording');
      return session.handle;
    }
    try {
      splitProfilePath(path);
    } catch {
      session.fail(`Invalid recording path: ${path}`);
      return session.handle;
    }

    let reading: Promise<Uint8Array>;
    try {
      reading = this.readFile(path);
    } catch (error) {
      session.fail(messageOf(error));
      return session.handle;
    }
    reading.then(
      (bytes) => {
        if (cancelled || session.ended) return;
        if (bytes.length === 0) {
          session.fail(`The recording is empty: ${path}`);
          return;
        }
        try {
          const started = this.player.play(bytes, mimeTypeOf(path));
          playback = started;
          session.start();
          started.done.then(
            (reason) => session.end(reason),
            (error: unknown) => session.fail(messageOf(error)),
          );
        } catch (error) {
          session.fail(messageOf(error));
        }
      },
      (error: unknown) => session.fail(`Could not read the recording ${path}: ${messageOf(error)}`),
    );
    return session.handle;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

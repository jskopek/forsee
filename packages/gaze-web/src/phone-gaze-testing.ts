import type {
  PhoneGazeConnection,
  PhoneGazeConnector,
  PhoneGazeSocketHandlers,
} from './phone-gaze-source';

/** One connection the fake server accepted. */
export class FakePhoneGazeSocket implements PhoneGazeConnection {
  /** Messages the app sent, parsed. */
  readonly sent: unknown[] = [];
  open = false;
  closedByClient = false;
  closedByServer = false;

  constructor(
    readonly url: string,
    private readonly handlers: PhoneGazeSocketHandlers,
  ) {}

  send(text: string): boolean {
    if (!this.open || this.closedByClient || this.closedByServer) return false;
    this.sent.push(JSON.parse(text));
    return true;
  }

  close(): void {
    this.closedByClient = true;
    this.open = false;
  }

  get live(): boolean {
    return !this.closedByClient && !this.closedByServer;
  }

  /** The connection opens (no hello yet). */
  accept(): this {
    this.open = true;
    this.handlers.onOpen();
    return this;
  }

  /** Opens and sends the engine's hello. */
  acceptWithHello(
    screen: unknown = { width: 1512, height: 982, scale: 2 },
    version: unknown = 1,
  ): this {
    this.accept();
    return this.sendJson({ type: 'hello', version, screen });
  }

  sendJson(message: unknown): this {
    return this.sendRaw(JSON.stringify(message));
  }

  sendRaw(data: unknown): this {
    if (this.live) this.handlers.onMessage(data);
    return this;
  }

  /** One gaze sample (screen points, engine seconds). */
  gaze(x: number, y: number, t: number, extra: Record<string, unknown> = {}): this {
    return this.sendJson({ type: 'gaze', x, y, t, confidence: 0.9, valid: true, ...extra });
  }

  /** The server drops the connection (or refuses it, if never accepted). */
  drop(reason = ''): void {
    if (!this.live) return;
    this.closedByServer = true;
    this.open = false;
    this.handlers.onClose({ code: 1006, reason });
  }
}

/** A fake Phone Gaze engine: hands out `FakePhoneGazeSocket`s through `connector`. */
export class FakePhoneGazeServer {
  readonly sockets: FakePhoneGazeSocket[] = [];
  /** When set, the connector throws this instead of connecting. */
  throwOnConnect: Error | null = null;

  readonly connector: PhoneGazeConnector = (url, handlers) => {
    if (this.throwOnConnect) throw this.throwOnConnect;
    const socket = new FakePhoneGazeSocket(url, handlers);
    this.sockets.push(socket);
    return socket;
  };

  /** The most recent connection. */
  get last(): FakePhoneGazeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('No connection yet');
    return socket;
  }

  /** Connections the client has not closed and the server has not dropped. */
  get liveCount(): number {
    return this.sockets.filter((s) => s.live).length;
  }
}

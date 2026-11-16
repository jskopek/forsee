/* global fetch, WebSocket, window, performance */
// Engine API client: REST helpers and the UI WebSocket (docs/INTERFACES.md).

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Api {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.wsOpen = false;
    this.state = null;
    this.retryMs = 500;
  }

  async request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      throw new ApiError(`The engine did not answer (${err.message}). Is it running?`, 0);
    }
    let data;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      throw new ApiError((data && data.error) || `${res.status} ${res.statusText}`, res.status);
    }
    return data;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body = {}) {
    return this.request('POST', path, body);
  }

  /** Subscribe to WebSocket messages of `type` ("*" for all, "open"/"close" for connection). */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, msg) {
    for (const key of [type, '*']) {
      const set = this.handlers.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try {
          fn(msg);
        } catch (err) {
          window.console.error(`handler for ${type} failed`, err);
        }
      }
    }
  }

  connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.wsOpen = true;
      this.retryMs = 500;
      this.emit('open', {});
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if ((msg.type === 'hello' || msg.type === 'state') && msg.state) this.state = msg.state;
      this.emit(msg.type, msg);
    });
    ws.addEventListener('close', () => {
      const was = this.wsOpen;
      this.wsOpen = false;
      if (was) this.emit('close', {});
      window.setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(5000, this.retryMs * 2);
    });
    ws.addEventListener('error', () => {
      // 'close' follows and reconnects.
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Tell the engine where this window is (ui.screen). */
  sendScreen() {
    this.send({
      type: 'ui.screen',
      screen_x: window.screenX,
      screen_y: window.screenY,
      inner_width: window.innerWidth,
      inner_height: window.innerHeight,
      device_pixel_ratio: window.devicePixelRatio,
      fullscreen: Boolean(window.document.fullscreenElement),
    });
  }

  async refreshState() {
    this.state = await this.get('/api/state');
    this.emit('state', { type: 'state', state: this.state, local: true });
    return this.state;
  }

  now() {
    return performance.now();
  }
}

export const api = new Api();

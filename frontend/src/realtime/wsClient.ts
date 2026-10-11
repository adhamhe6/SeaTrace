import type { ConnectionState } from './liveStore';
import { parseServerMessage, type DataMessage } from './protocol';

/** The subset of the browser WebSocket API the client relies on (so tests can inject a fake). */
export interface WebSocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export interface LiveClientOptions {
  url: () => string;
  getToken: () => string | null;
  createSocket: SocketFactory;
  onMessage: (message: DataMessage) => void;
  onStateChange: (state: ConnectionState) => void;
  /** Cached REST state may be out of date: reload everything. */
  onResync: () => void;
  /** The server refused our credentials (close code 4401) or no token is available. */
  onUnauthorized: () => void;
  onServerTime?: (iso: string) => void;
  onFrame?: (at: number) => void;
  pingIntervalMs?: number;
  deadAfterMs?: number;
  handshakeTimeoutMs?: number;
  stableAfterMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  now?: () => number;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_TRY_AGAIN = 1013;

/**
 * Resilient client for the SeaTrace real-time channel:
 * hello -> auth(resume_from) -> ready -> sequenced messages, with ping, dead-connection detection,
 * exponential backoff with jitter and sequence-based resume/resync.
 */
export class LiveClient {
  private readonly o: Required<
    Pick<
      LiveClientOptions,
      | 'pingIntervalMs'
      | 'deadAfterMs'
      | 'handshakeTimeoutMs'
      | 'stableAfterMs'
      | 'backoffBaseMs'
      | 'backoffMaxMs'
      | 'random'
      | 'now'
    >
  > &
    LiveClientOptions;

  private ws: WebSocketLike | null = null;
  private stopped = true;
  private everOpened = false;
  private attempts = 0;
  private lastSeq: number | null = null;
  private forceResync = false;
  private state: ConnectionState = 'closed';
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private deadTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LiveClientOptions) {
    this.o = {
      pingIntervalMs: 20_000,
      deadAfterMs: 45_000,
      handshakeTimeoutMs: 10_000,
      stableAfterMs: 10_000,
      backoffBaseMs: 1000,
      backoffMaxMs: 30_000,
      random: Math.random,
      now: Date.now,
      ...options,
    };
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get resumeFrom(): number | null {
    return this.lastSeq;
  }

  get failedAttempts(): number {
    return this.attempts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detach(ws);
      try {
        ws.close(1000, 'client stopped');
      } catch {
        /* already closed */
      }
    }
    this.setState('closed');
  }

  /** Skip the pending backoff delay, e.g. when the browser regains network connectivity. */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.ws && this.state === 'open') return;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detach(ws);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.open();
  }

  /** Delay before reconnect attempt number `attempt` (0-based): 1s, 2s, 4s ... capped, with jitter. */
  backoffDelay(attempt: number): number {
    const base = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** attempt);
    const jitter = 0.8 + 0.4 * this.o.random();
    return Math.min(this.o.backoffMaxMs, Math.round(base * jitter));
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.o.onStateChange(next);
  }

  private open(): void {
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    let ws: WebSocketLike;
    try {
      ws = this.o.createSocket(this.o.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.armDeadTimer();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.handleFrame(ws, event.data);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleDisconnect(event.code);
    };
    ws.onerror = () => {
      /* a close event always follows; reconnect logic lives there */
    };
    this.armHandshakeTimer();
  }

  private handleFrame(ws: WebSocketLike, data: unknown): void {
    const at = this.o.now();
    this.armDeadTimer();
    this.o.onFrame?.(at);
    const message = parseServerMessage(data);
    if (!message) return;
    switch (message.type) {
      case 'hello': {
        this.o.onServerTime?.(message.server_time);
        const token = this.o.getToken();
        if (!token) {
          this.stop();
          this.o.onUnauthorized();
          return;
        }
        ws.send(JSON.stringify({ type: 'auth', token, resume_from: this.lastSeq }));
        this.armHandshakeTimer();
        return;
      }
      case 'ready': {
        clearTimeout(this.handshakeTimer);
        this.everOpened = true;
        this.setState('open');
        if (message.resync_required || this.forceResync) {
          this.forceResync = false;
          this.lastSeq = message.seq;
          this.o.onResync();
        } else {
          this.lastSeq ??= message.seq;
        }
        clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
          this.attempts = 0;
        }, this.o.stableAfterMs);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.ws === ws && ws.readyState === WS_OPEN)
            ws.send(JSON.stringify({ type: 'ping' }));
        }, this.o.pingIntervalMs);
        return;
      }
      case 'heartbeat':
        this.o.onServerTime?.(message.server_time);
        return;
      case 'pong':
        if (message.server_time) this.o.onServerTime?.(message.server_time);
        return;
      default: {
        if (this.lastSeq !== null && message.seq <= this.lastSeq) return; // duplicate or replayed twice
        this.lastSeq = message.seq;
        this.o.onMessage(message);
      }
    }
  }

  private handleDisconnect(code: number): void {
    this.clearTimers();
    if (this.stopped) return;
    if (code === CLOSE_UNAUTHORIZED) {
      this.stopped = true;
      this.setState('closed');
      this.o.onUnauthorized();
      return;
    }
    if (code === CLOSE_TRY_AGAIN) {
      // The server dropped us because we were too slow or it is busy: events were lost.
      this.forceResync = true;
      this.lastSeq = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.backoffDelay(this.attempts);
    this.attempts += 1;
    this.setState('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) this.open();
    }, delay);
  }

  private armDeadTimer(): void {
    clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      this.dropConnection();
    }, this.o.deadAfterMs);
  }

  private armHandshakeTimer(): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      this.dropConnection();
    }, this.o.handshakeTimeoutMs);
  }

  /** Treat the connection as dead without waiting for the browser to notice. */
  private dropConnection(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.detach(ws);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.handleDisconnect(0);
  }

  private detach(ws: WebSocketLike): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  private clearTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.deadTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.retryTimer);
    this.pingTimer = undefined;
    this.deadTimer = undefined;
    this.handshakeTimer = undefined;
    this.stableTimer = undefined;
    this.retryTimer = undefined;
  }
}

export function defaultSocketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/v1/ws`;
}

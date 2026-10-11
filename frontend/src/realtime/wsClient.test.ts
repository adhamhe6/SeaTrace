import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from './liveStore';
import type { DataMessage } from './protocol';
import { LiveClient, type WebSocketLike } from './wsClient';

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const hello = {
  type: 'hello',
  protocol: 1,
  auth_timeout_s: 5,
  server_time: '2026-03-01T10:00:00Z',
};
const ready = (seq: number, resync = false) => ({
  type: 'ready',
  seq,
  resync_required: resync,
  user: { username: 'operator', role: 'operator' },
});
const telemetry = (seq: number): DataMessage => ({
  seq,
  type: 'telemetry',
  ts: '2026-03-01T10:00:00Z',
  data: { items: [] },
});

interface Harness {
  client: LiveClient;
  states: ConnectionState[];
  messages: DataMessage[];
  resync: ReturnType<typeof vi.fn>;
  unauthorized: ReturnType<typeof vi.fn>;
  token: { value: string | null };
}

function setup(): Harness {
  FakeWs.all = [];
  const states: ConnectionState[] = [];
  const messages: DataMessage[] = [];
  const resync = vi.fn();
  const unauthorized = vi.fn();
  const token = { value: 'jwt-1' as string | null };
  const client = new LiveClient({
    url: () => 'ws://host/api/v1/ws',
    getToken: () => token.value,
    createSocket: (url) => new FakeWs(url),
    onMessage: (m) => messages.push(m),
    onStateChange: (s) => states.push(s),
    onResync: resync,
    onUnauthorized: unauthorized,
    random: () => 0.5, // jitter factor 1.0
  });
  return { client, states, messages, resync, unauthorized, token };
}

const current = () => FakeWs.all[FakeWs.all.length - 1]!;

/** Complete the handshake for the latest socket. */
function handshake(seq = 10, resync = false) {
  const ws = current();
  ws.serverOpen();
  ws.serverSend(hello);
  ws.serverSend(ready(seq, resync));
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LiveClient handshake', () => {
  it('waits for hello, authenticates with the token and resume_from, then reports open', () => {
    const h = setup();
    h.client.start();
    expect(h.states).toEqual(['connecting']);
    const ws = current();
    expect(ws.url).toBe('ws://host/api/v1/ws');
    ws.serverOpen();
    expect(ws.sent).toEqual([]); // nothing is sent before hello
    ws.serverSend(hello);
    expect(ws.sent).toEqual([{ type: 'auth', token: 'jwt-1', resume_from: null }]);
    ws.serverSend(ready(10));
    expect(h.states).toEqual(['connecting', 'open']);
    expect(h.client.resumeFrom).toBe(10);
    expect(h.resync).not.toHaveBeenCalled();
  });

  it('dispatches sequenced messages once and ignores duplicates', () => {
    const h = setup();
    h.client.start();
    const ws = handshake(10);
    ws.serverSend(telemetry(11));
    ws.serverSend(telemetry(11));
    ws.serverSend(telemetry(10));
    ws.serverSend(telemetry(12));
    expect(h.messages.map((m) => m.seq)).toEqual([11, 12]);
    expect(h.client.resumeFrom).toBe(12);
  });

  it('ignores malformed frames', () => {
    const h = setup();
    h.client.start();
    const ws = handshake();
    ws.onmessage?.({ data: 'not json' });
    ws.serverSend({ type: 'mystery' });
    ws.serverSend({ type: 'telemetry', seq: 'x' });
    expect(h.messages).toEqual([]);
    expect(h.states.at(-1)).toBe('open');
  });

  it('stops and signs out when there is no token', () => {
    const h = setup();
    h.token.value = null;
    h.client.start();
    const ws = current();
    ws.serverOpen();
    ws.serverSend(hello);
    expect(h.unauthorized).toHaveBeenCalledTimes(1);
    expect(h.client.connectionState).toBe('closed');
  });
});

describe('reconnect, resume and resync', () => {
  it('reconnects with exponential backoff capped at 30 s', () => {
    const h = setup();
    h.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const before = FakeWs.all.length;
      current().serverClose(1006);
      expect(h.client.connectionState).toBe('reconnecting');
      // find the delay by stepping time until a new socket appears
      let waited = 0;
      while (FakeWs.all.length === before && waited < 40_000) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('applies jitter within +-20% of the base delay', () => {
    const make = (random: () => number) =>
      new LiveClient({
        url: () => '',
        getToken: () => 't',
        createSocket: (u) => new FakeWs(u),
        onMessage: () => undefined,
        onStateChange: () => undefined,
        onResync: () => undefined,
        onUnauthorized: () => undefined,
        random,
      });
    expect(make(() => 0).backoffDelay(2)).toBe(3200);
    expect(make(() => 1).backoffDelay(2)).toBe(4800);
    expect(make(() => 1).backoffDelay(10)).toBe(30000);
  });

  it('resumes from the last seen seq and does not resync when the server can replay', () => {
    const h = setup();
    h.client.start();
    const first = handshake(10);
    first.serverSend(telemetry(11));
    first.serverSend(telemetry(12));
    first.serverClose(1006);
    vi.advanceTimersByTime(1000);
    const second = current();
    expect(second).not.toBe(first);
    second.serverOpen();
    second.serverSend(hello);
    expect(second.sent).toEqual([{ type: 'auth', token: 'jwt-1', resume_from: 12 }]);
    second.serverSend(ready(14, false));
    second.serverSend(telemetry(13)); // backlog replay
    second.serverSend(telemetry(14));
    expect(h.resync).not.toHaveBeenCalled();
    expect(h.messages.map((m) => m.seq)).toEqual([11, 12, 13, 14]);
  });

  it('asks for a full resync when the server says resync_required', () => {
    const h = setup();
    h.client.start();
    const first = handshake(10);
    first.serverSend(telemetry(11));
    first.serverClose(1006);
    vi.advanceTimersByTime(1000);
    const second = current();
    second.serverOpen();
    second.serverSend(hello);
    second.serverSend(ready(3, true)); // server restarted: sequence numbers restarted
    expect(h.resync).toHaveBeenCalledTimes(1);
    expect(h.client.resumeFrom).toBe(3);
    second.serverSend(telemetry(4));
    expect(h.messages.at(-1)?.seq).toBe(4);
  });

  it('close code 1013 reconnects without resume_from and forces a resync', () => {
    const h = setup();
    h.client.start();
    const first = handshake(10);
    first.serverSend(telemetry(11));
    first.serverClose(1013);
    vi.advanceTimersByTime(1000);
    const second = current();
    second.serverOpen();
    second.serverSend(hello);
    expect(second.sent[0]).toEqual({ type: 'auth', token: 'jwt-1', resume_from: null });
    second.serverSend(ready(50, false));
    expect(h.resync).toHaveBeenCalledTimes(1);
    expect(h.client.resumeFrom).toBe(50);
  });

  it('close code 4401 signs out and does not reconnect', () => {
    const h = setup();
    h.client.start();
    const ws = handshake();
    ws.serverClose(4401);
    expect(h.unauthorized).toHaveBeenCalledTimes(1);
    expect(h.client.connectionState).toBe('closed');
    const count = FakeWs.all.length;
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.all.length).toBe(count);
  });

  it('keeps the backoff growing when connections do not stay up, and resets it once stable', () => {
    const h = setup();
    h.client.start();
    handshake();
    current().serverClose(1006); // dropped immediately: attempt 1
    vi.advanceTimersByTime(1000);
    handshake();
    current().serverClose(1006); // still unstable: attempt 2 uses 2 s
    expect(h.client.failedAttempts).toBe(2);
    vi.advanceTimersByTime(2000);
    handshake();
    vi.advanceTimersByTime(10_001); // stays up long enough
    expect(h.client.failedAttempts).toBe(0);
    current().serverClose(1006);
    const before = FakeWs.all.length;
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(before + 1); // back to a 1 s delay
  });

  it('reconnectNow skips the backoff delay', () => {
    const h = setup();
    h.client.start();
    handshake();
    current().serverClose(1006);
    const before = FakeWs.all.length;
    h.client.reconnectNow();
    expect(FakeWs.all.length).toBe(before + 1);
  });

  it('stop() closes the socket and prevents reconnects', () => {
    const h = setup();
    h.client.start();
    const ws = handshake();
    h.client.stop();
    expect(ws.closedWith).toBe(1000);
    expect(h.client.connectionState).toBe('closed');
    const count = FakeWs.all.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all.length).toBe(count);
  });
});

describe('liveness', () => {
  it('pings every 20 s while open', () => {
    const h = setup();
    h.client.start();
    const ws = handshake();
    ws.sent.length = 0;
    vi.advanceTimersByTime(20_000);
    expect(ws.sent).toEqual([{ type: 'ping' }]);
    ws.serverSend({ type: 'pong' });
    vi.advanceTimersByTime(20_000);
    expect(ws.sent).toHaveLength(2);
  });

  it('treats 45 s of silence as a dead connection and reconnects', () => {
    const h = setup();
    h.client.start();
    const ws = handshake();
    vi.advanceTimersByTime(44_000);
    expect(h.client.connectionState).toBe('open');
    ws.serverSend({ type: 'heartbeat', seq: 10, server_time: '2026-03-01T10:00:44Z' });
    vi.advanceTimersByTime(44_000); // heartbeat reset the watchdog
    expect(h.client.connectionState).toBe('open');
    vi.advanceTimersByTime(2000);
    expect(h.client.connectionState).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all.length).toBe(2);
  });

  it('gives up on a handshake that never completes', () => {
    const h = setup();
    h.client.start();
    current().serverOpen(); // no hello ever arrives
    vi.advanceTimersByTime(10_001);
    expect(h.client.connectionState).toBe('reconnecting');
  });

  it('forwards server time from hello, heartbeat and pong', () => {
    const times: string[] = [];
    FakeWs.all = [];
    const client = new LiveClient({
      url: () => 'ws://x',
      getToken: () => 't',
      createSocket: (u) => new FakeWs(u),
      onMessage: () => undefined,
      onStateChange: () => undefined,
      onResync: () => undefined,
      onUnauthorized: () => undefined,
      onServerTime: (iso) => times.push(iso),
    });
    client.start();
    const ws = handshake();
    ws.serverSend({ type: 'heartbeat', seq: 10, server_time: 'H' });
    ws.serverSend({ type: 'pong', server_time: 'P' });
    expect(times).toEqual(['2026-03-01T10:00:00Z', 'H', 'P']);
  });
});

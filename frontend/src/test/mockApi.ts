import { vi } from 'vitest';
import {
  makeAlarm,
  makeFleetSummary,
  makeScenario,
  makeSimStatus,
  makeSystemStatus,
  makeVessel,
  makeVesselSummary,
} from './fixtures';

export type Handler = (request: { url: URL; method: string; body: unknown }) => unknown;

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message, request_id: 'req-test' } }, status);
}

/** Routes keyed "METHOD /api/v1/path" (no query). Unmatched calls fail loudly. */
export type Routes = Record<string, Handler>;

export function defaultRoutes(): Routes {
  return {
    'GET /api/v1/system/status': () => makeSystemStatus(),
    'GET /api/v1/fleet/summary': () => makeFleetSummary(),
    'GET /api/v1/vessels': () => [
      makeVesselSummary(),
      makeVesselSummary({ id: 2, code: 'VES-002', name: 'MV Baltic Meridian' }),
    ],
    'GET /api/v1/vessels/VES-001': () => makeVessel(),
    'GET /api/v1/vessels/VES-002': () =>
      makeVessel({ code: 'VES-002', name: 'MV Baltic Meridian' }),
    'GET /api/v1/events/recent': () => [],
    'GET /api/v1/alarms': () => ({ items: [makeAlarm()], total: 1, limit: 25, offset: 0 }),
    'GET /api/v1/simulator/status': () => makeSimStatus(),
    'GET /api/v1/simulator/scenarios': () => [makeScenario()],
    'GET /api/v1/simulator/events': () => [],
  };
}

export interface MockApi {
  calls: RecordedCall[];
  callsTo: (method: string, path: string) => RecordedCall[];
  lastCall: (method: string, path: string) => RecordedCall | undefined;
}

/** Installs a fetch stub backed by `routes` (merged over the defaults). Test-only. */
export function installApi(overrides: Routes = {}): MockApi {
  const routes = { ...defaultRoutes(), ...overrides };
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      headers: new Headers(init?.headers),
    });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      return Promise.resolve(apiError(404, 'not_found', `No mock for ${method} ${url.pathname}`));
    }
    // Handlers may return a Response, plain JSON, or a promise of either (pending / rejected for network errors).
    return Promise.resolve(handler({ url, method, body })).then((result) =>
      result instanceof Response ? result : json(result),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    callsTo: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    lastCall: (method, path) => calls.filter((c) => c.method === method && c.path === path).at(-1),
  };
}

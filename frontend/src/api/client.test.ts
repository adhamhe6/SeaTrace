import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/auth/authStore';
import { makeToken } from '@/test/fixtures';
import { apiError, installApi, json } from '@/test/mockApi';
import { ApiError, api, buildQuery, isApiError } from './client';
import { describeError } from '@/lib/errors';

afterEach(() => {
  vi.useRealTimers();
});

describe('buildQuery', () => {
  it('repeats array params and skips empty values', () => {
    const q = buildQuery({ severity: ['critical', 'warning'], vessel: '', limit: 25, open: true, x: undefined, y: null });
    expect(q).toBe('?severity=critical&severity=warning&limit=25&open=true');
  });
  it('returns an empty string without params', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({})).toBe('');
  });
});

describe('request', () => {
  it('sends the bearer token and parses JSON', async () => {
    useAuth.getState().signIn(makeToken('operator'));
    const mock = installApi({ 'GET /api/v1/ping': () => ({ ok: true }) });
    await expect(api.get('/ping')).resolves.toEqual({ ok: true });
    expect(mock.calls[0]?.headers.get('Authorization')).toBe('Bearer token-operator');
  });

  it('serialises POST bodies as JSON', async () => {
    const mock = installApi({ 'POST /api/v1/echo': ({ body }) => body });
    await api.post('/echo', { a: 1 });
    expect(mock.calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(mock.calls[0]?.body).toEqual({ a: 1 });
  });

  it('maps the backend error envelope onto ApiError', async () => {
    installApi({
      'GET /api/v1/boom': () =>
        json({ error: { code: 'window_too_large', message: 'too big', details: [{ loc: ['query'] }], request_id: 'abc' } }, 422),
    });
    const error = await api.get('/boom').catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    const e = error as ApiError;
    expect(e).toMatchObject({ status: 422, code: 'window_too_large', message: 'too big', requestId: 'abc' });
    expect(e.details).toEqual([{ loc: ['query'] }]);
    expect(e.isNetwork).toBe(false);
  });

  it('falls back gracefully for non-JSON error bodies', async () => {
    installApi({ 'GET /api/v1/gw': () => new Response('<html>Bad gateway</html>', { status: 502 }) });
    const e = (await api.get('/gw').catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ status: 502, code: 'http_error' });
    expect(e.message).toMatch(/unavailable/i);
  });

  it('reports invalid JSON in a success response', async () => {
    installApi({ 'GET /api/v1/bad': () => new Response('not json', { status: 200 }) });
    await expect(api.get('/bad')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns network failures into a status-0 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const e = (await api.get('/x').catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ status: 0, code: 'network_error' });
    expect(e.isNetwork).toBe(true);
  });

  it('aborts after the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const pending = api.get('/slow', { timeoutMs: 1000 }).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('rethrows caller aborts untouched', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_r, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })),
    );
    const pending = api.get('/x', { signal: controller.signal }).catch((x: unknown) => x);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('signs the user out on 401 but not for the login call', async () => {
    useAuth.getState().signIn(makeToken('operator'));
    installApi({
      'GET /api/v1/secret': () => apiError(401, 'unauthorized', 'Invalid or expired token'),
      'POST /api/v1/auth/login': () => apiError(401, 'invalid_credentials', 'Invalid username or password'),
    });
    await expect(api.get('/secret')).rejects.toMatchObject({ status: 401 });
    expect(useAuth.getState().token).toBeNull();
    expect(useAuth.getState().notice).toMatch(/expired/i);

    useAuth.getState().signIn(makeToken('viewer'));
    await expect(api.post('/auth/login', {}, { skipAuthHandling: true })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(useAuth.getState().token).toBe('token-viewer');
  });
});

describe('describeError', () => {
  it('adds hints for known codes and statuses', () => {
    expect(describeError(new ApiError({ status: 422, code: 'window_too_large', message: 'm' })).hint).toMatch(/shorter/i);
    expect(describeError(new ApiError({ status: 0, code: 'network_error', message: 'm' })).title).toMatch(/unreachable/i);
    expect(describeError(new ApiError({ status: 403, code: 'forbidden', message: 'm' })).hint).toMatch(/operator/i);
    expect(describeError(new ApiError({ status: 503, code: 'database_unavailable', message: 'm' })).title).toMatch(/database/i);
    expect(describeError(new ApiError({ status: 500, code: 'internal_error', message: 'm', requestId: 'r1' })).requestId).toBe('r1');
  });
  it('handles non-API errors', () => {
    expect(describeError(new Error('plain')).message).toBe('plain');
    expect(describeError('weird').title).toMatch(/wrong/i);
  });
});

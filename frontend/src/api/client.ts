/**
 * Centralised REST client: relative same-origin URLs, bearer token, typed errors, timeouts.
 * The backend error envelope is `{ error: { code, message, details, request_id } }`.
 */

export interface ErrorDetail {
  loc?: string[];
  message?: string;
  type?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[] | null;
  readonly requestId: string | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: ErrorDetail[] | null;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? null;
    this.requestId = init.requestId ?? null;
  }

  /** True when no HTTP response was received (offline, proxy down, timeout). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Do not trigger the global 401 handler (used by the login call). */
  skipAuthHandling?: boolean;
}

interface ApiConfig {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized: (error: ApiError) => void;
  defaultTimeoutMs: number;
}

const config: ApiConfig = {
  baseUrl: '/api/v1',
  getToken: () => null,
  onUnauthorized: () => undefined,
  defaultTimeoutMs: 15_000,
};

export function configureApi(partial: Partial<ApiConfig>): void {
  Object.assign(config, partial);
}

export function buildQuery(query: QueryParams | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values: readonly QueryValue[] = Array.isArray(raw)
      ? (raw as QueryValue[])
      : [raw as QueryValue];
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseErrorBody(status: number, text: string, headerRequestId: string | null): ApiError {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed) && isRecord(parsed.error)) {
    const err = parsed.error;
    return new ApiError({
      status,
      code: typeof err.code === 'string' ? err.code : 'http_error',
      message: typeof err.message === 'string' ? err.message : `Request failed (${status})`,
      details: Array.isArray(err.details) ? (err.details as ErrorDetail[]) : null,
      requestId: typeof err.request_id === 'string' ? err.request_id : headerRequestId,
    });
  }
  const fallbackMessage =
    status === 502 || status === 503 || status === 504
      ? 'The service is temporarily unavailable'
      : `Request failed (${status})`;
  return new ApiError({
    status,
    code: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'http_error',
    message: fallbackMessage,
    requestId: headerRequestId,
  });
}

export async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = `${config.baseUrl}${path}${buildQuery(options.query)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = config.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
  const flags = { timedOut: false };
  const timer = setTimeout(() => {
    flags.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => {
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (cause) {
    if (flags.timedOut) {
      throw new ApiError({
        status: 0,
        code: 'timeout',
        message: `The server did not respond within ${Math.round(timeoutMs / 1000)} s`,
      });
    }
    if (options.signal?.aborted) throw cause;
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Cannot reach the server. Check your connection and try again.',
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const requestId = response.headers.get('X-Request-ID');
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'The connection was interrupted while reading the response.',
    });
  }

  if (!response.ok) {
    const error = parseErrorBody(response.status, text, requestId);
    if (response.status === 401 && !options.skipAuthHandling) config.onUnauthorized(error);
    throw error;
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'invalid_response',
      message: 'The server returned a response that could not be read.',
      requestId,
    });
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
};

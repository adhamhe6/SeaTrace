import { ApiError } from '@/api/client';

export interface ErrorInfo {
  title: string;
  message: string;
  hint?: string;
  requestId?: string;
  code: string;
}

/** Human-readable description of any thrown value, with remediation hints for known backend codes. */
export function describeError(error: unknown): ErrorInfo {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Something went wrong',
      message: error instanceof Error ? error.message : 'An unexpected error occurred.',
      code: 'unknown',
    };
  }
  const base = {
    message: error.message,
    code: error.code,
    requestId: error.requestId ?? undefined,
  };
  switch (error.code) {
    case 'network_error':
      return {
        ...base,
        title: 'Server unreachable',
        hint: 'Check your network connection and that the SeaTrace backend is running, then retry.',
      };
    case 'timeout':
      return {
        ...base,
        title: 'The request timed out',
        hint: 'The server is slow to respond. Retry in a moment.',
      };
    case 'window_too_large':
      return {
        ...base,
        title: 'Replay window too large',
        hint: 'Select a shorter time range, or step through the incident in consecutive windows.',
      };
    case 'invalid_range':
      return {
        ...base,
        title: 'Invalid time range',
        hint: 'The start time must be earlier than the end time.',
      };
    case 'too_many_attempts':
      return {
        ...base,
        title: 'Too many attempts',
        hint: 'Wait a minute before signing in again.',
      };
    case 'simulator_unavailable':
      return {
        ...base,
        title: 'Simulator unavailable',
        hint: 'The backend cannot reach the simulator over OPC UA. Make sure the simulator is running and connected.',
      };
    case 'database_unavailable':
      return {
        ...base,
        title: 'Database unavailable',
        hint: 'The backend cannot reach its database. Try again shortly.',
      };
    default:
      break;
  }
  switch (error.status) {
    case 401:
      return { ...base, title: 'Session expired', hint: 'Sign in again to continue.' };
    case 403:
      return {
        ...base,
        title: 'Not permitted',
        hint: 'Your role does not allow this action. Operator role required.',
      };
    case 404:
      return { ...base, title: 'Not found' };
    case 422:
      return { ...base, title: 'Request rejected' };
    case 502:
    case 503:
    case 504:
      return {
        ...base,
        title: 'Service unavailable',
        hint: 'The backend is temporarily unavailable. Retry shortly.',
      };
    default:
      return { ...base, title: 'Request failed' };
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

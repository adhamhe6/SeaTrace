import { QueryClient } from '@tanstack/react-query';
import { ApiError, configureApi } from '@/api/client';
import { useAuth } from '@/auth/authStore';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 2000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/** Wires the REST client to the auth store: bearer token out, 401 -> sign out (the route guard redirects). */
export function bootstrapApi(): void {
  configureApi({
    getToken: () => useAuth.getState().token,
    onUnauthorized: () => {
      if (useAuth.getState().token) {
        useAuth.getState().signOut('Your session has expired. Please sign in again.');
      }
    },
  });
}

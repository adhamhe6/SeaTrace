import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './authStore';

/** Only same-origin absolute paths are accepted as post-login targets (prevents open redirects). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next === '/login' || next.startsWith('/login?')) return '/';
  return next;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuth((s) => s.token);
  const location = useLocation();
  if (!token) {
    const target = `${location.pathname}${location.search}`;
    const search = target === '/' ? '' : `?next=${encodeURIComponent(target)}`;
    return <Navigate to={`/login${search}`} replace />;
  }
  return <>{children}</>;
}

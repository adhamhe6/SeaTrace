import { create } from 'zustand';
import type { Role, TokenResponse, UserOut } from '@/api/types';
import { safeStorage } from '@/lib/storage';

/**
 * The bearer token lives in sessionStorage: it survives reloads of the tab but not a new browser session,
 * and is never written to localStorage. Trade-off: any XSS could read it (see docs/frontend.md).
 */
const STORAGE_KEY = 'seatrace.auth';
const storage = safeStorage('sessionStorage');

interface StoredSession {
  token: string;
  user: UserOut;
  expiresAt: string;
}

interface AuthState {
  token: string | null;
  user: UserOut | null;
  expiresAt: string | null;
  /** Message shown on the login page after an involuntary sign-out. */
  notice: string | null;
  signIn: (response: TokenResponse) => void;
  signOut: (notice?: string | null) => void;
}

function readStored(): StoredSession | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!parsed?.token || !parsed.user || !parsed.expiresAt) return null;
    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return { token: parsed.token, user: parsed.user, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

const initial = readStored();

export const useAuth = create<AuthState>()((set) => ({
  token: initial?.token ?? null,
  user: initial?.user ?? null,
  expiresAt: initial?.expiresAt ?? null,
  notice: null,
  signIn: (response) => {
    const session: StoredSession = {
      token: response.access_token,
      user: response.user,
      expiresAt: response.expires_at,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
    set({ ...session, notice: null });
  },
  signOut: (notice = null) => {
    storage.removeItem(STORAGE_KEY);
    set({ token: null, user: null, expiresAt: null, notice });
  },
}));

export function useRole(): Role | null {
  return useAuth((s) => s.user?.role ?? null);
}

export function useIsOperator(): boolean {
  return useAuth((s) => s.user?.role === 'operator');
}

export const OPERATOR_REQUIRED = 'Operator role required';

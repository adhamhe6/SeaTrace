import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeToken } from '@/test/fixtures';

beforeEach(() => {
  vi.resetModules();
  window.sessionStorage.clear();
});

async function loadStore() {
  return import('./authStore');
}

describe('authStore session persistence (sessionStorage)', () => {
  it('restores a valid session after a reload', async () => {
    const token = makeToken('operator');
    window.sessionStorage.setItem(
      'seatrace.auth',
      JSON.stringify({ token: token.access_token, user: token.user, expiresAt: token.expires_at }),
    );
    const { useAuth } = await loadStore();
    expect(useAuth.getState()).toMatchObject({
      token: 'token-operator',
      user: { role: 'operator' },
    });
  });

  it('drops expired or corrupt sessions', async () => {
    window.sessionStorage.setItem(
      'seatrace.auth',
      JSON.stringify({
        token: 't',
        user: { id: 1, username: 'x', role: 'viewer' },
        expiresAt: '2000-01-01T00:00:00Z',
      }),
    );
    expect((await loadStore()).useAuth.getState().token).toBeNull();
    expect(window.sessionStorage.getItem('seatrace.auth')).toBeNull();

    vi.resetModules();
    window.sessionStorage.setItem('seatrace.auth', '{not json');
    expect((await loadStore()).useAuth.getState().token).toBeNull();
  });

  it('signIn stores and signOut clears, with an optional notice', async () => {
    const { useAuth } = await loadStore();
    useAuth.getState().signIn(makeToken('viewer'));
    expect(window.sessionStorage.getItem('seatrace.auth')).toContain('token-viewer');
    useAuth.getState().signOut('Bye');
    expect(window.sessionStorage.getItem('seatrace.auth')).toBeNull();
    expect(useAuth.getState().notice).toBe('Bye');
  });

  it('keeps working when sessionStorage throws (private mode)', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { useAuth } = await loadStore();
    expect(() => {
      useAuth.getState().signIn(makeToken('viewer'));
    }).not.toThrow();
    expect(useAuth.getState().token).toBe('token-viewer');
    spy.mockRestore();
  });
});

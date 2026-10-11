import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeToken } from '@/test/fixtures';
import { apiError, installApi, json } from '@/test/mockApi';
import { renderApp } from '@/test/render';
import { useAuth } from './authStore';
import { loginErrorMessage } from './LoginPage';
import { safeNextPath } from './RequireAuth';
import { ApiError } from '@/api/client';

async function signInAs(user: ReturnType<typeof userEvent.setup>, name: string, password: string) {
  await user.type(screen.getByLabelText('Username'), name);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('route guard', () => {
  it('redirects unauthenticated visitors to /login and keeps the intended route', async () => {
    installApi();
    renderApp({ route: '/alarms?severity=critical', role: null });
    expect(await screen.findByRole('heading', { name: 'SeaTrace' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('returns to the intended route after signing in', async () => {
    const api = installApi({ 'POST /api/v1/auth/login': () => makeToken('operator') });
    const user = userEvent.setup();
    renderApp({ route: '/alarms?severity=critical', role: null });
    await signInAs(user, 'operator', 'secret');
    expect(await screen.findByRole('heading', { name: 'Alarm center' })).toBeInTheDocument();
    expect(api.lastCall('GET', '/api/v1/alarms')?.query.getAll('severity')).toEqual(['critical']);
    expect(api.lastCall('POST', '/api/v1/auth/login')?.body).toEqual({
      username: 'operator',
      password: 'secret',
    });
  });

  it('sends a signed-in user away from /login', async () => {
    installApi();
    renderApp({ route: '/login' });
    expect(await screen.findByRole('heading', { name: 'Fleet overview' })).toBeInTheDocument();
  });

  it('only accepts same-origin paths as post-login targets', () => {
    expect(safeNextPath('/alarms/7')).toBe('/alarms/7');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
  });
});

describe('login form', () => {
  it('has no hardcoded credentials and explains that accounts come from the environment', () => {
    installApi();
    renderApp({ route: '/login', role: null });
    expect(screen.getByLabelText('Username')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByText(/configured through environment variables/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('shows an error for invalid credentials and stays on the page', async () => {
    installApi({
      'POST /api/v1/auth/login': () =>
        apiError(401, 'invalid_credentials', 'Invalid username or password'),
    });
    const user = userEvent.setup();
    renderApp({ route: '/login', role: null });
    await signInAs(user, 'operator', 'wrong');
    expect(await screen.findByText('Invalid username or password.')).toBeInTheDocument();
    expect(useAuth.getState().token).toBeNull();
    expect(screen.getByLabelText('Username')).toBeEnabled();
  });

  it('explains throttling (429)', async () => {
    installApi({ 'POST /api/v1/auth/login': () => apiError(429, 'too_many_attempts', 'Too many') });
    const user = userEvent.setup();
    renderApp({ route: '/login', role: null });
    await signInAs(user, 'a', 'b');
    expect(await screen.findByText(/too many failed sign-in attempts/i)).toBeInTheDocument();
  });

  it('explains an unreachable server', async () => {
    installApi({ 'POST /api/v1/auth/login': () => Promise.reject(new TypeError('fail')) });
    const user = userEvent.setup();
    renderApp({ route: '/login', role: null });
    await signInAs(user, 'a', 'b');
    expect(await screen.findByText(/cannot reach the server/i)).toBeInTheDocument();
  });

  it('disables the form while the request is pending (no double submit)', async () => {
    let calls = 0;
    let release: (r: Response) => void = () => undefined;
    installApi({
      'POST /api/v1/auth/login': () => {
        calls += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    });
    const user = userEvent.setup();
    renderApp({ route: '/login', role: null });
    await signInAs(user, 'operator', 'pw');
    const button = screen.getByRole('button', { name: /signing in/i });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Username')).toBeDisabled();
    await user.click(button);
    expect(calls).toBe(1);
    release(json(makeToken('operator')));
    await waitFor(() => {
      expect(useAuth.getState().token).toBe('token-operator');
    });
  });

  it('maps errors to messages', () => {
    expect(
      loginErrorMessage(new ApiError({ status: 500, code: 'internal_error', message: 'x' })),
    ).toMatch(/not available/);
    expect(loginErrorMessage(new Error('x'))).toMatch(/failed/);
  });
});

describe('session handling', () => {
  it('stores the token in sessionStorage only', async () => {
    installApi({ 'POST /api/v1/auth/login': () => makeToken('viewer') });
    const user = userEvent.setup();
    renderApp({ route: '/login', role: null });
    await signInAs(user, 'viewer', 'pw');
    await screen.findByRole('heading', { name: 'Fleet overview' });
    expect(window.sessionStorage.getItem('seatrace.auth')).toContain('token-viewer');
    expect(window.localStorage.getItem('seatrace.auth')).toBeNull();
  });

  it('a 401 from any API call signs out and returns to the login page with a notice', async () => {
    installApi({
      'GET /api/v1/fleet/summary': () => apiError(401, 'unauthorized', 'Invalid or expired token'),
    });
    renderApp({ route: '/' });
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByText(/session has expired/i)).toBeInTheDocument();
    expect(window.sessionStorage.getItem('seatrace.auth')).toBeNull();
  });

  it('signs out from the user menu and clears cached data', async () => {
    installApi();
    const user = userEvent.setup();
    const { queryClient } = renderApp({ route: '/' });
    await screen.findByRole('heading', { name: 'Fleet overview' });
    await user.click(screen.getByRole('button', { name: /operator/ }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('role display', () => {
  it('shows the role badge in the user menu', async () => {
    installApi();
    renderApp({ route: '/', role: 'viewer' });
    const button = await screen.findByRole('button', { name: /viewer/ });
    expect(within(button).getByText('Viewer')).toBeInTheDocument();
  });
});

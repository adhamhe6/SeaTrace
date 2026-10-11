import { useMutation } from '@tanstack/react-query';
import { Anchor, LogIn, TriangleAlert } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '@/api/client';
import type { TokenResponse } from '@/api/types';
import { usePageTitle } from '@/lib/usePageTitle';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Field, Input } from '@/ui/Field';
import { ThemeToggle } from '@/ui/ThemeToggle';
import { useAuth } from './authStore';
import { safeNextPath } from './RequireAuth';
import './login.css';

export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 || error.code === 'too_many_attempts') {
      return 'Too many failed sign-in attempts. Wait a minute, then try again.';
    }
    if (error.status === 401 || error.code === 'invalid_credentials')
      return 'Invalid username or password.';
    if (error.isNetwork)
      return 'Cannot reach the server. Check your connection and that the backend is running.';
    if (error.status >= 500) return 'The server is not available right now. Try again shortly.';
    return error.message;
  }
  return 'Sign-in failed. Please try again.';
}

export function LoginPage() {
  usePageTitle('Sign in');
  const [params] = useSearchParams();
  const token = useAuth((s) => s.token);
  const notice = useAuth((s) => s.notice);
  const signIn = useAuth((s) => s.signIn);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      api.post<TokenResponse>('/auth/login', credentials, { skipAuthHandling: true }),
    onSuccess: (response) => {
      signIn(response);
    },
  });

  if (token) return <Navigate to={safeNextPath(params.get('next'))} replace />;

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (login.isPending) return;
    login.mutate({ username: username.trim(), password });
  };

  return (
    <div className="login">
      <div className="login__theme">
        <ThemeToggle />
      </div>
      <main className="login__panel" id="main">
        <div className="login__brand">
          <Anchor size={26} aria-hidden="true" />
          <div>
            <h1>SeaTrace</h1>
            <p className="muted">Maritime automation monitoring and incident replay</p>
          </div>
        </div>
        <p className="sim-flag" role="note" style={{ alignSelf: 'flex-start' }}>
          <TriangleAlert size={13} aria-hidden="true" />
          Simulated data — not a real vessel
        </p>
        {notice ? <Banner tone="warning">{notice}</Banner> : null}
        <form onSubmit={onSubmit} className="login__form" noValidate>
          <Field label="Username">
            <Input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              disabled={login.isPending}
              onChange={(e) => {
                setUsername(e.target.value);
              }}
            />
          </Field>
          <Field label="Password">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={login.isPending}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          </Field>
          {login.isError ? (
            <Banner tone="critical" role="alert">
              {loginErrorMessage(login.error)}
            </Banner>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            icon={LogIn}
            loading={login.isPending}
            disabled={!username.trim() || !password}
          >
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="muted login__note">
          Demo accounts only. Usernames and passwords are configured through environment variables
          on the server (a read-only <em>viewer</em> and an <em>operator</em> who can acknowledge
          alarms and control the simulator); ask whoever deployed this instance.
        </p>
      </main>
    </div>
  );
}

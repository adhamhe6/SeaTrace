import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '@/App';
import { useAuth } from '@/auth/authStore';
import type { WebSocketLike } from '@/realtime/wsClient';
import { makeToken } from './fixtures';

export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
}

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface RenderAppOptions {
  route?: string;
  role?: 'viewer' | 'operator' | null;
  queryClient?: QueryClient;
}

/** Renders the whole application (router, providers, shell) at a route, optionally signed in. */
export function renderApp({ route = '/', role = 'operator', queryClient }: RenderAppOptions = {}) {
  if (role) useAuth.getState().signIn(makeToken(role));
  FakeSocket.instances = [];
  const client = queryClient ?? newQueryClient();
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <App queryClient={client} createSocket={(url) => new FakeSocket(url)} />
    </MemoryRouter>,
  );
  return { ...utils, queryClient: client };
}

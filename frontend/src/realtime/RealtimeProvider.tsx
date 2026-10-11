import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/auth/authStore';
import { applyLiveMessage } from './applyMessage';
import { useLive } from './liveStore';
import { defaultSocketUrl, LiveClient, type SocketFactory } from './wsClient';

const browserSocket: SocketFactory = (url) =>
  new WebSocket(url) as unknown as ReturnType<SocketFactory>;

interface Props {
  children: ReactNode;
  createSocket?: SocketFactory;
}

/** Owns the single WebSocket connection while a user is signed in. */
export function RealtimeProvider({ children, createSocket = browserSocket }: Props) {
  const token = useAuth((s) => s.token);
  const queryClient = useQueryClient();

  useEffect(() => {
    const setOnline = useLive.getState().setOnline;
    const onOnline = () => {
      setOnline(true);
    };
    const onOffline = () => {
      setOnline(false);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!token) {
      useLive.getState().reset();
      return;
    }
    const live = useLive.getState();
    const client = new LiveClient({
      url: defaultSocketUrl,
      getToken: () => useAuth.getState().token,
      createSocket,
      onMessage: (message) => {
        applyLiveMessage(queryClient, message);
      },
      onStateChange: (state) => {
        live.setConnection(state);
      },
      onResync: () => {
        void queryClient.invalidateQueries();
      },
      onUnauthorized: () => {
        useAuth.getState().signOut('Your session is no longer valid. Please sign in again.');
      },
      onServerTime: (iso) => {
        live.setServerTime(iso);
      },
      onFrame: (at) => {
        live.touch(at);
      },
    });
    live.setConnection('connecting');
    client.start();
    const onOnline = () => {
      client.reconnectNow();
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      client.stop();
    };
  }, [token, queryClient, createSocket]);

  return <>{children}</>;
}

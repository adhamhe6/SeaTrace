import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { LoginPage } from '@/auth/LoginPage';
import { RequireAuth } from '@/auth/RequireAuth';
import { useAuth } from '@/auth/authStore';
import { AppShell } from '@/layout/AppShell';
import { resolveTheme, useSettings } from '@/lib/settingsStore';
import { AboutPage } from '@/pages/AboutPage';
import { AlarmDetailPage } from '@/pages/AlarmDetailPage';
import { AlarmsPage } from '@/pages/AlarmsPage';
import { FleetPage } from '@/pages/FleetPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SimulatorPage } from '@/pages/SimulatorPage';
import { RealtimeProvider } from '@/realtime/RealtimeProvider';
import type { SocketFactory } from '@/realtime/wsClient';
import { LoadingBlock } from '@/ui/Skeleton';
import { ToastProvider } from '@/ui/Toast';

const VesselPage = lazy(() => import('@/pages/VesselPage'));
const ReplayPage = lazy(() => import('@/pages/ReplayPage'));

function ThemeSync() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const apply = () => {
      document.documentElement.setAttribute('data-theme', resolveTheme(theme));
    };
    apply();
    if (theme !== null || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', apply);
    return () => {
      media.removeEventListener('change', apply);
    };
  }, [theme]);
  return null;
}

/** Drops all cached server data when the user signs out so nothing leaks to the next session. */
function CacheReset({ client }: { client: QueryClient }) {
  useEffect(
    () =>
      useAuth.subscribe((state, previous) => {
        if (previous.token && !state.token) client.clear();
      }),
    [client],
  );
  return null;
}

function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingBlock label="Loading page" lines={6} height={20} />}>
      {children}
    </Suspense>
  );
}

interface AppProps {
  queryClient: QueryClient;
  createSocket?: SocketFactory;
}

export function App({ queryClient, createSocket }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <CacheReset client={queryClient} />
      <ToastProvider>
        <RealtimeProvider createSocket={createSocket}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<FleetPage />} />
              <Route
                path="vessels/:code"
                element={
                  <Lazy>
                    <VesselPage />
                  </Lazy>
                }
              />
              <Route path="alarms" element={<AlarmsPage />} />
              <Route path="alarms/:id" element={<AlarmDetailPage />} />
              <Route
                path="replay"
                element={
                  <Lazy>
                    <ReplayPage />
                  </Lazy>
                }
              />
              <Route path="simulator" element={<SimulatorPage />} />
              <Route path="about" element={<AboutPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </RealtimeProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

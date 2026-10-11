import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { useAuth } from '@/auth/authStore';
import { bootstrapApi } from '@/queryClient';
import { useSettings } from '@/lib/settingsStore';
import { useLive } from '@/realtime/liveStore';

// Canvas charts cannot run in jsdom: replace the ECharts runtime with an inert stub.
vi.mock('@/ui/chart/echartsCore', () => {
  const chart = {
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    getZr: () => ({ on: vi.fn() }),
    convertFromPixel: vi.fn(() => [0]),
  };
  return { echarts: { init: vi.fn(() => chart), use: vi.fn() } };
});

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

Element.prototype.scrollIntoView = vi.fn();

bootstrapApi();

beforeEach(() => {
  useAuth.setState({ token: null, user: null, expiresAt: null, notice: null });
  useLive.getState().reset();
  useSettings.setState({ theme: null, timeMode: 'utc' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

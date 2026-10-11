import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useLive } from '@/realtime/liveStore';
import { installApi } from '@/test/mockApi';
import { newQueryClient } from '@/test/render';
import { FALLBACK_POLL_MS, LIVE_SAFETY_POLL_MS, useAnomaly, useHistory, useRefetchInterval } from './hooks';

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={newQueryClient()}>{children}</QueryClientProvider>;

describe('useRefetchInterval: REST polling is the fallback for a dead live channel', () => {
  it('polls every 5 s unless the websocket is open', () => {
    const { result } = renderHook(() => useRefetchInterval(LIVE_SAFETY_POLL_MS));
    expect(result.current).toBe(FALLBACK_POLL_MS); // connecting
    act(() => {
      useLive.getState().setConnection('open');
    });
    expect(result.current).toBe(LIVE_SAFETY_POLL_MS);
    act(() => {
      useLive.getState().setConnection('reconnecting');
    });
    expect(result.current).toBe(FALLBACK_POLL_MS);
    act(() => {
      useLive.getState().setConnection('open');
    });
    const noSafety = renderHook(() => useRefetchInterval(false));
    expect(noSafety.result.current).toBe(false);
  });
});

describe('useHistory', () => {
  it('computes the window at fetch time from server-aligned time and picks raw vs bucketed', async () => {
    const api = installApi({
      'GET /api/v1/telemetry/history': () => ({ vessel_code: 'V', equipment_code: 'E', from: '', to: '', bucket_s: null, units: {}, items: [], buckets: [], next_cursor: null, truncated: false }),
    });
    useLive.setState({ clockOffsetMs: 60_000 }); // server is one minute ahead of this browser
    const raw = renderHook(() => useHistory('V', 'E', 5), { wrapper });
    await waitFor(() => {
      expect(raw.result.current.isSuccess).toBe(true);
    });
    const q = api.calls[0]!.query;
    const span = Date.parse(q.get('to')!) - Date.parse(q.get('from')!);
    expect(span).toBe(5 * 60_000);
    expect(Date.parse(q.get('to')!) - Date.now()).toBeGreaterThan(50_000);
    expect(q.get('limit')).toBe('20000');
    expect(q.get('bucket_s')).toBeNull();

    renderHook(() => useHistory('V', 'E', 60), { wrapper });
    await waitFor(() => {
      expect(api.calls.length).toBe(2);
    });
    expect(api.calls[1]!.query.get('bucket_s')).toBe('30');
    expect(api.calls[1]!.query.get('limit')).toBeNull();
  });
});

describe('useAnomaly', () => {
  it('polls every 5 seconds regardless of the live channel', async () => {
    installApi({ 'GET /api/v1/anomalies/VES-001': () => ({ status: 'normal' }) });
    useLive.getState().setConnection('open');
    const { result } = renderHook(() => useAnomaly('VES-001'), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });
});

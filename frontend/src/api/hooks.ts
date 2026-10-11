import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useLive, serverNow } from '@/realtime/liveStore';
import { api } from './client';
import { keys } from './queryKeys';
import type {
  AlarmDetail,
  AlarmKind,
  AlarmList,
  AlarmState,
  AnomalyAssessment,
  FleetSummary,
  HistoryResponse,
  IncidentWindow,
  RecentEvent,
  ScenarioInfo,
  ScenarioResult,
  Severity,
  SimulatorEventOut,
  SimulatorStatus,
  SystemStatus,
  VesselDetail,
  VesselSummary,
} from './types';

/** Polling interval while the WebSocket is down. */
export const FALLBACK_POLL_MS = 5000;
/** Safety-net refresh for aggregate data while the live channel is healthy. */
export const LIVE_SAFETY_POLL_MS = 30_000;

/**
 * react-query `refetchInterval` policy: while the live channel is open data arrives by push (optionally
 * with a slow safety refresh); otherwise the REST endpoints are polled.
 */
export function useRefetchInterval(whileLive: number | false = false): number | false {
  const connection = useLive((s) => s.connection);
  return connection === 'open' ? whileLive : FALLBACK_POLL_MS;
}

export function useSystemStatus(): UseQueryResult<SystemStatus> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.systemStatus,
    queryFn: ({ signal }) => api.get<SystemStatus>('/system/status', { signal }),
    refetchInterval,
  });
}

export function useFleetSummary(): UseQueryResult<FleetSummary> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.fleetSummary,
    queryFn: ({ signal }) => api.get<FleetSummary>('/fleet/summary', { signal }),
    refetchInterval,
  });
}

export function useVessels(): UseQueryResult<VesselSummary[]> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.vessels,
    queryFn: ({ signal }) => api.get<VesselSummary[]>('/vessels', { signal }),
    refetchInterval,
  });
}

export function useVessel(code: string | undefined): UseQueryResult<VesselDetail> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.vessel(code ?? ''),
    queryFn: ({ signal }) =>
      api.get<VesselDetail>(`/vessels/${encodeURIComponent(code ?? '')}`, { signal }),
    enabled: Boolean(code),
    refetchInterval,
  });
}

export function useRecentEvents(limit = 20): UseQueryResult<RecentEvent[]> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.recentEvents(limit),
    queryFn: ({ signal }) => api.get<RecentEvent[]>('/events/recent', { query: { limit }, signal }),
    refetchInterval,
  });
}

// ---------------------------------------------------------------------------------------- alarms
export interface AlarmQuery {
  open?: boolean;
  state?: readonly AlarmState[];
  severity?: readonly Severity[];
  vessel?: string;
  equipment?: string;
  kind?: AlarmKind;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export function useAlarms(query: AlarmQuery, enabled = true): UseQueryResult<AlarmList> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.alarmList(query),
    queryFn: ({ signal }) =>
      api.get<AlarmList>('/alarms', {
        query: {
          open: query.open,
          state: query.state,
          severity: query.severity,
          vessel: query.vessel,
          equipment: query.equipment,
          kind: query.kind,
          from: query.from,
          to: query.to,
          limit: query.limit,
          offset: query.offset,
        },
        signal,
      }),
    placeholderData: keepPreviousData,
    refetchInterval,
    enabled,
  });
}

export function useAlarm(id: number): UseQueryResult<AlarmDetail> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.alarm(id),
    queryFn: ({ signal }) => api.get<AlarmDetail>(`/alarms/${String(id)}`, { signal }),
    enabled: Number.isInteger(id) && id > 0,
    refetchInterval,
  });
}

export function useAcknowledgeAlarm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) =>
      api.post<AlarmDetail>(`/alarms/${String(id)}/acknowledge`, note ? { note } : {}),
    onSuccess: (detail) => {
      queryClient.setQueryData(keys.alarm(detail.id), detail);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.alarmsAll });
      void queryClient.invalidateQueries({ queryKey: keys.fleetSummary });
      void queryClient.invalidateQueries({ queryKey: keys.vessels });
      void queryClient.invalidateQueries({ queryKey: keys.eventsAll });
    },
  });
}

// ------------------------------------------------------------------------------------ telemetry
export const HISTORY_RANGES_MIN = [5, 15, 60] as const;
export type HistoryRangeMin = (typeof HISTORY_RANGES_MIN)[number];
/** Ranges up to this many minutes use raw samples; longer ranges use server-side buckets. */
export const RAW_HISTORY_MAX_MIN = 15;
export const BUCKET_SECONDS = 30;

export function useHistory(
  vessel: string,
  equipment: string,
  rangeMin: number,
): UseQueryResult<HistoryResponse> {
  // Raw ranges are extended by live WebSocket points; bucketed ranges need a periodic refresh instead.
  const refetchInterval = useRefetchInterval(
    rangeMin > RAW_HISTORY_MAX_MIN ? LIVE_SAFETY_POLL_MS : false,
  );
  return useQuery({
    queryKey: keys.history(vessel, equipment, rangeMin),
    queryFn: ({ signal }) => {
      const to = serverNow();
      const from = to - rangeMin * 60_000;
      const raw = rangeMin <= RAW_HISTORY_MAX_MIN;
      return api.get<HistoryResponse>('/telemetry/history', {
        query: {
          vessel,
          equipment,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          limit: raw ? 20000 : undefined,
          bucket_s: raw ? undefined : BUCKET_SECONDS,
        },
        signal,
      });
    },
    placeholderData: keepPreviousData,
    refetchInterval,
    // A refetch recomputes the window, so never serve it from a stale cache entry for long.
    staleTime: 5000,
  });
}

// -------------------------------------------------------------------------------------- incidents
export interface WindowQuery {
  vessel: string;
  equipment: string;
  from: string;
  to: string;
}

export function useIncidentWindow(query: WindowQuery | null): UseQueryResult<IncidentWindow> {
  return useQuery({
    queryKey: keys.incidentWindow(query),
    queryFn: ({ signal }) =>
      api.get<IncidentWindow>('/incidents/window', {
        query: query ? { ...query } : undefined,
        signal,
        timeoutMs: 45_000,
      }),
    enabled: query !== null,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function useIncidentForAlarm(
  alarmId: number | null,
  beforeS: number,
  afterS: number,
): UseQueryResult<IncidentWindow> {
  return useQuery({
    queryKey: keys.incidentAlarm(alarmId ?? 0, beforeS, afterS),
    queryFn: ({ signal }) =>
      api.get<IncidentWindow>(`/incidents/alarm/${String(alarmId)}`, {
        query: { before_s: beforeS, after_s: afterS },
        signal,
        timeoutMs: 45_000,
      }),
    enabled: alarmId !== null,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

// -------------------------------------------------------------------------------------- simulator
export function useScenarios(): UseQueryResult<ScenarioInfo[]> {
  return useQuery({
    queryKey: keys.scenarios,
    queryFn: ({ signal }) => api.get<ScenarioInfo[]>('/simulator/scenarios', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useSimulatorStatus(): UseQueryResult<SimulatorStatus> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.simulatorStatus,
    queryFn: ({ signal }) => api.get<SimulatorStatus>('/simulator/status', { signal }),
    refetchInterval,
  });
}

export function useSimulatorEvents(limit = 25): UseQueryResult<SimulatorEventOut[]> {
  const refetchInterval = useRefetchInterval(LIVE_SAFETY_POLL_MS);
  return useQuery({
    queryKey: keys.simulatorEvents(limit),
    queryFn: ({ signal }) =>
      api.get<SimulatorEventOut[]>('/simulator/events', { query: { limit }, signal }),
    refetchInterval,
  });
}

export interface ScenarioCommandInput {
  scenarioId: string;
  vesselCode?: string;
  durationS?: number;
}

function useSimulatorMutation<TInput = undefined>(fn: (input: TInput) => Promise<ScenarioResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.simulatorStatus });
      void queryClient.invalidateQueries({ queryKey: keys.simulatorEventsAll });
      void queryClient.invalidateQueries({ queryKey: keys.fleetSummary });
      void queryClient.invalidateQueries({ queryKey: keys.eventsAll });
    },
  });
}

export function useActivateScenario() {
  return useSimulatorMutation(({ scenarioId, vesselCode, durationS }: ScenarioCommandInput) =>
    api.post<ScenarioResult>(`/simulator/scenarios/${encodeURIComponent(scenarioId)}/activate`, {
      vessel_code: vesselCode ?? null,
      duration_s: durationS ?? null,
    }),
  );
}

export function useClearScenario() {
  return useSimulatorMutation(({ scenarioId, vesselCode }: ScenarioCommandInput) =>
    api.post<ScenarioResult>(`/simulator/scenarios/${encodeURIComponent(scenarioId)}/clear`, {
      vessel_code: vesselCode ?? null,
    }),
  );
}

export function useResetScenarios() {
  return useSimulatorMutation(() => api.post<ScenarioResult>('/simulator/reset'));
}

// ---------------------------------------------------------------------------------------- anomaly
/** Experimental anomaly assessment of a vessel's main engine; always polled (it is not pushed). */
export function useAnomaly(vessel: string): UseQueryResult<AnomalyAssessment> {
  return useQuery({
    queryKey: keys.anomaly(vessel),
    queryFn: ({ signal }) =>
      api.get<AnomalyAssessment>(`/anomalies/${encodeURIComponent(vessel)}`, { signal }),
    refetchInterval: FALLBACK_POLL_MS,
  });
}

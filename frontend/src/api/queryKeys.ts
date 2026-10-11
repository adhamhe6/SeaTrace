export const keys = {
  systemStatus: ['system', 'status'] as const,
  fleetSummary: ['fleet', 'summary'] as const,
  vessels: ['vessels'] as const,
  vessel: (code: string) => ['vessel', code] as const,
  equipment: (vessel: string, equipment: string) => ['equipment', vessel, equipment] as const,
  latestAll: ['telemetry', 'latest'] as const,
  latest: (vessel?: string, equipment?: string) =>
    ['telemetry', 'latest', vessel ?? null, equipment ?? null] as const,
  history: (vessel: string, equipment: string, rangeMin: number) =>
    ['telemetry', 'history', vessel, equipment, rangeMin] as const,
  anomaly: (vessel: string) => ['anomaly', vessel] as const,
  alarmsAll: ['alarms'] as const,
  alarmList: (params: unknown) => ['alarms', 'list', params] as const,
  alarm: (id: number) => ['alarm', id] as const,
  recentEvents: (limit: number) => ['events', 'recent', limit] as const,
  eventsAll: ['events'] as const,
  scenarios: ['simulator', 'scenarios'] as const,
  simulatorStatus: ['simulator', 'status'] as const,
  simulatorEvents: (limit: number) => ['simulator', 'events', limit] as const,
  simulatorEventsAll: ['simulator', 'events'] as const,
  incidentWindow: (params: unknown) => ['incident', 'window', params] as const,
  incidentAlarm: (id: number, before: number, after: number) =>
    ['incident', 'alarm', id, before, after] as const,
};

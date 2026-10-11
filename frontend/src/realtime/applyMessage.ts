import type { QueryClient } from '@tanstack/react-query';
import { keys } from '@/api/queryKeys';
import type {
  AlarmDetail,
  AlarmEventOut,
  LatestReading,
  SystemStatus,
  VesselDetail,
} from '@/api/types';
import { useLive } from './liveStore';
import type { DataMessage, TelemetryItem } from './protocol';
import { telemetryBus } from './telemetryBus';

export const HIGHLIGHT_MS = 5000;
const INVALIDATE_DEBOUNCE_MS = 300;

type KeyList = readonly (readonly unknown[])[];
const pending = new Map<
  QueryClient,
  { keys: Map<string, readonly unknown[]>; timer: ReturnType<typeof setTimeout> }
>();

/** Coalesces bursts of invalidations (e.g. several alarm transitions in one second) into one refetch. */
export function scheduleInvalidate(client: QueryClient, queryKeys: KeyList): void {
  let entry = pending.get(client);
  if (!entry) {
    const created = {
      keys: new Map<string, readonly unknown[]>(),
      timer: setTimeout(() => {
        pending.delete(client);
        created.keys.forEach((queryKey) => {
          void client.invalidateQueries({ queryKey });
        });
      }, INVALIDATE_DEBOUNCE_MS),
    };
    pending.set(client, created);
    entry = created;
  }
  for (const k of queryKeys) entry.keys.set(JSON.stringify(k), k);
}

function readingMatches(reading: LatestReading, item: TelemetryItem): boolean {
  return (
    reading.vessel_code === item.vessel_code &&
    reading.equipment_code === item.equipment_code &&
    reading.measurement === item.measurement
  );
}

function patchReading(
  reading: LatestReading,
  item: TelemetryItem,
  serverNowMs: number,
): LatestReading {
  const previous = reading.source_ts ? Date.parse(reading.source_ts) : null;
  const incoming = Date.parse(item.source_ts);
  if (previous !== null && Number.isFinite(incoming) && incoming < previous) return reading;
  const ingested = Date.parse(item.ingested_ts);
  return {
    ...reading,
    value: item.value,
    quality: item.quality,
    source_ts: item.source_ts,
    ingested_ts: item.ingested_ts,
    age_s: Number.isFinite(ingested) ? Math.max(0, (serverNowMs - ingested) / 1000) : 0,
    stale: false,
  };
}

function patchReadings(
  readings: LatestReading[],
  items: readonly TelemetryItem[],
  serverNowMs: number,
): LatestReading[] {
  const next = readings.map((reading) => {
    let current = reading;
    for (const item of items) {
      if (readingMatches(current, item)) current = patchReading(current, item, serverNowMs);
    }
    return current;
  });
  return next.some((reading, i) => reading !== readings[i]) ? next : readings;
}

function applyTelemetry(client: QueryClient, items: readonly TelemetryItem[]): void {
  const serverNowMs = Date.now() + useLive.getState().clockOffsetMs;
  const vesselCodes = new Set(items.map((i) => i.vessel_code));
  for (const code of vesselCodes) {
    client.setQueryData<VesselDetail>(keys.vessel(code), (old) => {
      if (!old) return old;
      const vesselItems = items.filter((i) => i.vessel_code === code);
      const equipment = old.equipment.map((eq) => {
        const eqItems = vesselItems.filter((i) => i.equipment_code === eq.code);
        if (eqItems.length === 0) return eq;
        const readings = patchReadings(eq.readings, eqItems, serverNowMs);
        if (readings === eq.readings) return eq;
        const lastData = eqItems.reduce(
          (acc, i) => (i.ingested_ts > acc ? i.ingested_ts : acc),
          eq.last_data_at ?? '',
        );
        return { ...eq, readings, last_data_at: lastData === '' ? eq.last_data_at : lastData };
      });
      return equipment.some((eq, i) => eq !== old.equipment[i]) ? { ...old, equipment } : old;
    });
  }
  client.setQueriesData<LatestReading[]>({ queryKey: keys.latestAll }, (old) =>
    Array.isArray(old) ? patchReadings(old, items, serverNowMs) : old,
  );
  telemetryBus.emit(items);
}

function mergeEvent(events: AlarmEventOut[], incoming: AlarmEventOut): AlarmEventOut[] {
  if (events.some((e) => e.id === incoming.id)) return events;
  return [...events, incoming].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id - b.id);
}

function applyAlarm(client: QueryClient, message: Extract<DataMessage, { type: 'alarm' }>): void {
  const { alarm, alarm_event: alarmEvent, event } = message.data;
  const live = useLive.getState();
  live.highlight(alarm.id, Date.now() + HIGHLIGHT_MS);
  if ((event === 'raised' || event === 'reactivated') && alarm.severity === 'critical') {
    live.announce(
      `Critical alarm ${event === 'raised' ? 'raised' : 'reactivated'} on ${alarm.vessel_name} ${alarm.equipment_name}: ${alarm.message}`,
    );
  }
  client.setQueryData<AlarmDetail>(keys.alarm(alarm.id), (old) =>
    old ? { ...old, ...alarm, events: mergeEvent(old.events, alarmEvent) } : old,
  );
  scheduleInvalidate(client, [
    keys.alarmsAll,
    keys.fleetSummary,
    keys.vessels,
    ['vessel'],
    keys.eventsAll,
  ]);
}

/** Applies one sequenced server message to the query cache and live stores. */
export function applyLiveMessage(client: QueryClient, message: DataMessage): void {
  switch (message.type) {
    case 'telemetry':
      applyTelemetry(client, message.data.items);
      return;
    case 'alarm':
      applyAlarm(client, message);
      return;
    case 'equipment_state': {
      const { vessel_code, equipment_code, state, source_ts } = message.data;
      client.setQueryData<VesselDetail>(keys.vessel(vessel_code), (old) =>
        old
          ? {
              ...old,
              equipment: old.equipment.map((eq) =>
                eq.code === equipment_code ? { ...eq, state, state_since: source_ts } : eq,
              ),
            }
          : old,
      );
      scheduleInvalidate(client, [keys.vessel(vessel_code), keys.vessels, keys.fleetSummary]);
      return;
    }
    case 'source_status':
      useLive.getState().setSourceStatus(message.data);
      client.setQueryData<SystemStatus>(keys.systemStatus, (old) =>
        old ? { ...old, opcua: message.data } : old,
      );
      scheduleInvalidate(client, [
        keys.fleetSummary,
        keys.vessels,
        ['vessel'],
        keys.eventsAll,
        keys.simulatorStatus,
      ]);
      return;
    case 'scenario':
      // The status embedded in the message is captured right after the OPC UA call and can still list the
      // previous scenarios, so refetch it instead of trusting it.
      scheduleInvalidate(client, [
        keys.simulatorStatus,
        keys.simulatorEventsAll,
        keys.fleetSummary,
        keys.eventsAll,
      ]);
      return;
  }
}

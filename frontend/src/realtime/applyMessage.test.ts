import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '@/api/queryKeys';
import type { AlarmDetail, LatestReading, SystemStatus, VesselDetail } from '@/api/types';
import {
  makeAlarm,
  makeAlarmDetail,
  makeAlarmEvent,
  makeOpcUa,
  makeReading,
  makeSimStatus,
  makeSystemStatus,
  makeVessel,
} from '@/test/fixtures';
import { applyLiveMessage } from './applyMessage';
import { useLive } from './liveStore';
import type { DataMessage, TelemetryItem } from './protocol';
import { telemetryBus } from './telemetryBus';

const item = (over: Partial<TelemetryItem> = {}): TelemetryItem => ({
  vessel_code: 'VES-001',
  equipment_code: 'ME1',
  measurement: 'temperature',
  unit: '°C',
  value: 91.2,
  quality: 'good',
  source_ts: new Date().toISOString(),
  ingested_ts: new Date().toISOString(),
  ...over,
});

const telemetry = (items: TelemetryItem[]): DataMessage => ({
  type: 'telemetry',
  seq: 1,
  ts: new Date().toISOString(),
  data: { items },
});

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('telemetry', () => {
  it('patches readings in the vessel detail cache and keeps static fields', () => {
    const old = makeReading({
      value: 80,
      source_ts: '2026-03-01T10:00:00Z',
      ingested_ts: '2026-03-01T10:00:00Z',
      stale: true,
      age_s: 99,
    });
    client.setQueryData<VesselDetail>(
      keys.vessel('VES-001'),
      makeVessel({ equipment: [{ ...makeVessel().equipment[0]!, readings: [old] }] }),
    );
    applyLiveMessage(client, telemetry([item()]));
    const reading = client.getQueryData<VesselDetail>(keys.vessel('VES-001'))!.equipment[0]!
      .readings[0]!;
    expect(reading.value).toBe(91.2);
    expect(reading.stale).toBe(false);
    expect(reading.age_s).toBeLessThan(2);
    expect(reading.name).toBe('Engine temperature');
    expect(reading.nominal_max).toBe(88);
  });

  it('patches the latest-readings list cache and ignores unknown sensors', () => {
    client.setQueryData<LatestReading[]>(keys.latest(), [
      makeReading({ value: 1 }),
      makeReading({ measurement: 'rpm', value: 2 }),
    ]);
    applyLiveMessage(
      client,
      telemetry([
        item({ measurement: 'rpm', value: 99 }),
        item({ measurement: 'unknown', value: 5 }),
      ]),
    );
    const list = client.getQueryData<LatestReading[]>(keys.latest())!;
    expect(list.map((r) => r.value)).toEqual([1, 99]);
  });

  it('does not let an older sample overwrite a newer reading', () => {
    const newer = new Date().toISOString();
    client.setQueryData<LatestReading[]>(keys.latest(), [
      makeReading({ value: 50, source_ts: newer }),
    ]);
    applyLiveMessage(client, telemetry([item({ value: 10, source_ts: '2020-01-01T00:00:00Z' })]));
    expect(client.getQueryData<LatestReading[]>(keys.latest())![0]!.value).toBe(50);
  });

  it('feeds live chart buffers through the telemetry bus', () => {
    const received: number[] = [];
    const off = telemetryBus.subscribe((items) => received.push(items.length));
    applyLiveMessage(client, telemetry([item(), item({ measurement: 'rpm' })]));
    off();
    expect(received).toEqual([2]);
  });
});

describe('alarms', () => {
  const alarmMessage = (
    event: string,
    severity: 'critical' | 'warning' = 'critical',
  ): DataMessage => ({
    type: 'alarm',
    seq: 2,
    ts: new Date().toISOString(),
    data: {
      event,
      alarm: makeAlarm({ id: 7, severity }),
      alarm_event: makeAlarmEvent({ id: 99, alarm_id: 7, event_type: event }),
    },
  });

  it('highlights the alarm, announces new critical alarms and invalidates lists after a debounce', () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    applyLiveMessage(client, alarmMessage('raised'));
    applyLiveMessage(client, alarmMessage('raised'));
    expect(useLive.getState().highlighted[7]).toBeGreaterThan(Date.now());
    expect(useLive.getState().announcement?.text).toMatch(/Critical alarm raised/);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    const invalidated = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(keys.alarmsAll));
    expect(invalidated).toContain(JSON.stringify(keys.fleetSummary));
    expect(new Set(invalidated).size).toBe(invalidated.length); // coalesced
  });

  it('does not announce warnings or acknowledgements', () => {
    applyLiveMessage(client, alarmMessage('raised', 'warning'));
    applyLiveMessage(client, alarmMessage('acknowledged'));
    expect(useLive.getState().announcement).toBeNull();
  });

  it('updates a cached alarm detail and appends the new event once', () => {
    client.setQueryData<AlarmDetail>(
      keys.alarm(7),
      makeAlarmDetail({ events: [makeAlarmEvent({ id: 1 })] }),
    );
    applyLiveMessage(client, alarmMessage('acknowledged'));
    applyLiveMessage(client, alarmMessage('acknowledged'));
    const detail = client.getQueryData<AlarmDetail>(keys.alarm(7))!;
    expect(detail.events.map((e) => e.id)).toEqual([1, 99]);
  });
});

describe('state and status messages', () => {
  it('updates equipment state in the vessel cache', () => {
    client.setQueryData<VesselDetail>(keys.vessel('VES-001'), makeVessel());
    applyLiveMessage(client, {
      type: 'equipment_state',
      seq: 3,
      ts: '',
      data: {
        vessel_code: 'VES-001',
        equipment_code: 'ME1',
        state: 'TRIPPED',
        source_ts: '2026-03-01T10:00:00Z',
      },
    });
    expect(client.getQueryData<VesselDetail>(keys.vessel('VES-001'))!.equipment[0]!.state).toBe(
      'TRIPPED',
    );
  });

  it('stores the pushed OPC UA status and mirrors it into the system status cache', () => {
    client.setQueryData<SystemStatus>(keys.systemStatus, makeSystemStatus());
    const status = makeOpcUa({ state: 'backoff', reconnect_attempts: 3 });
    applyLiveMessage(client, { type: 'source_status', seq: 4, ts: '', data: status });
    expect(useLive.getState().sourceStatus?.state).toBe('backoff');
    expect(client.getQueryData<SystemStatus>(keys.systemStatus)!.opcua.reconnect_attempts).toBe(3);
  });

  it('refetches the simulator status on scenario messages instead of trusting the embedded copy', () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    applyLiveMessage(client, {
      type: 'scenario',
      seq: 5,
      ts: '',
      data: {
        action: 'activate',
        scenario_id: 'engine_overheat',
        vessel_code: 'VES-001',
        accepted: true,
        actor: 'operator',
        simulator: makeSimStatus(),
      },
    });
    vi.advanceTimersByTime(400);
    expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(
      JSON.stringify(keys.simulatorStatus),
    );
  });
});

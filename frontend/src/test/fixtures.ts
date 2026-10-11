import type {
  AlarmDetail,
  AnomalyAssessment,
  AlarmEventOut,
  AlarmOut,
  EquipmentDetail,
  FleetSummary,
  IncidentWindow,
  LatestReading,
  OpcUaStatus,
  RecentEvent,
  ScenarioInfo,
  SimulatorStatus,
  SystemStatus,
  TokenResponse,
  VesselDetail,
  VesselSummary,
} from '@/api/types';

/** API-shaped fixtures: typed against the generated OpenAPI schema, never used by the application. */

export const T0 = Date.parse('2026-03-01T10:00:00Z');
export const iso = (offsetSeconds: number, base = T0): string =>
  new Date(base + offsetSeconds * 1000).toISOString();

export function makeToken(role: 'viewer' | 'operator' = 'operator'): TokenResponse {
  return {
    access_token: `token-${role}`,
    token_type: 'bearer',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: role === 'operator' ? 1 : 2, username: role, role },
  };
}

export function makeReading(over: Partial<LatestReading> = {}): LatestReading {
  const now = new Date().toISOString();
  return {
    sensor_id: 1,
    vessel_code: 'VES-001',
    equipment_code: 'ME1',
    measurement: 'temperature',
    name: 'Engine temperature',
    unit: '°C',
    value: 82.5,
    quality: 'good',
    source_ts: now,
    ingested_ts: now,
    age_s: 0.4,
    stale: false,
    nominal_min: 78,
    nominal_max: 88,
    ...over,
  };
}

export function makeEquipment(over: Partial<EquipmentDetail> = {}): EquipmentDetail {
  return {
    id: 1,
    code: 'ME1',
    name: 'Main engine',
    type: 'main_engine',
    state: 'RUNNING',
    state_since: iso(-600),
    sensor_health: 'OK',
    health: 'normal',
    communication: 'online',
    open_alarms: 0,
    unacknowledged_alarms: 0,
    last_data_at: new Date().toISOString(),
    vessel_code: 'VES-001',
    vessel_name: 'MV Aurora Tide',
    readings: [
      makeReading(),
      makeReading({
        sensor_id: 2,
        measurement: 'rpm',
        name: 'Engine speed',
        unit: 'rpm',
        value: 98.2,
        nominal_min: 90,
        nominal_max: 105,
      }),
    ],
    ...over,
  };
}

export function makeVessel(over: Partial<VesselDetail> = {}): VesselDetail {
  return {
    id: 1,
    code: 'VES-001',
    name: 'MV Aurora Tide',
    vessel_type: 'Bulk carrier (simulated)',
    simulated: true,
    health: 'normal',
    communication: 'online',
    equipment_count: 2,
    open_alarms: { info: 0, warning: 0, critical: 0, unacknowledged: 0 },
    last_data_at: new Date().toISOString(),
    equipment: [
      makeEquipment(),
      makeEquipment({
        id: 2,
        code: 'GEN1',
        name: 'Generator 1',
        type: 'generator',
        readings: [
          makeReading({
            sensor_id: 5,
            equipment_code: 'GEN1',
            measurement: 'frequency',
            name: 'Frequency',
            unit: 'Hz',
            value: 49.9,
            nominal_min: 49.8,
            nominal_max: 50.2,
          }),
        ],
      }),
    ],
    ...over,
  };
}

export function makeVesselSummary(over: Partial<VesselSummary> = {}): VesselSummary {
  const { equipment, ...rest } = makeVessel();
  return { ...rest, equipment_count: equipment.length, ...over };
}

export function makeFleetSummary(over: Partial<FleetSummary> = {}): FleetSummary {
  return {
    vessels_total: 2,
    vessels_by_health: { normal: 1, warning: 0, critical: 1, offline: 0 },
    equipment_total: 8,
    equipment_by_health: { normal: 6, warning: 1, critical: 1, offline: 0 },
    communication: { online: 2, degraded: 0, offline: 0 },
    open_alarms: { info: 1, warning: 2, critical: 3, unacknowledged: 4 },
    opcua_state: 'connected',
    last_data_at: new Date().toISOString(),
    active_scenarios: 0,
    ...over,
  };
}

export function makeOpcUa(over: Partial<OpcUaStatus> = {}): OpcUaStatus {
  return {
    state: 'connected',
    endpoint: 'opc.tcp://sim:4840/seatrace/simulator',
    security: 'secure',
    last_connected_at: iso(-3600),
    last_disconnected_at: null,
    last_data_at: new Date().toISOString(),
    reconnect_attempts: 0,
    monitored_items: 38,
    heartbeat: 1234,
    last_error: null,
    ...over,
  };
}

export function makeSystemStatus(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    version: '0.1.0',
    environment: 'test',
    server_time: new Date().toISOString(),
    simulated: true,
    disclaimer: 'SIMULATED DATA.',
    database: 'ok',
    opcua: makeOpcUa(),
    ingestion: {
      queue_depth: 0,
      received: 1000,
      accepted: 990,
      duplicates: 2,
      late: 1,
      invalid: 3,
      bad: 2,
      stuck: 1,
      dropped: 0,
      rejected_timestamp: 0,
      db_failures: 0,
      last_batch_at: new Date().toISOString(),
    },
    websocket_clients: 1,
    stale_after_s: 10,
    ...over,
  };
}

export function makeSimStatus(over: Partial<SimulatorStatus> = {}): SimulatorStatus {
  return {
    connected: true,
    opcua_state: 'connected',
    endpoint: 'opc.tcp://sim:4840/seatrace/simulator',
    security: 'secure',
    heartbeat: 1234,
    heartbeat_age_s: 0.4,
    active_scenarios: [],
    notice: 'SIMULATED DATA.',
    ...over,
  };
}

export function makeScenario(over: Partial<ScenarioInfo> = {}): ScenarioInfo {
  return {
    id: 'engine_overheat',
    name: 'Engine overheating',
    description: 'Cooling effectiveness degrades gradually.',
    category: 'equipment',
    target: 'Main engine ME1',
    scope: 'vessel',
    default_duration_s: 0,
    max_duration_s: 3600,
    expected_alarms: ['ME_TEMP_HIGH', 'ME_TEMP_HIGH_HIGH'],
    ...over,
  };
}

export function makeAlarm(over: Partial<AlarmOut> = {}): AlarmOut {
  return {
    id: 7,
    rule: { id: 1, code: 'ME_TEMP_HIGH', name: 'High engine temperature' },
    kind: 'condition',
    severity: 'warning',
    state: 'active_unacknowledged',
    condition_active: true,
    acknowledged: false,
    vessel_code: 'VES-001',
    vessel_name: 'MV Aurora Tide',
    equipment_code: 'ME1',
    equipment_name: 'Main engine',
    measurement: 'temperature',
    unit: '°C',
    message: 'Engine temperature above limit: 96.1 °C (limit 95 °C)',
    comparison: 'gt',
    threshold: 95,
    trigger_value: 96.1,
    trigger_ts: iso(0),
    last_value: 97.4,
    last_value_ts: iso(20),
    raised_at: iso(0),
    cleared_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    occurrence_count: 1,
    ...over,
  };
}

export function makeAlarmEvent(over: Partial<AlarmEventOut> = {}): AlarmEventOut {
  return {
    id: 1,
    alarm_id: 7,
    event_type: 'raised',
    from_state: null,
    to_state: 'active_unacknowledged',
    ts: iso(0),
    recorded_at: iso(0),
    actor: 'system',
    value: 96.1,
    note: null,
    details: null,
    ...over,
  };
}

export function makeAlarmDetail(over: Partial<AlarmDetail> = {}): AlarmDetail {
  return { ...makeAlarm(), events: [makeAlarmEvent()], ...over };
}

export function makeRecentEvent(over: Partial<RecentEvent> = {}): RecentEvent {
  return {
    id: 'alarm-7-raised',
    type: 'alarm',
    at: iso(0),
    severity: 'warning',
    vessel_code: 'VES-001',
    equipment_code: 'ME1',
    message: 'Alarm raised: Engine temperature above limit',
    alarm_id: 7,
    ...over,
  };
}

/**
 * A 60 s incident window with 1 Hz temperature samples (0..59 s), one 20 s data gap in rpm
 * (between 20 s and 40 s), an alarm raised at 30 s, acknowledged at 45 s and cleared at 55 s.
 */
export function makeIncidentWindow(over: Partial<IncidentWindow> = {}): IncidentWindow {
  const temperature = Array.from({ length: 60 }, (_, i) => ({
    ts: iso(i),
    value: 80 + i * 0.5,
    quality: 'good' as const,
  }));
  const rpm = [
    ...Array.from({ length: 21 }, (_, i) => i),
    ...Array.from({ length: 20 }, (_, i) => 40 + i),
  ].map((i) => ({ ts: iso(i), value: 100 + i, quality: 'good' as const }));
  return {
    vessel_code: 'VES-001',
    vessel_name: 'MV Aurora Tide',
    equipment_code: 'ME1',
    equipment_name: 'Main engine',
    from: iso(0),
    to: iso(60),
    series: [
      {
        measurement: 'temperature',
        name: 'Engine temperature',
        unit: '°C',
        nominal_min: 78,
        nominal_max: 88,
        points: temperature,
        truncated: false,
      },
      {
        measurement: 'rpm',
        name: 'Engine speed',
        unit: 'rpm',
        nominal_min: 90,
        nominal_max: 105,
        points: rpm,
        truncated: false,
      },
    ],
    state_changes: [{ ts: iso(35), state: 'DEGRADED' }],
    state_at_start: 'RUNNING',
    alarm_events: [
      makeAlarmEvent({ id: 11, ts: iso(30) }),
      makeAlarmEvent({
        id: 12,
        event_type: 'acknowledged',
        from_state: 'active_unacknowledged',
        to_state: 'active_acknowledged',
        ts: iso(45),
        actor: 'operator',
        note: 'Looking into it',
      }),
      makeAlarmEvent({
        id: 13,
        event_type: 'cleared',
        from_state: 'active_acknowledged',
        to_state: 'cleared',
        ts: iso(55),
      }),
    ],
    alarms: [
      makeAlarm({
        id: 7,
        raised_at: iso(30),
        state: 'cleared',
        condition_active: false,
        acknowledged: true,
        cleared_at: iso(55),
      }),
    ],
    gaps: [{ measurement: 'rpm', from: iso(20), to: iso(40), seconds: 20 }],
    point_count: 80,
    first_ts: iso(0),
    last_ts: iso(59),
    focus_alarm_id: 7,
    ...over,
  };
}

export function makeAnomaly(over: Partial<AnomalyAssessment> = {}): AnomalyAssessment {
  return {
    vessel_code: 'VES-001',
    equipment_code: 'ME1',
    status: 'watch',
    score: 0.64,
    explanation: 'Watch: vibration 3.32 mm/s is +1.7 robust sigma from its 300s baseline.',
    features: {
      vibration_z: 1.67,
      temp_slope_c_per_min: 1.744,
      reference_samples: 103,
      vibration_sigma: null,
    },
    alarm_active: false,
    evaluated_at: new Date().toISOString(),
    disclaimer: 'Experimental statistical heuristic on simulated data.',
    ...over,
  };
}

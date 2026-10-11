import type {
  AlarmEventOut,
  AlarmOut,
  OpcUaStatus,
  Quality,
  Role,
  SimulatorStatus,
} from '@/api/types';

/** Wire format of the real-time channel (see backend/app/api/routers/ws.py). */
export interface TelemetryItem {
  vessel_code: string;
  equipment_code: string;
  measurement: string;
  unit: string;
  value: number | null;
  quality: Quality;
  source_ts: string;
  ingested_ts: string;
}

export interface HelloMessage {
  type: 'hello';
  protocol: number;
  auth_timeout_s: number;
  server_time: string;
}

export interface ReadyMessage {
  type: 'ready';
  seq: number;
  resync_required: boolean;
  user: { username: string; role: Role };
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  seq: number;
  server_time: string;
}

export interface PongMessage {
  type: 'pong';
  server_time?: string;
}

interface Sequenced {
  seq: number;
  ts: string;
}

export interface TelemetryMessage extends Sequenced {
  type: 'telemetry';
  data: { items: TelemetryItem[] };
}

export interface AlarmMessage extends Sequenced {
  type: 'alarm';
  data: { event: string; alarm: AlarmOut; alarm_event: AlarmEventOut };
}

export interface EquipmentStateMessage extends Sequenced {
  type: 'equipment_state';
  data: { vessel_code: string; equipment_code: string; state: string; source_ts: string };
}

export interface SourceStatusMessage extends Sequenced {
  type: 'source_status';
  data: OpcUaStatus;
}

export interface ScenarioMessage extends Sequenced {
  type: 'scenario';
  data: {
    action: string;
    scenario_id: string | null;
    vessel_code: string | null;
    accepted: boolean;
    actor: string;
    simulator: SimulatorStatus;
  };
}

export type DataMessage =
  TelemetryMessage | AlarmMessage | EquipmentStateMessage | SourceStatusMessage | ScenarioMessage;

export type ServerMessage =
  HelloMessage | ReadyMessage | HeartbeatMessage | PongMessage | DataMessage;

const DATA_TYPES = new Set(['telemetry', 'alarm', 'equipment_state', 'source_status', 'scenario']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses and shallowly validates a frame; returns null for anything that is not a known message. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null;
  const type = parsed.type;
  if (type === 'hello' || type === 'ready' || type === 'heartbeat' || type === 'pong') {
    if (
      type === 'ready' &&
      (typeof parsed.seq !== 'number' || typeof parsed.resync_required !== 'boolean')
    ) {
      return null;
    }
    return parsed as unknown as ServerMessage;
  }
  if (DATA_TYPES.has(type)) {
    if (typeof parsed.seq !== 'number' || !isRecord(parsed.data)) return null;
    if (type === 'telemetry' && !Array.isArray(parsed.data.items)) return null;
    return parsed as unknown as ServerMessage;
  }
  return null;
}

import type { AlarmOut, AlarmState, IncidentWindow, Quality, Severity } from '@/api/types';
import { toMs } from '@/lib/format';
import { lastIndexAtOrBefore } from '@/lib/series';

/** Everything the replay UI needs, parsed once from the server's incident window (no resampling). */
export interface ReplaySeries {
  measurement: string;
  name: string;
  unit: string;
  nominalMin: number | null;
  nominalMax: number | null;
  /** Sample times in epoch ms, ascending. */
  t: number[];
  v: (number | null)[];
  q: Quality[];
  truncated: boolean;
}

export interface ReplayEvent {
  id: number;
  alarmId: number;
  type: string;
  fromState: AlarmState | null;
  toState: AlarmState;
  ts: number;
  actor: string;
  value: number | null;
  note: string | null;
  severity: Severity;
  message: string;
}

export interface ReplayGap {
  measurement: string;
  from: number;
  to: number;
  seconds: number;
}

export interface ReplayModel {
  vesselCode: string;
  vesselName: string;
  equipmentCode: string;
  equipmentName: string;
  from: number;
  to: number;
  series: ReplaySeries[];
  stateChanges: { ts: number; state: string }[];
  stateAtStart: string | null;
  events: ReplayEvent[];
  eventsByAlarm: Map<number, ReplayEvent[]>;
  alarms: Map<number, AlarmOut>;
  gaps: ReplayGap[];
  /** Union of all stored sample times, ascending and unique. */
  sampleTimes: number[];
  pointCount: number;
  focusAlarmId: number | null;
}

function byTime<T extends { ts: number }>(a: T, b: T): number {
  return a.ts - b.ts;
}

export function buildReplayModel(w: IncidentWindow): ReplayModel {
  const alarms = new Map<number, AlarmOut>(w.alarms.map((a) => [a.id, a]));
  const series: ReplaySeries[] = w.series.map((s) => {
    const t: number[] = [];
    const v: (number | null)[] = [];
    const q: Quality[] = [];
    for (const p of s.points) {
      const ms = toMs(p.ts);
      if (ms === null) continue;
      t.push(ms);
      v.push(p.value);
      q.push(p.quality);
    }
    return {
      measurement: s.measurement,
      name: s.name,
      unit: s.unit,
      nominalMin: s.nominal_min,
      nominalMax: s.nominal_max,
      t,
      v,
      q,
      truncated: s.truncated,
    };
  });
  const events: ReplayEvent[] = w.alarm_events
    .map((e) => {
      const alarm = alarms.get(e.alarm_id);
      return {
        id: e.id,
        alarmId: e.alarm_id,
        type: e.event_type,
        fromState: e.from_state,
        toState: e.to_state,
        ts: toMs(e.ts) ?? 0,
        actor: e.actor,
        value: e.value,
        note: e.note,
        severity: alarm?.severity ?? 'info',
        message: alarm?.message ?? `Alarm #${String(e.alarm_id)}`,
      };
    })
    .sort((a, b) => byTime(a, b) || a.id - b.id);
  const eventsByAlarm = new Map<number, ReplayEvent[]>();
  for (const e of events) {
    const list = eventsByAlarm.get(e.alarmId) ?? [];
    list.push(e);
    eventsByAlarm.set(e.alarmId, list);
  }
  const times = new Set<number>();
  for (const s of series) for (const ms of s.t) times.add(ms);
  return {
    vesselCode: w.vessel_code,
    vesselName: w.vessel_name,
    equipmentCode: w.equipment_code,
    equipmentName: w.equipment_name,
    from: toMs(w.from) ?? 0,
    to: toMs(w.to) ?? 0,
    series,
    stateChanges: w.state_changes
      .map((s) => ({ ts: toMs(s.ts) ?? 0, state: s.state }))
      .sort(byTime),
    stateAtStart: w.state_at_start,
    events,
    eventsByAlarm,
    alarms,
    gaps: w.gaps.map((g) => ({
      measurement: g.measurement,
      from: toMs(g.from) ?? 0,
      to: toMs(g.to) ?? 0,
      seconds: g.seconds,
    })),
    sampleTimes: [...times].sort((a, b) => a - b),
    pointCount: w.point_count,
    focusAlarmId: w.focus_alarm_id ?? null,
  };
}

export interface SampleAtCursor {
  index: number;
  ts: number;
  value: number | null;
  quality: Quality;
  /** How long before the cursor the sample was taken (ms, >= 0). */
  ageMs: number;
}

/** The last STORED sample at or before the cursor. Never interpolates; null when none exists yet. */
export function sampleAt(series: ReplaySeries, cursor: number): SampleAtCursor | null {
  const index = lastIndexAtOrBefore(series.t, cursor);
  if (index < 0) return null;
  const ts = series.t[index] ?? 0;
  return {
    index,
    ts,
    value: series.v[index] ?? null,
    quality: series.q[index] ?? 'good',
    ageMs: cursor - ts,
  };
}

export function stateAt(
  model: ReplayModel,
  cursor: number,
): { state: string | null; since: number | null } {
  let state = model.stateAtStart;
  let since: number | null = null;
  for (const change of model.stateChanges) {
    if (change.ts > cursor) break;
    state = change.state;
    since = change.ts;
  }
  return { state, since };
}

/** Lifecycle state of an alarm at the cursor, reconstructed from the transitions inside the window. */
export function alarmStateAt(
  model: ReplayModel,
  alarmId: number,
  cursor: number,
): AlarmState | null {
  const events = model.eventsByAlarm.get(alarmId) ?? [];
  let latest: ReplayEvent | undefined;
  for (const e of events) {
    if (e.ts > cursor) break;
    latest = e;
  }
  if (latest) return latest.toState;
  const first = events[0];
  if (first) return first.fromState; // before the first in-window transition
  const alarm = model.alarms.get(alarmId);
  if (!alarm) return null;
  const raised = toMs(alarm.raised_at);
  if (raised !== null && cursor < raised) return null;
  return alarm.state; // no transition inside the window: the alarm stayed in its recorded state
}

export interface OpenAlarm {
  alarm: AlarmOut;
  state: AlarmState;
}

export function alarmsOpenAt(model: ReplayModel, cursor: number): OpenAlarm[] {
  const out: OpenAlarm[] = [];
  for (const alarm of model.alarms.values()) {
    const state = alarmStateAt(model, alarm.id, cursor);
    if (state !== null && state !== 'cleared') out.push({ alarm, state });
  }
  return out.sort((a, b) => (toMs(a.alarm.raised_at) ?? 0) - (toMs(b.alarm.raised_at) ?? 0));
}

export type Phase = 'before' | 'during' | 'after';

export const PHASE_LABEL: Record<Phase, string> = {
  before: 'Before alarm',
  during: 'During alarm',
  after: 'After alarm (condition cleared)',
};

export function phaseAt(model: ReplayModel, cursor: number): Phase | null {
  if (model.focusAlarmId === null) return null;
  const state = alarmStateAt(model, model.focusAlarmId, cursor);
  if (state === null) return 'before';
  if (state === 'active_unacknowledged' || state === 'active_acknowledged') return 'during';
  return 'after';
}

export interface FocusTimes {
  raisedAt: number | null;
  clearedAt: number | null;
}

export function focusTimes(model: ReplayModel): FocusTimes {
  if (model.focusAlarmId === null) return { raisedAt: null, clearedAt: null };
  const events = model.eventsByAlarm.get(model.focusAlarmId) ?? [];
  const alarm = model.alarms.get(model.focusAlarmId);
  const raisedEvent = events.find((e) => e.type === 'raised');
  const clearedEvent = [...events].reverse().find((e) => e.type === 'cleared');
  const raisedAt = raisedEvent?.ts ?? toMs(alarm?.raised_at) ?? null;
  const clearedAt = clearedEvent?.ts ?? toMs(alarm?.cleared_at) ?? null;
  return {
    raisedAt: raisedAt !== null && raisedAt >= model.from && raisedAt <= model.to ? raisedAt : null,
    clearedAt:
      clearedAt !== null && clearedAt >= model.from && clearedAt <= model.to ? clearedAt : null,
  };
}

/** First time strictly after `t` in a sorted array, or null. */
export function nextAfter(times: readonly number[], t: number): number | null {
  let lo = 0;
  let hi = times.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = times[mid] ?? 0;
    if (value > t) {
      found = value;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/** Last time strictly before `t` in a sorted array, or null. */
export function prevBefore(times: readonly number[], t: number): number | null {
  let lo = 0;
  let hi = times.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = times[mid] ?? 0;
    if (value < t) {
      found = value;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Gap of this measurement that contains the cursor, if any. */
export function gapAt(model: ReplayModel, measurement: string, cursor: number): ReplayGap | null {
  return (
    model.gaps.find((g) => g.measurement === measurement && cursor > g.from && cursor < g.to) ??
    null
  );
}

export function isUsableQuality(quality: Quality): boolean {
  return quality === 'good' || quality === 'uncertain';
}

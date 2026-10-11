import { describe, expect, it } from 'vitest';
import { iso, makeAlarm, makeAlarmEvent, makeIncidentWindow, T0 } from '@/test/fixtures';
import { drawableSeries, eventMarkers, gapAreas, markerLabel } from './markers';
import {
  alarmStateAt,
  alarmsOpenAt,
  buildReplayModel,
  focusTimes,
  gapAt,
  nextAfter,
  phaseAt,
  prevBefore,
  sampleAt,
  stateAt,
} from './model';

const at = (s: number) => T0 + s * 1000;
const model = buildReplayModel(makeIncidentWindow());

describe('buildReplayModel', () => {
  it('parses series without resampling', () => {
    expect(model.series).toHaveLength(2);
    expect(model.series[0]?.t).toHaveLength(60);
    expect(model.series[1]?.t).toHaveLength(41);
    expect(model.from).toBe(at(0));
    expect(model.to).toBe(at(60));
    expect(model.focusAlarmId).toBe(7);
  });
  it('builds the union of sample times, sorted and unique', () => {
    expect(model.sampleTimes).toHaveLength(60);
    expect([...model.sampleTimes]).toEqual([...model.sampleTimes].sort((a, b) => a - b));
  });
  it('sorts events by time and attaches the alarm severity and message', () => {
    const shuffled = makeIncidentWindow();
    shuffled.alarm_events = [...shuffled.alarm_events].reverse();
    const m = buildReplayModel(shuffled);
    expect(m.events.map((e) => e.type)).toEqual(['raised', 'acknowledged', 'cleared']);
    expect(m.events[0]?.severity).toBe('warning');
    expect(m.events[0]?.message).toMatch(/Engine temperature/);
  });
});

describe('sampleAt: last stored sample, never interpolated', () => {
  const temp = model.series[0]!;
  const rpm = model.series[1]!;
  it('returns null before the first sample', () => {
    expect(sampleAt(temp, at(-5))).toBeNull();
  });
  it('returns the exact sample when the cursor is on it', () => {
    expect(sampleAt(temp, at(10))).toMatchObject({ ts: at(10), value: 85, ageMs: 0 });
  });
  it('returns the previous stored sample between samples with its true age', () => {
    const s = sampleAt(temp, at(10) + 600);
    expect(s?.ts).toBe(at(10));
    expect(s?.value).toBe(85); // not 85.3 or any blend with the next sample
    expect(s?.ageMs).toBe(600);
  });
  it('keeps returning the last sample before a data gap, with a growing age', () => {
    const s = sampleAt(rpm, at(33));
    expect(s?.ts).toBe(at(20));
    expect(s?.ageMs).toBe(13_000);
  });
  it('returns the final sample after the series ends', () => {
    expect(sampleAt(temp, at(60))?.ts).toBe(at(59));
  });
});

describe('gaps and drawing', () => {
  it('detects whether the cursor is inside a reported gap', () => {
    expect(gapAt(model, 'rpm', at(30))?.seconds).toBe(20);
    expect(gapAt(model, 'rpm', at(10))).toBeNull();
    expect(gapAt(model, 'temperature', at(30))).toBeNull();
  });
  it('breaks the line inside gaps with a null point and shades the gap', () => {
    const drawn = drawableSeries(model, model.series[1]!);
    expect(drawn.line.filter((p) => p[1] === null)).toHaveLength(1);
    expect(drawn.line.filter((p) => p[1] !== null)).toHaveLength(41);
    expect(gapAreas(model, 'rpm')).toEqual([{ from: at(20), to: at(40), label: 'no data' }]);
  });
  it('puts non-good samples on a separate flagged layer instead of the line', () => {
    const w = makeIncidentWindow();
    w.series[0]!.points[5] = { ts: iso(5), value: 500, quality: 'invalid' };
    const drawn = drawableSeries(buildReplayModel(w), buildReplayModel(w).series[0]!);
    expect(drawn.flagged).toEqual([[at(5), 500, 'invalid']]);
    expect(drawn.line.some((p) => p[1] === 500)).toBe(false);
  });
});

describe('equipment state at cursor', () => {
  it('uses state_at_start until the first change, then the latest change', () => {
    expect(stateAt(model, at(10))).toEqual({ state: 'RUNNING', since: null });
    expect(stateAt(model, at(35))).toEqual({ state: 'DEGRADED', since: at(35) });
    expect(stateAt(model, at(50)).state).toBe('DEGRADED');
  });
  it('is unknown when nothing was recorded before the window', () => {
    const m = buildReplayModel(makeIncidentWindow({ state_at_start: null, state_changes: [] }));
    expect(stateAt(m, at(10))).toEqual({ state: null, since: null });
  });
});

describe('alarm lifecycle at cursor', () => {
  it('reconstructs the state from in-window transitions', () => {
    expect(alarmStateAt(model, 7, at(10))).toBeNull(); // raised event has no from_state: not yet raised
    expect(alarmStateAt(model, 7, at(30))).toBe('active_unacknowledged');
    expect(alarmStateAt(model, 7, at(44))).toBe('active_unacknowledged');
    expect(alarmStateAt(model, 7, at(45))).toBe('active_acknowledged');
    expect(alarmStateAt(model, 7, at(58))).toBe('cleared');
  });
  it('lists only alarms that are still open', () => {
    expect(alarmsOpenAt(model, at(10))).toEqual([]);
    expect(alarmsOpenAt(model, at(40)).map((o) => o.state)).toEqual(['active_unacknowledged']);
    expect(alarmsOpenAt(model, at(58))).toEqual([]);
  });
  it('uses the first in-window transition to know the state before it (alarm raised before the window)', () => {
    const w = makeIncidentWindow({
      alarm_events: [
        makeAlarmEvent({ id: 21, event_type: 'cleared', from_state: 'active_unacknowledged', to_state: 'cleared_unacknowledged', ts: iso(20) }),
      ],
      alarms: [makeAlarm({ id: 7, raised_at: iso(-600), state: 'cleared_unacknowledged', condition_active: false, cleared_at: iso(20) })],
    });
    const m = buildReplayModel(w);
    expect(alarmStateAt(m, 7, at(5))).toBe('active_unacknowledged');
    expect(alarmStateAt(m, 7, at(25))).toBe('cleared_unacknowledged');
    expect(alarmsOpenAt(m, at(25))[0]?.state).toBe('cleared_unacknowledged');
  });
  it('falls back to the recorded state when no transition happened inside the window', () => {
    const m = buildReplayModel(
      makeIncidentWindow({ alarm_events: [], alarms: [makeAlarm({ id: 7, raised_at: iso(-60) })] }),
    );
    expect(alarmStateAt(m, 7, at(10))).toBe('active_unacknowledged');
  });
});

describe('phase and focus times', () => {
  it('derives before / during / after relative to the focus alarm', () => {
    expect(phaseAt(model, at(5))).toBe('before');
    expect(phaseAt(model, at(30))).toBe('during');
    expect(phaseAt(model, at(50))).toBe('during');
    expect(phaseAt(model, at(55))).toBe('after');
  });
  it('has no phase without a focus alarm', () => {
    expect(phaseAt(buildReplayModel(makeIncidentWindow({ focus_alarm_id: null })), at(30))).toBeNull();
  });
  it('finds raised and cleared times inside the window', () => {
    expect(focusTimes(model)).toEqual({ raisedAt: at(30), clearedAt: at(55) });
  });
  it('reports a missing cleared time for an alarm still active', () => {
    const w = makeIncidentWindow();
    w.alarm_events = w.alarm_events.slice(0, 1);
    w.alarms = [makeAlarm({ id: 7, raised_at: iso(30) })];
    expect(focusTimes(buildReplayModel(w))).toEqual({ raisedAt: at(30), clearedAt: null });
  });
});

describe('search helpers and markers', () => {
  const times = [10, 20, 30];
  it('finds strictly next and previous times', () => {
    expect(nextAfter(times, 20)).toBe(30);
    expect(nextAfter(times, 30)).toBeNull();
    expect(nextAfter(times, 5)).toBe(10);
    expect(prevBefore(times, 20)).toBe(10);
    expect(prevBefore(times, 10)).toBeNull();
    expect(prevBefore(times, 99)).toBe(30);
  });
  it('labels alarm events with a glyph, severity and verb', () => {
    expect(markerLabel(model.events[0]!)).toBe('▲ WARN raised');
    expect(eventMarkers(model).map((m) => m.lineType)).toEqual(['solid', 'dotted', 'dashed']);
  });
});

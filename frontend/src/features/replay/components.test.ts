import { describe, expect, it } from 'vitest';
import { makeIncidentWindow, T0 } from '@/test/fixtures';
import { buildReplayModel } from './model';
import { timelineEntries } from './EventTimeline';
import { stateSegments } from './StateStrip';
import { formatSampleAge } from './StateAtCursor';

const model = buildReplayModel(makeIncidentWindow());

describe('stateSegments', () => {
  it('covers the whole window with the start state first', () => {
    const s = stateSegments(model);
    expect(s).toEqual([
      { from: T0, to: T0 + 35_000, state: 'RUNNING' },
      { from: T0 + 35_000, to: T0 + 60_000, state: 'DEGRADED' },
    ]);
  });
  it('shows an unknown segment when no state was recorded before the window', () => {
    const m = buildReplayModel(makeIncidentWindow({ state_at_start: null }));
    expect(stateSegments(m)[0]).toMatchObject({ state: null });
  });
});

describe('timelineEntries', () => {
  it('merges alarm events and state changes chronologically', () => {
    const e = timelineEntries(model);
    expect(e.map((x) => `${x.kind}:${x.ts - T0}`)).toEqual([
      'alarm:30000',
      'state:35000',
      'alarm:45000',
      'alarm:55000',
    ]);
    expect(e[0]?.severityLabel).toBe('Warning');
  });
});

describe('formatSampleAge', () => {
  it('formats the distance between sample and cursor', () => {
    expect(formatSampleAge(0)).toBe('at the cursor');
    expect(formatSampleAge(400)).toBe('0.4 s before the cursor');
    expect(formatSampleAge(13_000)).toBe('13 s before the cursor');
    expect(formatSampleAge(125_000)).toBe('2 min 5 s before the cursor');
  });
});

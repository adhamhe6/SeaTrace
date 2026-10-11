import { describe, expect, it } from 'vitest';
import { makeReading } from '@/test/fixtures';
import { ALARM_STATE, comparisonSymbol, effectiveQuality, eventLabel } from './domain';
import { rangePosition, rangeStatus, readingFreshness } from './readings';

describe('alarm lifecycle descriptions', () => {
  it('describes the four states consistently with the backend semantics', () => {
    expect(ALARM_STATE.active_unacknowledged).toMatchObject({ conditionActive: true, acknowledged: false, needsAcknowledgement: true });
    expect(ALARM_STATE.active_acknowledged).toMatchObject({ conditionActive: true, acknowledged: true, needsAcknowledgement: false });
    expect(ALARM_STATE.cleared_unacknowledged).toMatchObject({ conditionActive: false, acknowledged: false, needsAcknowledgement: true });
    expect(ALARM_STATE.cleared).toMatchObject({ conditionActive: false, acknowledged: true, needsAcknowledgement: false });
    for (const info of Object.values(ALARM_STATE)) expect(info.explanation.length).toBeGreaterThan(30);
  });
  it('labels events and comparisons', () => {
    expect(eventLabel('cleared')).toBe('Returned to normal');
    expect(eventLabel('custom_thing')).toBe('custom thing');
    expect(comparisonSymbol('gt')).toBe('>');
    expect(comparisonSymbol('lt')).toBe('<');
    expect(comparisonSymbol('stale')).toBe('data stale');
    expect(comparisonSymbol('weird')).toBe('weird');
  });
  it('effectiveQuality prefers stale when locally stale', () => {
    expect(effectiveQuality(makeReading(), true)).toBe('stale');
    expect(effectiveQuality(makeReading({ quality: 'uncertain' }), false)).toBe('uncertain');
  });
});

describe('readingFreshness', () => {
  const now = Date.parse('2026-03-01T10:00:30Z');
  const at = (s: number) => new Date(Date.parse('2026-03-01T10:00:00Z') + s * 1000).toISOString();

  it('recomputes age locally from ingested_ts', () => {
    const r = readingFreshness(makeReading({ ingested_ts: at(25), age_s: 0.2 }), now, 10);
    expect(r.ageS).toBe(5);
    expect(r.stale).toBe(false);
    expect(r.quality).toBe('good');
  });
  it('turns stale locally once the age exceeds stale_after_s even without new messages', () => {
    const r = readingFreshness(makeReading({ ingested_ts: at(10), stale: false }), now, 10);
    expect(r.ageS).toBe(20);
    expect(r).toMatchObject({ stale: true, quality: 'stale' });
  });
  it('respects the server stale flag and missing samples', () => {
    expect(readingFreshness(makeReading({ ingested_ts: at(29), stale: true }), now, null).quality).toBe('stale');
    const never = readingFreshness(makeReading({ value: null, source_ts: null, ingested_ts: null, age_s: null, stale: true, quality: 'stale' }), now, 10);
    expect(never).toMatchObject({ ageS: null, stale: true });
  });
  it('without stale_after_s only the server flag decides', () => {
    expect(readingFreshness(makeReading({ ingested_ts: at(0), stale: false }), now, null).stale).toBe(false);
  });
});

describe('nominal range helpers', () => {
  it('positions values and classifies them', () => {
    expect(rangePosition(5, 0, 10)).toBe(0.5);
    expect(rangePosition(5, 5, 5)).toBe(0.5);
    expect(rangeStatus(11, 0, 10)).toBe('above');
    expect(rangeStatus(-1, 0, 10)).toBe('below');
    expect(rangeStatus(5, null, null)).toBe('within');
  });
});

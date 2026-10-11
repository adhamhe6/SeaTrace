import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatAxisTime,
  formatDuration,
  formatNumber,
  formatRelativeOffset,
  formatTimestamp,
  formatValue,
  localOffsetLabel,
  parseUtcInputValue,
  titleCase,
  toMs,
  toUtcInputValue,
  zoneLabel,
} from './format';

describe('formatTimestamp', () => {
  const ms = Date.parse('2026-03-01T09:05:07.042Z');
  it('renders UTC with an explicit label', () => {
    expect(formatTimestamp(ms, 'utc')).toBe('2026-03-01 09:05:07 UTC');
  });
  it('can include milliseconds and drop the date or zone', () => {
    expect(formatTimestamp(ms, 'utc', { millis: true })).toBe('2026-03-01 09:05:07.042 UTC');
    expect(formatTimestamp(ms, 'utc', { timeOnly: true, zone: false })).toBe('09:05:07');
  });
  it('renders local time with its offset label', () => {
    const text = formatTimestamp(ms, 'local');
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{1,2}(:\d{2})?$/);
  });
  it('returns a dash for missing or invalid input', () => {
    expect(formatTimestamp(null, 'utc')).toBe('—');
    expect(formatTimestamp('not a date', 'utc')).toBe('—');
  });
  it('accepts ISO strings and Date objects', () => {
    expect(formatTimestamp('2026-03-01T09:05:07Z', 'utc')).toBe('2026-03-01 09:05:07 UTC');
    expect(formatTimestamp(new Date(ms), 'utc', { zone: false })).toBe('2026-03-01 09:05:07');
  });
});

describe('zone labels', () => {
  it('labels UTC and local zones', () => {
    expect(zoneLabel('utc')).toBe('UTC');
    expect(zoneLabel('local', Date.now())).toBe(localOffsetLabel(Date.now()));
  });
  it('axis labels may include the date', () => {
    expect(formatAxisTime(Date.parse('2026-03-01T09:05:07Z'), 'utc', true)).toBe(
      '2026-03-01\n09:05:07',
    );
  });
});

describe('formatAge', () => {
  it.each([
    [null, 'no data'],
    [0.2, 'just now'],
    [3, '3 s ago'],
    [59.6, '60 s ago'],
    [60, '1 min ago'],
    [125, '2 min 5 s ago'],
    [3700, '1 h 2 min ago'],
    [200000, '2 d ago'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatAge(input)).toBe(expected);
  });
});

describe('numbers and durations', () => {
  it('formats numbers with adaptive precision and no grouping', () => {
    expect(formatNumber(82.5123)).toBe('82.51');
    expect(formatNumber(123.456)).toBe('123.5');
    expect(formatNumber(1234.56)).toBe('1235');
    expect(formatNumber(3, 3)).toBe('3');
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });
  it('formats values with units', () => {
    expect(formatValue(82.5, '°C')).toBe('82.5 °C');
    expect(formatValue(null, '°C')).toBe('—');
    expect(formatValue(5, null)).toBe('5');
  });
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(125)).toBe('2 min 5 s');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(5400)).toBe('1 h 30 min');
  });
  it('formats signed offsets', () => {
    const ref = 1_000_000;
    expect(formatRelativeOffset(ref - 30_000, ref)).toBe('T-00:30');
    expect(formatRelativeOffset(ref + 135_000, ref)).toBe('T+02:15');
    expect(formatRelativeOffset(ref + 3_725_000, ref)).toBe('T+01:02:05');
  });
});

describe('datetime-local helpers (always UTC)', () => {
  it('round-trips values', () => {
    const ms = Date.parse('2026-03-01T09:05:07Z');
    expect(toUtcInputValue(ms)).toBe('2026-03-01T09:05:07');
    expect(parseUtcInputValue('2026-03-01T09:05:07')).toBe(ms);
    expect(parseUtcInputValue('2026-03-01T09:05')).toBe(Date.parse('2026-03-01T09:05:00Z'));
  });
  it('rejects empty or malformed values', () => {
    expect(parseUtcInputValue('')).toBeNull();
    expect(parseUtcInputValue('01/03/2026 09:05')).toBeNull();
  });
  it('toMs handles nullish and invalid input', () => {
    expect(toMs(undefined)).toBeNull();
    expect(toMs('garbage')).toBeNull();
    expect(toMs(5)).toBe(5);
  });
  it('title-cases snake_case identifiers', () => {
    expect(titleCase('data_quality')).toBe('Data quality');
  });
});

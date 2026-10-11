import { describe, expect, it } from 'vitest';
import { parseReplayUrl, sourceToParams } from './urlState';

const parse = (q: string) => parseReplayUrl(new URLSearchParams(q));

describe('parseReplayUrl', () => {
  it('returns nothing for a bare /replay', () => {
    expect(parse('')).toEqual({ source: null, problem: null });
  });
  it('parses alarm deep links with default and custom context', () => {
    expect(parse('alarm=12').source).toEqual({ kind: 'alarm', alarmId: 12, before: 300, after: 300 });
    expect(parse('alarm=12&before=60&after=120').source).toEqual({ kind: 'alarm', alarmId: 12, before: 60, after: 120 });
  });
  it('clamps and sanitises context seconds', () => {
    expect(parse('alarm=1&before=99999&after=-4').source).toMatchObject({ before: 3600, after: 300 });
  });
  it('rejects invalid alarm ids', () => {
    expect(parse('alarm=abc').problem).toMatch(/valid alarm id/);
    expect(parse('alarm=0').source).toBeNull();
  });
  it('parses window deep links into normalised ISO times', () => {
    const { source } = parse('vessel=VES-001&equipment=ME1&from=2026-03-01T10:00:00Z&to=2026-03-01T10:05:00Z');
    expect(source).toEqual({
      kind: 'window',
      vessel: 'VES-001',
      equipment: 'ME1',
      from: '2026-03-01T10:00:00.000Z',
      to: '2026-03-01T10:05:00.000Z',
    });
  });
  it('explains unusable links', () => {
    expect(parse('vessel=VES-001').problem).toMatch(/needs vessel, equipment, from and to/);
    expect(parse('vessel=a&equipment=b&from=x&to=y').problem).toMatch(/not valid/);
    expect(parse('vessel=a&equipment=b&from=2026-03-01T10:05:00Z&to=2026-03-01T10:00:00Z').problem).toMatch(/earlier/);
  });
  it('round-trips through sourceToParams', () => {
    const source = parse('alarm=5&before=60').source!;
    expect(parse(sourceToParams(source).toString()).source).toEqual(source);
    expect(sourceToParams({ kind: 'alarm', alarmId: 5, before: 300, after: 300 }).toString()).toBe('alarm=5');
  });
});

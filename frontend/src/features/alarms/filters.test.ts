import { describe, expect, it } from 'vitest';
import {
  buildAlarmSearch,
  filtersToQuery,
  hasActiveFilters,
  parseAlarmFilters,
  utcInputToIso,
} from './filters';

const parse = (q: string) => parseAlarmFilters(new URLSearchParams(q));

describe('alarm filters <-> URL <-> API query', () => {
  it('defaults to the Open tab with no filters', () => {
    const f = parse('');
    expect(f).toMatchObject({ tab: 'open', severity: [], state: [], page: 1, limit: 25 });
    expect(hasActiveFilters(f)).toBe(false);
    expect(filtersToQuery(f)).toMatchObject({ open: true, limit: 25, offset: 0 });
  });
  it('maps the History tab to open=false', () => {
    expect(filtersToQuery(parse('tab=history')).open).toBe(false);
  });
  it('maps every filter into the API query', () => {
    const q = filtersToQuery(
      parse(
        'severity=critical&severity=warning&state=active_unacknowledged&vessel=VES-001&equipment=ME1&kind=data_quality&from=2026-03-01T10:00:00Z&to=2026-03-01T11:00:00Z&page=3&limit=50',
      ),
    );
    expect(q).toEqual({
      open: true,
      state: ['active_unacknowledged'],
      severity: ['critical', 'warning'],
      vessel: 'VES-001',
      equipment: 'ME1',
      kind: 'data_quality',
      from: '2026-03-01T10:00:00.000Z',
      to: '2026-03-01T11:00:00.000Z',
      limit: 50,
      offset: 100,
    });
  });
  it('ignores unknown values instead of passing them to the API', () => {
    const f = parse('severity=banana&state=nope&kind=x&limit=7&page=-2&from=junk');
    expect(f).toMatchObject({ severity: [], state: [], kind: '', limit: 25, page: 1, from: '' });
  });
  it('serialises back to a minimal query string', () => {
    const f = parse('tab=history&severity=critical&vessel=VES-002&page=2');
    expect(buildAlarmSearch(f).toString()).toBe(
      'tab=history&severity=critical&vessel=VES-002&page=2',
    );
    expect(buildAlarmSearch(parse('')).toString()).toBe('');
  });
  it('converts datetime-local input (UTC) to ISO', () => {
    expect(utcInputToIso('2026-03-01T10:00:00')).toBe('2026-03-01T10:00:00.000Z');
    expect(utcInputToIso('')).toBe('');
  });
});

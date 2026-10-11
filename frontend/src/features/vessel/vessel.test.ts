import { describe, expect, it } from 'vitest';
import type { HistoryResponse } from '@/api/types';
import { iso } from '@/test/fixtures';
import { toMeasurementSeries } from './Trends';

const base: HistoryResponse = {
  vessel_code: 'V', equipment_code: 'E', from: iso(0), to: iso(60), bucket_s: null, units: {}, items: [], buckets: [], next_cursor: null, truncated: false,
};

describe('toMeasurementSeries', () => {
  it('keeps usable samples on the line, breaks the line at bad samples and flags them separately', () => {
    const s = toMeasurementSeries(
      { ...base, items: [
        { ts: iso(1), measurement: 't', value: 80, quality: 'good' },
        { ts: iso(2), measurement: 't', value: 999, quality: 'invalid' },
        { ts: iso(3), measurement: 't', value: 82, quality: 'uncertain' },
        { ts: iso(3), measurement: 'other', value: 1, quality: 'good' },
      ] },
      't',
    );
    expect(s.line.map((p) => p[1])).toEqual([80, null, 82]);
    expect(s.flagged).toEqual([[Date.parse(iso(2)), 999, 'invalid']]);
    expect(s.band).toBeNull();
  });
  it('uses bucket averages with min/max for bucketed history', () => {
    const s = toMeasurementSeries(
      { ...base, bucket_s: 30, buckets: [
        { ts: iso(0), measurement: 't', avg: 80, min: 78, max: 82, samples: 30 },
        { ts: iso(30), measurement: 't', avg: null, min: null, max: null, samples: 0 },
      ] },
      't',
    );
    expect(s.line.map((p) => p[1])).toEqual([80, null]);
    expect(s.band?.min[0]?.[1]).toBe(78);
    expect(s.band?.max[0]?.[1]).toBe(82);
  });
});

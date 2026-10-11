import { describe, expect, it } from 'vitest';
import type { ChartPoint } from '@/ui/chart/chartOption';
import { breakAtGaps, detectGaps, lastIndexAtOrBefore } from './series';

describe('detectGaps', () => {
  it('finds intervals far longer than the typical cadence', () => {
    const times = [0, 1000, 2000, 3000, 20_000, 21_000, 22_000];
    expect(detectGaps(times)).toEqual([{ from: 3000, to: 20_000 }]);
  });
  it('ignores jitter and short series', () => {
    expect(detectGaps([0, 1000, 2100, 3000, 4500])).toEqual([]);
    expect(detectGaps([0, 10_000])).toEqual([]);
  });
});

describe('breakAtGaps', () => {
  it('inserts a null point inside each gap and keeps all real points', () => {
    const points: ChartPoint[] = [[0, 1], [1000, 2], [9000, 3]];
    const out = breakAtGaps(points, [{ from: 1000, to: 9000 }]);
    expect(out).toEqual([[0, 1], [1000, 2], [5000, null], [9000, 3]]);
  });
  it('returns a copy when there are no gaps', () => {
    const points: ChartPoint[] = [[0, 1]];
    expect(breakAtGaps(points, [])).toEqual(points);
  });
});

describe('lastIndexAtOrBefore', () => {
  const t = [10, 20, 30];
  it.each([
    [5, -1],
    [10, 0],
    [25, 1],
    [30, 2],
    [99, 2],
  ])('t=%s -> %s', (x, expected) => {
    expect(lastIndexAtOrBefore(t, x)).toBe(expected);
  });
  it('handles an empty array', () => {
    expect(lastIndexAtOrBefore([], 5)).toBe(-1);
  });
});

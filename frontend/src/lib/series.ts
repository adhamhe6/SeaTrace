import type { ChartPoint } from '@/ui/chart/chartOption';

export interface TimeGap {
  from: number;
  to: number;
}

/**
 * Intervals between consecutive samples that are much longer than the series' typical cadence
 * (same rule as the backend: max(3 s, 5 x median interval)). Used for drawing only.
 */
export function detectGaps(times: readonly number[], minGapMs = 3000, factor = 5): TimeGap[] {
  if (times.length < 3) return [];
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i += 1) deltas.push((times[i] ?? 0) - (times[i - 1] ?? 0));
  const sorted = [...deltas].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  const limit = Math.max(minGapMs, factor * median);
  const gaps: TimeGap[] = [];
  deltas.forEach((delta, i) => {
    if (delta > limit) gaps.push({ from: times[i] ?? 0, to: times[i + 1] ?? 0 });
  });
  return gaps;
}

/**
 * Inserts a null point inside each gap so the line is not drawn across missing data.
 * Purely a drawing aid: no value is invented.
 */
export function breakAtGaps(points: readonly ChartPoint[], gaps: readonly TimeGap[]): ChartPoint[] {
  if (gaps.length === 0) return [...points];
  const byStart = new Map(gaps.map((g) => [g.from, g]));
  const out: ChartPoint[] = [];
  points.forEach((point, i) => {
    out.push(point);
    const gap = byStart.get(point[0]);
    const next = points[i + 1];
    if (gap && next?.[0] === gap.to) out.push([point[0] + (gap.to - gap.from) / 2, null]);
  });
  return out;
}

/** Index of the last element with `times[i] <= t`, or -1 if every element is later. */
export function lastIndexAtOrBefore(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] ?? Number.POSITIVE_INFINITY) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

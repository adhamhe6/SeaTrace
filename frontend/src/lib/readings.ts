import type { LatestReading, Quality } from '@/api/types';
import { toMs } from './format';

export interface ReadingFreshness {
  /** Seconds since the backend stored the value; null when no sample has ever arrived. */
  ageS: number | null;
  stale: boolean;
  quality: Quality;
}

/**
 * Recomputes the age locally from `ingested_ts` so numbers visibly go stale even without any message,
 * falling back to the server-provided `age_s`/`stale` when timestamps are missing.
 */
export function readingFreshness(
  reading: LatestReading,
  nowMs: number,
  staleAfterS: number | null,
): ReadingFreshness {
  const ingested = toMs(reading.ingested_ts);
  let ageS: number | null;
  if (ingested !== null) ageS = Math.max(0, (nowMs - ingested) / 1000);
  else ageS = reading.age_s;
  const localStale = ageS !== null && staleAfterS !== null && ageS > staleAfterS;
  const stale = reading.stale || localStale || reading.value === null;
  const noSample = reading.ingested_ts === null && reading.source_ts === null;
  return {
    ageS: noSample ? null : ageS,
    stale,
    quality: stale && !noSample ? 'stale' : noSample ? 'stale' : reading.quality,
  };
}

/** Position of a value within a nominal range: 0..1 inside the band; <0 below, >1 above. */
export function rangePosition(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return (value - min) / (max - min);
}

export type RangeStatus = 'below' | 'within' | 'above';

export function rangeStatus(value: number, min: number | null, max: number | null): RangeStatus {
  if (min !== null && value < min) return 'below';
  if (max !== null && value > max) return 'above';
  return 'within';
}

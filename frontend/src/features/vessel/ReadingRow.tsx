import type { LatestReading } from '@/api/types';
import { formatAge, formatNumber } from '@/lib/format';
import { readingFreshness } from '@/lib/readings';
import { QualityBadge } from '@/ui/Badge';
import { cx } from '@/ui/cx';
import { RangeBar, Timestamp } from '@/ui/misc';

interface Props {
  reading: LatestReading;
  nowMs: number;
  staleAfterS: number | null;
}

export function ReadingRow({ reading, nowMs, staleAfterS }: Props) {
  const fresh = readingFreshness(reading, nowMs, staleAfterS);
  const noData = reading.source_ts === null && reading.ingested_ts === null;
  const showValue = reading.value !== null;
  return (
    <div className="reading" data-testid={`reading-${reading.measurement}`}>
      <div>
        <div style={{ fontWeight: 600 }}>{reading.name}</div>
        <div className="reading__meta mono">{reading.measurement}</div>
      </div>
      <div>
        <div className={cx('reading__value', fresh.stale && 'is-stale')}>
          <span data-testid="reading-value">{showValue ? formatNumber(reading.value) : '—'}</span>
          {showValue ? <span className="reading__unit">{reading.unit}</span> : null}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 2 }}>
          <QualityBadge quality={fresh.quality} />
        </div>
        <div className="reading__meta" style={{ marginTop: 3 }}>
          {noData ? (
            'No sample received yet'
          ) : (
            <>
              <span>
                Sampled <Timestamp value={reading.source_ts} />
              </span>
              <br />
              <span data-testid="reading-age">{formatAge(fresh.ageS)}</span>
              {fresh.stale ? ' — stale' : ''}
            </>
          )}
        </div>
      </div>
      <RangeBar
        value={reading.value}
        min={reading.nominal_min}
        max={reading.nominal_max}
        unit={reading.unit}
      />
    </div>
  );
}

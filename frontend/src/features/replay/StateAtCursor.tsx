import { Link } from 'react-router-dom';
import { ALARM_STATE } from '@/lib/domain';
import { formatDuration, formatNumber } from '@/lib/format';
import {
  Badge,
  AlarmStateBadge,
  EquipmentStateBadge,
  QualityBadge,
  SeverityBadge,
} from '@/ui/Badge';
import { Card } from '@/ui/Card';
import { Timestamp } from '@/ui/misc';
import { alarmsOpenAt, gapAt, sampleAt, stateAt, type ReplayModel } from './model';
import type { PlaybackStore } from './playback';
import { usePlaybackSnapshot } from './usePlayback';

export function formatSampleAge(ageMs: number): string {
  if (ageMs < 1) return 'at the cursor';
  if (ageMs < 60_000) return `${formatNumber(ageMs / 1000, 1)} s before the cursor`;
  return `${formatDuration(ageMs / 1000)} before the cursor`;
}

/**
 * Values at the cursor. Each row is the last STORED sample at or before the cursor: no interpolation, no
 * invented points. The sample's own timestamp and its age relative to the cursor are always shown.
 */
export function StateAtCursor({ model, store }: { model: ReplayModel; store: PlaybackStore }) {
  const { cursor } = usePlaybackSnapshot(store);
  const equipmentState = stateAt(model, cursor);
  const open = alarmsOpenAt(model, cursor);
  const noTelemetry = model.pointCount === 0;
  return (
    <Card
      title="State at cursor"
      subtitle="Last stored sample at or before the replay time"
      bodyClassName="stack"
    >
      <div className="row row--between">
        <span className="muted small">Equipment state</span>
        <span data-testid="equipment-state">
          <EquipmentStateBadge state={equipmentState.state} />
          {equipmentState.state === null ? (
            <span className="xs muted"> (no state recorded yet)</span>
          ) : equipmentState.since === null ? (
            <span className="xs muted"> (since before window)</span>
          ) : null}
        </span>
      </div>
      {noTelemetry ? (
        <p className="muted small" role="status">
          No stored telemetry in this window.
        </p>
      ) : (
        <ul className="cursor-values" aria-label="Measurements at cursor">
          {model.series.map((series) => {
            const sample = sampleAt(series, cursor);
            const gap = gapAt(model, series.measurement, cursor);
            return (
              <li
                key={series.measurement}
                className="cursor-values__item"
                data-testid={`cursor-${series.measurement}`}
              >
                <div className="cursor-values__name">{series.name}</div>
                {sample === null ? (
                  <div className="muted small">No sample yet at this position</div>
                ) : (
                  <>
                    <div className="cursor-values__value tnum">
                      <span data-testid="cursor-value">
                        {sample.value === null ? '—' : formatNumber(sample.value)}
                      </span>
                      <span className="reading__unit">{series.unit}</span>
                      <span style={{ marginLeft: 8 }}>
                        <QualityBadge quality={sample.quality} />
                      </span>
                    </div>
                    <div className="xs muted">
                      Sampled <Timestamp value={sample.ts} millis /> ·{' '}
                      <span data-testid="cursor-sample-age">{formatSampleAge(sample.ageMs)}</span>
                    </div>
                    {gap ? (
                      <div className="xs">
                        <Badge tone="offline">
                          Inside a data gap of {formatNumber(gap.seconds, 1)} s: no newer sample
                          stored
                        </Badge>
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <h3 className="small" style={{ marginBottom: 6 }}>
          Alarms open at this time
        </h3>
        {open.length === 0 ? (
          <p className="muted small">No alarm was open at this position.</p>
        ) : (
          <ul className="cursor-alarms" aria-label="Open alarms at cursor">
            {open.map(({ alarm, state }) => (
              <li key={alarm.id}>
                <div className="badges">
                  <SeverityBadge severity={alarm.severity} />
                  <AlarmStateBadge state={state} />
                </div>
                <Link to={`/alarms/${String(alarm.id)}`} className="small">
                  #{alarm.id} {alarm.message}
                </Link>
                <div className="xs muted">
                  {ALARM_STATE[state].conditionActive
                    ? 'Condition active'
                    : 'Condition returned to normal'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

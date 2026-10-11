import { FlaskConical } from 'lucide-react';
import { useAnomaly } from '@/api/hooks';
import type { AnomalyAssessment } from '@/api/types';
import type { Tone } from '@/lib/domain';
import { formatNumber } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Card } from '@/ui/Card';
import { Timestamp } from '@/ui/misc';
import { Skeleton } from '@/ui/Skeleton';
import { ErrorState } from '@/ui/states';

const STATUS: Record<AnomalyAssessment['status'], { label: string; tone: Tone }> = {
  normal: { label: 'Normal', tone: 'ok' },
  watch: { label: 'Watch', tone: 'warning' },
  anomaly: { label: 'Anomaly', tone: 'critical' },
  insufficient_data: { label: 'Insufficient data', tone: 'offline' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};

const FEATURE_LABEL: Record<string, string> = {
  vibration_z: 'Vibration deviation (robust sigma)',
  vibration_recent_mean: 'Vibration, recent mean (mm/s)',
  vibration_reference_median: 'Vibration, baseline median (mm/s)',
  vibration_sigma: 'Vibration, baseline spread (mm/s)',
  temp_slope_c_per_min: 'Temperature trend (°C/min)',
  temp_slope_t: 'Temperature trend, t-statistic',
  reference_samples: 'Baseline samples',
  recent_samples: 'Recent samples',
  temperature_samples: 'Temperature samples',
};

function ScoreMeter({ score, tone }: { score: number; tone: Tone }) {
  const pct = Math.min(100, Math.max(0, score * 100));
  return (
    <div>
      <div
        role="meter"
        aria-label="Anomaly score"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={score}
        aria-valuetext={`${formatNumber(score, 2)} out of 1`}
        className={`st-tone-${tone}`}
        style={{ height: 10, borderRadius: 5, background: 'var(--surface-3)', overflow: 'hidden' }}
      >
        <div style={{ width: `${String(pct)}%`, height: '100%', background: 'var(--tone-fg)' }} />
      </div>
      <p className="small tnum" style={{ marginTop: 4 }}>
        Score <strong data-testid="anomaly-score">{formatNumber(score, 2)}</strong> of 1.00
        <span className="muted"> (0 = nominal, 1 = strongest combined drift)</span>
      </p>
    </div>
  );
}

export function AnomalyPanel({ vesselCode }: { vesselCode: string }) {
  const { data, isPending, isError, error, refetch, isRefetching } = useAnomaly(vesselCode);
  return (
    <Card
      title="Anomaly insight (experimental)"
      subtitle="Explainable statistical heuristic for the main engine, refreshed every 5 s"
      icon={FlaskConical}
    >
      {isPending ? (
        <Skeleton height={90} />
      ) : isError ? (
        <ErrorState
          error={error}
          title="Could not load the anomaly assessment"
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      ) : (
        <AnomalyBody a={data} />
      )}
    </Card>
  );
}

function AnomalyBody({ a }: { a: AnomalyAssessment }) {
  const status = STATUS[a.status];
  const features = Object.entries(a.features);
  const hasScore = a.status !== 'insufficient_data' && a.status !== 'not_applicable';
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="small muted">
          {a.equipment_code} · evaluated <Timestamp value={a.evaluated_at} />
        </span>
        {a.alarm_active ? <Badge tone="critical">Alarm already active</Badge> : null}
      </div>
      {a.status === 'insufficient_data' ? (
        <p className="small" role="status">
          Not enough recent telemetry to assess this engine yet. The assessment needs a baseline of
          stored samples and fresh data; it will appear automatically once enough has been
          collected.
        </p>
      ) : null}
      {a.status === 'not_applicable' ? (
        <p className="small">No anomaly model applies to this vessel.</p>
      ) : null}
      {hasScore ? <ScoreMeter score={a.score} tone={status.tone} /> : null}
      <p className="small" data-testid="anomaly-explanation">
        {a.explanation}
      </p>
      {features.length > 0 ? (
        <table className="st-table" aria-label="Anomaly features">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col" className="is-right">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {features.map(([key, value]) => (
              <tr key={key}>
                <td>{FEATURE_LABEL[key] ?? key}</td>
                <td className="is-right is-mono">
                  {value === null ? '—' : formatNumber(value, 3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="xs muted">{a.disclaimer}</p>
    </div>
  );
}

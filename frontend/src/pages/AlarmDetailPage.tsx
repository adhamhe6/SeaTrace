import {
  ArrowRightLeft,
  Check,
  CircleCheck,
  History,
  RotateCcw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAlarm } from '@/api/hooks';
import type { AlarmEventOut } from '@/api/types';
import { AcknowledgeDialog } from '@/features/alarms/AcknowledgeDialog';
import { AckButton, ConditionIndicator } from '@/features/alarms/parts';
import { ALARM_STATE, KIND_LABEL, comparisonSymbol, eventLabel } from '@/lib/domain';
import { isNotFound } from '@/lib/errors';
import { formatNumber, formatValue, toMs } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { AlarmStateBadge, SeverityBadge } from '@/ui/Badge';
import { ButtonLink } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { KeyValue, Timestamp } from '@/ui/misc';
import { Skeleton } from '@/ui/Skeleton';
import { ErrorState } from '@/ui/states';
import './pages.css';

const EVENT_ICON: Record<string, LucideIcon> = {
  raised: TriangleAlert,
  acknowledged: Check,
  cleared: CircleCheck,
  reactivated: RotateCcw,
};

const EVENT_TONE: Record<string, string> = {
  raised: 'critical',
  acknowledged: 'info',
  cleared: 'ok',
  reactivated: 'warning',
};

export function sortEvents(events: readonly AlarmEventOut[]): AlarmEventOut[] {
  return [...events].sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0) || a.id - b.id);
}

function History_({ events }: { events: readonly AlarmEventOut[] }) {
  const sorted = sortEvents(events);
  if (sorted.length === 0) return <p className="muted small">No transitions recorded.</p>;
  return (
    <ol className="timeline" aria-label="Alarm history, oldest first">
      {sorted.map((e) => {
        const Icon = EVENT_ICON[e.event_type] ?? ArrowRightLeft;
        return (
          <li
            key={e.id}
            className={`timeline__item st-tone-${EVENT_TONE[e.event_type] ?? 'neutral'}`}
          >
            <span className="timeline__dot">
              <Icon size={14} aria-hidden="true" />
            </span>
            <div className="timeline__title">
              <span>{eventLabel(e.event_type)}</span>
              <Timestamp value={e.ts} millis />
            </div>
            <p className="small muted">
              by <strong>{e.actor}</strong>
              {e.from_state ? ` · ${ALARM_STATE[e.from_state].label} → ` : ' · → '}
              {ALARM_STATE[e.to_state].label}
              {e.value !== null ? ` · value ${formatNumber(e.value)}` : ''}
            </p>
            {e.note ? <p className="small">Note: “{e.note}”</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function AlarmDetailPage() {
  const { id: rawId = '' } = useParams();
  const id = Number(rawId);
  const alarm = useAlarm(id);
  const [acking, setAcking] = useState(false);
  usePageTitle(`Alarm #${rawId}`);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <Card>
        <ErrorState
          error={new Error(`"${rawId}" is not a valid alarm id.`)}
          title="Invalid alarm id"
        />
      </Card>
    );
  }
  if (alarm.isPending) {
    return (
      <div className="stack" role="status" aria-label="Loading alarm">
        <Skeleton height={32} width="50%" />
        <Skeleton height={160} />
      </div>
    );
  }
  if (alarm.isError) {
    return (
      <Card>
        <ErrorState
          error={alarm.error}
          title={
            isNotFound(alarm.error) ? `Alarm #${String(id)} was not found` : 'Could not load alarm'
          }
          onRetry={() => void alarm.refetch()}
          retrying={alarm.isRefetching}
        />
      </Card>
    );
  }

  const a = alarm.data;
  const info = ALARM_STATE[a.state];
  const rule =
    a.comparison === 'gt' || a.comparison === 'lt'
      ? `${a.measurement ?? 'value'} ${comparisonSymbol(a.comparison)} ${formatValue(a.threshold, a.unit)}`
      : comparisonSymbol(a.comparison);
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <p className="xs muted">
            <Link to="/alarms">Alarm center</Link> / #{a.id}
          </p>
          <h1>{a.message}</h1>
          <div className="badges">
            <SeverityBadge severity={a.severity} />
            <AlarmStateBadge state={a.state} />
            <ConditionIndicator alarm={a} />
          </div>
        </div>
        <div className="page-head__actions">
          <AckButton
            alarm={a}
            onAcknowledge={() => {
              setAcking(true);
            }}
          />
          <ButtonLink icon={History} to={`/replay?alarm=${String(a.id)}`}>
            Replay incident
          </ButtonLink>
        </div>
      </div>

      <p className={`explain st-tone-${info.tone}`} data-testid="state-explanation">
        <strong>{info.label}.</strong> {info.explanation}
      </p>

      <div className="grid grid--2">
        <Card title="Details" headingLevel={2}>
          <KeyValue
            items={[
              {
                label: 'Vessel',
                value: <Link to={`/vessels/${a.vessel_code}`}>{a.vessel_name}</Link>,
              },
              { label: 'Equipment', value: `${a.equipment_name} (${a.equipment_code})` },
              { label: 'Measurement', value: a.measurement ?? '—' },
              { label: 'Kind', value: KIND_LABEL[a.kind] },
              {
                label: 'Rule',
                value: (
                  <span>
                    <span className="mono">{a.rule.code}</span> — {a.rule.name}
                  </span>
                ),
              },
              { label: 'Condition', value: <span className="mono">{rule}</span> },
              {
                label: 'Trigger value',
                value: (
                  <span>
                    <span className="tnum">{formatValue(a.trigger_value, a.unit)}</span> at{' '}
                    <Timestamp value={a.trigger_ts} millis />
                  </span>
                ),
              },
              {
                label: 'Last value',
                value: a.last_value_ts ? (
                  <span>
                    <span className="tnum">{formatValue(a.last_value, a.unit)}</span> at{' '}
                    <Timestamp value={a.last_value_ts} millis />
                  </span>
                ) : (
                  '—'
                ),
              },
              { label: 'Raised', value: <Timestamp value={a.raised_at} millis /> },
              {
                label: 'Returned to normal',
                value: a.cleared_at ? (
                  <Timestamp value={a.cleared_at} millis />
                ) : (
                  'Condition still active'
                ),
              },
              {
                label: 'Acknowledged',
                value: a.acknowledged_at ? (
                  <span>
                    by {a.acknowledged_by ?? 'unknown'} at{' '}
                    <Timestamp value={a.acknowledged_at} millis />
                  </span>
                ) : (
                  'Not acknowledged'
                ),
              },
              { label: 'Occurrences', value: <span className="tnum">{a.occurrence_count}</span> },
            ]}
          />
        </Card>
        <Card title="History" subtitle="State transitions in chronological order" icon={History}>
          <History_ events={a.events} />
        </Card>
      </div>
      <AcknowledgeDialog
        alarm={acking ? a : null}
        onClose={() => {
          setAcking(false);
        }}
      />
    </div>
  );
}

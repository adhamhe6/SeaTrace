import { ArrowRight, Boxes, FlaskConical, Radio, Ship, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useFleetSummary, useRecentEvents, useSimulatorStatus, useVessels } from '@/api/hooks';
import type { AlarmCounts, FleetSummary, Health, RecentEvent, VesselSummary } from '@/api/types';
import { HEALTH, SEVERITY } from '@/lib/domain';
import { titleCase } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { Badge, CommunicationBadge, HealthBadge, SeverityBadge } from '@/ui/Badge';
import { Banner } from '@/ui/Banner';
import { Card } from '@/ui/Card';
import { DataTable, type Column } from '@/ui/DataTable';
import { Skeleton } from '@/ui/Skeleton';
import { EmptyState, ErrorState } from '@/ui/states';
import { RelativeAge, Stat, Timestamp } from '@/ui/misc';
import './pages.css';

const HEALTH_ORDER: Health[] = ['offline', 'critical', 'warning', 'normal'];

/** Headline priority: an active critical condition outranks missing data, which outranks a warning. */
const HEADLINE_PRIORITY: Record<Health, number> = {
  normal: 0,
  warning: 1,
  offline: 2,
  critical: 3,
};

export function worstHealth(counts: Record<string, number>): Health {
  let worst: Health = 'normal';
  for (const [key, count] of Object.entries(counts)) {
    if (count > 0 && key in HEADLINE_PRIORITY) {
      const health = key as Health;
      if (HEADLINE_PRIORITY[health] > HEADLINE_PRIORITY[worst]) worst = health;
    }
  }
  return worst;
}

function totalOpen(counts: AlarmCounts): number {
  return counts.info + counts.warning + counts.critical;
}

function FleetStatusBanner({ summary }: { summary: FleetSummary }) {
  const worst = worstHealth(summary.vessels_by_health);
  const d = HEALTH[worst];
  const detail = HEALTH_ORDER.filter((h) => (summary.vessels_by_health[h] ?? 0) > 0)
    .map((h) => `${String(summary.vessels_by_health[h])} ${HEALTH[h].label.toLowerCase()}`)
    .join(', ');
  const label = worst === 'offline' ? 'Telemetry offline' : d.label;
  const tone = worst === 'offline' ? 'offline' : d.tone;
  return (
    <Banner
      tone={tone}
      title={`Fleet status: ${label}.`}
      role={worst === 'critical' ? 'alert' : 'status'}
    >
      {summary.vessels_total} {summary.vessels_total === 1 ? 'vessel' : 'vessels'} (
      {detail || 'no status'}).
      {summary.opcua_state !== 'connected'
        ? ` Source connection: ${summary.opcua_state}. Values shown may be out of date.`
        : ''}
    </Banner>
  );
}

function CountBadges({ counts }: { counts: Record<string, number> }) {
  return (
    <div className="badges">
      {HEALTH_ORDER.map((h) => {
        const n = counts[h] ?? 0;
        return n > 0 || h === 'normal' ? (
          <Badge key={h} tone={HEALTH[h].tone} icon={HEALTH[h].icon}>
            {n} {HEALTH[h].label}
          </Badge>
        ) : null;
      })}
    </div>
  );
}

function SummaryCards({ summary }: { summary: FleetSummary }) {
  const open = summary.open_alarms;
  return (
    <div className="grid grid--stats">
      <Card
        title="Open alarms"
        icon={TriangleAlert}
        subtitle="Includes alarms that returned to normal but await acknowledgement"
      >
        <div className="stack stack--sm">
          <Stat
            label="Total open"
            value={totalOpen(open)}
            sub={`${String(open.unacknowledged)} unacknowledged`}
          />
          <div className="badges">
            {(['critical', 'warning', 'info'] as const).map((s) => (
              <Badge key={s} tone={SEVERITY[s].tone} icon={SEVERITY[s].icon}>
                {open[s]} {SEVERITY[s].label}
              </Badge>
            ))}
          </div>
        </div>
      </Card>
      <Card title="Equipment condition" icon={Boxes}>
        <div className="stack stack--sm">
          <Stat label="Equipment items" value={summary.equipment_total} />
          <CountBadges counts={summary.equipment_by_health} />
        </div>
      </Card>
      <Card title="Telemetry and communication" icon={Radio}>
        <div className="stack stack--sm">
          <div className="badges">
            <Badge tone="ok">{summary.communication.online ?? 0} Online</Badge>
            <Badge tone="warning">{summary.communication.degraded ?? 0} Degraded</Badge>
            <Badge tone="offline">{summary.communication.offline ?? 0} Offline</Badge>
          </div>
          <p className="small">
            OPC UA source: <strong data-testid="fleet-opcua">{summary.opcua_state}</strong>
          </p>
          <p className="small muted">
            Last data: <RelativeAge value={summary.last_data_at} fallback="none received" />
          </p>
        </div>
      </Card>
      <Card title="Active scenarios" icon={FlaskConical}>
        <Stat
          label="Running now"
          value={summary.active_scenarios}
          sub={
            summary.active_scenarios === 0
              ? 'Simulation is running nominally'
              : 'Fault scenarios injected'
          }
        />
      </Card>
    </div>
  );
}

function ScenarioNotice({ count }: { count: number }) {
  const status = useSimulatorStatus();
  const active = status.data?.active_scenarios ?? [];
  if (count === 0 && active.length === 0) return null;
  return (
    <Banner tone="warning" title="Fault scenarios are active.">
      {active.length > 0
        ? active
            .map((s) => `${titleCase(s.scenario_id)}${s.vessel_code ? ` on ${s.vessel_code}` : ''}`)
            .join('; ')
        : `${String(count)} scenario(s) running.`}{' '}
      Alarms and degraded readings below are expected results of the simulation.{' '}
      <Link to="/simulator">Simulator controls</Link>
    </Banner>
  );
}

function OpenAlarmBadges({ counts }: { counts: AlarmCounts }) {
  if (totalOpen(counts) === 0) return <span className="muted">None</span>;
  return (
    <div className="badges">
      {(['critical', 'warning', 'info'] as const).map((s) =>
        counts[s] > 0 ? (
          <Badge key={s} tone={SEVERITY[s].tone} icon={SEVERITY[s].icon}>
            {counts[s]} {SEVERITY[s].label}
          </Badge>
        ) : null,
      )}
      {counts.unacknowledged > 0 ? (
        <Badge tone="neutral">{counts.unacknowledged} unack.</Badge>
      ) : null}
    </div>
  );
}

const VESSEL_COLUMNS: Column<VesselSummary>[] = [
  {
    key: 'name',
    header: 'Vessel',
    cell: (v) => (
      <div>
        <Link to={`/vessels/${v.code}`} className="link-plain">
          {v.name}
        </Link>
        <div className="muted xs">
          <span className="mono">{v.code}</span> · {v.vessel_type}
        </div>
      </div>
    ),
  },
  { key: 'health', header: 'Health', cell: (v) => <HealthBadge health={v.health} /> },
  {
    key: 'comm',
    header: 'Communication',
    cell: (v) => <CommunicationBadge communication={v.communication} />,
  },
  { key: 'eq', header: 'Equipment', align: 'right', mono: true, cell: (v) => v.equipment_count },
  { key: 'alarms', header: 'Open alarms', cell: (v) => <OpenAlarmBadges counts={v.open_alarms} /> },
  {
    key: 'age',
    header: 'Last data',
    cell: (v) => <RelativeAge value={v.last_data_at} fallback="no data yet" />,
  },
  {
    key: 'open',
    header: <span className="sr-only">Open</span>,
    label: 'Details',
    cell: (v) => (
      <Link to={`/vessels/${v.code}`} aria-label={`Open ${v.name}`}>
        Details <ArrowRight size={13} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
      </Link>
    ),
  },
];

function VesselInventory() {
  const { data, isPending, isError, error, refetch, isRefetching } = useVessels();
  return (
    <Card title="Vessel inventory" icon={Ship} flush>
      {isError ? (
        <ErrorState
          error={error}
          title="Could not load vessels"
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      ) : (
        <DataTable
          caption="Vessel inventory"
          columns={VESSEL_COLUMNS}
          rows={data}
          loading={isPending}
          getRowKey={(v) => v.code}
          empty={
            <EmptyState title="No vessels configured">
              The backend reports an empty fleet.
            </EmptyState>
          }
        />
      )}
    </Card>
  );
}

function EventFeedItem({ event }: { event: RecentEvent }) {
  return (
    <li className="feed__item">
      <Timestamp value={event.at} />
      <div>
        <div className="feed__meta">
          <SeverityBadge severity={event.severity} />
          <span>{titleCase(event.type)}</span>
          {event.vessel_code ? (
            <span className="mono">
              {event.vessel_code}
              {event.equipment_code ? `/${event.equipment_code}` : ''}
            </span>
          ) : null}
        </div>
        <p>
          {event.message}{' '}
          {event.alarm_id !== null && event.alarm_id !== undefined ? (
            <Link to={`/alarms/${String(event.alarm_id)}`}>Alarm #{event.alarm_id}</Link>
          ) : null}
        </p>
      </div>
    </li>
  );
}

function RecentEvents() {
  const { data, isPending, isError, error, refetch, isRefetching } = useRecentEvents(15);
  return (
    <Card title="Recent events" subtitle="Alarms, scenario commands and connectivity changes" flush>
      {isPending ? (
        <div style={{ padding: 'var(--s-4)' }}>
          <Skeleton height={14} />
        </div>
      ) : isError ? (
        <ErrorState
          error={error}
          title="Could not load events"
          onRetry={() => void refetch()}
          retrying={isRefetching}
        />
      ) : data.length === 0 ? (
        <EmptyState title="No events yet">
          Events appear here when alarms are raised or scenarios are run.
        </EmptyState>
      ) : (
        <ul className="feed" aria-label="Recent events">
          {data.map((event) => (
            <EventFeedItem key={event.id} event={event} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function FleetPage() {
  usePageTitle('Fleet overview');
  const summary = useFleetSummary();
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Fleet overview</h1>
          <p className="page-head__sub">
            Condition, communication and open alarms across all simulated vessels.
          </p>
        </div>
      </div>
      {summary.isPending ? (
        <Skeleton height={48} />
      ) : summary.isError ? (
        <Card>
          <ErrorState
            error={summary.error}
            title="Could not load fleet status"
            onRetry={() => void summary.refetch()}
            retrying={summary.isRefetching}
          />
        </Card>
      ) : (
        <>
          <FleetStatusBanner summary={summary.data} />
          <ScenarioNotice count={summary.data.active_scenarios} />
          <SummaryCards summary={summary.data} />
        </>
      )}
      <VesselInventory />
      <RecentEvents />
    </div>
  );
}

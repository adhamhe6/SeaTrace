import { Ship } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useSystemStatus, useVessel } from '@/api/hooks';
import { AnomalyPanel } from '@/features/vessel/AnomalyPanel';
import { Trends } from '@/features/vessel/Trends';
import { EquipmentPanel } from '@/features/vessel/EquipmentPanel';
import { isNotFound } from '@/lib/errors';
import { titleCase } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { useNow } from '@/lib/useNow';
import { CommunicationBadge, HealthBadge } from '@/ui/Badge';
import { Card } from '@/ui/Card';
import { KeyValue, RelativeAge } from '@/ui/misc';
import { Skeleton } from '@/ui/Skeleton';
import { EmptyState, ErrorState } from '@/ui/states';
import { ButtonLink } from '@/ui/Button';
import './pages.css';

export default function VesselPage() {
  const { code = '' } = useParams();
  const vessel = useVessel(code);
  const system = useSystemStatus();
  const now = useNow();
  usePageTitle(vessel.data ? vessel.data.name : `Vessel ${code}`);

  if (vessel.isPending) {
    return (
      <div className="stack" role="status" aria-label="Loading vessel">
        <Skeleton height={32} width="40%" />
        <Skeleton height={120} />
        <div className="grid grid--cards">
          <Skeleton height={260} />
          <Skeleton height={260} />
        </div>
      </div>
    );
  }
  if (vessel.isError) {
    return (
      <Card>
        <ErrorState
          error={vessel.error}
          title={
            isNotFound(vessel.error) ? `Vessel ${code} was not found` : 'Could not load vessel'
          }
          onRetry={() => void vessel.refetch()}
          retrying={vessel.isRefetching}
          hint={
            isNotFound(vessel.error)
              ? 'Check the vessel code or pick a vessel from the navigation.'
              : undefined
          }
        />
        <div
          className="st-state__actions"
          style={{ justifyContent: 'center', paddingBottom: 'var(--s-4)' }}
        >
          <ButtonLink to="/">Back to fleet overview</ButtonLink>
        </div>
      </Card>
    );
  }

  const v = vessel.data;
  const staleAfter = system.data?.stale_after_s ?? null;
  const open = v.open_alarms;
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <p className="xs muted">
            <Link to="/">Fleet overview</Link> / {v.code}
          </p>
          <h1>{v.name}</h1>
        </div>
        <div className="page-head__actions">
          <HealthBadge health={v.health} />
          <CommunicationBadge communication={v.communication} />
        </div>
      </div>

      <Card title="Identification" icon={Ship}>
        <KeyValue
          items={[
            { label: 'Vessel code', value: <span className="mono">{v.code}</span> },
            { label: 'Vessel type', value: v.vessel_type },
            { label: 'Data source', value: 'Simulated (SeaTrace OPC UA simulator)' },
            {
              label: 'Equipment',
              value: `${String(v.equipment_count)} items: ${v.equipment.map((e) => titleCase(e.type)).join(', ')}`,
            },
            {
              label: 'Open alarms',
              value:
                open.critical + open.warning + open.info === 0 ? (
                  'None'
                ) : (
                  <Link to={`/alarms?vessel=${encodeURIComponent(v.code)}`}>
                    {open.critical} critical, {open.warning} warning, {open.info} info (
                    {open.unacknowledged} unacknowledged)
                  </Link>
                ),
            },
            {
              label: 'Last data',
              value: <RelativeAge value={v.last_data_at} fallback="none received yet" />,
            },
          ]}
        />
      </Card>

      {v.equipment.length === 0 ? (
        <Card>
          <EmptyState title="No equipment">
            This vessel has no equipment in the inventory.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid--cards" aria-label="Equipment inventory">
            {v.equipment.map((eq) => (
              <EquipmentPanel
                key={eq.code}
                vesselCode={v.code}
                equipment={eq}
                nowMs={now}
                staleAfterS={staleAfter}
              />
            ))}
          </div>
          <AnomalyPanel vesselCode={v.code} />
          <Trends vessel={v} />
        </>
      )}
    </div>
  );
}

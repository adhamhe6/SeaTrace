import { Cpu } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { EquipmentDetail } from '@/api/types';
import { CommunicationBadge, EquipmentStateBadge, HealthBadge } from '@/ui/Badge';
import { Card } from '@/ui/Card';
import { RelativeAge } from '@/ui/misc';
import { titleCase } from '@/lib/format';
import { ReadingRow } from './ReadingRow';

interface Props {
  vesselCode: string;
  equipment: EquipmentDetail;
  nowMs: number;
  staleAfterS: number | null;
}

export function EquipmentPanel({ vesselCode, equipment, nowMs, staleAfterS }: Props) {
  return (
    <Card
      title={
        <>
          {equipment.name} <span className="muted mono small">{equipment.code}</span>
        </>
      }
      subtitle={
        titleCase(equipment.type) === equipment.name ? undefined : titleCase(equipment.type)
      }
      icon={Cpu}
      headingLevel={3}
      actions={<EquipmentStateBadge state={equipment.state} />}
      id={`equipment-${equipment.code}`}
    >
      <div className="stack stack--sm">
        <div className="badges">
          <HealthBadge health={equipment.health} />
          <CommunicationBadge communication={equipment.communication} />
          {equipment.sensor_health ? (
            <span className="xs muted">Sensor health: {equipment.sensor_health}</span>
          ) : null}
        </div>
        <p className="xs muted">
          {equipment.open_alarms > 0 ? (
            <Link
              to={`/alarms?vessel=${encodeURIComponent(vesselCode)}&equipment=${encodeURIComponent(equipment.code)}`}
            >
              {equipment.open_alarms} open {equipment.open_alarms === 1 ? 'alarm' : 'alarms'}
              {equipment.unacknowledged_alarms > 0
                ? ` (${String(equipment.unacknowledged_alarms)} unacknowledged)`
                : ''}
            </Link>
          ) : (
            'No open alarms'
          )}
          {' · '}last data <RelativeAge value={equipment.last_data_at} fallback="none yet" />
        </p>
        <div className="readings" role="list" aria-label={`${equipment.name} latest readings`}>
          {equipment.readings.map((reading) => (
            <div role="listitem" key={reading.measurement} style={{ display: 'contents' }}>
              <ReadingRow reading={reading} nowMs={nowMs} staleAfterS={staleAfterS} />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

import { RadioTower } from 'lucide-react';
import type { OpcUaStatus, SimulatorStatus, SystemStatus } from '@/api/types';
import { formatNumber } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Card } from '@/ui/Card';
import { KeyValue, RelativeAge, Timestamp } from '@/ui/misc';
import type { Tone } from '@/lib/domain';

const TONE: Record<OpcUaStatus['state'], Tone> = {
  connected: 'ok',
  connecting: 'warning',
  backoff: 'warning',
  disconnected: 'critical',
  disabled: 'offline',
  stopped: 'offline',
};

interface Props {
  opcua: OpcUaStatus;
  system: SystemStatus | undefined;
  simulator: SimulatorStatus | undefined;
}

export function ConnectionPanel({ opcua, system, simulator }: Props) {
  const ing = system?.ingestion;
  return (
    <Card title="OPC UA connection" icon={RadioTower} subtitle="Backend to simulator">
      <div className="stack">
        <KeyValue
          items={[
            { label: 'State', value: <Badge tone={TONE[opcua.state]}>{opcua.state}</Badge> },
            { label: 'Endpoint', value: <span className="mono">{opcua.endpoint}</span> },
            {
              label: 'Security mode',
              value: opcua.security === 'secure' ? 'Secure channel (signed and encrypted)' : 'None',
            },
            { label: 'Last connected', value: <Timestamp value={opcua.last_connected_at} /> },
            { label: 'Last disconnected', value: <Timestamp value={opcua.last_disconnected_at} /> },
            {
              label: 'Reconnect attempts',
              value: <span className="tnum">{opcua.reconnect_attempts}</span>,
            },
            {
              label: 'Heartbeat',
              value: (
                <span className="tnum">
                  {opcua.heartbeat ?? '—'}
                  {simulator?.heartbeat_age_s !== null && simulator?.heartbeat_age_s !== undefined
                    ? ` (changed ${formatNumber(simulator.heartbeat_age_s, 1)} s ago)`
                    : ''}
                </span>
              ),
            },
            {
              label: 'Monitored items',
              value: <span className="tnum">{opcua.monitored_items}</span>,
            },
            {
              label: 'Last data',
              value: <RelativeAge value={opcua.last_data_at} fallback="none received" />,
            },
            { label: 'Last error', value: opcua.last_error ?? 'None' },
          ]}
        />
        {ing ? (
          <>
            <h3>Ingestion</h3>
            <KeyValue
              items={[
                {
                  label: 'Received / accepted',
                  value: (
                    <span className="tnum">
                      {ing.received} / {ing.accepted}
                    </span>
                  ),
                },
                {
                  label: 'Duplicates / late',
                  value: (
                    <span className="tnum">
                      {ing.duplicates} / {ing.late}
                    </span>
                  ),
                },
                {
                  label: 'Invalid / bad / stuck',
                  value: (
                    <span className="tnum">
                      {ing.invalid} / {ing.bad} / {ing.stuck}
                    </span>
                  ),
                },
                {
                  label: 'Dropped / DB failures',
                  value: (
                    <span className="tnum">
                      {ing.dropped} / {ing.db_failures}
                    </span>
                  ),
                },
                { label: 'Queue depth', value: <span className="tnum">{ing.queue_depth}</span> },
                { label: 'Last batch', value: <Timestamp value={ing.last_batch_at} /> },
              ]}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}

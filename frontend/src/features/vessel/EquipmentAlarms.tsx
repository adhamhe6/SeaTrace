import { Bell, History } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAlarms } from '@/api/hooks';
import type { AlarmOut } from '@/api/types';
import { AlarmStateBadge, SeverityBadge } from '@/ui/Badge';
import { ButtonLink } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { DataTable, type Column } from '@/ui/DataTable';
import { EmptyState, ErrorState } from '@/ui/states';
import { Timestamp } from '@/ui/misc';

const COLUMNS: Column<AlarmOut>[] = [
  { key: 'sev', header: 'Severity', cell: (a) => <SeverityBadge severity={a.severity} /> },
  { key: 'state', header: 'State', cell: (a) => <AlarmStateBadge state={a.state} /> },
  {
    key: 'msg',
    header: 'Alarm',
    cell: (a) => (
      <Link to={`/alarms/${String(a.id)}`} className="link-plain">
        {a.message}
      </Link>
    ),
  },
  { key: 'raised', header: 'Raised', cell: (a) => <Timestamp value={a.raised_at} /> },
  {
    key: 'investigate',
    header: <span className="sr-only">Investigate</span>,
    label: 'Replay',
    cell: (a) => (
      <ButtonLink
        size="sm"
        icon={History}
        to={`/replay?alarm=${String(a.id)}`}
        aria-label={`Investigate alarm ${String(a.id)} in replay`}
      >
        Investigate
      </ButtonLink>
    ),
  },
];

export function EquipmentAlarms({
  vesselCode,
  equipmentCode,
}: {
  vesselCode: string;
  equipmentCode: string;
}) {
  const open = useAlarms({
    vessel: vesselCode,
    equipment: equipmentCode,
    open: true,
    limit: 20,
    offset: 0,
  });
  const closed = useAlarms({
    vessel: vesselCode,
    equipment: equipmentCode,
    open: false,
    limit: 10,
    offset: 0,
  });
  return (
    <div className="stack">
      <Card title="Active alarms" icon={Bell} headingLevel={3} flush>
        {open.isError ? (
          <ErrorState
            error={open.error}
            onRetry={() => void open.refetch()}
            retrying={open.isRefetching}
          />
        ) : (
          <DataTable
            caption={`Active alarms for ${equipmentCode}`}
            columns={COLUMNS}
            rows={open.data?.items}
            loading={open.isPending}
            getRowKey={(a) => a.id}
            empty={
              <EmptyState title="No open alarms">This equipment has no open alarms.</EmptyState>
            }
          />
        )}
      </Card>
      <Card title="Alarm history" icon={History} headingLevel={3} flush>
        {closed.isError ? (
          <ErrorState
            error={closed.error}
            onRetry={() => void closed.refetch()}
            retrying={closed.isRefetching}
          />
        ) : (
          <DataTable
            caption={`Closed alarms for ${equipmentCode}`}
            columns={COLUMNS}
            rows={closed.data?.items}
            loading={closed.isPending}
            getRowKey={(a) => a.id}
            empty={
              <EmptyState title="No closed alarms">
                No alarm for this equipment has been closed yet.
              </EmptyState>
            }
          />
        )}
      </Card>
    </div>
  );
}

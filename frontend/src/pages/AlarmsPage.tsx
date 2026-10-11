import { Bell, History as HistoryIcon, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAlarms, useVessels } from '@/api/hooks';
import { ALARM_KINDS, ALARM_STATES, SEVERITIES, type AlarmOut } from '@/api/types';
import { AcknowledgeDialog } from '@/features/alarms/AcknowledgeDialog';
import {
  OPEN_STATES,
  PAGE_SIZES,
  buildAlarmSearch,
  filtersToQuery,
  hasActiveFilters,
  parseAlarmFilters,
  utcInputToIso,
  type AlarmFilters,
  type AlarmTab,
} from '@/features/alarms/filters';
import { AckButton, ConditionIndicator } from '@/features/alarms/parts';
import { useEquipmentOptions } from '@/features/alarms/useEquipmentOptions';
import { ALARM_STATE, KIND_LABEL, SEVERITY } from '@/lib/domain';
import { toMs, toUtcInputValue } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { useNow } from '@/lib/useNow';
import { useLive } from '@/realtime/liveStore';
import { AlarmStateBadge, SeverityBadge } from '@/ui/Badge';
import { Button, ButtonLink } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { MultiSelect } from '@/ui/Choice';
import { DataTable, type Column } from '@/ui/DataTable';
import { Field, Input, Select } from '@/ui/Field';
import { Timestamp } from '@/ui/misc';
import { EmptyState, ErrorState } from '@/ui/states';
import { Tabs, panelId, tabId } from '@/ui/Tabs';
import './pages.css';

const TAB_BASE = 'alarm-tabs';

function utcValue(iso: string): string {
  const ms = toMs(iso);
  return ms === null ? '' : toUtcInputValue(ms);
}

function Filters({
  filters,
  onChange,
}: {
  filters: AlarmFilters;
  onChange: (next: Partial<AlarmFilters>) => void;
}) {
  const vessels = useVessels();
  const equipment = useEquipmentOptions(filters.vessel);
  const stateOptions =
    filters.tab === 'open' ? OPEN_STATES : ALARM_STATES.filter((s) => s === 'cleared');
  return (
    <Card title="Filters" bodyClassName="stack">
      <div className="filters">
        <MultiSelect
          label="Severity"
          value={filters.severity}
          onChange={(severity) => {
            onChange({ severity });
          }}
          options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY[s].label }))}
        />
        {filters.tab === 'open' ? (
          <MultiSelect
            label="Lifecycle state"
            value={filters.state}
            onChange={(state) => {
              onChange({ state });
            }}
            options={stateOptions.map((s) => ({ value: s, label: ALARM_STATE[s].label }))}
          />
        ) : null}
        <Field label="Vessel">
          <Select
            value={filters.vessel}
            onChange={(e) => {
              onChange({ vessel: e.target.value, equipment: '' });
            }}
          >
            <option value="">All vessels</option>
            {vessels.data?.map((v) => (
              <option key={v.code} value={v.code}>
                {v.name} ({v.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Equipment">
          <Select
            value={filters.equipment}
            onChange={(e) => {
              onChange({ equipment: e.target.value });
            }}
          >
            <option value="">All equipment</option>
            {equipment.codes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
            {filters.equipment && !equipment.codes.includes(filters.equipment) ? (
              <option value={filters.equipment}>{filters.equipment}</option>
            ) : null}
          </Select>
        </Field>
        <Field label="Kind">
          <Select
            value={filters.kind}
            onChange={(e) => {
              onChange({ kind: ALARM_KINDS.find((k) => k === e.target.value) ?? '' });
            }}
          >
            <option value="">All kinds</option>
            {ALARM_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Raised from (UTC)">
          <Input
            type="datetime-local"
            step={1}
            value={utcValue(filters.from)}
            onChange={(e) => {
              onChange({ from: utcInputToIso(e.target.value) });
            }}
          />
        </Field>
        <Field label="Raised until (UTC)">
          <Input
            type="datetime-local"
            step={1}
            value={utcValue(filters.to)}
            onChange={(e) => {
              onChange({ to: utcInputToIso(e.target.value) });
            }}
          />
        </Field>
      </div>
      {hasActiveFilters(filters) ? (
        <div>
          <Button
            icon={X}
            size="sm"
            onClick={() => {
              onChange({
                severity: [],
                state: [],
                vessel: '',
                equipment: '',
                kind: '',
                from: '',
                to: '',
              });
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Pager({
  page,
  limit,
  total,
  onPage,
  onLimit,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
  onLimit: (limit: number) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * limit + 1;
  const last = Math.min(total, page * limit);
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pager">
      <p className="small" aria-live="polite">
        Showing{' '}
        <strong className="tnum">
          {first}–{last}
        </strong>{' '}
        of <strong className="tnum">{total}</strong>
      </p>
      <div className="row">
        <label className="small muted" htmlFor="alarm-page-size">
          Per page
        </label>
        <Select
          id="alarm-page-size"
          style={{ width: 'auto' }}
          value={limit}
          onChange={(e) => {
            onLimit(Number(e.target.value));
          }}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={page <= 1}
          onClick={() => {
            onPage(page - 1);
          }}
        >
          Previous
        </Button>
        <span className="small tnum">
          Page {page} of {pages}
        </span>
        <Button
          size="sm"
          disabled={page >= pages}
          onClick={() => {
            onPage(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function AlarmsPage() {
  usePageTitle('Alarm center');
  const [params, setParams] = useSearchParams();
  const filters = parseAlarmFilters(params);
  const query = filtersToQuery(filters);
  const alarms = useAlarms(query);
  const highlighted = useLive((s) => s.highlighted);
  const now = useNow();
  const [target, setTarget] = useState<AlarmOut | null>(null);

  const update = (next: Partial<AlarmFilters>, keepPage = false) => {
    const merged: AlarmFilters = { ...filters, ...next };
    if (!keepPage) merged.page = 1;
    // The state options differ between the tabs.
    if (next.tab && next.tab !== filters.tab) merged.state = [];
    setParams(buildAlarmSearch(merged));
  };

  const columns: Column<AlarmOut>[] = [
    {
      key: 'state',
      header: 'Severity / state',
      cell: (a) => (
        <div className="stack stack--sm" style={{ gap: 4, alignItems: 'flex-start' }}>
          <SeverityBadge severity={a.severity} />
          <AlarmStateBadge state={a.state} />
          <ConditionIndicator alarm={a} />
        </div>
      ),
    },
    {
      key: 'where',
      header: 'Vessel / equipment',
      cell: (a) => (
        <div>
          <Link to={`/vessels/${a.vessel_code}`}>{a.vessel_name}</Link>
          <div className="muted xs">
            {a.equipment_name} <span className="mono">({a.equipment_code})</span>
          </div>
        </div>
      ),
    },
    {
      key: 'msg',
      header: 'Alarm',
      className: 'alarm-msg',
      cell: (a) => (
        <div>
          <Link to={`/alarms/${String(a.id)}`} className="link-plain">
            {a.message}
          </Link>
          <div className="muted xs">#{a.id}</div>
        </div>
      ),
    },
    { key: 'raised', header: 'Raised', cell: (a) => <Timestamp value={a.raised_at} /> },
    {
      key: 'ack',
      header: 'Acknowledged',
      cell: (a) =>
        a.acknowledged_at ? (
          <div>
            <div>{a.acknowledged_by ?? 'unknown'}</div>
            <Timestamp value={a.acknowledged_at} />
          </div>
        ) : (
          <span className="muted">No</span>
        ),
    },
    { key: 'count', header: 'Count', align: 'right', mono: true, cell: (a) => a.occurrence_count },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      label: 'Actions',
      cell: (a) => (
        <div className="stack stack--sm" style={{ gap: 4, alignItems: 'flex-end' }}>
          <AckButton alarm={a} onAcknowledge={setTarget} />
          <ButtonLink
            size="sm"
            variant="ghost"
            to={`/alarms/${String(a.id)}`}
            aria-label={`Details of alarm ${String(a.id)}`}
          >
            Details
          </ButtonLink>
        </div>
      ),
    },
  ];

  const tabItems = [
    { id: 'open', label: 'Open', count: filters.tab === 'open' ? alarms.data?.total : undefined },
    {
      id: 'history',
      label: 'History',
      count: filters.tab === 'history' ? alarms.data?.total : undefined,
    },
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head__title">
          <h1>Alarm center</h1>
          <p className="page-head__sub">
            Open alarms still need attention or acknowledgement; history holds closed alarms
            (condition returned to normal and acknowledged).
          </p>
        </div>
      </div>

      <Tabs
        label="Alarm scope"
        idBase={TAB_BASE}
        value={filters.tab}
        onChange={(id) => {
          update({ tab: id as AlarmTab });
        }}
        items={tabItems}
      />
      <Filters
        filters={filters}
        onChange={(next) => {
          update(next);
        }}
      />

      <div
        role="tabpanel"
        id={panelId(TAB_BASE, filters.tab)}
        aria-labelledby={tabId(TAB_BASE, filters.tab)}
      >
        <Card
          title={filters.tab === 'open' ? 'Open alarms' : 'Alarm history'}
          icon={filters.tab === 'open' ? Bell : HistoryIcon}
          subtitle="Newest raised first"
          flush
        >
          {alarms.isError ? (
            <ErrorState
              error={alarms.error}
              title="Could not load alarms"
              onRetry={() => void alarms.refetch()}
              retrying={alarms.isRefetching}
            />
          ) : (
            <>
              <DataTable
                caption={
                  filters.tab === 'open'
                    ? 'Open alarms, newest first'
                    : 'Closed alarms, newest first'
                }
                columns={columns}
                rows={alarms.data?.items}
                loading={alarms.isPending}
                getRowKey={(a) => a.id}
                rowClassName={(a) => ((highlighted[a.id] ?? 0) > now ? 'is-flash' : undefined)}
                empty={
                  <EmptyState
                    title={
                      filters.tab === 'open' ? 'No open alarms match' : 'No closed alarms match'
                    }
                    action={
                      hasActiveFilters(filters) ? (
                        <Button
                          onClick={() => {
                            update({
                              severity: [],
                              state: [],
                              vessel: '',
                              equipment: '',
                              kind: '',
                              from: '',
                              to: '',
                            });
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : undefined
                    }
                  >
                    {hasActiveFilters(filters)
                      ? 'No alarm matches the current filters.'
                      : filters.tab === 'open'
                        ? 'Nothing needs attention right now.'
                        : 'No alarm has been closed yet.'}
                  </EmptyState>
                }
              />
              {alarms.data ? (
                <Pager
                  page={filters.page}
                  limit={filters.limit}
                  total={alarms.data.total}
                  onPage={(page) => {
                    update({ page }, true);
                  }}
                  onLimit={(limit) => {
                    update({ limit });
                  }}
                />
              ) : null}
            </>
          )}
        </Card>
      </div>
      <AcknowledgeDialog
        alarm={target}
        onClose={() => {
          setTarget(null);
        }}
      />
    </div>
  );
}

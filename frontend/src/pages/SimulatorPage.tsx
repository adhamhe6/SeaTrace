import { FlaskConical, RotateCcw, Square, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useClearScenario,
  useResetScenarios,
  useScenarios,
  useSimulatorEvents,
  useSimulatorStatus,
  useSystemStatus,
  useVessels,
} from '@/api/hooks';
import type { ActiveScenario, ScenarioInfo, SimulatorEventOut } from '@/api/types';
import { OPERATOR_REQUIRED, useIsOperator } from '@/auth/authStore';
import { ConnectionPanel } from '@/features/simulator/ConnectionPanel';
import { describeCommandFailure } from '@/features/simulator/errors';
import { ScenarioCard } from '@/features/simulator/ScenarioCard';
import { titleCase } from '@/lib/format';
import { usePageTitle } from '@/lib/usePageTitle';
import { useLive } from '@/realtime/liveStore';
import { Badge } from '@/ui/Badge';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { DataTable, type Column } from '@/ui/DataTable';
import { Dialog } from '@/ui/Dialog';
import { Timestamp, RelativeAge } from '@/ui/misc';
import { Skeleton } from '@/ui/Skeleton';
import { EmptyState, ErrorState } from '@/ui/states';
import { useToast } from '@/ui/Toast';
import './pages.css';

const CATEGORY_LABEL: Record<ScenarioInfo['category'], string> = {
  equipment: 'Equipment faults',
  sensor: 'Sensor faults',
  communication: 'Communication faults',
};
const CATEGORY_ORDER: ScenarioInfo['category'][] = ['equipment', 'sensor', 'communication'];

function resultTone(result: string) {
  return result === 'accepted' ? 'ok' : result === 'rejected' ? 'warning' : 'critical';
}

const EVENT_COLUMNS: Column<SimulatorEventOut>[] = [
  { key: 'at', header: 'Time', cell: (e) => <Timestamp value={e.at} /> },
  { key: 'actor', header: 'Actor', cell: (e) => e.actor },
  { key: 'action', header: 'Action', cell: (e) => titleCase(e.action) },
  {
    key: 'scenario',
    header: 'Scenario',
    cell: (e) => (e.scenario_id ? <span className="mono">{e.scenario_id}</span> : '—'),
  },
  { key: 'vessel', header: 'Vessel', cell: (e) => e.vessel_code ?? '—' },
  {
    key: 'result',
    header: 'Result',
    cell: (e) => <Badge tone={resultTone(e.result)}>{e.result}</Badge>,
  },
  { key: 'message', header: 'Message', cell: (e) => e.message ?? '—' },
];

function ActiveScenarios({
  active,
  scenarios,
}: {
  active: readonly ActiveScenario[];
  scenarios: readonly ScenarioInfo[];
}) {
  const isOperator = useIsOperator();
  const clear = useClearScenario();
  const toast = useToast();
  const names = new Map(scenarios.map((s) => [s.id, s.name]));
  return (
    <Card title="Active scenarios" icon={FlaskConical} flush>
      {active.length === 0 ? (
        <EmptyState title="No scenario is active">The simulation is running nominally.</EmptyState>
      ) : (
        <ul className="feed" aria-label="Active scenarios">
          {active.map((a) => (
            <li
              key={`${a.scenario_id}-${a.vessel_code ?? 'server'}`}
              className="feed__item"
              style={{ alignItems: 'center' }}
            >
              <span className="mono small">{a.vessel_code ?? 'server'}</span>
              <div className="row row--between">
                <div>
                  <strong>{names.get(a.scenario_id) ?? titleCase(a.scenario_id)}</strong>
                  <div className="muted xs">
                    started <RelativeAge value={a.started_at} fallback="at an unknown time" />
                    {a.ends_at ? (
                      <>
                        {' · ends '}
                        <Timestamp value={a.ends_at} />
                      </>
                    ) : (
                      ' · until cleared'
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  icon={Square}
                  loading={clear.isPending && clear.variables.scenarioId === a.scenario_id}
                  disabled={clear.isPending}
                  disabledReason={isOperator ? undefined : OPERATOR_REQUIRED}
                  aria-label={`Clear ${names.get(a.scenario_id) ?? a.scenario_id}${a.vessel_code ? ` on ${a.vessel_code}` : ''}`}
                  onClick={() => {
                    clear.mutate(
                      { scenarioId: a.scenario_id, vesselCode: a.vessel_code ?? undefined },
                      {
                        onSuccess: () => {
                          toast.success('Scenario cleared', names.get(a.scenario_id));
                        },
                        onError: (error) => {
                          const f = describeCommandFailure(error);
                          toast.error(f.title, f.message);
                        },
                      },
                    );
                  }}
                >
                  Clear
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ResetAll() {
  const isOperator = useIsOperator();
  const reset = useResetScenarios();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        icon={RotateCcw}
        variant="danger"
        disabledReason={isOperator ? undefined : OPERATOR_REQUIRED}
        onClick={() => {
          setOpen(true);
        }}
      >
        Reset all scenarios
      </Button>
      <Dialog
        open={open}
        busy={reset.isPending}
        onClose={() => {
          setOpen(false);
        }}
        title="Reset all scenarios?"
        description="Every active fault scenario on every vessel and on the simulator server will be cleared."
        footer={
          <>
            <Button
              disabled={reset.isPending}
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={RotateCcw}
              loading={reset.isPending}
              onClick={() => {
                if (reset.isPending) return;
                reset.mutate(undefined, {
                  onSuccess: (result) => {
                    toast.success('All scenarios cleared', result.message || undefined);
                    setOpen(false);
                  },
                  onError: (error) => {
                    const f = describeCommandFailure(error);
                    toast.error(f.title, f.message);
                  },
                });
              }}
            >
              Reset all
            </Button>
          </>
        }
      >
        {reset.isError ? (
          <Banner tone="critical" role="alert" title={describeCommandFailure(reset.error).title}>
            {describeCommandFailure(reset.error).message}
          </Banner>
        ) : (
          <p className="small muted">
            The simulated process returns to its nominal behaviour. Alarms close as conditions
            return to normal.
          </p>
        )}
      </Dialog>
    </>
  );
}

export function SimulatorPage() {
  usePageTitle('Simulator controls');
  const isOperator = useIsOperator();
  const system = useSystemStatus();
  const status = useSimulatorStatus();
  const scenarios = useScenarios();
  const vessels = useVessels();
  const events = useSimulatorEvents(25);
  const pushedSource = useLive((s) => s.sourceStatus);

  const active = status.data?.active_scenarios ?? [];
  const opcua = pushedSource ?? system.data?.opcua;
  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        items: (scenarios.data ?? []).filter((s) => s.category === category),
      })).filter((g) => g.items.length > 0),
    [scenarios.data],
  );

  return (
    <div className="stack">
      <div className="sim-banner" role="note">
        <FlaskConical size={20} aria-hidden="true" />
        <span>
          SIMULATION — scenarios inject simulated faults into the SeaTrace simulator. No real vessel
          or equipment is affected.
        </span>
      </div>
      <div className="page-head">
        <div className="page-head__title">
          <h1>Simulator controls</h1>
          <p className="page-head__sub">
            Activate or clear fault scenarios and watch alarms, readings and replay react. Commands
            are audited.
          </p>
        </div>
        <div className="page-head__actions">
          <ResetAll />
        </div>
      </div>
      {!isOperator ? (
        <Banner tone="info" title="Read-only access.">
          You are signed in as a viewer. Scenario controls are disabled; the Operator role is
          required to activate, clear or reset scenarios.
        </Banner>
      ) : null}
      {status.data && !status.data.connected ? (
        <Banner tone="warning" title="Simulator not connected.">
          The backend has no OPC UA connection to the simulator, so commands will fail until it
          reconnects.
        </Banner>
      ) : null}

      <div className="grid grid--2">
        {opcua ? (
          <ConnectionPanel opcua={opcua} system={system.data} simulator={status.data} />
        ) : system.isError ? (
          <Card>
            <ErrorState
              error={system.error}
              title="Could not load connection status"
              onRetry={() => void system.refetch()}
              retrying={system.isRefetching}
            />
          </Card>
        ) : (
          <Card title="OPC UA connection">
            <Skeleton height={160} />
          </Card>
        )}
        {status.isError ? (
          <Card title="Active scenarios">
            <ErrorState
              error={status.error}
              onRetry={() => void status.refetch()}
              retrying={status.isRefetching}
            />
          </Card>
        ) : (
          <ActiveScenarios active={active} scenarios={scenarios.data ?? []} />
        )}
      </div>

      {scenarios.isPending ? (
        <Skeleton height={200} />
      ) : scenarios.isError ? (
        <Card>
          <ErrorState
            error={scenarios.error}
            title="Could not load scenarios"
            onRetry={() => void scenarios.refetch()}
            retrying={scenarios.isRefetching}
          />
        </Card>
      ) : (
        grouped.map((group) => (
          <section
            key={group.category}
            className="scenario-group"
            aria-labelledby={`cat-${group.category}`}
          >
            <h2 id={`cat-${group.category}`}>{CATEGORY_LABEL[group.category]}</h2>
            <div className="grid grid--cards">
              {group.items.map((scenario) => (
                <ScenarioCard
                  key={scenario.id}
                  scenario={scenario}
                  vessels={vessels.data ?? []}
                  active={active}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <Card
        title="Recent commands"
        subtitle="Audit trail of operator actions on the simulator"
        icon={Terminal}
        flush
      >
        {events.isError ? (
          <ErrorState
            error={events.error}
            onRetry={() => void events.refetch()}
            retrying={events.isRefetching}
          />
        ) : (
          <DataTable
            caption="Simulator command audit"
            columns={EVENT_COLUMNS}
            rows={events.data}
            loading={events.isPending}
            getRowKey={(e) => e.id}
            empty={
              <EmptyState title="No commands yet">
                Commands issued from this page appear here.
              </EmptyState>
            }
          />
        )}
      </Card>
    </div>
  );
}

import { Play, Square } from 'lucide-react';
import { useState } from 'react';
import { useActivateScenario, useClearScenario } from '@/api/hooks';
import type { ActiveScenario, ScenarioInfo, VesselSummary } from '@/api/types';
import { OPERATOR_REQUIRED, useIsOperator } from '@/auth/authStore';
import { formatDuration } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Field, Input, Select } from '@/ui/Field';
import { useToast } from '@/ui/Toast';
import { describeCommandFailure } from './errors';

interface Props {
  scenario: ScenarioInfo;
  vessels: readonly VesselSummary[];
  active: readonly ActiveScenario[];
}

interface Outcome {
  ok: boolean;
  title: string;
  message: string;
}

export function validateDuration(
  raw: string,
  max: number,
): { value: number | undefined; error: string | null } {
  const text = raw.trim();
  if (text === '') return { value: undefined, error: null };
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0)
    return { value: undefined, error: 'Enter a whole number of seconds (0 or more).' };
  if (n > max)
    return {
      value: undefined,
      error: `At most ${String(max)} s (${formatDuration(max)}) for this scenario.`,
    };
  return { value: n, error: null };
}

export function ScenarioCard({ scenario, vessels, active }: Props) {
  const isOperator = useIsOperator();
  const toast = useToast();
  const activate = useActivateScenario();
  const clear = useClearScenario();
  const [vesselChoice, setVesselChoice] = useState('');
  const [duration, setDuration] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const serverScope = scenario.scope === 'server';
  const vessel = serverScope ? undefined : vesselChoice || vessels[0]?.code;
  const parsed = validateDuration(duration, scenario.max_duration_s);
  const pending = activate.isPending || clear.isPending;
  const runningHere = active.filter(
    (a) =>
      a.scenario_id === scenario.id &&
      (serverScope || a.vessel_code === vessel || a.vessel_code === null),
  );
  const reason = isOperator ? undefined : OPERATOR_REQUIRED;
  const missingVessel = !serverScope && !vessel;

  const run = (kind: 'activate' | 'clear') => {
    if (pending || parsed.error) return;
    const handlers = {
      onSuccess: (result: { message: string }) => {
        const verb = kind === 'activate' ? 'activated' : 'cleared';
        const target = vessel ? ` on ${vessel}` : '';
        setOutcome({ ok: true, title: `Scenario ${verb}${target}`, message: result.message });
        toast.success(`${scenario.name} ${verb}${target}`, result.message || undefined);
      },
      onError: (error: unknown) => {
        const failure = describeCommandFailure(error);
        setOutcome({ ok: false, ...failure });
        toast.error(failure.title, failure.message);
      },
    };
    if (kind === 'activate') {
      activate.mutate(
        { scenarioId: scenario.id, vesselCode: vessel, durationS: parsed.value },
        handlers,
      );
    } else {
      clear.mutate({ scenarioId: scenario.id, vesselCode: vessel }, handlers);
    }
  };

  return (
    <Card bodyClassName="scenario" headingLevel={3} aria-labelledby={`scenario-${scenario.id}`}>
      <div className="scenario__title">
        <h3 id={`scenario-${scenario.id}`}>{scenario.name}</h3>
        <div className="badges">
          <Badge tone="neutral">{scenario.scope === 'server' ? 'Server-wide' : 'Per vessel'}</Badge>
          {runningHere.length > 0 ? (
            <Badge tone="warning">Active{vessel ? ` on ${vessel}` : ''}</Badge>
          ) : null}
        </div>
      </div>
      <p className="small">{scenario.description}</p>
      <p className="small muted">
        Target: <strong>{scenario.target}</strong> · scenario id{' '}
        <span className="mono">{scenario.id}</span>
      </p>
      <div className="small">
        <span className="muted">Expected alarms: </span>
        <span className="badges" style={{ display: 'inline-flex' }}>
          {scenario.expected_alarms.map((code) => (
            <span key={code} className="mono xs st-badge st-tone-neutral st-badge--plain">
              {code}
            </span>
          ))}
        </span>
      </div>
      <div className="scenario__controls">
        {serverScope ? null : (
          <Field label="Vessel">
            <Select
              value={vessel ?? ''}
              disabled={pending}
              onChange={(e) => {
                setVesselChoice(e.target.value);
              }}
            >
              {vessels.map((v) => (
                <option key={v.code} value={v.code}>
                  {v.name} ({v.code})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label="Duration (s, optional)"
          hint={
            scenario.default_duration_s === 0
              ? `Empty or 0 = until cleared. Max ${String(scenario.max_duration_s)} s.`
              : `Default ${String(scenario.default_duration_s)} s. Max ${String(scenario.max_duration_s)} s.`
          }
          error={parsed.error}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={scenario.max_duration_s}
            step={1}
            placeholder={String(scenario.default_duration_s)}
            value={duration}
            disabled={pending}
            onChange={(e) => {
              setDuration(e.target.value);
            }}
          />
        </Field>
      </div>
      <div className="scenario__buttons">
        <Button
          variant="primary"
          icon={Play}
          loading={activate.isPending}
          disabled={clear.isPending || Boolean(parsed.error) || missingVessel}
          disabledReason={reason}
          onClick={() => {
            run('activate');
          }}
          aria-label={`Activate ${scenario.name}`}
        >
          Activate
        </Button>
        <Button
          icon={Square}
          loading={clear.isPending}
          disabled={activate.isPending || missingVessel}
          disabledReason={reason}
          onClick={() => {
            run('clear');
          }}
          aria-label={`Clear ${scenario.name}`}
        >
          Clear
        </Button>
      </div>
      {outcome ? (
        <div
          className={`result st-tone-${outcome.ok ? 'ok' : 'critical'}`}
          role={outcome.ok ? 'status' : 'alert'}
        >
          <strong>{outcome.title}.</strong> {outcome.message}
        </div>
      ) : null}
    </Card>
  );
}

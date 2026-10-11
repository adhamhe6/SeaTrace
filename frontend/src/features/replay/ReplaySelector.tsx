import { Search } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useVessel, useVessels } from '@/api/hooks';
import { formatTimestamp, parseUtcInputValue, toUtcInputValue } from '@/lib/format';
import { Button } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Segmented } from '@/ui/Choice';
import { Field, Input, Select } from '@/ui/Field';
import { serverNow } from '@/realtime/liveStore';
import { DEFAULT_CONTEXT_S, MAX_CONTEXT_S, type ReplaySource } from './urlState';

const PRESETS = [5, 15, 30, 60] as const;
type Preset = (typeof PRESETS)[number] | 'custom';
type Mode = 'window' | 'alarm';

interface Props {
  current: ReplaySource | null;
  onSubmit: (source: ReplaySource) => void;
  loading: boolean;
}

function contextError(raw: string): string | null {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < 0 || n > MAX_CONTEXT_S)
    return `Whole seconds, 0 to ${String(MAX_CONTEXT_S)}.`;
  return null;
}

export function ReplaySelector({ current, onSubmit, loading }: Props) {
  const vessels = useVessels();
  const [mode, setMode] = useState<Mode>(current?.kind === 'alarm' ? 'alarm' : 'window');
  const [vesselChoice, setVesselChoice] = useState(
    current?.kind === 'window' ? current.vessel : '',
  );
  const [equipmentChoice, setEquipmentChoice] = useState(
    current?.kind === 'window' ? current.equipment : '',
  );
  const [preset, setPreset] = useState<Preset>(current?.kind === 'window' ? 'custom' : 15);
  const [fromText, setFromText] = useState(
    current?.kind === 'window' ? toUtcInputValue(Date.parse(current.from)) : '',
  );
  const [toText, setToText] = useState(
    current?.kind === 'window' ? toUtcInputValue(Date.parse(current.to)) : '',
  );
  const [alarmText, setAlarmText] = useState(
    current?.kind === 'alarm' ? String(current.alarmId) : '',
  );
  const [beforeText, setBeforeText] = useState(
    String(current?.kind === 'alarm' ? current.before : DEFAULT_CONTEXT_S),
  );
  const [afterText, setAfterText] = useState(
    String(current?.kind === 'alarm' ? current.after : DEFAULT_CONTEXT_S),
  );
  const [touched, setTouched] = useState(false);

  const vessel = vesselChoice || (vessels.data?.[0]?.code ?? '');
  const detail = useVessel(vessel || undefined);
  const equipmentCodes = detail.data?.equipment.map((e) => ({ code: e.code, name: e.name })) ?? [];
  const equipment = equipmentCodes.some((e) => e.code === equipmentChoice)
    ? equipmentChoice
    : (equipmentCodes[0]?.code ?? '');

  const fromMs = parseUtcInputValue(fromText);
  const toMsValue = parseUtcInputValue(toText);
  const customError =
    preset !== 'custom'
      ? null
      : fromMs === null || toMsValue === null
        ? 'Enter both start and end (UTC).'
        : fromMs >= toMsValue
          ? 'The start must be earlier than the end.'
          : null;
  const alarmId = Number(alarmText);
  const alarmError =
    !Number.isInteger(alarmId) || alarmId <= 0 ? 'Enter a positive alarm number.' : null;
  const beforeError = contextError(beforeText);
  const afterError = contextError(afterText);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (loading) return;
    if (mode === 'alarm') {
      if (alarmError || beforeError || afterError) return;
      onSubmit({ kind: 'alarm', alarmId, before: Number(beforeText), after: Number(afterText) });
      return;
    }
    if (!vessel || !equipment || customError) return;
    let from: number;
    let to: number;
    if (preset === 'custom') {
      if (fromMs === null || toMsValue === null) return;
      from = fromMs;
      to = toMsValue;
    } else {
      to = Math.floor(serverNow() / 1000) * 1000;
      from = to - preset * 60_000;
    }
    onSubmit({
      kind: 'window',
      vessel,
      equipment,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
  };

  return (
    <Card
      title="Select incident window"
      subtitle="All times are UTC unless you switch the time zone in the top bar"
    >
      <form onSubmit={submit} className="stack" noValidate>
        <Segmented
          label="Replay source"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'window', label: 'Time window' },
            { value: 'alarm', label: 'Around an alarm' },
          ]}
        />
        {mode === 'window' ? (
          <div className="filters">
            <Field label="Vessel">
              <Select
                value={vessel}
                onChange={(e) => {
                  setVesselChoice(e.target.value);
                  setEquipmentChoice('');
                }}
              >
                {vessels.data?.map((v) => (
                  <option key={v.code} value={v.code}>
                    {v.name} ({v.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Equipment">
              <Select
                value={equipment}
                onChange={(e) => {
                  setEquipmentChoice(e.target.value);
                }}
              >
                {equipmentCodes.map((e) => (
                  <option key={e.code} value={e.code}>
                    {e.name} ({e.code})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="st-field">
              <span className="st-field__label">Range</span>
              <Segmented
                label="Time range preset"
                value={preset}
                onChange={setPreset}
                options={[
                  ...PRESETS.map((p) => ({ value: p, label: `Last ${String(p)} min` })),
                  { value: 'custom' as const, label: 'Custom' },
                ]}
              />
            </div>
            {preset === 'custom' ? (
              <>
                <Field label="From (UTC)" error={touched ? customError : null}>
                  <Input
                    type="datetime-local"
                    step={1}
                    value={fromText}
                    onChange={(e) => {
                      setFromText(e.target.value);
                    }}
                  />
                </Field>
                <Field label="To (UTC)">
                  <Input
                    type="datetime-local"
                    step={1}
                    value={toText}
                    onChange={(e) => {
                      setToText(e.target.value);
                    }}
                  />
                </Field>
              </>
            ) : (
              <p className="small muted filters__wide">
                Presets end at the moment you press Load ({formatTimestamp(serverNow(), 'utc')}) and
                are saved in the link as fixed times.
              </p>
            )}
          </div>
        ) : (
          <div className="filters">
            <Field label="Alarm number" error={touched ? alarmError : null}>
              <Input
                inputMode="numeric"
                value={alarmText}
                onChange={(e) => {
                  setAlarmText(e.target.value);
                }}
              />
            </Field>
            <Field
              label="Seconds before alarm"
              hint="Context shown before the alarm was raised"
              error={touched ? beforeError : null}
            >
              <Input
                inputMode="numeric"
                value={beforeText}
                onChange={(e) => {
                  setBeforeText(e.target.value);
                }}
              />
            </Field>
            <Field
              label="Seconds after alarm"
              hint="Context shown after the alarm cleared"
              error={touched ? afterError : null}
            >
              <Input
                inputMode="numeric"
                value={afterText}
                onChange={(e) => {
                  setAfterText(e.target.value);
                }}
              />
            </Field>
          </div>
        )}
        <div>
          <Button type="submit" variant="primary" icon={Search} loading={loading}>
            Load replay
          </Button>
        </div>
      </form>
    </Card>
  );
}

export const DEFAULT_CONTEXT_S = 300;
export const MAX_CONTEXT_S = 3600;

export type ReplaySource =
  | { kind: 'alarm'; alarmId: number; before: number; after: number }
  | { kind: 'window'; vessel: string; equipment: string; from: string; to: string };

export interface ParsedReplayUrl {
  source: ReplaySource | null;
  /** Human-readable reason when the URL contained replay parameters that could not be used. */
  problem: string | null;
}

function contextSeconds(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_CONTEXT_S;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_CONTEXT_S;
  return Math.min(n, MAX_CONTEXT_S);
}

export function parseReplayUrl(params: URLSearchParams): ParsedReplayUrl {
  const alarm = params.get('alarm');
  if (alarm !== null) {
    const alarmId = Number(alarm);
    if (!Number.isInteger(alarmId) || alarmId <= 0) {
      return { source: null, problem: `"${alarm}" is not a valid alarm id.` };
    }
    return {
      source: {
        kind: 'alarm',
        alarmId,
        before: contextSeconds(params.get('before')),
        after: contextSeconds(params.get('after')),
      },
      problem: null,
    };
  }
  const vessel = params.get('vessel');
  const equipment = params.get('equipment');
  const from = params.get('from');
  const to = params.get('to');
  if (!vessel && !equipment && !from && !to) return { source: null, problem: null };
  if (!vessel || !equipment || !from || !to) {
    return {
      source: null,
      problem: 'A replay link needs vessel, equipment, from and to (or an alarm id).',
    };
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return {
      source: null,
      problem: 'The from/to times in this link are not valid ISO-8601 timestamps.',
    };
  }
  if (fromMs >= toMs)
    return { source: null, problem: 'The start time must be earlier than the end time.' };
  return {
    source: {
      kind: 'window',
      vessel,
      equipment,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    },
    problem: null,
  };
}

export function sourceToParams(source: ReplaySource): URLSearchParams {
  const params = new URLSearchParams();
  if (source.kind === 'alarm') {
    params.set('alarm', String(source.alarmId));
    if (source.before !== DEFAULT_CONTEXT_S) params.set('before', String(source.before));
    if (source.after !== DEFAULT_CONTEXT_S) params.set('after', String(source.after));
  } else {
    params.set('vessel', source.vessel);
    params.set('equipment', source.equipment);
    params.set('from', source.from);
    params.set('to', source.to);
  }
  return params;
}

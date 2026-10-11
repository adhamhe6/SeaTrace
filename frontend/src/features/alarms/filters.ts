import type { AlarmQuery } from '@/api/hooks';
import {
  ALARM_KINDS,
  ALARM_STATES,
  SEVERITIES,
  type AlarmKind,
  type AlarmState,
  type Severity,
} from '@/api/types';
import { parseUtcInputValue } from '@/lib/format';

export type AlarmTab = 'open' | 'history';

export interface AlarmFilters {
  tab: AlarmTab;
  severity: Severity[];
  state: AlarmState[];
  vessel: string;
  equipment: string;
  kind: AlarmKind | '';
  /** ISO-8601 UTC instants */
  from: string;
  to: string;
  page: number;
  limit: number;
}

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_LIMIT = 25;

export const OPEN_STATES: readonly AlarmState[] = [
  'active_unacknowledged',
  'active_acknowledged',
  'cleared_unacknowledged',
];

function pickAll<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const out: T[] = [];
  for (const raw of values.flatMap((v) => v.split(','))) {
    const match = allowed.find((a) => a === raw);
    if (match && !out.includes(match)) out.push(match);
  }
  return out;
}

function isoOrEmpty(value: string | null): string {
  if (!value) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function parseAlarmFilters(params: URLSearchParams): AlarmFilters {
  const kind = params.get('kind');
  const limit = Number(params.get('limit'));
  const page = Number(params.get('page'));
  return {
    tab: params.get('tab') === 'history' ? 'history' : 'open',
    severity: pickAll(params.getAll('severity'), SEVERITIES),
    state: pickAll(params.getAll('state'), ALARM_STATES),
    vessel: params.get('vessel') ?? '',
    equipment: params.get('equipment') ?? '',
    kind: ALARM_KINDS.find((k) => k === kind) ?? '',
    from: isoOrEmpty(params.get('from')),
    to: isoOrEmpty(params.get('to')),
    page: Number.isInteger(page) && page > 0 ? page : 1,
    limit: PAGE_SIZES.find((s) => s === limit) ?? DEFAULT_LIMIT,
  };
}

/** Serialises the filters into a query string; defaults are omitted to keep URLs short. */
export function buildAlarmSearch(filters: AlarmFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.tab === 'history') params.set('tab', 'history');
  filters.severity.forEach((s) => {
    params.append('severity', s);
  });
  filters.state.forEach((s) => {
    params.append('state', s);
  });
  if (filters.vessel) params.set('vessel', filters.vessel);
  if (filters.equipment) params.set('equipment', filters.equipment);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.page > 1) params.set('page', String(filters.page));
  if (filters.limit !== DEFAULT_LIMIT) params.set('limit', String(filters.limit));
  return params;
}

/** The API query for a set of filters: "Open" = open=true, "History" = open=false. */
export function filtersToQuery(filters: AlarmFilters): AlarmQuery {
  return {
    open: filters.tab === 'open',
    state: filters.state.length > 0 ? filters.state : undefined,
    severity: filters.severity.length > 0 ? filters.severity : undefined,
    vessel: filters.vessel || undefined,
    equipment: filters.equipment || undefined,
    kind: filters.kind || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    limit: filters.limit,
    offset: (filters.page - 1) * filters.limit,
  };
}

export function hasActiveFilters(filters: AlarmFilters): boolean {
  return Boolean(
    filters.severity.length ||
    filters.state.length ||
    filters.vessel ||
    filters.equipment ||
    filters.kind ||
    filters.from ||
    filters.to,
  );
}

/** Converts a `datetime-local` value (interpreted as UTC) to an ISO string, or '' when empty/invalid. */
export function utcInputToIso(value: string): string {
  const ms = parseUtcInputValue(value);
  return ms === null ? '' : new Date(ms).toISOString();
}

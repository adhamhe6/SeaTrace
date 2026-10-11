import type { TimeMode } from './settingsStore';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function toMs(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** "+02:00" style offset of the browser's local zone at the given instant. */
export function localOffsetLabel(ms: number): string {
  const offsetMin = -new Date(ms).getTimezoneOffset();
  if (offsetMin === 0) return 'UTC+0';
  const sign = offsetMin > 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hours = pad(Math.floor(abs / 60));
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
}

export function zoneLabel(mode: TimeMode, ms: number = Date.now()): string {
  return mode === 'utc' ? 'UTC' : localOffsetLabel(ms);
}

interface TimestampOptions {
  /** Include milliseconds. */
  millis?: boolean;
  /** Omit the date part (time of day only). */
  timeOnly?: boolean;
  /** Append the zone label (default true). */
  zone?: boolean;
}

/** Returns "YYYY-MM-DD HH:mm:ss UTC" (or the same in the browser's local zone, labelled with its offset). */
export function formatTimestamp(
  value: string | number | Date | null | undefined,
  mode: TimeMode,
  options: TimestampOptions = {},
): string {
  const ms = toMs(value);
  if (ms === null) return '—';
  const d = new Date(ms);
  const utc = mode === 'utc';
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const M = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const D = utc ? d.getUTCDate() : d.getDate();
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  const msPart = utc ? d.getUTCMilliseconds() : d.getMilliseconds();
  const date = `${String(Y)}-${pad(M)}-${pad(D)}`;
  const time = `${pad(h)}:${pad(m)}:${pad(s)}${options.millis ? `.${pad(msPart, 3)}` : ''}`;
  const body = options.timeOnly ? time : `${date} ${time}`;
  return options.zone === false ? body : `${body} ${zoneLabel(mode, ms)}`;
}

/** Compact axis label: HH:mm:ss, with the date on a new line when `withDate` is set. */
export function formatAxisTime(ms: number, mode: TimeMode, withDate = false): string {
  const time = formatTimestamp(ms, mode, { timeOnly: true, zone: false });
  if (!withDate) return time;
  return `${formatTimestamp(ms, mode, { zone: false }).slice(0, 10)}\n${time}`;
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'no data';
  const s = Math.max(0, seconds);
  if (s < 1) return 'just now';
  if (s < 60) return `${String(Math.round(s))} s ago`;
  if (s < 3600) {
    const min = Math.floor(s / 60);
    return `${String(min)} min ${String(Math.round(s - min * 60))} s ago`.replace(
      ' 0 s ago',
      ' ago',
    );
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const min = Math.round((s - h * 3600) / 60);
    return `${String(h)} h ${String(min)} min ago`;
  }
  return `${String(Math.floor(s / 86400))} d ago`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${String(s)} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${String(m)} min ${String(rest)} s` : `${String(m)} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${String(h)} h ${String(m)} min` : `${String(h)} h`;
}

/** Sign-aware offset like "T+02:15" / "T-00:30" relative to a reference instant. */
export function formatRelativeOffset(ms: number, referenceMs: number): string {
  const diff = Math.round((ms - referenceMs) / 1000);
  const sign = diff < 0 ? '-' : '+';
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `T${sign}${h ? `${pad(h)}:` : ''}${pad(m)}:${pad(s)}`;
}

export function formatNumber(value: number | null | undefined, maxDecimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const decimals = maxDecimals ?? (Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : 2);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(value);
}

export function formatValue(
  value: number | null | undefined,
  unit: string | null | undefined,
): string {
  const num = formatNumber(value);
  return num === '—' ? num : unit ? `${num} ${unit}` : num;
}

/** `datetime-local` input value ("YYYY-MM-DDTHH:mm:ss") for an instant, rendered in UTC. */
export function toUtcInputValue(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Parses a `datetime-local` value as UTC. Returns null when empty or invalid. */
export function parseUtcInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, Y, M, D, h, m, s] = match;
  const ms = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(m), Number(s ?? 0));
  return Number.isFinite(ms) ? ms : null;
}

export function titleCase(text: string): string {
  return text.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

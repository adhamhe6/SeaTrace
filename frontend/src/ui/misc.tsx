import type { ReactNode } from 'react';
import { formatAge, formatTimestamp, toMs, zoneLabel } from '@/lib/format';
import { useSettings } from '@/lib/settingsStore';
import { useNow } from '@/lib/useNow';
import { cx } from './cx';

/** Monospaced timestamp in the user's chosen zone (UTC by default), always labelled with the zone. */
export function Timestamp({
  value,
  millis,
  className,
}: {
  value: string | number | null | undefined;
  millis?: boolean;
  className?: string;
}) {
  const mode = useSettings((s) => s.timeMode);
  const ms = toMs(value);
  if (ms === null) return <span className="muted">—</span>;
  return (
    <time className={cx('st-time', className)} dateTime={new Date(ms).toISOString()}>
      {formatTimestamp(ms, mode, { millis, zone: false })}
      <span className="st-time__zone">{zoneLabel(mode, ms)}</span>
    </time>
  );
}

/** "3 s ago" that keeps ticking. */
export function RelativeAge({
  value,
  fallback = 'no data',
}: {
  value: string | number | null | undefined;
  fallback?: string;
}) {
  const now = useNow();
  const ms = toMs(value);
  if (ms === null) return <span className="muted">{fallback}</span>;
  return <span className="tnum">{formatAge(Math.max(0, (now - ms) / 1000))}</span>;
}

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('st-stat', className)}>
      <span className="st-stat__label">{label}</span>
      <span className="st-stat__value">{value}</span>
      {sub ? <span className="st-stat__sub">{sub}</span> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="st-kv">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Small bar showing where a value sits relative to its nominal range. */
export function RangeBar({
  value,
  min,
  max,
  unit,
}: {
  value: number | null;
  min: number | null;
  max: number | null;
  unit: string;
}) {
  if (min === null || max === null || max <= min) {
    return (
      <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
        No nominal range
      </span>
    );
  }
  // Scale: nominal band occupies the middle 50%; the track extends half a band width on each side.
  const span = max - min;
  const lo = min - span / 2;
  const hi = max + span / 2;
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const pct = (n: number) => clamp(((n - lo) / (hi - lo)) * 100);
  const below = value !== null && value < min;
  const above = value !== null && value > max;
  const outside = below || above;
  const description =
    value === null
      ? `No value. Nominal range ${String(min)} to ${String(max)} ${unit}`
      : `${below ? 'Below' : above ? 'Above' : 'Within'} nominal range ${String(min)} to ${String(max)} ${unit}`;
  return (
    <div>
      <div
        className={cx('st-range', value === null && 'st-range--none', outside && 'st-range--out')}
        role="img"
        aria-label={description}
      >
        <span
          className="st-range__band"
          style={{ left: `${String(pct(min))}%`, width: `${String(pct(max) - pct(min))}%` }}
        />
        {value !== null ? (
          <span className="st-range__marker" style={{ left: `${String(pct(value))}%` }} />
        ) : null}
      </div>
      <div
        className="muted tnum"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--fs-xs)',
          marginTop: 3,
        }}
      >
        <span>{below ? 'below range' : String(min)}</span>
        <span>{above ? 'above range' : `${String(max)} ${unit}`}</span>
      </div>
    </div>
  );
}

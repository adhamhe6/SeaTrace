import type { CSSProperties } from 'react';

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, style }: SkeletonProps) {
  return <span className="st-skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}

/** Announces loading to assistive technology while showing placeholder blocks. */
export function LoadingBlock({
  label = 'Loading',
  lines = 3,
  height = 16,
}: {
  label?: string;
  lines?: number;
  height?: number;
}) {
  return (
    <div role="status" aria-live="polite" aria-label={label} style={{ display: 'grid', gap: 10 }}>
      <span className="sr-only">{label}…</span>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={height} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

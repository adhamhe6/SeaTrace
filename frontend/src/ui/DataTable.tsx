import type { ReactNode } from 'react';
import { cx } from './cx';
import { Skeleton } from './Skeleton';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  /** Text used as the label when the table stacks on narrow screens (defaults to a string header). */
  label?: string;
  className?: string;
}

interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[] | undefined;
  getRowKey: (row: T) => string | number;
  /** Visible to assistive technology (and optionally sighted users) as the table name. */
  caption: string;
  showCaption?: boolean;
  loading?: boolean;
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  stack?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  showCaption = false,
  loading = false,
  empty,
  rowClassName,
  stack = true,
}: DataTableProps<T>) {
  if (!loading && rows?.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="st-table-wrap">
      <table
        className={cx('st-table', stack && 'st-table--stack')}
        aria-busy={loading || undefined}
      >
        <caption className={showCaption ? undefined : 'sr-only'}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === 'right' ? 'is-right' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !rows
            ? Array.from({ length: 4 }, (_, i) => (
                <tr key={`sk-${String(i)}`}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <Skeleton height={14} />
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map((row) => (
                <tr key={getRowKey(row)} className={rowClassName?.(row)}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      data-label={c.label ?? (typeof c.header === 'string' ? c.header : c.key)}
                      className={cx(
                        c.align === 'right' && 'is-right',
                        c.mono && 'is-mono',
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

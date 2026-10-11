import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeError } from '@/lib/errors';
import { Button } from './Button';

interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="st-state">
      <Inbox size={28} className="st-state__icon" aria-hidden="true" />
      <p className="st-state__title">{title}</p>
      {children ? <p className="st-state__text">{children}</p> : null}
      {action ? <div className="st-state__actions">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  /** Overrides the generated hint for known error codes. */
  hint?: string;
}

export function ErrorState({ error, title, onRetry, retrying, hint }: ErrorStateProps) {
  const info = describeError(error);
  return (
    <div className="st-state st-state--error" role="alert">
      <CircleAlert size={28} className="st-state__icon" aria-hidden="true" />
      <p className="st-state__title">{title ?? info.title}</p>
      <p className="st-state__text">{info.message}</p>
      {(hint ?? info.hint) ? <p className="st-state__hint">{hint ?? info.hint}</p> : null}
      {info.requestId ? <p className="st-state__meta">Request ID {info.requestId}</p> : null}
      {onRetry ? (
        <div className="st-state__actions">
          <Button icon={RefreshCw} onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

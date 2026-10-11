import { CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tone } from '@/lib/domain';
import { cx } from './cx';

const ICONS: Partial<Record<Tone, LucideIcon>> = {
  info: Info,
  ok: CircleCheck,
  warning: TriangleAlert,
  critical: OctagonAlert,
  offline: TriangleAlert,
  neutral: Info,
};

interface BannerProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** `alert` interrupts assistive technology; `status` (default) is polite. */
  role?: 'status' | 'alert';
  className?: string;
}

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  role = 'status',
  className,
}: BannerProps) {
  const Icon = ICONS[tone] ?? Info;
  return (
    <div className={cx('st-banner', `st-tone-${tone}`, className)} role={role}>
      <Icon size={16} className="st-banner__icon" aria-hidden="true" />
      <div className="st-banner__body">
        {title ? <span className="st-banner__title">{title}</span> : null}
        {title && children ? ' ' : null}
        {children}
      </div>
      {actions ? <div className="st-banner__actions">{actions}</div> : null}
    </div>
  );
}

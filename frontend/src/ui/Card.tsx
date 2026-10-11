import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx';

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  /** Heading level for the title (default 2). */
  headingLevel?: 2 | 3;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
  id?: string;
  'aria-labelledby'?: string;
}

export function Card({
  title,
  subtitle,
  icon: Icon,
  actions,
  headingLevel = 2,
  flush,
  className,
  bodyClassName,
  children,
  id,
  ...rest
}: CardProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('st-card', className)} id={id} {...rest}>
      {title || actions ? (
        <header className="st-card__head">
          <div>
            {title ? (
              <Heading className="st-card__title">
                {Icon ? <Icon size={16} aria-hidden="true" /> : null}
                {title}
              </Heading>
            ) : null}
            {subtitle ? <p className="st-card__sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="st-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? (
        <div className={cx('st-card__body', flush && 'st-card__body--flush', bodyClassName)}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

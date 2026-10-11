import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cx } from './cx';
import { Tooltip } from './Tooltip';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface CommonProps {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
}

export interface ButtonProps extends CommonProps, ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  /**
   * When set the button is unavailable for a reason the user can fix or should know about
   * (e.g. "Operator role required"). It stays focusable (aria-disabled) so the explanation is reachable.
   */
  disabledReason?: string;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    loading = false,
    disabledReason,
    className,
    children,
    onClick,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const blocked = Boolean(disabledReason);
  const button = (aria: { 'aria-describedby'?: string }) => (
    <button
      {...rest}
      {...aria}
      ref={ref}
      type={type}
      className={cx('st-btn', `st-btn--${variant}`, size === 'sm' && 'st-btn--sm', className)}
      disabled={(disabled ?? false) || loading}
      aria-disabled={blocked ? true : undefined}
      aria-busy={loading || undefined}
      onClick={
        blocked
          ? (event) => {
              event.preventDefault();
            }
          : onClick
      }
    >
      {loading ? (
        <span className="st-spinner" aria-hidden="true" />
      ) : Icon ? (
        <Icon size={16} aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
  if (!blocked) return button({});
  return <Tooltip content={disabledReason}>{(aria) => button(aria)}</Tooltip>;
});

interface IconButtonProps
  extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: LucideIcon;
  /** Required accessible name; also shown as the tooltip. */
  label: string;
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', className, tooltip = true, ...rest },
  ref,
) {
  const button = (aria: { 'aria-describedby'?: string }) => (
    <button
      {...rest}
      {...aria}
      ref={ref}
      type={rest.type ?? 'button'}
      aria-label={label}
      className={cx(
        'st-btn',
        `st-btn--${variant}`,
        'st-btn--icon',
        size === 'sm' && 'st-btn--sm',
        className,
      )}
    >
      <Icon size={size === 'sm' ? 15 : 18} aria-hidden="true" />
    </button>
  );
  if (!tooltip) return button({});
  return <Tooltip content={label}>{(aria) => button(aria)}</Tooltip>;
});

interface ButtonLinkProps extends CommonProps, LinkProps {
  children?: ReactNode;
}

/** A router link styled as a button. */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      {...rest}
      className={cx('st-btn', `st-btn--${variant}`, size === 'sm' && 'st-btn--sm', className)}
    >
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      {children}
    </Link>
  );
}

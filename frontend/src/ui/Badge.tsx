import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AlarmState, Communication, Health, Quality, Role, Severity } from '@/api/types';
import { ALARM_STATE, COMMUNICATION, HEALTH, QUALITY, SEVERITY, type Tone } from '@/lib/domain';
import { cx } from './cx';
import { Tooltip } from './Tooltip';

interface BadgeProps {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  title?: string;
  className?: string;
}

/** Status pill. Status is always conveyed by icon and text, never by colour alone. */
export function Badge({ tone = 'neutral', icon: Icon, children, title, className }: BadgeProps) {
  const pill = (aria: { 'aria-describedby'?: string }) => (
    <span
      {...aria}
      className={cx('st-badge', `st-tone-${tone}`, !Icon && 'st-badge--plain', className)}
    >
      {Icon ? <Icon size={13} aria-hidden="true" /> : null}
      {children}
    </span>
  );
  if (!title) return pill({});
  return <Tooltip content={title}>{(aria) => pill(aria)}</Tooltip>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const d = SEVERITY[severity];
  return (
    <Badge tone={d.tone} icon={d.icon}>
      {d.label}
    </Badge>
  );
}

export function HealthBadge({ health }: { health: Health }) {
  const d = HEALTH[health];
  return (
    <Badge tone={d.tone} icon={d.icon}>
      {d.label}
    </Badge>
  );
}

export function CommunicationBadge({ communication }: { communication: Communication }) {
  const d = COMMUNICATION[communication];
  return (
    <Badge tone={d.tone} icon={d.icon}>
      {d.label}
    </Badge>
  );
}

export function QualityBadge({ quality }: { quality: Quality }) {
  const d = QUALITY[quality];
  return (
    <Badge tone={d.tone} icon={d.icon} title={d.description}>
      {d.label}
    </Badge>
  );
}

export function AlarmStateBadge({ state }: { state: AlarmState }) {
  const d = ALARM_STATE[state];
  return (
    <Badge tone={d.tone} icon={d.icon} title={d.explanation}>
      {d.label}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge tone={role === 'operator' ? 'info' : 'neutral'}>
      {role === 'operator' ? 'Operator' : 'Viewer'}
    </Badge>
  );
}

const STATE_TONE: Record<string, Tone> = {
  RUNNING: 'ok',
  STARTING: 'info',
  PUMPING: 'info',
  DEGRADED: 'warning',
  TRIPPED: 'critical',
  STOPPED: 'neutral',
  STANDBY: 'neutral',
};

/** Equipment operating state (RUNNING, STOPPED, ...). */
export function EquipmentStateBadge({ state }: { state: string | null }) {
  if (!state) return <Badge tone="offline">Unknown</Badge>;
  return <Badge tone={STATE_TONE[state.toUpperCase()] ?? 'neutral'}>{state}</Badge>;
}

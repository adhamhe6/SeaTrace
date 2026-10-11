import {
  Activity,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Info,
  OctagonAlert,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type {
  AlarmState,
  Communication,
  Health,
  LatestReading,
  Quality,
  Severity,
} from '@/api/types';

export type Tone = 'neutral' | 'info' | 'ok' | 'warning' | 'critical' | 'offline';

export interface Descriptor {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  description?: string;
}

export const SEVERITY: Record<Severity, Descriptor & { rank: number }> = {
  info: { label: 'Info', tone: 'info', icon: Info, rank: 0 },
  warning: { label: 'Warning', tone: 'warning', icon: TriangleAlert, rank: 1 },
  critical: { label: 'Critical', tone: 'critical', icon: OctagonAlert, rank: 2 },
};

export const HEALTH: Record<Health, Descriptor> = {
  normal: { label: 'Normal', tone: 'ok', icon: CircleCheck },
  warning: { label: 'Warning', tone: 'warning', icon: TriangleAlert },
  critical: { label: 'Critical', tone: 'critical', icon: OctagonAlert },
  offline: { label: 'Offline', tone: 'offline', icon: WifiOff },
};

export const COMMUNICATION: Record<Communication, Descriptor> = {
  online: { label: 'Online', tone: 'ok', icon: Activity },
  degraded: { label: 'Degraded', tone: 'warning', icon: TriangleAlert },
  offline: { label: 'Offline', tone: 'offline', icon: WifiOff },
};

export const QUALITY: Record<Quality, Descriptor> = {
  good: {
    label: 'Good',
    tone: 'ok',
    icon: CircleCheck,
    description: 'Source reported a good value.',
  },
  uncertain: {
    label: 'Uncertain',
    tone: 'warning',
    icon: CircleHelp,
    description:
      'Source flagged the value as uncertain (for example just after a sensor recovered).',
  },
  bad: {
    label: 'Bad',
    tone: 'critical',
    icon: OctagonAlert,
    description: 'Source reported a bad status; the value must be ignored.',
  },
  invalid: {
    label: 'Invalid',
    tone: 'critical',
    icon: CircleSlash,
    description: 'The value failed plausibility validation (outside physical limits).',
  },
  stuck: {
    label: 'Stuck',
    tone: 'warning',
    icon: TriangleAlert,
    description: 'The value is flat-lined while the timestamp keeps advancing.',
  },
  stale: {
    label: 'Stale',
    tone: 'offline',
    icon: WifiOff,
    description: 'No fresh sample has arrived within the staleness limit.',
  },
};

export interface AlarmStateInfo extends Descriptor {
  conditionActive: boolean;
  acknowledged: boolean;
  needsAcknowledgement: boolean;
  explanation: string;
}

export const ALARM_STATE: Record<AlarmState, AlarmStateInfo> = {
  active_unacknowledged: {
    label: 'Active - unacknowledged',
    tone: 'critical',
    icon: OctagonAlert,
    conditionActive: true,
    acknowledged: false,
    needsAcknowledgement: true,
    explanation:
      'The alarm condition is present and no operator has acknowledged it yet. It needs attention and acknowledgement.',
  },
  active_acknowledged: {
    label: 'Active - acknowledged',
    tone: 'warning',
    icon: TriangleAlert,
    conditionActive: true,
    acknowledged: true,
    needsAcknowledgement: false,
    explanation:
      'An operator has acknowledged the alarm, but the underlying condition is still present. It closes once the condition returns to normal.',
  },
  cleared_unacknowledged: {
    label: 'Cleared - unacknowledged',
    tone: 'info',
    icon: Info,
    conditionActive: false,
    acknowledged: false,
    needsAcknowledgement: true,
    explanation:
      'The condition has returned to normal, but the alarm still needs to be acknowledged by an operator before it closes. Clearing never implies acknowledgement.',
  },
  cleared: {
    label: 'Closed',
    tone: 'ok',
    icon: CircleCheck,
    conditionActive: false,
    acknowledged: true,
    needsAcknowledgement: false,
    explanation:
      'The condition returned to normal and the alarm was acknowledged. The alarm is closed and kept only as history.',
  },
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  raised: 'Raised',
  acknowledged: 'Acknowledged',
  cleared: 'Returned to normal',
  reactivated: 'Reactivated',
};

export function eventLabel(eventType: string): string {
  return EVENT_TYPE_LABEL[eventType] ?? eventType.replace(/_/g, ' ');
}

export const KIND_LABEL = {
  condition: 'Process condition',
  data_quality: 'Data quality',
  communication: 'Communication',
} as const;

/** Worst-first ordering for health values. */
export const HEALTH_RANK: Record<Health, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
  offline: 3,
};

export function comparisonSymbol(comparison: string): string {
  switch (comparison) {
    case 'gt':
      return '>';
    case 'lt':
      return '<';
    case 'bad_quality':
      return 'quality is bad';
    case 'stale':
      return 'data stale';
    default:
      return comparison;
  }
}

/** Effective reading quality, taking local staleness into account. */
export function effectiveQuality(reading: LatestReading, locallyStale: boolean): Quality {
  return locallyStale ? 'stale' : reading.quality;
}

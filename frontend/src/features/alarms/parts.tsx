import { Check, CircleCheck, Activity } from 'lucide-react';
import { useIsOperator, OPERATOR_REQUIRED } from '@/auth/authStore';
import type { AlarmOut } from '@/api/types';
import { ALARM_STATE } from '@/lib/domain';
import { Button } from '@/ui/Button';

/** Distinguishes "condition still present" from "returned to normal" (independent of acknowledgement). */
export function ConditionIndicator({ alarm }: { alarm: Pick<AlarmOut, 'condition_active'> }) {
  return alarm.condition_active ? (
    <span className="cond cond--active">
      <Activity size={13} aria-hidden="true" />
      Condition: active
    </span>
  ) : (
    <span className="cond cond--normal">
      <CircleCheck size={13} aria-hidden="true" />
      Condition: returned to normal
    </span>
  );
}

export function AckButton({
  alarm,
  onAcknowledge,
}: {
  alarm: AlarmOut;
  onAcknowledge: (alarm: AlarmOut) => void;
}) {
  const isOperator = useIsOperator();
  if (!ALARM_STATE[alarm.state].needsAcknowledgement) {
    return <span className="muted xs">Acknowledged</span>;
  }
  return (
    <Button
      size="sm"
      variant="primary"
      icon={Check}
      disabledReason={isOperator ? undefined : OPERATOR_REQUIRED}
      aria-label={`Acknowledge alarm ${String(alarm.id)}`}
      onClick={() => {
        onAcknowledge(alarm);
      }}
    >
      Acknowledge
    </Button>
  );
}

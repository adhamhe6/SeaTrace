import { Check } from 'lucide-react';
import { useState } from 'react';
import { useAcknowledgeAlarm } from '@/api/hooks';
import { ApiError } from '@/api/client';
import type { AlarmOut } from '@/api/types';
import { describeError } from '@/lib/errors';
import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { Field, TextArea } from '@/ui/Field';
import { useToast } from '@/ui/Toast';

interface Props {
  alarm: AlarmOut | null;
  onClose: () => void;
}

export function AcknowledgeDialog({ alarm, onClose }: Props) {
  return alarm ? <AcknowledgeInner key={alarm.id} alarm={alarm} onClose={onClose} /> : null;
}

function AcknowledgeInner({ alarm, onClose }: { alarm: AlarmOut; onClose: () => void }) {
  const [note, setNote] = useState('');
  const toast = useToast();
  const ack = useAcknowledgeAlarm();

  const submit = () => {
    if (ack.isPending) return;
    ack.mutate(
      { id: alarm.id, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Alarm #${String(alarm.id)} acknowledged`, alarm.message);
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            toast.info(
              'Already acknowledged',
              'Another operator acknowledged this alarm first, or it has already closed. The list was refreshed.',
            );
            onClose();
          } else if (error instanceof ApiError && error.status === 403) {
            toast.error(
              'Operator role required',
              'Your account is read-only and cannot acknowledge alarms.',
            );
            onClose();
          } else if (error instanceof ApiError && error.status === 404) {
            toast.error('Alarm not found', 'The alarm no longer exists.');
            onClose();
          } else {
            toast.error('Acknowledgement failed', describeError(error).message);
          }
        },
      },
    );
  };

  const handled = ack.error instanceof ApiError && [403, 404, 409].includes(ack.error.status);
  return (
    <Dialog
      open
      onClose={onClose}
      busy={ack.isPending}
      title={`Acknowledge alarm #${String(alarm.id)}`}
      footer={
        <>
          <Button onClick={onClose} disabled={ack.isPending}>
            Cancel
          </Button>
          <Button variant="primary" icon={Check} loading={ack.isPending} onClick={submit}>
            Acknowledge
          </Button>
        </>
      }
    >
      <p className="small">
        <strong>{alarm.message}</strong>
        <br />
        <span className="muted">
          {alarm.vessel_name} / {alarm.equipment_name}
        </span>
      </p>
      <p className="small muted">
        Acknowledging records that you have seen this alarm. It does not clear the underlying
        condition.
      </p>
      <Field label="Note (optional)" hint="Up to 500 characters; stored in the alarm history.">
        <TextArea
          maxLength={500}
          value={note}
          data-autofocus
          disabled={ack.isPending}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
      </Field>
      {ack.isError && !handled ? (
        <Banner tone="critical" role="alert">
          {describeError(ack.error).message}
        </Banner>
      ) : null}
    </Dialog>
  );
}

import {
  Flag,
  FlagOff,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from 'lucide-react';
import { formatRelativeOffset } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button, IconButton } from '@/ui/Button';
import { Card } from '@/ui/Card';
import { Segmented } from '@/ui/Choice';
import { Timestamp } from '@/ui/misc';
import { focusTimes, nextAfter, phaseAt, PHASE_LABEL, prevBefore, type ReplayModel } from './model';
import { SPEEDS, type PlaybackStore, type Speed } from './playback';
import { usePlaybackSnapshot } from './usePlayback';

interface Props {
  model: ReplayModel;
  store: PlaybackStore;
}

const PHASE_TONE = { before: 'info', during: 'critical', after: 'ok' } as const;

export function PlaybackControls({ model, store }: Props) {
  const { cursor, playing, speed } = usePlaybackSnapshot(store);
  const focus = focusTimes(model);
  const phase = phaseAt(model, cursor);
  const eventTimes = model.events.map((e) => e.ts);
  const hasSamples = model.sampleTimes.length > 0;
  const prevSample = prevBefore(model.sampleTimes, cursor - 0.5);
  const nextSample = nextAfter(model.sampleTimes, cursor + 0.5);
  const prevEvent = prevBefore(eventTimes, cursor - 0.5);
  const nextEvent = nextAfter(eventTimes, cursor + 0.5);
  const duration = model.to - model.from;
  const reference = focus.raisedAt ?? model.from;

  return (
    <Card title="Playback" bodyClassName="stack">
      <div className="playback__row">
        <Button
          variant="primary"
          icon={playing ? Pause : Play}
          onClick={() => {
            store.toggle();
          }}
          aria-keyshortcuts="Space"
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <IconButton
          icon={StepBack}
          label="Step back to previous sample"
          variant="secondary"
          disabled={prevSample === null}
          onClick={() => {
            if (prevSample !== null) store.seek(prevSample);
          }}
          aria-keyshortcuts="ArrowLeft"
        />
        <IconButton
          icon={StepForward}
          label="Step forward to next sample"
          variant="secondary"
          disabled={nextSample === null}
          onClick={() => {
            if (nextSample !== null) store.seek(nextSample);
          }}
          aria-keyshortcuts="ArrowRight"
        />
        <IconButton
          icon={SkipBack}
          label="Previous alarm event"
          variant="secondary"
          disabled={prevEvent === null}
          onClick={() => {
            if (prevEvent !== null) store.seek(prevEvent);
          }}
        />
        <IconButton
          icon={SkipForward}
          label="Next alarm event"
          variant="secondary"
          disabled={nextEvent === null}
          onClick={() => {
            if (nextEvent !== null) store.seek(nextEvent);
          }}
        />
        <Segmented
          label="Playback speed (relative to data time)"
          value={speed}
          onChange={(value: Speed) => {
            store.setSpeed(value);
          }}
          options={SPEEDS.map((s) => ({ value: s, label: `${String(s)}x` }))}
        />
        {model.focusAlarmId !== null ? (
          <>
            <Button
              icon={Flag}
              disabled={focus.raisedAt === null}
              disabledReason={
                focus.raisedAt === null ? 'The alarm was raised before this window' : undefined
              }
              onClick={() => {
                if (focus.raisedAt !== null) store.seek(focus.raisedAt);
              }}
            >
              Jump to alarm raised
            </Button>
            <Button
              icon={FlagOff}
              disabledReason={
                focus.clearedAt === null
                  ? 'The alarm condition did not return to normal in this window'
                  : undefined
              }
              onClick={() => {
                if (focus.clearedAt !== null) store.seek(focus.clearedAt);
              }}
            >
              Jump to alarm cleared
            </Button>
          </>
        ) : null}
      </div>

      <div className="playback__slider">
        <label htmlFor="replay-seek" className="sr-only">
          Seek position in the replay window
        </label>
        <input
          id="replay-seek"
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={Math.max(1, Math.round(duration / 2000))}
          value={Math.round(cursor - model.from)}
          disabled={!hasSamples && model.events.length === 0 && duration <= 0}
          aria-valuetext={new Date(cursor).toISOString()}
          onChange={(e) => {
            store.seek(model.from + Number(e.target.value));
          }}
        />
      </div>

      <div className="playback__readout">
        <div>
          <span className="st-stat__label">Replay time</span>
          <div className="playback__time" data-testid="cursor-time" aria-live="off">
            <Timestamp value={cursor} millis />
          </div>
        </div>
        <div>
          <span className="st-stat__label">Offset</span>
          <div className="mono tnum" data-testid="cursor-offset">
            {formatRelativeOffset(cursor, reference)}
          </div>
          <div className="xs muted">
            {focus.raisedAt !== null ? 'from alarm raised' : 'from window start'}
          </div>
        </div>
        {phase ? (
          <div>
            <span className="st-stat__label">Phase</span>
            <div data-testid="phase">
              <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>
            </div>
          </div>
        ) : null}
      </div>
      <p className="xs muted">
        Keyboard: <kbd>Space</kbd> play / pause · <kbd>←</kbd> <kbd>→</kbd> step to the previous /
        next stored sample. Speed is data seconds per real second.
      </p>
    </Card>
  );
}

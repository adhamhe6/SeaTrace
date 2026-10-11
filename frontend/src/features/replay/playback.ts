import { clampNumber } from './util';

export const SPEEDS = [0.5, 1, 2, 5, 10, 30] as const;
export type Speed = (typeof SPEEDS)[number];

export interface PlaybackSnapshot {
  /** Cursor position in data time (epoch ms). */
  cursor: number;
  playing: boolean;
  /** Data seconds advanced per real second. */
  speed: Speed;
}

interface Scheduler {
  raf: (cb: (time: number) => void) => number;
  caf: (handle: number) => void;
  now: () => number;
}

const browserScheduler = (): Scheduler => ({
  raf: (cb) => window.requestAnimationFrame(cb),
  caf: (h) => {
    window.cancelAnimationFrame(h);
  },
  now: () => performance.now(),
});

/**
 * Playback clock for the replay. The cursor advances in DATA time (speed x real time), driven by
 * requestAnimationFrame, and pauses itself at the end of the window. Exposed as an external store so
 * high-frequency cursor updates only re-render the few components that display it.
 */
export class PlaybackStore {
  private snap: PlaybackSnapshot;
  private readonly listeners = new Set<() => void>();
  private handle: number | null = null;
  private lastFrame = 0;
  private readonly scheduler: Scheduler;

  constructor(
    private readonly from: number,
    private readonly to: number,
    scheduler?: Partial<Scheduler>,
    initialCursor: number = from,
  ) {
    this.scheduler = { ...browserScheduler(), ...scheduler };
    this.snap = { cursor: clampNumber(initialCursor, from, to), playing: false, speed: 1 };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PlaybackSnapshot => this.snap;

  get cursor(): number {
    return this.snap.cursor;
  }

  private set(partial: Partial<PlaybackSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    this.listeners.forEach((l) => {
      l();
    });
  }

  private frame = (time: number): void => {
    this.handle = null;
    if (!this.snap.playing) return;
    const dt = Math.max(0, time - this.lastFrame);
    this.lastFrame = time;
    const next = this.snap.cursor + dt * this.snap.speed;
    if (next >= this.to) {
      this.set({ cursor: this.to, playing: false });
      return;
    }
    this.set({ cursor: next });
    this.handle = this.scheduler.raf(this.frame);
  };

  play(): void {
    if (this.snap.playing) return;
    const atEnd = this.snap.cursor >= this.to;
    this.lastFrame = this.scheduler.now();
    this.set({ playing: true, cursor: atEnd ? this.from : this.snap.cursor });
    this.handle = this.scheduler.raf(this.frame);
  }

  pause(): void {
    if (!this.snap.playing) return;
    if (this.handle !== null) this.scheduler.caf(this.handle);
    this.handle = null;
    this.set({ playing: false });
  }

  toggle(): void {
    if (this.snap.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: Speed): void {
    this.set({ speed });
  }

  /** Moves the cursor (clamped to the window). Playback state is unchanged unless the end is reached. */
  seek(ms: number): void {
    const cursor = clampNumber(ms, this.from, this.to);
    this.set({ cursor });
  }

  dispose(): void {
    if (this.handle !== null) this.scheduler.caf(this.handle);
    this.handle = null;
    this.listeners.clear();
  }
}

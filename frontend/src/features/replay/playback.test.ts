import { describe, expect, it } from 'vitest';
import { PlaybackStore } from './playback';

/** A manual animation-frame clock so playback can be driven deterministically. */
function clock() {
  let time = 0;
  let next: ((t: number) => void) | null = null;
  let handle = 0;
  return {
    scheduler: {
      now: () => time,
      raf: (cb: (t: number) => void) => {
        next = cb;
        handle += 1;
        return handle;
      },
      caf: () => {
        next = null;
      },
    },
    advance(ms: number) {
      time += ms;
      const cb = next;
      next = null;
      cb?.(time);
    },
    get scheduled() {
      return next !== null;
    },
  };
}

describe('PlaybackStore', () => {
  it('advances the cursor in DATA time: speed x real time', () => {
    const c = clock();
    const store = new PlaybackStore(1000, 61_000, c.scheduler);
    store.play();
    c.advance(1000);
    expect(store.cursor).toBe(2000); // 1x: one data second per real second
    store.setSpeed(10);
    c.advance(1000);
    expect(store.cursor).toBe(12_000); // 10x
    store.setSpeed(0.5);
    c.advance(2000);
    expect(store.cursor).toBe(13_000);
  });

  it('pauses itself at the end of the window', () => {
    const c = clock();
    const store = new PlaybackStore(0, 10_000, c.scheduler);
    store.setSpeed(30);
    store.play();
    c.advance(1000);
    expect(store.getSnapshot()).toMatchObject({ cursor: 10_000, playing: false });
    expect(c.scheduled).toBe(false);
  });

  it('pause stops advancing and cancels the frame', () => {
    const c = clock();
    const store = new PlaybackStore(0, 100_000, c.scheduler);
    store.play();
    c.advance(500);
    store.pause();
    expect(c.scheduled).toBe(false);
    c.advance(5000);
    expect(store.cursor).toBe(500);
    expect(store.getSnapshot().playing).toBe(false);
  });

  it('restarts from the beginning when played at the end', () => {
    const c = clock();
    const store = new PlaybackStore(0, 10_000, c.scheduler);
    store.seek(10_000);
    store.play();
    expect(store.getSnapshot()).toMatchObject({ cursor: 0, playing: true });
  });

  it('seek clamps to the window and keeps the playing state', () => {
    const c = clock();
    const store = new PlaybackStore(1000, 5000, c.scheduler);
    store.seek(-50);
    expect(store.cursor).toBe(1000);
    store.seek(9999);
    expect(store.cursor).toBe(5000);
    store.seek(2500);
    store.play();
    store.seek(3000);
    expect(store.getSnapshot()).toMatchObject({ cursor: 3000, playing: true });
  });

  it('toggle flips between play and pause and notifies subscribers', () => {
    const c = clock();
    const store = new PlaybackStore(0, 5000, c.scheduler);
    let notifications = 0;
    const off = store.subscribe(() => {
      notifications += 1;
    });
    store.toggle();
    expect(store.getSnapshot().playing).toBe(true);
    store.toggle();
    expect(store.getSnapshot().playing).toBe(false);
    off();
    store.seek(10);
    expect(notifications).toBe(2);
  });

  it('dispose cancels pending frames and drops listeners', () => {
    const c = clock();
    const store = new PlaybackStore(0, 5000, c.scheduler);
    store.play();
    store.dispose();
    expect(c.scheduled).toBe(false);
  });
});

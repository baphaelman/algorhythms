import { beforeEach, describe, expect, it, vi } from 'vitest';

// Compose for me (M4.5-28): the build is driven by animation frames; the test runs them at chosen
// times (performance.now and the frame time are the test's clock).
const env = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.matchMedia = () => ({ matches: false });
  const queue = new Map<number, (t: number) => void>();
  let next = 0;
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    queue.set(++next, cb);
    return next;
  };
  g.cancelAnimationFrame = (id: number) => queue.delete(id);
  const clock = { now: 0 };
  return {
    clock,
    /** Drops the composer's detail steps (a composition whose detail sweep is empty). */
    noDetail: false,
    /** Runs the frames queued now, at the clock's time. */
    frame() {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(clock.now);
    },
  };
});
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
    loopAudio: ok,
  };
});
vi.mock('../../../src/app/persist', async () => {
  const { loadPiece } = await import('../../../src/app/store');
  const { newPiece } = await import('../../../src/core/defaults');
  return { loadNewPiece: () => loadPiece(newPiece({ seed: 1 }), { source: 'new' }) };
});

vi.mock('../../../src/core/compose-directed', async (orig) => {
  const m = await orig<typeof import('../../../src/core/compose-directed')>();
  return {
    ...m,
    composeDirected: (...a: Parameters<typeof m.composeDirected>) => {
      const c = m.composeDirected(...a);
      return env.noDetail ? { ...c, steps: c.steps.filter((s) => s.phase === 'structure') } : c;
    },
  };
});

import { compile } from '../../../src/core/compiler/compile';
import { composedPiece } from '../../../src/core/generate';
import { parsePiece } from '../../../src/core/schema';
import {
  closeCompose,
  closeSetup,
  composeAgain,
  finish,
  openCompose,
  runCompose,
  setComposeWatch,
  stopCompose,
  useCompose,
} from '../../../src/app/compose';
import { composeDirected } from '../../../src/core/compose-directed';
import { DEFAULT_ANSWERS, buildBrief, type ComposeAnswers } from '../../../src/app/compose-setup';
import { MAX_PEN_SECONDS, composeTimeline, penAt, stepsAt } from '../../../src/app/compose-pace';
import { composeView } from '../../../src/app/compose-view';
import { updateMoment } from '../../../src/app/editor/actions';
import { redo, undo, useEditor } from '../../../src/app/editor/history';
import { camera, usePlayer } from '../../../src/app/store';

vi.spyOn(performance, 'now').mockImplementation(() => env.clock.now);

const piece = () => usePlayer.getState().piece;
const ui = () => useCompose.getState();

/** Advances the clock by `ms` in 16 ms frames. */
function run(ms: number): void {
  const end = env.clock.now + ms;
  while (env.clock.now < end) {
    env.clock.now = Math.min(end, env.clock.now + 16);
    env.frame();
  }
}

/** A fixed length, so the pace checks see a full-size piece. */
const ANSWERS: ComposeAnswers = { ...DEFAULT_ANSWERS, mood: 'dreamy', length: 180 };

/** The finished piece for `seed` and `answers`. */
const want = (seed: number, answers = ANSWERS) =>
  composedPiece(composeDirected(buildBrief(answers, seed)));

/** New → Compose for me, then Compose with `answers` and `seed`. */
function open(seed = 4242, answers = ANSWERS): void {
  openCompose();
  expect(ui().setup).toBe(true);
  useCompose.setState({ seed, answers });
  runCompose();
}

describe('compose pace', () => {
  it('builds a 2 min piece in 15–25 s, 3 min in 20–35 s', () => {
    for (const seed of [1, 2, 3, 4242, 99]) {
      for (const [brief, lo, hi] of [
        [{ seed, length: 120 }, 15_000, 25_000],
        [{ seed, length: 180, mood: 'driving' }, 20_000, 35_000],
        [{ seed, length: 180, shape: 'build' }, 20_000, 35_000],
      ] as const) {
        const total = composeTimeline(composeDirected(brief)).total;
        expect(total, JSON.stringify(brief)).toBeGreaterThan(lo);
        expect(total, JSON.stringify(brief)).toBeLessThan(hi);
      }
    }
  });

  it('keeps short and long pieces watchable: 1 min takes a few seconds, 5 min under a minute', () => {
    const short = composeTimeline(composeDirected({ seed: 5, length: 60 })).total;
    expect(short).toBeGreaterThan(3_000);
    expect(short).toBeLessThan(15_000);
    const long = composeTimeline(composeDirected({ seed: 5, length: 300 })).total;
    expect(long).toBeLessThan((MAX_PEN_SECONDS + 10) * 1000);
  });

  it('applies steps in order; the pen only moves forward, through the structure then the details', () => {
    const c = composeDirected({ seed: 1, mood: 'dreamy', length: 180 }); // has a detail step
    const tl = composeTimeline(c);
    expect(tl.beats).toHaveLength(c.steps.length);
    expect(stepsAt(tl, 0)).toBe(1);
    expect(stepsAt(tl, tl.total)).toBe(c.steps.length);
    const details = tl.beats.filter((b) => b.detail);
    expect(details.length).toBeGreaterThan(0);
    expect(tl.beats.findIndex((b) => b.detail)).toBe(tl.beats.length - details.length);
    let k = 0;
    let pen = 0;
    let detail = false;
    for (let ms = 0; ms < tl.total; ms += 20) {
      const now = stepsAt(tl, ms);
      expect(now).toBeGreaterThanOrEqual(k);
      k = now;
      const p = penAt(tl, ms);
      // One restart, into the detail sweep.
      if (!detail && tl.beats[k - 1].detail) {
        detail = true;
        pen = -Infinity;
      }
      expect(p).toBeGreaterThanOrEqual(pen - 1e-9);
      pen = p;
    }
    expect(detail).toBe(true);
    expect(penAt(tl, tl.total)).toBe(Infinity);
  });
});

describe('Compose for me', () => {
  beforeEach(() => {
    closeCompose();
    env.clock.now = 0;
  });

  it('opens an empty piece, then places moments over time and ends on generate()', () => {
    open();
    expect(ui().open).toBe(true);
    expect(ui().status).toBe('building');
    const counts: number[] = [];
    for (let i = 0; i < 6; i++) {
      run(2000);
      counts.push(piece().moments.length);
    }
    expect(composeView.reveal).toBeGreaterThan(50);
    expect(composeView.reveal).toBeLessThan(120);
    // Moments appear over time, a few per two seconds, not all at once.
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThan(counts[5]);
    run(25000);
    expect(ui().status).toBe('done');
    expect(composeView.reveal).toBe(undefined);
    expect(piece().moments).toEqual(want(4242).moments);
    expect(piece().end).toEqual(want(4242).end);
    expect(ui().brief).toEqual({ seed: 4242, mood: 'dreamy', length: 180 });
  });

  it('Skip shows the whole piece at once', () => {
    open(7);
    run(500);
    finish();
    expect(ui().status).toBe('done');
    expect(piece().moments).toEqual(want(7).moments);
  });

  it('Watch the composer unticked: Compose opens the finished piece at once', () => {
    setComposeWatch(false);
    try {
      open(8);
      expect(ui().status).toBe('done');
      expect(piece().moments).toEqual(want(8).moments);
      expect(composeView.reveal).toBe(undefined);
      // All of it in view at once (not the empty piece's length).
      expect(usePlayer.getState().view.window).toBeGreaterThan(140);
      undo();
      expect(piece().moments).toEqual([]);
    } finally {
      setComposeWatch(true);
    }
  });

  it('a composition with no detail steps finishes straight after the structure', () => {
    env.noDetail = true;
    try {
      open(9);
      const activities = new Set<string>();
      let detail = false;
      for (let t = 0; t < 60_000 && ui().status === 'building'; t += 16) {
        run(16);
        activities.add(ui().activity);
        detail ||= composeView.detail;
      }
      expect(ui().status).toBe('done');
      expect(detail).toBe(false);
      expect([...activities].some((a) => a.startsWith('Adding details'))).toBe(false);
      expect(piece().moments).toEqual(want(9).moments);
    } finally {
      env.noDetail = false;
    }
  });

  it('Stop keeps a valid, playable partial piece; one undo empties it', () => {
    open(31);
    run(6000);
    stopCompose();
    expect(ui().status).toBe('stopped');
    const partial = piece();
    const all = want(31).moments.length;
    expect(partial.moments.length).toBeGreaterThan(1);
    expect(partial.moments.length).toBeLessThan(all);
    expect(parsePiece(JSON.parse(JSON.stringify(partial))).ok).toBe(true);
    const score = compile(partial);
    expect(score.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(score.duration).toBeGreaterThan(10);
    // Nothing more is placed after Stop.
    run(5000);
    expect(piece()).toBe(partial);

    expect(useEditor.getState().undoLabel).toBe('Compose');
    undo();
    expect(piece().moments).toHaveLength(0); // the empty piece
    expect(useEditor.getState().canUndo).toBe(false);
    redo();
    expect(piece()).toBe(partial);
  });

  it('the camera follows the pen forward, then holds on the whole piece for the details', () => {
    open(1); // seed 1 has a detail step
    let start = camera.start;
    let flashed = 0;
    let fitted = NaN;
    while (ui().status === 'building') {
      run(16);
      if (ui().status !== 'building') break;
      if (!composeView.detail) {
        expect(camera.start).toBeGreaterThanOrEqual(start - 1e-9);
        start = camera.start;
      } else {
        if (Number.isNaN(fitted)) fitted = camera.start;
        expect(camera.start).toBe(fitted);
        expect(usePlayer.getState().view.window).toBeGreaterThan(140);
        if (composeView.flash) flashed++;
      }
    }
    expect(start).toBeGreaterThan(60);
    expect(fitted).toBe(0);
    expect(flashed).toBeGreaterThan(0);
  });

  it('Compose again reopens the setup with the last answers and a new seed; one entry', () => {
    open(5);
    finish();
    const done = piece();
    composeAgain();
    expect(ui().setup).toBe(true);
    expect(ui().answers).toEqual(ANSWERS);
    expect(ui().seed).not.toBe(5);
    run(3000);
    expect(piece()).toBe(done);
    expect(ui().open).toBe(true);

    const dark: ComposeAnswers = { ...ANSWERS, mood: 'dark', speed: 'fast' };
    useCompose.setState({ seed: 6, answers: dark });
    runCompose();
    expect(ui().setup).toBe(false);
    expect(ui().status).toBe('building');
    expect(ui().brief?.speed).toBe('fast');
    finish();
    expect(piece().moments).toEqual(want(6, dark).moments);
    expect(ui().open).toBe(true);
    // Compose again keeps the Speed answer.
    composeAgain();
    expect(ui().answers.speed).toBe('fast');
    closeSetup();
    undo();
    expect(piece().moments).toHaveLength(0);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('after Stop, Compose again rebuilds as one entry', () => {
    open(6);
    run(3000);
    stopCompose();
    const kept = piece();
    composeAgain();
    run(2000);
    expect(piece()).toBe(kept);
    useCompose.setState({ seed: 7 });
    runCompose();
    finish();
    expect(piece().moments).toEqual(want(7).moments);
    undo();
    expect(piece().moments).toHaveLength(0);
  });

  it('closing the setup from New leaves the open piece alone', () => {
    const before = piece();
    openCompose();
    closeSetup();
    expect(ui().setup).toBe(false);
    expect(ui().open).toBe(false);
    expect(piece()).toBe(before);
  });

  it('the user editing the piece after the build closes the panel', () => {
    open(8);
    finish();
    expect(ui().open).toBe(true);
    updateMoment(piece().moments[1].id, { muted: true });
    expect(ui().open).toBe(false);
    // Undo of the edit, then of the whole compose (one entry).
    undo();
    undo();
    expect(piece().moments).toHaveLength(0);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('undoing the compose closes the panel', () => {
    open(12);
    finish();
    undo();
    expect(ui().open).toBe(false);
  });

  it('an edit from outside stops the build where it is and closes the panel', () => {
    open(9);
    run(4000);
    const id = piece().moments[1].id;
    updateMoment(id, { muted: true });
    run(200);
    expect(ui().status).toBe('stopped');
    expect(ui().open).toBe(false);
    const n = piece().moments.length;
    run(4000);
    expect(piece().moments.length).toBe(n);
  });
});

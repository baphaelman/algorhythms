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

import { compile } from '../../../src/core/compiler/compile';
import { composeSteps, generate } from '../../../src/core/generate';
import { parsePiece } from '../../../src/core/schema';
import {
  closeCompose,
  composeAgain,
  finish,
  openCompose,
  setComposeInput,
  stopCompose,
  useCompose,
} from '../../../src/app/compose';
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

function open(seed = '4242', extra = {}): void {
  useCompose.setState((s) => ({
    form: { ...s.form, mode: 'dorian', length: 150, naturalLength: false, voices: 12, ...extra },
  }));
  openCompose();
  setComposeInput({ seed });
}

describe('compose pace', () => {
  it('builds a 2:30 piece in 15–25 s', () => {
    for (const seed of [1, 2, 3, 4242, 99]) {
      for (const opts of [
        { mode: 'dorian' as const, length: 150 },
        { mode: 'pentatonic' as const },
        { mode: 'lydian' as const, length: 150, voices: 24 },
      ]) {
        const total = composeTimeline(composeSteps(seed, opts)).total;
        expect(total, `${seed} ${JSON.stringify(opts)}`).toBeGreaterThan(15_000);
        expect(total).toBeLessThan(25_000);
      }
    }
  });

  it('keeps short and long pieces watchable: 30 s takes a few seconds, 15 min under a minute', () => {
    const short = composeTimeline(composeSteps(5, { mode: 'aeolian', length: 30 })).total;
    expect(short).toBeGreaterThan(3_000);
    expect(short).toBeLessThan(15_000);
    const long = composeTimeline(composeSteps(5, { mode: 'aeolian', length: 900 })).total;
    expect(long).toBeLessThan((MAX_PEN_SECONDS + 10) * 1000);
  });

  it('applies steps in order; the pen only moves forward, through the structure then the details', () => {
    const c = composeSteps(8, { mode: 'dorian' });
    const tl = composeTimeline(c);
    expect(tl.beats).toHaveLength(c.steps.length);
    expect(stepsAt(tl, 0)).toBe(1);
    expect(stepsAt(tl, tl.total)).toBe(c.steps.length);
    const details = tl.beats.filter((b) => b.detail);
    expect(details.length).toBeGreaterThan(1);
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
    run(15000);
    expect(ui().status).toBe('done');
    expect(composeView.reveal).toBe(undefined);
    const want = generate(4242, { mode: 'dorian', length: 150, voices: 12, density: 0.45 });
    expect(piece().moments).toEqual(want.moments);
    expect(piece().end).toEqual(want.end);
  });

  it('Skip shows the whole piece at once', () => {
    open('7');
    run(500);
    finish();
    expect(ui().status).toBe('done');
    expect(piece().moments).toEqual(generate(7, { mode: 'dorian', length: 150 }).moments);
  });

  it('Stop keeps a valid, playable partial piece; one undo empties it', () => {
    open('31');
    run(6000);
    stopCompose();
    expect(ui().status).toBe('stopped');
    const partial = piece();
    const all = generate(31, { mode: 'dorian', length: 150 }).moments.length;
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

  it('an input change mid-build restarts from it', () => {
    open('100');
    run(5000);
    const before = ui().step;
    expect(before).toBeGreaterThan(3);
    setComposeInput({ seed: '101' });
    expect(ui().step).toBe(0);
    expect(piece().moments).toHaveLength(0);
    run(2000);
    const first = composeSteps(101, { mode: 'dorian', length: 150 }).steps[1].moment;
    expect(piece().moments.some((m) => m.id === first.id)).toBe(true);
    finish();
    expect(piece().moments).toEqual(generate(101, { mode: 'dorian', length: 150 }).moments);
    undo();
    expect(piece().moments).toHaveLength(0);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('the camera follows the pen forward, then holds on the whole piece for the details', () => {
    open('4242');
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

  it('after it finishes, input changes do not recompose; Compose again does, as one entry', () => {
    open('5');
    finish();
    const done = piece();
    setComposeInput({ voices: 6 });
    expect(ui().status).toBe('done');
    run(3000);
    expect(piece()).toBe(done);
    expect(ui().open).toBe(true);

    composeAgain();
    expect(ui().status).toBe('building');
    finish();
    expect(piece().voices).toHaveLength(6);
    expect(piece().moments).toEqual(
      generate(5, { mode: 'dorian', length: 150, voices: 6 }).moments,
    );
    expect(ui().open).toBe(true);
    undo();
    expect(piece().moments).toHaveLength(0);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('after Stop, input changes wait for Compose again', () => {
    open('6');
    run(3000);
    stopCompose();
    const kept = piece();
    setComposeInput({ seed: '7' });
    run(2000);
    expect(piece()).toBe(kept);
    composeAgain();
    finish();
    expect(piece().moments).toEqual(generate(7, { mode: 'dorian', length: 150 }).moments);
    undo();
    expect(piece().moments).toHaveLength(0);
  });

  it('the user editing the piece after the build closes the panel', () => {
    open('8');
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
    open('12');
    finish();
    undo();
    expect(ui().open).toBe(false);
  });

  it('an edit from outside stops the build where it is and closes the panel', () => {
    open('9');
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

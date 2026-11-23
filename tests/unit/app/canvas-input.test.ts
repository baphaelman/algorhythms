import { beforeEach, describe, expect, it, vi } from 'vitest';

// canvas-input's document-level keys, with the store, editor actions and DOM stubbed out.
const h = vi.hoisted(() => {
  class FakeElement {
    tagName = 'DIV';
    type = '';
    isContentEditable = false;
  }
  const state = {
    handler: null as ((e: KeyboardEvent) => void) | null,
    upHandler: null as ((e: KeyboardEvent) => void) | null,
    /** The window capture handler for Space (keydown and keyup). */
    spaceHandler: null as ((e: KeyboardEvent) => void) | null,
    dialogOpen: false,
    wide: true,
    selection: [] as string[],
    /** Moment types with no effect at the playhead. */
    noEffect: new Set<string>(),
  };
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = FakeElement;
  g.window = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void, capture?: boolean) => {
      if (type === 'keydown' && capture === true) state.spaceHandler = fn;
    },
    removeEventListener: () => undefined,
  };
  g.document = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void) => {
      if (type === 'keydown') state.handler = fn;
      if (type === 'keyup') state.upHandler = fn;
    },
    removeEventListener: () => undefined,
    querySelector: (sel: string) => {
      if (sel === 'dialog[open]') return state.dialogOpen ? {} : null;
      if (sel === '.app[data-layout="full"]') return state.wide ? {} : null;
      return null;
    },
  };
  return { FakeElement, state };
});

const fns = vi.hoisted(() => ({
  undo: vi.fn(),
  redo: vi.fn(),
  select: vi.fn(),
  addMoment: vi.fn(),
  deleteMoments: vi.fn(() => true),
  stepNote: vi.fn((id: string) => id === 'note1'),
  octaveDots: vi.fn(() => null),
  togglePlay: vi.fn(),
  seekBy: vi.fn(),
  zoomBy: vi.fn(),
}));

vi.mock('../../../src/app/store', () => ({
  currentTime: () => 12.3,
  usePlayer: {
    getState: () => ({
      piece: { view: {} },
      view: { window: 10, pan: 0 },
      transport: { status: 'paused' },
    }),
  },
  panBy: vi.fn(),
  seekBy: fns.seekBy,
  togglePlay: fns.togglePlay,
  zoomBy: fns.zoomBy,
}));
vi.mock('../../../src/app/editor/history', () => ({
  undo: fns.undo,
  redo: fns.redo,
  select: fns.select,
  useEditor: { getState: () => ({ selection: h.state.selection }) },
}));
vi.mock('../../../src/app/editor/actions', () => ({
  addMoment: fns.addMoment,
  deleteMoments: fns.deleteMoments,
  stepNote: fns.stepNote,
  octaveDots: fns.octaveDots,
  // ./clipboard (M5): nothing selected to copy.
  clipOfSelection: () => null,
  cutMoments: vi.fn(),
  pasteClipAt: vi.fn(),
}));
vi.mock('../../../src/app/editor/palette-effects', () => ({
  playheadEffect: (type: string) => ({ effect: !h.state.noEffect.has(type) }),
}));
// No pointer over the timeline: shortcuts add at the playhead (./palette-drop `shortcutTime`).
vi.mock('../../../src/app/palette-drop', () => ({ shortcutTime: () => 12.3 }));
vi.mock('../../../src/app/hover', () => ({ clearHover: vi.fn(), setHover: vi.fn() }));
vi.mock('../../../src/app/loop', () => ({ currentPps: () => 100 }));
vi.mock('../../../src/app/audition', () => ({
  auditionMoment: vi.fn(),
  holdNote: vi.fn(),
  stopAudition: vi.fn(),
}));

import { attachKeys } from '../../../src/app/canvas-input';

interface Ev {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: unknown;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

const el = (tagName: string, type = '', isContentEditable = false): unknown =>
  Object.assign(new h.FakeElement(), { tagName: tagName.toUpperCase(), type, isContentEditable });
const BODY = el('body');

function press(key: string, over: Partial<Ev> = {}): Ev {
  const e: Ev = {
    key,
    code: key === ' ' ? 'Space' : '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: BODY,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...over,
  };
  // As in the browser: the window capture handler first, then the document unless stopped.
  let stopped = false;
  const ev = Object.assign(e, {
    type: 'keydown',
    stopPropagation: () => {
      stopped = true;
    },
  });
  h.state.spaceHandler?.(ev as unknown as KeyboardEvent);
  if (!stopped) h.state.handler?.(ev as unknown as KeyboardEvent);
  return e;
}

/** Releases `key` (keyup); true if it was cancelled. */
function release(key: string, target: unknown = BODY): boolean {
  let prevented = false;
  h.state.spaceHandler?.({
    type: 'keyup',
    key,
    code: key === ' ' ? 'Space' : '',
    target,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => undefined,
  } as unknown as KeyboardEvent);
  return prevented;
}

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockClear();
  h.state.dialogOpen = false;
  h.state.wide = true;
  h.state.selection = [];
  h.state.noEffect.clear();
});
attachKeys();

describe('editor letters', () => {
  it('add a moment at the playhead in the wide layout', () => {
    const e = press('c');
    expect(fns.addMoment).toHaveBeenCalledWith('chord', 12.3);
    expect(e.defaultPrevented).toBe(true);
    press('L');
    expect(fns.addMoment).toHaveBeenLastCalledWith('level', 12.3);
  });

  it('do not add a type with no effect at the playhead', () => {
    h.state.noEffect.add('tune');
    const e = press('m');
    expect(fns.addMoment).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    press('c');
    expect(fns.addMoment).toHaveBeenCalledWith('chord', 12.3);
  });

  it('are ignored with a dialog open', () => {
    h.state.dialogOpen = true;
    press('c');
    expect(fns.addMoment).not.toHaveBeenCalled();
  });

  it('are ignored outside the wide layout', () => {
    h.state.wide = false;
    const e = press('c');
    expect(fns.addMoment).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('are ignored in text fields, not on buttons or sliders', () => {
    for (const t of [el('input', 'text'), el('input', 'number'), el('textarea'), el('select')]) {
      press('c', { target: t });
    }
    press('c', { target: el('div', '', true) });
    expect(fns.addMoment).not.toHaveBeenCalled();
    press('c', { target: el('button') });
    press('c', { target: el('input', 'range') });
    press('c', { target: el('input', 'checkbox') });
    expect(fns.addMoment).toHaveBeenCalledTimes(3);
  });

  it('are ignored with any modifier or on auto-repeat', () => {
    press('c', { metaKey: true });
    press('c', { ctrlKey: true });
    press('c', { altKey: true });
    press('C', { shiftKey: true });
    press('c', { repeat: true });
    expect(fns.addMoment).not.toHaveBeenCalled();
  });
});

describe('Delete and Escape', () => {
  it('Delete deletes the selection and only then prevents the default', () => {
    expect(press('Delete').defaultPrevented).toBe(false);
    expect(fns.deleteMoments).not.toHaveBeenCalled();
    h.state.selection = ['m1'];
    expect(press('Backspace').defaultPrevented).toBe(true);
    expect(fns.deleteMoments).toHaveBeenCalledWith(['m1']);
  });

  it('Delete is ignored with ⌘/Ctrl/Alt, in text fields and with a dialog open', () => {
    h.state.selection = ['m1'];
    press('Delete', { metaKey: true });
    press('Backspace', { altKey: true });
    press('Backspace', { target: el('input', 'text') });
    h.state.dialogOpen = true;
    press('Delete');
    expect(fns.deleteMoments).not.toHaveBeenCalled();
  });

  it('Escape clears a selection', () => {
    expect(press('Escape').defaultPrevented).toBe(false);
    expect(fns.select).not.toHaveBeenCalled();
    h.state.selection = ['m1'];
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(fns.select).toHaveBeenCalledWith([]);
  });

  it('Escape already used by another handler (a menu closing) keeps the selection', () => {
    h.state.selection = ['m1'];
    press('Escape', { defaultPrevented: true });
    expect(fns.select).not.toHaveBeenCalled();
  });
});

describe('undo and redo', () => {
  it('⌘/Ctrl+Z undoes; with Shift, or Ctrl+Y, redoes', () => {
    expect(press('z', { metaKey: true }).defaultPrevented).toBe(true);
    press('z', { ctrlKey: true });
    expect(fns.undo).toHaveBeenCalledTimes(2);
    press('Z', { metaKey: true, shiftKey: true });
    press('y', { ctrlKey: true });
    expect(fns.redo).toHaveBeenCalledTimes(2);
    press('y', { metaKey: true }); // ⌘Y is not redo
    press('z', { metaKey: true, altKey: true });
    expect(fns.undo).toHaveBeenCalledTimes(2);
    expect(fns.redo).toHaveBeenCalledTimes(2);
  });

  it('text fields keep their own undo; select, range and checkbox pass it through', () => {
    for (const t of [el('input', 'text'), el('textarea'), el('div', '', true)]) {
      expect(press('z', { metaKey: true, target: t }).defaultPrevented).toBe(false);
    }
    expect(fns.undo).not.toHaveBeenCalled();
    for (const t of [el('select'), el('input', 'range'), el('input', 'checkbox')]) {
      press('z', { metaKey: true, target: t });
    }
    expect(fns.undo).toHaveBeenCalledTimes(3);
  });

  it('is ignored with a dialog open', () => {
    h.state.dialogOpen = true;
    press('z', { metaKey: true });
    expect(fns.undo).not.toHaveBeenCalled();
  });
});

describe('player keys', () => {
  it('Space plays on release in the editor (Space-drag pans), on any control', () => {
    press(' ');
    expect(fns.togglePlay).not.toHaveBeenCalled();
    release(' ');
    expect(fns.togglePlay).toHaveBeenCalledTimes(1);
    for (const t of [el('button'), el('input', 'checkbox'), el('select'), el('input', 'range')]) {
      expect(press(' ', { target: t }).defaultPrevented).toBe(true);
      press(' ', { target: t, repeat: true });
      expect(release(' ', t)).toBe(true);
    }
    expect(fns.togglePlay).toHaveBeenCalledTimes(5);
  });

  it('Space types in text fields and does not play', () => {
    for (const t of [el('input', 'text'), el('input', 'search'), el('textarea')]) {
      expect(press(' ', { target: t }).defaultPrevented).toBe(false);
      expect(release(' ', t)).toBe(false);
    }
    expect(fns.togglePlay).not.toHaveBeenCalled();
  });

  it('Enter toggles a focused checkbox', () => {
    const click = vi.fn();
    const box = Object.assign(el('input', 'checkbox') as object, { click });
    expect(press('Enter', { target: box }).defaultPrevented).toBe(true);
    press('Enter', { target: box, repeat: true });
    press('Enter', { target: el('button') });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('arrows seek, except on sliders and text fields; − and = zoom', () => {
    press('ArrowRight');
    press('ArrowLeft', { shiftKey: true });
    expect(fns.seekBy.mock.calls).toEqual([[5], [-15]]);
    press('ArrowLeft', { target: el('input', 'range') });
    press('ArrowLeft', { target: el('input', 'text') });
    expect(fns.seekBy).toHaveBeenCalledTimes(2);
    press('-');
    press('=');
    expect(fns.zoomBy.mock.calls).toEqual([[1.25], [0.8]]);
  });

  it('work outside the wide layout, and not with a dialog open', () => {
    h.state.wide = false;
    press(' ');
    expect(fns.togglePlay).toHaveBeenCalledTimes(1);
    press(' ', { repeat: true });
    release(' ');
    expect(fns.togglePlay).toHaveBeenCalledTimes(1);
    h.state.dialogOpen = true;
    press(' ');
    expect(fns.togglePlay).toHaveBeenCalledTimes(1);
  });
});

describe('▲/▼ on a selected note point', () => {
  it('steps its `to` and only then prevents the default', () => {
    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(fns.stepNote).not.toHaveBeenCalled();
    h.state.selection = ['note1'];
    expect(press('ArrowUp').defaultPrevented).toBe(true);
    expect(fns.stepNote).toHaveBeenLastCalledWith('note1', 1, undefined, false);
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(fns.stepNote).toHaveBeenLastCalledWith('note1', -1, undefined, false);
    // Shift: an octave (no dots selected, so the note point).
    expect(press('ArrowUp', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(fns.stepNote).toHaveBeenLastCalledWith('note1', 1, undefined, true);
    h.state.selection = ['chord1'];
    expect(press('ArrowUp').defaultPrevented).toBe(false);
  });

  it('is ignored when handled, in fields and outside the wide layout', () => {
    h.state.selection = ['note1'];
    press('ArrowUp', { defaultPrevented: true });
    press('ArrowUp', { shiftKey: true, defaultPrevented: true });
    press('ArrowDown', { target: el('input', 'range') });
    h.state.wide = false;
    press('ArrowDown');
    expect(fns.stepNote).not.toHaveBeenCalled();
  });
});

/** Musical typing's key mapping and gating (PLAN.md §9 "Inputs", M7-b). */

import { describe, expect, it } from 'vitest';
import { editorKey } from '../../../src/app/editor/shortcuts';
import {
  DEFAULT_OCTAVE,
  letterCode,
  OCTAVE_MAX,
  OCTAVE_MIN,
  shiftOctave,
  typingAction,
  typingPitch,
} from '../../../src/app/typing-keys';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const key = (letter: string, extra: Record<string, unknown> = {}) => ({
  key: letter.toLowerCase(),
  code: `Key${letter}`,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  target: { tagName: 'BUTTON', type: 'button' },
  ...extra,
});

describe('musical typing: key mapping', () => {
  it('A W S E D F T G Y H U J K play C up to the next C', () => {
    const order = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K'];
    expect(order.map((l) => typingPitch(`Key${l}`, 4))).toEqual([
      60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72,
    ]);
    expect(typingPitch('KeyQ', 4)).toBeNull();
    expect(typingPitch('KeyZ', 4)).toBeNull();
  });

  it('octaves move the whole row; the default is C4', () => {
    expect(DEFAULT_OCTAVE).toBe(4);
    expect(typingPitch('KeyA', 3)).toBe(48);
    expect(typingPitch('KeyK', 5)).toBe(84);
    expect(typingPitch('KeyA', OCTAVE_MIN)).toBe(24);
    expect(typingPitch('KeyK', OCTAVE_MAX)).toBe(108);
  });

  it('Z/X shift the octave within the limits', () => {
    expect(shiftOctave(4, -1)).toBe(3);
    expect(shiftOctave(4, 1)).toBe(5);
    expect(shiftOctave(OCTAVE_MIN, -1)).toBe(OCTAVE_MIN);
    expect(shiftOctave(OCTAVE_MAX, 1)).toBe(OCTAVE_MAX);
    let o = DEFAULT_OCTAVE;
    for (let i = 0; i < 20; i++) o = shiftOctave(o, 1);
    expect(o).toBe(OCTAVE_MAX);
    expect(typingAction(key('Z'), true)).toEqual({ kind: 'octave', dir: -1 });
    expect(typingAction(key('X'), true)).toEqual({ kind: 'octave', dir: 1 });
  });

  it('keys are read by position (code), the letter only without one', () => {
    // AZERTY: the physical A key types "q" but plays C.
    expect(typingAction({ ...key('A'), key: 'q' }, true, 4)).toMatchObject({ pitch: 60 });
    expect(letterCode({ key: 'w', code: '' })).toBe('KeyW');
    expect(letterCode({ key: '1', code: 'Digit1' })).toBeNull();
  });

  it('notes take the current octave', () => {
    expect(typingAction(key('A'), true, 2)).toEqual({ kind: 'note', code: 'KeyA', pitch: 36 });
  });
});

describe('musical typing: shortcut gating', () => {
  it('with the mode on, every letter is taken, so no editor shortcut sees it', () => {
    for (const l of LETTERS) {
      for (const shiftKey of [false, true]) {
        const e = key(l, { shiftKey, key: shiftKey ? l : l.toLowerCase() });
        expect(typingAction(e, true), l).not.toBeNull();
      }
    }
    // The palette letters (S W T U K among them) are editor shortcuts with the mode off.
    for (const l of ['C', 'U', 'S', 'M', 'T', 'P', 'W', 'R', 'E', 'O', 'I', 'K', 'L', 'B']) {
      expect(editorKey(key(l)), l).not.toBeNull();
      expect(typingAction(key(l), false), l).toBeNull();
    }
  });

  it('key repeat is taken but plays nothing', () => {
    expect(typingAction(key('A', { repeat: true }), true)).toEqual({ kind: 'swallow' });
    expect(typingAction(key('Z', { repeat: true }), true)).toEqual({ kind: 'swallow' });
  });

  it('letters without a note are taken too', () => {
    expect(typingAction(key('Q'), true)).toEqual({ kind: 'swallow' });
    expect(typingAction(key('N'), true)).toEqual({ kind: 'swallow' });
  });

  it('Space, Escape, Delete, arrows and ⌘/Ctrl/Alt chords stay editor keys', () => {
    const other = (k: string, code: string) => ({ ...key('A'), key: k, code });
    expect(typingAction(other(' ', 'Space'), true)).toBeNull();
    expect(typingAction(other('Escape', 'Escape'), true)).toBeNull();
    expect(typingAction(other('Delete', 'Delete'), true)).toBeNull();
    expect(typingAction(other('ArrowLeft', 'ArrowLeft'), true)).toBeNull();
    expect(typingAction(other('\\', 'Backslash'), true)).toBeNull();
    expect(typingAction(key('Z', { metaKey: true }), true)).toBeNull();
    expect(typingAction(key('Z', { ctrlKey: true }), true)).toBeNull();
    expect(typingAction(key('C', { ctrlKey: true }), true)).toBeNull();
    expect(typingAction(key('A', { altKey: true }), true)).toBeNull();
  });

  it('text fields keep their keys (no notes, no toggle)', () => {
    for (const target of [
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      expect(typingAction(key('A', { target }), true)).toBeNull();
      expect(
        typingAction({ ...key('A', { target }), key: '`', code: 'Backquote' }, true),
      ).toBeNull();
    }
    // Sliders and buttons take no text: letters play there.
    const slider = { tagName: 'INPUT', type: 'range' };
    expect(typingAction(key('A', { target: slider }), true)).toMatchObject({ kind: 'note' });
  });

  it('` toggles the mode, on or off', () => {
    const tick = { ...key('A'), key: '`', code: 'Backquote' };
    expect(typingAction(tick, false)).toEqual({ kind: 'toggle' });
    expect(typingAction(tick, true)).toEqual({ kind: 'toggle' });
    expect(typingAction({ ...tick, repeat: true }, true)).toEqual({ kind: 'swallow' });
    expect(typingAction({ ...tick, metaKey: true }, true)).toBeNull();
  });
});

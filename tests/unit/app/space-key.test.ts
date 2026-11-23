import { describe, expect, it } from 'vitest';

import {
  dialogSpace,
  isSpace,
  setDialogSpace,
  spaceKey,
  typesSpace,
  type SpaceHeld,
} from '../../../src/app/space-key';

const el = (tagName: string, type = '', isContentEditable = false) => ({
  tagName: tagName.toUpperCase(),
  type,
  isContentEditable,
});
const BODY = el('body');
const EDITOR = { editor: true, dialog: false };
const PLAYER = { editor: false, dialog: false };

const down = (target: unknown = BODY, repeat = false) => ({ type: 'keydown', target, repeat });
const up = (target: unknown = BODY) => ({ type: 'keyup', target, repeat: false });
const fresh = (): SpaceHeld => ({ down: false, panned: false });

describe('typesSpace', () => {
  it('is true for text fields only', () => {
    for (const t of [
      el('input', 'text'),
      el('input', 'search'),
      el('input', 'number'),
      el('textarea'),
      el('div', '', true),
    ]) {
      expect(typesSpace(t)).toBe(true);
    }
    for (const t of [
      el('button'),
      el('select'),
      el('input', 'checkbox'),
      el('input', 'radio'),
      el('input', 'range'),
      el('input', 'button'),
      el('a'),
      el('canvas'),
      BODY,
      null,
    ]) {
      expect(typesSpace(t)).toBe(false);
    }
  });

  it('isSpace matches by code or key', () => {
    expect(isSpace({ key: ' ', code: 'Space' })).toBe(true);
    expect(isSpace({ key: ' ' })).toBe(true);
    expect(isSpace({ key: 'Enter', code: 'Enter' })).toBe(false);
  });
});

describe('spaceKey', () => {
  it('editor: arms on keydown and toggles on release, on any focused control', () => {
    for (const t of [BODY, el('button'), el('select'), el('input', 'checkbox'), el('canvas')]) {
      const held = fresh();
      expect(spaceKey(down(t), held, EDITOR)).toEqual({ consume: true, toggle: false });
      expect(held.down).toBe(true);
      expect(spaceKey(up(t), held, EDITOR)).toEqual({ consume: true, toggle: true });
      expect(held.down).toBe(false);
    }
  });

  it('player: toggles on keydown; the keyup is still cancelled', () => {
    const held = fresh();
    expect(spaceKey(down(el('button')), held, PLAYER)).toEqual({ consume: true, toggle: true });
    expect(spaceKey(up(el('button')), held, PLAYER)).toEqual({ consume: true, toggle: false });
  });

  it('key repeat never toggles again', () => {
    const p = fresh();
    expect(spaceKey(down(), p, PLAYER).toggle).toBe(true);
    for (let i = 0; i < 5; i++) expect(spaceKey(down(BODY, true), p, PLAYER).toggle).toBe(false);
    const e = fresh();
    spaceKey(down(), e, EDITOR);
    for (let i = 0; i < 5; i++) {
      expect(spaceKey(down(BODY, true), e, EDITOR)).toEqual({ consume: true, toggle: false });
    }
    expect(spaceKey(up(), e, EDITOR).toggle).toBe(true);
  });

  it('a Space-drag that panned does not toggle on release', () => {
    const held = fresh();
    spaceKey(down(), held, EDITOR);
    held.panned = true; // canvas-input's pointer pan
    expect(spaceKey(up(), held, EDITOR)).toEqual({ consume: true, toggle: false });
    // The next plain press toggles again.
    spaceKey(down(), held, EDITOR);
    expect(held.panned).toBe(false);
    expect(spaceKey(up(), held, EDITOR).toggle).toBe(true);
  });

  it('text fields type the space: nothing is cancelled', () => {
    for (const t of [
      el('input', 'text'),
      el('input', 'search'),
      el('textarea'),
      el('p', '', true),
    ]) {
      const held = fresh();
      expect(spaceKey(down(t), held, EDITOR)).toEqual({ consume: false, toggle: false });
      expect(spaceKey(up(t), held, EDITOR)).toEqual({ consume: false, toggle: false });
      expect(spaceKey(down(t), held, PLAYER)).toEqual({ consume: false, toggle: false });
      expect(held.down).toBe(false);
    }
  });

  it('a held Space toggles on release even if focus moved into a text field', () => {
    const held = fresh();
    spaceKey(down(), held, EDITOR);
    expect(spaceKey(up(el('input', 'text')), held, EDITOR).toggle).toBe(true);
  });

  it('an open dialog keeps the browser Space', () => {
    const ctx = { editor: true, dialog: true };
    const held = fresh();
    expect(spaceKey(down(el('button')), held, ctx)).toEqual({ consume: false, toggle: false });
    expect(spaceKey(up(el('button')), held, ctx)).toEqual({ consume: false, toggle: false });
    // Armed before the dialog opened: the release ends the hold without toggling.
    spaceKey(down(), held, EDITOR);
    expect(spaceKey(up(), held, ctx)).toEqual({ consume: true, toggle: false });
    expect(held.down).toBe(false);
  });

  it('a dialog with its own play/pause takes Space from any control but a text field', () => {
    for (const editor of [true, false]) {
      const ctx = { editor, dialog: true, dialogPlay: true };
      for (const t of [el('input', 'checkbox'), el('button'), el('input', 'radio'), BODY]) {
        const held = fresh();
        expect(spaceKey(down(t), held, ctx)).toEqual({ consume: true, toggle: true });
        expect(spaceKey(down(t, true), held, ctx)).toEqual({ consume: true, toggle: false });
        // The release is cancelled too (browsers activate buttons and switches on keyup).
        expect(spaceKey(up(t), held, ctx)).toEqual({ consume: true, toggle: false });
        expect(held.down).toBe(false);
      }
      const held = fresh();
      expect(spaceKey(down(el('input', 'text')), held, ctx)).toEqual({
        consume: false,
        toggle: false,
      });
      expect(spaceKey(up(el('textarea')), held, ctx)).toEqual({ consume: false, toggle: false });
    }
  });
});

describe('setDialogSpace', () => {
  it('registers one toggle; unregistering a replaced one keeps the newer', () => {
    const a = () => undefined;
    const b = () => undefined;
    const offA = setDialogSpace(a);
    expect(dialogSpace()).toBe(a);
    const offB = setDialogSpace(b);
    offA();
    expect(dialogSpace()).toBe(b);
    offB();
    expect(dialogSpace()).toBeNull();
  });
});

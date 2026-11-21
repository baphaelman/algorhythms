import { describe, expect, it } from 'vitest';
import { draftReduce } from '../../../src/app/ui/inspector/fields';

describe('number field draft rule', () => {
  const clean = { text: '3.1', dirty: false };

  it('typing makes a draft', () => {
    expect(draftReduce(clean, { type: 'type', text: '9' })).toEqual({ text: '9', dirty: true });
  });

  it('an external value change drops the draft and shows the new value', () => {
    const d = draftReduce({ text: '9', dirty: true }, { type: 'external', shown: '2' });
    expect(d).toEqual({ text: '2', dirty: false });
  });

  it('drops the draft even when the shown value is unchanged text-wise', () => {
    const d = draftReduce({ text: '3.1', dirty: true }, { type: 'external', shown: '3.1' });
    expect(d.dirty).toBe(false);
  });

  it('an external change with no draft just follows the value', () => {
    expect(draftReduce(clean, { type: 'external', shown: '4' })).toEqual({
      text: '4',
      dirty: false,
    });
    expect(draftReduce(clean, { type: 'external', shown: '3.1' })).toBe(clean);
  });

  it('a chord-symbol (text) draft is dropped by an outside change', () => {
    const d = draftReduce({ text: 'Am7', dirty: true }, { type: 'external', shown: 'C' });
    expect(d).toEqual({ text: 'C', dirty: false });
  });

  it('a field-set text (step, commit, Escape) is not a draft', () => {
    expect(draftReduce({ text: '9', dirty: true }, { type: 'set', text: '3.1' }).dirty).toBe(false);
  });
});

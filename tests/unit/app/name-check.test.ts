import { describe, expect, it } from 'vitest';
import { cleanName, shouldAskName } from '../../../src/app/name-check';

const base = { title: 'Untitled', edited: true, skipped: false };

describe('shouldAskName', () => {
  it('asks when the piece is edited and still has the default title', () => {
    expect(shouldAskName(base)).toBe(true);
    expect(shouldAskName({ ...base, title: '  Untitled ' })).toBe(true);
    expect(shouldAskName({ ...base, title: '' })).toBe(true);
  });
  it('does not ask when the piece has a name', () => {
    expect(shouldAskName({ ...base, title: 'Tidewater Hymn' })).toBe(false);
  });
  it('does not ask when the piece was never edited', () => {
    expect(shouldAskName({ ...base, edited: false })).toBe(false);
  });
  it('does not ask again after Skip', () => {
    expect(shouldAskName({ ...base, skipped: true })).toBe(false);
  });
});

describe('cleanName', () => {
  it('trims, and rejects empty or default names', () => {
    expect(cleanName('  Night walk ')).toBe('Night walk');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('Untitled')).toBeNull();
  });
});

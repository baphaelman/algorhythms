import { describe, expect, it } from 'vitest';
import { cleanName, shouldAskName } from '../../../src/app/name-check';

const base = { title: 'Untitled', edited: true, skipped: false };

describe('shouldAskName', () => {
  it('asks when the piece is edited and still has the default title', () => {
    expect(shouldAskName(base)).toBe(true);
    expect(shouldAskName({ ...base, title: '  Untitled ' })).toBe(true);
    expect(shouldAskName({ ...base, title: '' })).toBe(true);
  });
  it('treats an automatic Generate or Compose title as unnamed', () => {
    expect(shouldAskName({ ...base, title: 'Dorian 4242' })).toBe(true);
    expect(shouldAskName({ ...base, title: 'Pentatonic 0' })).toBe(true);
  });
  it('keeps a user title that only resembles one', () => {
    for (const title of ['Dorian sketch', 'Dorian 12 b', 'dorian 12', 'Dorian 007', 'Dorian'])
      expect(shouldAskName({ ...base, title })).toBe(false);
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

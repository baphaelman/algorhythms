import { describe, expect, it } from 'vitest';
import {
  formatWindow,
  hasAudioSession,
  isIos,
  needsSilentModeHint,
  requestPlaybackSession,
} from '../../../src/app/platform';

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari' };
const MAC = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari',
  platform: 'MacIntel',
  maxTouchPoints: 0,
};
const IPAD_AS_MAC = { ...MAC, maxTouchPoints: 5 };

describe('iOS audio session (§11.5)', () => {
  it('detects iOS, including iPadOS posing as a Mac', () => {
    expect(isIos(IPHONE)).toBe(true);
    expect(isIos(IPAD_AS_MAC)).toBe(true);
    expect(isIos(MAC)).toBe(false);
  });

  it('shows the silent-mode hint only on iOS without navigator.audioSession', () => {
    expect(needsSilentModeHint(IPHONE)).toBe(true);
    expect(
      needsSilentModeHint({ ...IPHONE, audioSession: { type: 'auto' } } as typeof IPHONE),
    ).toBe(false);
    expect(needsSilentModeHint(MAC)).toBe(false);
  });

  it("sets audioSession.type = 'playback' where supported", () => {
    const nav = { audioSession: { type: 'auto' } };
    expect(hasAudioSession(nav)).toBe(true);
    expect(requestPlaybackSession(nav)).toBe(true);
    expect(nav.audioSession.type).toBe('playback');
    expect(requestPlaybackSession({})).toBe(false);
  });
});

describe('formatWindow', () => {
  it('reads naturally across the range', () => {
    expect(formatWindow(2)).toBe('2.0 s');
    expect(formatWindow(7.46)).toBe('7.5 s');
    expect(formatWindow(20)).toBe('20 s');
    expect(formatWindow(90)).toBe('1:30');
    expect(formatWindow(301)).toBe('5:01');
  });
});

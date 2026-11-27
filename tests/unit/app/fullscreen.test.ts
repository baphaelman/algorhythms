/** Fullscreen across browsers: detection, the WebKit fallbacks, iOS's player events, F. */

import { describe, expect, it, vi } from 'vitest';
import {
  canElementFullscreen,
  canFullscreen,
  exitElementFullscreen,
  fullscreenChangeEvent,
  fullscreenElement,
  landscapeWanted,
  nativePlayerAction,
  requestElementFullscreen,
  videoFullscreenOnly,
  workspaceFullscreenKey,
} from '../../../src/app/fullscreen';

const iphoneVideo = { webkitEnterFullscreen() {} };
const canvasProto = { captureStream() {} };

describe('element fullscreen', () => {
  it('is offered standard or WebKit-prefixed (older iPad Safari)', () => {
    expect(canElementFullscreen({ fullscreenEnabled: true })).toBe(true);
    expect(canElementFullscreen({ webkitFullscreenEnabled: true })).toBe(true);
    expect(canElementFullscreen({ fullscreenEnabled: false })).toBe(false);
    expect(canElementFullscreen({})).toBe(false);
  });

  it('reads the element and the change event of the API in use', () => {
    const el = {} as Element;
    expect(fullscreenElement({ fullscreenElement: el })).toBe(el);
    expect(fullscreenElement({ webkitFullscreenElement: el })).toBe(el);
    expect(fullscreenElement({ fullscreenElement: null })).toBeNull();
    expect(fullscreenChangeEvent({ onfullscreenchange: null })).toBe('fullscreenchange');
    expect(fullscreenChangeEvent({ webkitExitFullscreen: () => undefined })).toBe(
      'webkitfullscreenchange',
    );
  });

  it('asks with the standard call, else the prefixed one; refusals stay quiet', async () => {
    const std = vi.fn(() => Promise.reject(new Error('no gesture')));
    const pre = vi.fn();
    await requestElementFullscreen({ requestFullscreen: std, webkitRequestFullscreen: pre });
    expect(std).toHaveBeenCalledOnce();
    expect(pre).not.toHaveBeenCalled();
    await requestElementFullscreen({ webkitRequestFullscreen: pre });
    expect(pre).toHaveBeenCalledOnce();
    const throws = () => {
      throw new Error('denied');
    };
    await expect(requestElementFullscreen({ webkitRequestFullscreen: throws })).resolves.toBe(
      undefined,
    );
    await expect(requestElementFullscreen({})).resolves.toBe(undefined);

    const exit = vi.fn();
    exitElementFullscreen({ webkitExitFullscreen: exit });
    expect(exit).toHaveBeenCalledOnce();
  });
});

describe('iPhone: video-only fullscreen', () => {
  it('only without element fullscreen, with webkitEnterFullscreen and a canvas stream', () => {
    expect(videoFullscreenOnly({}, iphoneVideo, canvasProto)).toBe(true);
    expect(videoFullscreenOnly({ webkitFullscreenEnabled: true }, iphoneVideo, canvasProto)).toBe(
      false,
    );
    expect(videoFullscreenOnly({ fullscreenEnabled: true }, iphoneVideo, canvasProto)).toBe(false);
    expect(videoFullscreenOnly({}, {}, canvasProto)).toBe(false);
    expect(videoFullscreenOnly({}, iphoneVideo, {})).toBe(false);
    expect(videoFullscreenOnly({}, undefined, undefined)).toBe(false);
  });

  it('the button shows with either kind', () => {
    expect(canFullscreen({ fullscreenEnabled: true })).toBe(true);
  });

  it("iOS's player's play and pause follow ours, only on a change; leaving it exits", () => {
    expect(nativePlayerAction('play', false)).toBe('play');
    expect(nativePlayerAction('play', true)).toBeNull();
    expect(nativePlayerAction('playing', false)).toBe('play');
    expect(nativePlayerAction('pause', true)).toBe('pause');
    expect(nativePlayerAction('pause', false)).toBeNull();
    expect(nativePlayerAction('webkitendfullscreen', true)).toBe('exit');
    expect(nativePlayerAction('webkitendfullscreen', false)).toBe('exit');
    expect(nativePlayerAction('timeupdate', true)).toBeNull();
  });
});

describe('landscape on phones', () => {
  it('locks for a wide video on a touch screen only', () => {
    expect(landscapeWanted({ coarse: true, aspect: 16 / 9 })).toBe(true);
    expect(landscapeWanted({ coarse: true, aspect: 9 / 16 })).toBe(false);
    expect(landscapeWanted({ coarse: true, aspect: 1 })).toBe(false);
    expect(landscapeWanted({ coarse: false, aspect: 16 / 9 })).toBe(false);
  });
});

describe("the workspace's F", () => {
  const key = (k: string, o: Partial<Parameters<typeof workspaceFullscreenKey>[0]> = {}) =>
    workspaceFullscreenKey({
      key: k,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      target: { tagName: 'BUTTON' },
      dialog: false,
      ...o,
    });

  it('goes fullscreen, but not while typing, with modifiers or a dialog', () => {
    expect(key('f')).toBe(true);
    expect(key('F')).toBe(true);
    expect(key('g')).toBe(false);
    expect(key('f', { target: { tagName: 'INPUT', type: 'text' } })).toBe(false);
    expect(key('f', { target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(key('f', { target: { tagName: 'INPUT', type: 'range' } })).toBe(true);
    expect(key('f', { metaKey: true })).toBe(false);
    expect(key('f', { shiftKey: true })).toBe(false);
    expect(key('f', { dialog: true })).toBe(false);
    expect(key('f', { defaultPrevented: true })).toBe(false);
  });
});

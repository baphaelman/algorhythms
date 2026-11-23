/** The video Preset and the Loudness display's helpers (PLAN.md §12 "Ready for YouTube"). */

import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_FORM, type ExportForm } from '../../../src/app/export-options';
import {
  LIMIT_WARN_DB,
  SHORTS_MAX,
  applyPreset,
  gainText,
  loudnessKey,
  lufsText,
  presetFields,
  presetOf,
  shortsTooLong,
  youtubeSize,
} from '../../../src/app/youtube-preset';
import { newPiece } from '../../../src/core/defaults';

const form = (p: Partial<ExportForm> = {}): ExportForm => ({
  ...DEFAULT_EXPORT_FORM,
  format: 'video',
  ...p,
});

describe('video presets', () => {
  it('YouTube: 16:9, 4K (1440p without it), 60 fps, High, −14 LUFS, title card, 10 s card', () => {
    expect(presetFields('youtube')).toEqual({
      videoAspect: '16:9',
      videoSize: '2160',
      videoFps: 60,
      videoQuality: 'high',
      loudness: -14,
      videoTitleCard: true,
      videoEndCard: 10,
    });
    expect(youtubeSize(['720', '1080', '1440', '2160'])).toBe('2160');
    expect(youtubeSize(['720', '1080', '1440'])).toBe('1440');
    expect(youtubeSize(['720', '1080'])).toBe('1080');
    expect(youtubeSize([])).toBe('1080');
    expect(presetFields('youtube', ['720', '1080', '1440']).videoSize).toBe('1440');
  });

  it('Shorts: 9:16 1080×1920, 60 fps, High, −14 LUFS, no end card', () => {
    expect(presetFields('shorts')).toEqual({
      videoAspect: '9:16',
      videoSize: '1080',
      videoFps: 60,
      videoQuality: 'high',
      loudness: -14,
      videoEndCard: 0,
    });
  });

  it('the defaults are Custom; applying a preset shows it; changing one of its fields Custom', () => {
    expect(presetOf(form())).toBe('custom');
    for (const p of ['youtube', 'shorts'] as const) {
      const f = applyPreset(form(), p);
      expect(presetOf(f)).toBe(p);
      for (const [k, v] of Object.entries({
        videoAspect: '1:1',
        videoSize: '720',
        videoFps: 30,
        videoQuality: 'max',
        loudness: 'off',
        videoEndCard: 5,
      })) {
        expect(presetOf({ ...f, [k]: v } as ExportForm)).toBe('custom');
      }
    }
    // Title card: YouTube sets it; Shorts doesn't care.
    expect(presetOf({ ...applyPreset(form(), 'youtube'), videoTitleCard: false })).toBe('custom');
    expect(presetOf({ ...applyPreset(form(), 'shorts'), videoTitleCard: true })).toBe('shorts');
    // Fields a preset doesn't set don't change it.
    const yt = applyPreset(form(), 'youtube');
    expect(presetOf({ ...yt, videoCamera: 'whole', videoFadeIn: 2, look: yt.look })).toBe(
      'youtube',
    );
  });

  it('YouTube at 1440p is YouTube where 4K is not encodable (or not known yet)', () => {
    const f = applyPreset(form(), 'youtube', ['720', '1080', '1440']);
    expect(f.videoSize).toBe('1440');
    expect(presetOf(f, ['720', '1080', '1440'])).toBe('youtube');
    expect(presetOf(f)).toBe('youtube');
    expect(presetOf(f, ['720', '1080', '1440', '2160'])).toBe('custom');
    expect(presetOf({ ...f, videoSize: '1080' })).toBe('custom');
  });

  it('Shorts warns over 3 minutes of section', () => {
    const f = applyPreset(form(), 'shorts');
    expect(SHORTS_MAX).toBe(180);
    expect(shortsTooLong(f, { start: 0, end: 180 })).toBe(false);
    expect(shortsTooLong(f, { start: 10, end: 191 })).toBe(true);
    expect(shortsTooLong(applyPreset(form(), 'youtube'), { start: 0, end: 400 })).toBe(false);
  });
});

describe('loudness display', () => {
  it('cache key: the piece as it sounds and the span, not its name, dates or view', () => {
    const p = newPiece({ seed: 7 });
    const k = loudnessKey(p);
    expect(k).toMatch(/^[0-9a-f]{8}:whole$/);
    expect(loudnessKey({ ...p, meta: { ...p.meta, title: 'Other' } })).toBe(k);
    expect(loudnessKey({ ...p, view: { ...p.view, gridBpm: 133 } })).toBe(k);
    expect(loudnessKey({ ...p, seed: p.seed + 1 })).not.toBe(k);
    expect(
      loudnessKey({ ...p, mix: { ...p.mix, reverb: { ...p.mix.reverb, returnLevel: 0.9 } } }),
    ).not.toBe(k);
    const a = loudnessKey(p, { start: 12, end: 24 });
    expect(a).toMatch(/:12\.0000-24\.0000$/);
    expect(a).not.toBe(k);
    expect(loudnessKey(p, { start: 12, end: 25 })).not.toBe(a);
  });

  it('texts', () => {
    expect(lufsText(-21.88)).toBe('−21.9 LUFS');
    expect(lufsText(-Infinity)).toBe('silent');
    expect(gainText(7.88)).toBe('+7.9 dB');
    expect(gainText(-2)).toBe('−2.0 dB');
    expect(LIMIT_WARN_DB).toBe(6);
  });
});

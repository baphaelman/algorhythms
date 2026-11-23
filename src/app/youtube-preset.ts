/**
 * The video Preset (PLAN.md §12 "Ready for YouTube" → Presets) and the Loudness display's cache
 * key, as pure functions. A preset sets a fixed list of form fields; the form shows that preset
 * while every one of them still holds its value, else Custom.
 */

import type { Piece, Seconds } from '../core/types';
import type { TimeSpan } from '../render/section';
import type { VideoSize } from '../render/video';
import type { ExportForm } from './export-options';

export type VideoPreset = 'youtube' | 'shorts' | 'custom';

export const VIDEO_PRESETS: readonly { id: VideoPreset; label: string }[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'custom', label: 'Custom' },
];

/** Longest Short, s. */
export const SHORTS_MAX: Seconds = 180;

/** The fields a preset sets. */
export type PresetFields = Pick<
  ExportForm,
  'videoAspect' | 'videoSize' | 'videoFps' | 'videoQuality' | 'loudness' | 'videoEndCard'
> &
  Partial<Pick<ExportForm, 'videoTitleCard'>>;

/**
 * YouTube's size: 4K where this browser encodes it at 16:9 60 fps, else 1440p, else the largest
 * it can. `sizes` = the classes `videoSizes` accepts at 16:9 60 fps (undefined: not known yet).
 */
export function youtubeSize(sizes?: readonly VideoSize[]): VideoSize {
  if (!sizes || sizes.includes('2160')) return '2160';
  if (sizes.includes('1440')) return '1440';
  return sizes.at(-1) ?? '1080';
}

/** What a preset sets (`sizes`: as `youtubeSize`). */
export function presetFields(
  preset: Exclude<VideoPreset, 'custom'>,
  sizes?: readonly VideoSize[],
): PresetFields {
  if (preset === 'youtube') {
    return {
      videoAspect: '16:9',
      videoSize: youtubeSize(sizes),
      videoFps: 60,
      videoQuality: 'high',
      loudness: -14,
      videoTitleCard: true,
      videoEndCard: 10,
    };
  }
  return {
    videoAspect: '9:16',
    videoSize: '1080',
    videoFps: 60,
    videoQuality: 'high',
    loudness: -14,
    videoEndCard: 0,
  };
}

/** The form with a preset applied. */
export function applyPreset(
  form: ExportForm,
  preset: Exclude<VideoPreset, 'custom'>,
  sizes?: readonly VideoSize[],
): ExportForm {
  return { ...form, ...presetFields(preset, sizes) };
}

/**
 * The preset the form matches, else Custom. Without `sizes` (not known yet) YouTube takes 4K or
 * 1440p.
 */
export function presetOf(form: ExportForm, sizes?: readonly VideoSize[]): VideoPreset {
  for (const p of ['youtube', 'shorts'] as const) {
    const f = presetFields(p, sizes);
    const match = (Object.keys(f) as (keyof PresetFields)[]).every((k) =>
      k === 'videoSize' && p === 'youtube' && !sizes
        ? form.videoSize === '2160' || form.videoSize === '1440'
        : form[k] === f[k],
    );
    if (match) return p;
  }
  return 'custom';
}

/** Shorts warns when the section is over SHORTS_MAX. */
export function shortsTooLong(form: ExportForm, span: TimeSpan, sizes?: readonly VideoSize[]) {
  return presetOf(form, sizes) === 'shorts' && span.end - span.start > SHORTS_MAX + 1e-6;
}

/** FNV-1a, 32 bits, as 8 hex digits. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The Loudness measurement's cache key: the piece as it sounds (not its name, dates or view)
 * and the span measured (none = the whole piece).
 */
export function loudnessKey(piece: Piece, span?: TimeSpan): string {
  const { meta: _m, view: _v, ...sound } = piece;
  const at = span ? `${span.start.toFixed(4)}-${span.end.toFixed(4)}` : 'whole';
  return `${hash(JSON.stringify(sound))}:${at}`;
}

/** "−21.9 LUFS". */
export function lufsText(lufs: number): string {
  if (!Number.isFinite(lufs)) return 'silent';
  return `${lufs < 0 ? '−' : ''}${Math.abs(lufs).toFixed(1)} LUFS`;
}

/** "+7.9 dB", "−2.0 dB". */
export function gainText(db: number): string {
  const r = Math.round(db * 10) / 10;
  return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)} dB`;
}

/** Limiting above this many dB gets the warning. */
export const LIMIT_WARN_DB = 6;

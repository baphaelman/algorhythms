/**
 * The text for a YouTube description box (PLAN.md §12 "Ready for YouTube" → Description): title;
 * key, tempo and length; chapters from the section labels when YouTube would accept them; the
 * credit and site URL; optionally the share link. Pure: no DOM, no store.
 */

import { keyAt } from '../core/query';
import type { CompiledScore, Piece, Seconds } from '../core/types';
import { keyName } from '../render/hud';
import { isWholeSpan, type TimeSpan } from '../render/section';
import { videoSpan } from '../render/video';

export const SITE_URL = 'https://baphaelman.github.io/algorhythms/';

/** YouTube's chapter rules: the first at 0:00, at least this many, each at least this long. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;

export interface DescriptionOptions {
  /** The exported section (M11-a): chapter times from its start, only labels inside it. */
  section?: TimeSpan;
  /** A share link to add ("Open it in AlgoRhythms"). */
  shareLink?: string;
  /** @default SITE_URL */
  siteUrl?: string;
}

export interface Chapter {
  /** Seconds from the video's start, whole (as written). */
  at: number;
  label: string;
}

/** A YouTube timestamp: `m:ss`, or `h:mm:ss` from an hour. */
export function timestamp(seconds: Seconds): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The labelled moments inside the span as chapters (times from its start, floored to the second
 * as written; one per second, the first label wins), or [] unless YouTube would accept them:
 * the first at 0:00, at least MIN_CHAPTERS, each at least MIN_CHAPTER_SECONDS to the next or to
 * the span's end.
 */
export function chapters(piece: Pick<Piece, 'moments'>, span: TimeSpan): Chapter[] {
  const length = span.end - span.start;
  const labelled = piece.moments
    .filter((m) => m.label?.trim() && m.at >= span.start - 1e-6 && m.at < span.end)
    .map((m, i) => ({
      at: Math.max(0, Math.floor(m.at - span.start + 1e-6)),
      label: m.label!.trim(),
      i,
    }))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const out: Chapter[] = [];
  for (const c of labelled) {
    if (out.at(-1)?.at !== c.at) out.push({ at: c.at, label: c.label });
  }
  if (out.length < MIN_CHAPTERS || out[0].at !== 0) return [];
  for (let i = 0; i < out.length; i++) {
    const next = i + 1 < out.length ? out[i + 1].at : length;
    if (next - out[i].at < MIN_CHAPTER_SECONDS) return [];
  }
  return out;
}

/** The description text (lines joined with \n). */
export function youtubeDescription(
  piece: Pick<Piece, 'meta' | 'moments' | 'view'>,
  score: CompiledScore,
  opts: DescriptionOptions = {},
): string {
  const span = isWholeSpan(opts.section, score.duration)
    ? { start: 0, end: score.duration }
    : videoSpan(score.duration, opts.section);
  const facts = [keyName(keyAt(score, span.start))];
  const bpm = piece.view.gridBpm;
  if (bpm !== undefined && bpm > 0) facts.push(`${Math.round(bpm * 10) / 10} bpm`);
  facts.push(timestamp(Math.round(span.end - span.start)));

  const lines = [piece.meta.title.trim() || 'Untitled', '', facts.join(' · ')];
  const ch = chapters(piece, span);
  if (ch.length > 0) lines.push('', ...ch.map((c) => `${timestamp(c.at)} ${c.label}`));
  lines.push('', `Made with AlgoRhythms: ${opts.siteUrl ?? SITE_URL}`);
  if (opts.shareLink) lines.push(`Open it in AlgoRhythms: ${opts.shareLink}`);
  return lines.join('\n');
}

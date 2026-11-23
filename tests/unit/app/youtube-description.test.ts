import { describe, expect, it } from 'vitest';
import {
  SITE_URL,
  chapters,
  timestamp,
  youtubeDescription,
} from '../../../src/app/youtube-description';
import { compile } from '../../../src/core/compiler/compile';
import { generate } from '../../../src/core/generate';
import type { Moment, Piece } from '../../../src/core/types';

/** A generated piece with labels at the given times (on copies of its first moment). */
function labelled(labels: [number, string][], over: Partial<Piece> = {}): Piece {
  const p = { ...generate(7), ...over };
  const base = p.moments[0];
  const extra = labels.map(([at, label], i) => ({ ...base, id: `lab${i}`, at, label }) as Moment);
  return { ...p, moments: [...p.moments.map((m) => ({ ...m, label: undefined })), ...extra] };
}

const span = (start: number, end: number) => ({ start, end });

describe('timestamp', () => {
  it('writes m:ss, and h:mm:ss from an hour, floored', () => {
    expect(timestamp(0)).toBe('0:00');
    expect(timestamp(9.99)).toBe('0:09');
    expect(timestamp(75)).toBe('1:15');
    expect(timestamp(3600 + 62)).toBe('1:01:02');
  });
});

describe('chapters (YouTube’s rules)', () => {
  const three: [number, string][] = [
    [0, 'Opening'],
    [20, 'Rise'],
    [45.6, 'Home'],
  ];
  it('lists labels from 0:00 when there are three, each at least 10 s', () => {
    expect(chapters(labelled(three), span(0, 60))).toEqual([
      { at: 0, label: 'Opening' },
      { at: 20, label: 'Rise' },
      { at: 45, label: 'Home' },
    ]);
  });
  it('writes none with fewer than three', () => {
    expect(chapters(labelled(three.slice(0, 2)), span(0, 60))).toEqual([]);
  });
  it('writes none when the first is not at 0:00 (a label at 0.9 s counts as 0:00)', () => {
    expect(
      chapters(
        labelled([
          [2, 'A'],
          [20, 'B'],
          [40, 'C'],
        ]),
        span(0, 60),
      ),
    ).toEqual([]);
    expect(
      chapters(
        labelled([
          [0.9, 'A'],
          [20, 'B'],
          [40, 'C'],
        ]),
        span(0, 60),
      ),
    ).toHaveLength(3);
  });
  it('writes none when any chapter is under 10 s, the last one included', () => {
    expect(
      chapters(
        labelled([
          [0, 'A'],
          [9, 'B'],
          [30, 'C'],
        ]),
        span(0, 60),
      ),
    ).toEqual([]);
    expect(
      chapters(
        labelled([
          [0, 'A'],
          [10, 'B'],
          [20, 'C'],
        ]),
        span(0, 30),
      ),
    ).toHaveLength(3);
    expect(
      chapters(
        labelled([
          [0, 'A'],
          [10, 'B'],
          [20, 'C'],
        ]),
        span(0, 29.5),
      ),
    ).toEqual([]);
  });
  it('ignores blank labels; one per second, the first wins; sorted by time', () => {
    const p = labelled([
      [40, 'C'],
      [0, 'A'],
      [20, 'B'],
      [20.4, 'B2'],
      [30, '  '],
    ]);
    expect(chapters(p, span(0, 60)).map((c) => c.label)).toEqual(['A', 'B', 'C']);
  });
  it('in a section: only its labels, timed from its start', () => {
    const p = labelled([
      [5, 'Before'],
      [30, 'A'],
      [45, 'B'],
      [62, 'C'],
      [90, 'After'],
    ]);
    expect(chapters(p, span(30, 80))).toEqual([
      { at: 0, label: 'A' },
      { at: 15, label: 'B' },
      { at: 32, label: 'C' },
    ]);
    expect(chapters(p, span(31, 80))).toEqual([]); // the section starts after its first label
  });
});

describe('youtubeDescription', () => {
  it('title; key, tempo and length; chapters; credit and site; the share link', () => {
    const p = labelled(
      [
        [0, 'Opening'],
        [20, 'Rise'],
        [40, 'Home'],
      ],
      {
        end: { at: 70, fade: 1 },
      },
    );
    p.meta = { ...p.meta, title: 'Kite Day' };
    p.view = { ...p.view, gridBpm: 96 };
    const score = compile(p);
    const text = youtubeDescription(p, score, { shareLink: 'https://x.test/#p=abc' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Kite Day');
    expect(lines[2]).toMatch(new RegExp(`^${p.key.tonic} .+ · 96 bpm · 1:10$`));
    expect(lines.slice(4, 7)).toEqual(['0:00 Opening', '0:20 Rise', '0:40 Home']);
    expect(lines.slice(-2)).toEqual([
      `Made with AlgoRhythms: ${SITE_URL}`,
      'Open it in AlgoRhythms: https://x.test/#p=abc',
    ]);
  });
  it('no tempo, no chapters, no share link: just the facts and the credit', () => {
    const p = labelled([[0, 'Only']], { end: { at: 30, fade: 1 } });
    p.view = { ...p.view, gridBpm: undefined };
    const text = youtubeDescription(p, compile(p), { siteUrl: 'https://s.test/' });
    const lines = text.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[2]).not.toMatch(/bpm/);
    expect(lines[2]).toMatch(/ · 0:30$/);
    expect(lines[4]).toBe('Made with AlgoRhythms: https://s.test/');
    expect(text).not.toMatch(/0:00 Only/);
  });
  it('a section: its length, and chapters inside it', () => {
    const p = labelled(
      [
        [10, 'A'],
        [25, 'B'],
        [40, 'C'],
      ],
      { end: { at: 80, fade: 1 } },
    );
    const text = youtubeDescription(p, compile(p), { section: { start: 10, end: 55 } });
    expect(text.split('\n')[2]).toMatch(/ · 0:45$/);
    expect(text).toContain('0:00 A\n0:15 B\n0:30 C');
  });
});

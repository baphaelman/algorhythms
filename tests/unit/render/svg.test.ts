/** SvgContext (PLAN.md §12 "Poster export"): the recording 2D context that writes SVG. */

import { describe, expect, it } from 'vitest';
import { SvgContext, escapeXml, svgColor } from '../../../src/render/svg';

/** The document's body elements (between the defs and </svg>). */
function body(c: SvgContext): string[] {
  const out = c.toSvg({ xmlDeclaration: false });
  return out
    .split('\n')
    .filter((l) => l.startsWith('<path') || l.startsWith('<text') || l.startsWith('<rect'));
}

describe('SvgContext', () => {
  it('writes a well-formed document with size and viewBox', () => {
    const c = new SvgContext(300, 200);
    const s = c.toSvg();
    expect(s.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg ')).toBe(true);
    expect(s).toContain('width="300" height="200" viewBox="0 0 300 200"');
    expect(s.trimEnd().endsWith('</svg>')).toBe(true);
    expect(c.toSvg({ xmlDeclaration: false }).startsWith('<svg')).toBe(true);
  });

  it('records paths with stroke attributes in device px', () => {
    const c = new SvgContext(100, 100);
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.strokeStyle = '#123456';
    c.lineWidth = 1.5;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(1, 2);
    c.lineTo(3, 4);
    c.lineTo(5, 6);
    c.quadraticCurveTo(7, 8, 9, 10);
    c.bezierCurveTo(1, 1, 2, 2, 3, 3);
    c.closePath();
    c.stroke();
    expect(body(c)).toEqual([
      '<path d="M2 4L6 8 10 12Q14 16 18 20C2 2 4 4 6 6Z" fill="none" stroke="#123456" ' +
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    ]);
  });

  it('miter joins carry the canvas miter limit; butt caps are the default', () => {
    const c = new SvgContext(10, 10);
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(5, 5);
    c.stroke();
    expect(body(c)[0]).toBe(
      '<path d="M0 0L5 5" fill="none" stroke="#000000" stroke-width="1" stroke-miterlimit="10"/>',
    );
  });

  it('merges consecutive opaque strokes of one style, not translucent or dashed ones', () => {
    const c = new SvgContext(10, 10);
    const line = (x: number) => {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, 5);
      c.stroke();
    };
    line(1);
    line(2);
    c.globalAlpha = 0.5;
    line(3);
    line(4);
    c.globalAlpha = 1;
    c.setLineDash([2, 1]);
    line(5);
    line(6);
    const els = body(c);
    expect(els).toHaveLength(5);
    expect(els[0]).toContain('d="M1 0L1 5M2 0L2 5"');
    expect(els[1]).toContain('opacity="0.5"');
    expect(els[3]).toContain('stroke-dasharray="2 1"');
  });

  it('fills with opacity, fill rule and transparent colours dropped', () => {
    const c = new SvgContext(10, 10);
    c.fillStyle = 'transparent';
    c.fillRect(0, 0, 10, 10);
    c.fillStyle = '#ff0000';
    c.globalAlpha = 0.25;
    c.beginPath();
    c.rect(1, 1, 2, 2);
    c.fill('evenodd');
    expect(body(c)).toEqual([
      '<path d="M1 1L3 1 3 3 1 3ZM1 1" fill="#ff0000" fill-rule="evenodd" opacity="0.25"/>',
    ]);
  });

  it('fillRect is a rect; a full clearRect drops what was drawn', () => {
    const c = new SvgContext(20, 10);
    c.fillStyle = '#00ff00';
    c.fillRect(0, 0, 4, 4);
    c.clearRect(0, 0, 20, 10);
    c.setTransform(2, 0, 0, 2, 1, 1);
    c.fillRect(1, 1, 3, 2);
    expect(body(c)).toEqual(['<rect x="3" y="3" width="6" height="4" fill="#00ff00"/>']);
    c.clearRect(0, 0, 1, 1); // partial: ignored
    expect(body(c)).toHaveLength(1);
  });

  it('writes linear gradients as userSpaceOnUse defs at the paint-time transform', () => {
    const c = new SvgContext(100, 100);
    c.setTransform(2, 0, 0, 2, 0, 0);
    const g = c.createLinearGradient(0, 40, 0, 10);
    g.addColorStop(0, '#000000');
    g.addColorStop(1, 'oklch(0.57 0.16 20)');
    c.strokeStyle = g;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(10, 0);
    c.stroke();
    c.fillStyle = c.strokeStyle;
    c.fill();
    const s = c.toSvg();
    const defs = s.match(/<linearGradient[^]*?<\/linearGradient>/g) ?? [];
    expect(defs).toHaveLength(1); // one def for both uses
    expect(defs[0]).toContain('gradientUnits="userSpaceOnUse" x1="0" y1="80" x2="0" y2="20"');
    expect(defs[0]).toMatch(/<stop offset="1" stop-color="#[0-9a-f]{6}"\/>/);
    expect(body(c)[0]).toContain('stroke="url(#g1)"');
    expect(body(c)[1]).toContain('fill="url(#g1)"');
    expect(() => g.addColorStop(2, '#fff')).toThrow(RangeError);
  });

  it('save/restore keeps style, transform, dash and clip', () => {
    const c = new SvgContext(50, 50);
    c.lineWidth = 2;
    c.save();
    c.lineWidth = 7;
    c.translate(10, 0);
    c.setLineDash([3]);
    c.beginPath();
    c.rect(0, 0, 5, 5);
    c.clip();
    expect(c.getLineDash()).toEqual([3, 3]);
    c.restore();
    expect(c.lineWidth).toBe(2);
    expect(c.getLineDash()).toEqual([]);
    expect(c.getTransform()).toMatchObject({ a: 1, e: 0 });
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(1, 1);
    c.stroke();
    expect(body(c)[0]).not.toContain('clip-path');
    expect(c.toSvg()).toContain('<clipPath id="c1"><path d="M10 0L15 0 15 5 10 5ZM10 0"/>');
  });

  it('clipped elements reference the clip; nested clips chain', () => {
    const c = new SvgContext(50, 50);
    c.beginPath();
    c.rect(0, 0, 20, 20);
    c.clip();
    c.beginPath();
    c.rect(5, 5, 20, 20);
    c.clip('evenodd');
    c.fillRect(0, 0, 50, 50);
    const s = c.toSvg();
    expect(s).toContain('<clipPath id="c2" clip-path="url(#c1)">');
    expect(s).toContain('clip-rule="evenodd"');
    expect(body(c)[0]).toContain('clip-path="url(#c2)"');
  });

  it('scales dashes and widths by the transform; composes transforms', () => {
    const c = new SvgContext(100, 100);
    c.scale(2, 2);
    c.translate(5, 5);
    c.setLineDash([1, 4]);
    c.lineDashOffset = 1;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(1, 0);
    c.stroke();
    const el = body(c)[0];
    expect(el).toContain('d="M10 10L12 10"');
    expect(el).toContain('stroke-width="2"');
    expect(el).toContain('stroke-dasharray="2 8" stroke-dashoffset="2"');
  });

  it('arcs: SVG arcs under a uniform scale, full circles split, a line to the start', () => {
    const c = new SvgContext(100, 100);
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.beginPath();
    c.arc(10, 10, 5, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(10, 10, 5, 0, Math.PI, true);
    c.stroke();
    const [circle, half] = body(c);
    expect(circle).toContain('d="M30 20A10 10 0 0 1 10 20A10 10 0 0 1 30 20"');
    expect(half).toContain('d="M0 0L30 20A10 10 0 0 0 10 20"');
  });

  it('arcs under rotation become cubic Béziers on the circle', () => {
    const c = new SvgContext(100, 100);
    c.rotate(Math.PI / 6);
    c.beginPath();
    c.arc(0, 0, 10, 0, Math.PI / 2);
    c.stroke();
    const d = /d="([^"]+)"/.exec(body(c)[0])![1];
    expect(d.startsWith('M')).toBe(true);
    const nums = d.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number);
    const [ex, ey] = nums.slice(-2);
    expect(Math.hypot(ex, ey)).toBeCloseTo(10, 1);
    expect(d).toContain('C');
  });

  it('text: position, font, alignment, letter spacing, escaping', () => {
    const c = new SvgContext(200, 100);
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.font = '500 9.5px "IBM Plex Mono", monospace';
    c.letterSpacing = '1px';
    c.textAlign = 'right';
    c.fillStyle = '#5E6876';
    c.globalAlpha = 0.75;
    c.fillText('A<B> & "c"  d', 50, 20);
    const t = body(c)[0];
    expect(t).toBe(
      '<text x="100" y="40" font-family="&quot;IBM Plex Mono&quot;, monospace" font-size="19" ' +
        'font-weight="500" letter-spacing="2" text-anchor="end" fill="#5E6876" opacity="0.75">' +
        'A&lt;B&gt; &amp; &quot;c&quot;  d</text>',
    );
    expect(c.toSvg()).toContain('xml:space="preserve"'); // runs of spaces kept, as canvas does
  });

  it('measureText: a monospace advance plus letter spacing', () => {
    const c = new SvgContext(10, 10);
    c.font = '10px monospace';
    expect(c.measureText('abcd').width).toBeCloseTo(24, 9);
    c.letterSpacing = '1px';
    expect(c.measureText('abcd').width).toBeCloseTo(28, 9);
    c.font = '500 12px x';
    c.letterSpacing = '0px';
    expect(c.measureText('ii7 · Dm7').width).toBeCloseTo(9 * 7.2, 9);
  });

  it('ignores invalid state values as a canvas does', () => {
    const c = new SvgContext(10, 10);
    c.globalAlpha = 2;
    c.lineWidth = -1;
    c.setLineDash([1, -1]);
    expect([c.globalAlpha, c.lineWidth, c.getLineDash()]).toEqual([1, 1, []]);
  });
});

describe('escapeXml and svgColor', () => {
  it('escapes markup and drops characters XML forbids', () => {
    expect(escapeXml(`<a href='x'>&\u0001</a>`)).toBe(
      '&lt;a href=&apos;x&apos;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('converts OKLCH to sRGB hex', () => {
    expect(svgColor('oklch(1 0 0)').color).toBe('#ffffff');
    expect(svgColor('oklch(0 0 0)').color).toBe('#000000');
    // OKLCH of sRGB red is about (0.628, 0.2577, 29.23).
    expect(svgColor('oklch(0.62796 0.25768 29.234)').color).toBe('#ff0000');
    expect(svgColor('oklch(0.5 0.1 100 / 0.5)').alpha).toBe(0.5);
    expect(svgColor('#abcdef')).toEqual({ color: '#abcdef', alpha: 1 });
  });

  it('clips out-of-gamut channels, as Chromium draws them', () => {
    // The dark theme's warm end: linear sRGB ≈ (1.07, 0.32, 0.33).
    expect(svgColor('oklch(0.8 0.13 20)').color).toMatch(/^#ff[0-9a-f]{4}$/);
    // The light theme's teal: linear red ≈ −0.11.
    expect(svgColor('oklch(0.57 0.16 195)').color).toMatch(/^#00[0-9a-f]{4}$/);
  });
});

import { DEFAULT_COLOURS } from '../../../src/app/export-colours';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_FORM,
  DEFAULT_LOOK_FORM,
  EXPORT_PREFS_KEY,
  EXPORT_PREFS_VERSION,
  HUD_CHOICES,
  POSTER_MAX_AREA,
  POSTER_MAX_ROWS,
  POSTER_MAX_SIDE,
  POSTER_MIN_SIDE,
  POSTER_SIZES,
  clampPosterDims,
  clampRows,
  aacNote,
  codecLabel,
  exportFileName,
  fileBase,
  followAtOf,
  followWindowOf,
  followWindowRange,
  followWindowToSlider,
  formatBytes,
  loadExportPrefs,
  lookOf,
  midiOptions,
  parsePrefs,
  posterCapped,
  posterOptions,
  posterPixels,
  posterPreset,
  posterSideMax,
  resetLook,
  sanitizeFileName,
  saveExportPrefs,
  sliderToFollowWindow,
  stemsOptions,
  videoOptions,
  voiceNames,
  wavOptions,
  windowSnaps,
  windowText,
  WINDOW_SNAP,
  type ExportForm,
} from '../../../src/app/export-options';
import { videoCamera, videoWindow } from '../../../src/render/video';
import { generate } from '../../../src/core/generate';
import type { Piece } from '../../../src/core/types';
import { DEFAULT_HUD, HUD_ITEMS } from '../../../src/render/hud';
import { EXPORT_LOOK } from '../../../src/render/look';
import { posterSize } from '../../../src/render/poster';

const form = (over: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_EXPORT_FORM, ...over });

function piece(title: string, over: Partial<Piece> = {}): Piece {
  const p = generate(5, { mode: 'dorian', voices: 3 });
  return { ...p, meta: { ...p.meta, title }, ...over };
}

describe('sanitizeFileName', () => {
  it('keeps ordinary titles readable', () => {
    expect(sanitizeFileName('Tidewater Hymn')).toBe('Tidewater-Hymn');
    expect(sanitizeFileName('  Étude No. 3 ♪ ')).toBe('Étude-No.-3-♪');
  });
  it('drops path separators, control and reserved characters', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeFileName('tab\there\nnew')).toBe('tab-here-new');
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc-passwd');
  });
  it('never starts with a dot or ends with a dot, space or hyphen', () => {
    expect(sanitizeFileName('...hidden')).toBe('hidden');
    expect(sanitizeFileName('name. ')).toBe('name');
    expect(sanitizeFileName('-x-')).toBe('x');
  });
  it('falls back when nothing usable is left, and avoids Windows device names', () => {
    expect(sanitizeFileName('')).toBe('piece');
    expect(sanitizeFileName('///')).toBe('piece');
    expect(sanitizeFileName('???', 'untitled')).toBe('untitled');
    expect(sanitizeFileName('CON')).toBe('CON_');
    expect(sanitizeFileName('nul')).toBe('nul_');
  });
  it('limits the length without leaving a trailing separator', () => {
    const s = sanitizeFileName(`${'x'.repeat(79)} tail`);
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('-')).toBe(false);
    expect(sanitizeFileName('y'.repeat(300)).length).toBe(80);
  });
});

describe('file names', () => {
  it('come from the title', () => {
    const p = piece('Lanterns / Salt');
    expect(fileBase(p)).toBe('Lanterns-Salt');
    expect(exportFileName(p, form({ format: 'wav' }))).toBe('Lanterns-Salt.wav');
    expect(exportFileName(p, form({ format: 'stems' }))).toBe('Lanterns-Salt-stems.zip');
    expect(exportFileName(p, form({ format: 'midi' }))).toBe('Lanterns-Salt.mid');
    expect(exportFileName(p, form({ format: 'midi' }), 3)).toBe('Lanterns-Salt-midi.zip');
  });
});

describe('option mapping', () => {
  it('maps WAV choices straight through', () => {
    expect(wavOptions(form({ bitDepth: 24, sampleRate: 44100 }))).toEqual({
      bitDepth: 24,
      sampleRate: 44100,
    });
    expect(wavOptions(DEFAULT_EXPORT_FORM)).toEqual({ bitDepth: 32, sampleRate: 48000 });
  });

  it('maps stems choices and names stems after named voices', () => {
    const p = piece('P');
    p.voices = p.voices.map((v, i) =>
      i === 0 ? { ...v, name: 'Lead' } : { ...v, name: undefined },
    );
    expect(voiceNames(p)).toEqual({ [p.voices[0].id]: 'Lead' });
    const o = stemsOptions(
      form({ format: 'stems', bitDepth: 16, mono: true, sampleRate: 44100 }),
      p,
    );
    expect(o).toMatchObject({ bitDepth: 16, mono: true, sampleRate: 44100 });
    expect(o.voiceNames).toEqual({ [p.voices[0].id]: 'Lead' });
  });

  it('maps MIDI choices; MPE is always ±48', () => {
    const p = piece('Song one');
    const base = midiOptions(form({ format: 'midi' }), p);
    expect(base).toMatchObject({
      mode: 'perVoice',
      bendRange: 24,
      cc11: false,
      restrikeOnArrival: false,
      name: 'Song-one',
      title: 'Song one',
    });
    expect(base.bpm).toBeUndefined();
    expect(midiOptions(form({ midiMode: 'mpe', bendRange: 2 }), p).bendRange).toBe(48);
    expect(
      midiOptions(form({ midiMode: 'notesOnly', bendRange: 12, cc11: true }), p),
    ).toMatchObject({
      mode: 'notesOnly',
      bendRange: 12,
      cc11: true,
    });
    expect(midiOptions(form({ restrike: true }), p).restrikeOnArrival).toBe(true);
  });

  it('follows the grid tempo when the piece has one', () => {
    const p = piece('Grid');
    p.view = { ...p.view, gridBpm: 90 };
    expect(midiOptions(form(), p).bpm).toBe(90);
    p.view = { ...p.view, gridBpm: 0 };
    expect(midiOptions(form(), p).bpm).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('uses decimal units, matching the 1 GB warning', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1500)).toBe('1.5 kB');
    expect(formatBytes(12_345_678)).toBe('12 MB');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
    expect(formatBytes(1e9)).toBe('1.00 GB');
    expect(formatBytes(2.28e9)).toBe('2.28 GB');
  });
});

describe('video', () => {
  const ctx = { window: 12, dark: true, colors: 'pitch' as const };
  it('maps the defaults: 16:9 1080p30 Follow at the editor window, current theme, EXPORT_LOOK', () => {
    const p = piece('Clip');
    expect(DEFAULT_EXPORT_FORM).toMatchObject({
      videoAspect: '16:9',
      videoSize: '1080',
      videoFps: 30,
      videoQuality: 'high',
      videoCamera: 'follow',
      videoFollowAt: null,
      videoHud: DEFAULT_HUD,
    });
    const look = { ...EXPORT_LOOK, theme: 'dark' as const, hudLayout: {} };
    expect(videoOptions(form({ format: 'video' }), p, ctx)).toEqual({
      aspect: '16:9',
      size: '1080',
      fps: 30,
      quality: 'high',
      camera: 'follow',
      window: 12,
      followAt: 0.8,
      theme: 'dark',
      hud: true,
      thickness: true,
      colors: 'pitch',
      customColors: p.voices.map((v) => v.color),
      look,
    });
    expect(videoOptions(form(), p, { ...ctx, dark: false }).look!.theme).toBe('light');
  });
  it('passes every choice; Whole piece has no window or followAt', () => {
    const o = videoOptions(
      form({
        videoAspect: '9:16',
        videoSize: '720',
        videoFps: 60,
        videoQuality: 'max',
        videoCamera: 'whole',
        videoHud: [],
        look: { ...DEFAULT_LOOK_FORM, theme: 'light', thickness: false },
      }),
      piece('Clip'),
      ctx,
    );
    expect(o).toMatchObject({
      aspect: '9:16',
      size: '720',
      fps: 60,
      quality: 'max',
      camera: 'whole',
      theme: 'light',
      hud: false,
      thickness: false,
    });
    expect(o.look).toMatchObject({ theme: 'light', thickness: false, hud: [] });
    expect('window' in o).toBe(false);
    expect('followAt' in o).toBe(false);
  });
  it('names the file .mp4 and the codecs plainly', () => {
    expect(exportFileName(piece('Tidewater Hymn'), form({ format: 'video' }))).toBe(
      'Tidewater-Hymn.mp4',
    );
    expect(codecLabel('avc1.640028', 'mp4a.40.2')).toBe('H.264 + AAC');
    expect(codecLabel('avc1.64001f', 'opus')).toBe('H.264 + Opus');
    expect(codecLabel('vp09.00.40.08', 'opus')).toBe('VP9 + Opus');
  });
});

describe('look', () => {
  const light = { dark: false, colors: 'pitch' as const };
  it('defaults to EXPORT_LOOK with the current theme; video HUD today, poster none', () => {
    const { hud: _h, theme: _t, colors: _c, ...rest } = EXPORT_LOOK;
    expect(DEFAULT_LOOK_FORM).toEqual({ ...rest, theme: 'current', colours: DEFAULT_COLOURS });
    expect(DEFAULT_LOOK_FORM).toMatchObject({
      guides: false,
      beats: 'off',
      markers: false,
      sections: true,
      future: 'hidden',
    });
    expect(lookOf(form(), 'video', light)).toEqual({
      ...EXPORT_LOOK,
      theme: 'light',
      hudLayout: {},
    });
    expect(lookOf(form(), 'poster', { dark: true, colors: 'pitch' })).toEqual({
      ...EXPORT_LOOK,
      theme: 'dark',
      hud: [],
      hudLayout: {},
    });
  });

  it('line colours follow the app by default; an explicit choice overrides it', () => {
    const p = piece('Clip');
    p.voices[0]!.color = '#ff00aa';
    const inkApp = { window: 10, dark: false, colors: 'ink' as const };
    const v = videoOptions(form(), p, inkApp);
    expect(v.colors).toBe('ink');
    expect(v.look!.colors).toBe('ink');
    expect('lineInk' in v.look!).toBe(false); // the theme's ink, as the app draws
    const c = posterOptions(form(), p, { dark: true, colors: 'custom' });
    expect(c.look!.colors).toBe('custom');
    expect(c.customColors).toEqual(p.voices.map((x) => x.color));
    expect(c.customColors![0]).toBe('#ff00aa');
    // A stored line colour does not apply to 'app'.
    const appInk = { ...DEFAULT_LOOK_FORM, colours: { ...DEFAULT_COLOURS, one: '#00ff00' } };
    expect('lineInk' in lookOf(form({ look: appInk }), 'video', inkApp)).toBe(false);
    // Overrides win over the app's mode.
    const pitch = form({
      look: { ...DEFAULT_LOOK_FORM, colours: { ...DEFAULT_COLOURS, lines: 'pitch' } },
    });
    expect(videoOptions(pitch, p, inkApp).look!.colors).toBe('pitch');
    const ink = form({
      look: { ...DEFAULT_LOOK_FORM, colours: { ...DEFAULT_COLOURS, lines: 'one', one: '#00ff00' } },
    });
    expect(posterOptions(ink, p, { dark: false, colors: 'custom' }).look).toMatchObject({
      colors: 'ink',
      lineInk: '#00ff00',
      colours: { lines: { kind: 'one', color: '#00ff00' } },
    });
  });

  it('maps each control', () => {
    const f = form({
      videoHud: ['spread', 'chord', 'formula', 'chord'],
      look: {
        ...DEFAULT_LOOK_FORM,
        theme: 'dark',
        guides: true,
        future: 'dimmed',
        futureOpacity: 0.5,
        lineWidth: 'bold',
        colours: { ...DEFAULT_COLOURS, lines: 'one', one: '#ff0000' },
        transparent: true,
        dots: false,
      },
    });
    const v = lookOf(f, 'video', light);
    expect(v).toMatchObject({
      theme: 'dark',
      guides: true,
      future: 'dimmed',
      futureOpacity: 0.5,
      lineWidth: 'bold',
      colors: 'ink',
      lineInk: '#ff0000',
      dots: false,
      transparent: false, // video has no alpha
      hud: ['formula', 'chord', 'spread'], // fixed order, no repeats
    });
    expect(lookOf(f, 'poster', light).transparent).toBe(true);
    expect('lineInk' in lookOf(form(), 'video', light)).toBe(false);
  });

  it('playhead at: 80 % with the future hidden, 35 % shown, the user’s value clamped', () => {
    const hidden = DEFAULT_LOOK_FORM;
    const dimmed = { ...DEFAULT_LOOK_FORM, future: 'dimmed' as const };
    expect(followAtOf(form({ look: hidden }))).toBe(80);
    expect(followAtOf(form({ look: dimmed }))).toBe(35);
    expect(followAtOf(form({ look: { ...dimmed, future: 'full' } }))).toBe(35);
    expect(followAtOf(form({ look: dimmed, videoFollowAt: 60 }))).toBe(60);
    expect(followAtOf(form({ look: hidden, videoFollowAt: 5 }))).toBe(10);
    expect(followAtOf(form({ look: hidden, videoFollowAt: 99 }))).toBe(90);
    expect(
      videoOptions(form({ videoFollowAt: 60 }), piece('x'), {
        window: 9,
        dark: false,
        colors: 'pitch',
      }),
    ).toMatchObject({ followAt: 0.6, window: 9 });
  });

  it('Window: null is the editor’s zoom; a set window is what the chosen aspect shows', () => {
    const ctx = { window: 12, duration: 100, dark: false, colors: 'pitch' as const };
    expect(DEFAULT_EXPORT_FORM.videoWindow).toBeNull();
    // Null: the editor's 16:9 window as before; shown scaled to the aspect.
    expect(videoOptions(form(), piece('x'), ctx).window).toBe(12);
    expect(followWindowOf(form({ videoAspect: '9:16' }), ctx)).toBeCloseTo(videoWindow(12, '9:16'));
    // Set: the renderer's 16:9 window makes the frame show exactly that many seconds.
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const o = videoOptions(form({ videoAspect: aspect, videoWindow: 20 }), piece('x'), ctx);
      expect(videoWindow(o.window!, aspect)).toBeCloseTo(20, 9);
    }
    // Clamped to [2 s, the piece]; Whole piece sends none.
    expect(followWindowOf(form({ videoWindow: 500 }), ctx)).toBe(100);
    expect(followWindowOf(form({ videoWindow: 0.5 }), ctx)).toBe(2);
    expect(followWindowOf(form({ videoWindow: 500 }), { window: 12 })).toBe(500);
    expect(
      'window' in videoOptions(form({ videoCamera: 'whole', videoWindow: 9 }), piece('x'), ctx),
    ).toBe(false);
  });

  it('Window slider: log scale from 2 s to the whole piece', () => {
    expect(followWindowRange(100)).toEqual([2, 100]);
    expect(followWindowRange(1)).toEqual([2, 2]);
    expect(followWindowToSlider(2, 100)).toBe(0);
    expect(followWindowToSlider(100, 100)).toBe(1);
    expect(followWindowToSlider(Math.sqrt(200), 100)).toBeCloseTo(0.5, 9);
    expect(followWindowToSlider(5, 1)).toBe(1);
    for (const x of [0, 0.25, 0.5, 1]) {
      expect(followWindowToSlider(sliderToFollowWindow(x, 180), 180)).toBeCloseTo(x, 9);
    }
    expect(sliderToFollowWindow(-1, 180)).toBeCloseTo(2, 9);
    expect(sliderToFollowWindow(2, 180)).toBeCloseTo(180, 9);
    expect(windowText(4.04)).toBe('4.0 s');
    expect(windowText(12.6)).toBe('13 s');
  });

  it('Window slider snaps to the editor-zoom tick when moved close', () => {
    const t = 0.4;
    expect(WINDOW_SNAP).toBe(0.03);
    // Pointer: by distance.
    expect(windowSnaps(0.4, t)).toBe(true);
    expect(windowSnaps(0.42, t)).toBe(true);
    expect(windowSnaps(0.38, t)).toBe(true);
    expect(windowSnaps(0.45, t)).toBe(false);
    expect(windowSnaps(0.35, t)).toBe(false);
    // Keyboard: only toward the tick, so a step can leave it.
    expect(windowSnaps(0.4, t, 0.401)).toBe(true);
    expect(windowSnaps(0.401, t, 0.4)).toBe(false);
    expect(windowSnaps(0.42, t, 0.41)).toBe(false);
    expect(windowSnaps(0.41, t, 0.42)).toBe(true);
    expect(windowSnaps(0.45, t, 0.46)).toBe(false);
  });

  it('Window reaches the camera: a frame shows the chosen seconds at every aspect', () => {
    const p = piece('x');
    const compiled = { duration: 60 } as Parameters<typeof videoCamera>[1];
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const o = videoOptions(form({ videoAspect: aspect, videoWindow: 7 }), p, {
        window: 12,
        duration: 60,
        dark: false,
        colors: 'pitch',
      });
      const cam = videoCamera('follow', compiled, 30, { ...o, pitchRange: [40, 80] });
      expect(cam.window).toBeCloseTo(7, 9);
    }
  });

  it('Reset restores the Look, the playhead place and the open format’s HUD', () => {
    const changed = form({
      format: 'video',
      videoFollowAt: 50,
      videoHud: ['gaps'],
      posterHud: ['title'],
      videoAspect: '1:1',
      look: {
        ...DEFAULT_LOOK_FORM,
        guides: true,
        theme: 'dark',
        lineWidth: 'thin',
        colours: { ...DEFAULT_COLOURS, lines: 'pitch', hud: '#ffffff' },
      },
    });
    const r = resetLook(changed);
    expect(r.look.colours).toEqual(DEFAULT_COLOURS);
    expect(r).toMatchObject({
      look: DEFAULT_LOOK_FORM,
      videoFollowAt: null,
      videoHud: DEFAULT_HUD,
      posterHud: ['title'],
      videoAspect: '1:1',
    });
    expect(resetLook({ ...changed, format: 'poster' })).toMatchObject({
      posterHud: [],
      videoHud: ['gaps'],
    });
  });

  it('HUD choices list every readout in order with a sample', () => {
    expect(HUD_CHOICES.map((c) => c.id)).toEqual(HUD_ITEMS);
    expect(HUD_CHOICES.find((c) => c.id === 'spread')!.sample).toBe('spread 19 st · octave + 5th');
    for (const c of HUD_CHOICES) expect(c.label.length).toBeGreaterThan(0);
  });
});

describe('poster', () => {
  it('maps the defaults: PNG 16:9 with the title, no HUD, current theme', () => {
    const p = piece('Kite Day');
    expect(DEFAULT_EXPORT_FORM).toMatchObject({
      posterFormat: 'png',
      posterWidth: 3840,
      posterHeight: 2160,
      posterRows: 1,
      posterTitle: true,
      posterHud: [],
    });
    expect(posterOptions(form({ format: 'poster' }), p, { dark: true, colors: 'pitch' })).toEqual({
      size: { width: 3840, height: 2160 },
      rows: 1,
      theme: 'dark',
      transparent: false,
      title: true,
      thickness: true,
      colors: 'pitch',
      customColors: p.voices.map((v) => v.color),
      look: { ...EXPORT_LOOK, theme: 'dark', hud: [], hudLayout: {} },
    });
    expect(exportFileName(p, form({ format: 'poster' }))).toBe('Kite-Day.png');
    expect(exportFileName(p, form({ format: 'poster', posterFormat: 'svg' }))).toBe('Kite-Day.svg');
    expect(posterPixels({ posterWidth: 3840, posterHeight: 2160 })).toBe('3840 × 2160 px');
    // The quick picks are the renderer's presets.
    for (const s of POSTER_SIZES) {
      expect(posterSize(s.id)).toEqual({ width: s.width, height: s.height });
      expect(posterPreset({ posterWidth: s.width, posterHeight: s.height })).toBe(s.id);
    }
    expect(posterPreset({ posterWidth: 3000, posterHeight: 2160 })).toBeUndefined();
  });

  it('caps width × height at the area every browser draws', () => {
    expect(POSTER_MAX_AREA).toBe(4096 * 4096);
    expect(posterSideMax(1000)).toBe(POSTER_MAX_SIDE);
    expect(posterSideMax(2160)).toBe(7767);
    expect(posterSideMax(8000)).toBe(2097);
    // Range and whole pixels.
    expect(clampPosterDims(500, 9000.4)).toEqual({ width: POSTER_MIN_SIDE, height: 8000 });
    expect(clampPosterDims(1234.6, 1000)).toEqual({ width: 1235, height: 1000 });
    expect(clampPosterDims(NaN, NaN)).toEqual({ width: 3840, height: 2160 });
    // The kept side stays; the other gives way.
    expect(clampPosterDims(8000, 8000, 'width')).toEqual({ width: 8000, height: 2097 });
    expect(clampPosterDims(8000, 8000, 'height')).toEqual({ width: 2097, height: 8000 });
    for (const [w, h] of [
      [8000, 8000],
      [5000, 4000],
      [7000, 2400],
    ]) {
      const d = clampPosterDims(w, h);
      expect(d.width * d.height).toBeLessThanOrEqual(POSTER_MAX_AREA);
    }
    expect(posterCapped(3840, 2160)).toBe(false);
    expect(posterCapped(8000, 2097)).toBe(true);
    expect(posterCapped(7767, 2160)).toBe(true);
    expect(posterCapped(7000, 2160)).toBe(false);
    expect(posterCapped(8000, 1000)).toBe(false); // the side limit, not the area
    for (const s of POSTER_SIZES) expect(posterCapped(s.width, s.height)).toBe(false);
  });

  it('a dragged side stops at the cap; the other side never moves', () => {
    // As the Width slider does (fixed 1,000–8,000 range): Height kept, Width gives way.
    for (const [v, h] of [
      [8000, 4000],
      [6000, 2160],
      [3000, 8000],
      [1000, 8000],
    ]) {
      const d = clampPosterDims(v, h, 'height');
      expect(d.height).toBe(h);
      expect(d.width).toBe(Math.min(v, posterSideMax(h)));
      expect(d.width * d.height).toBeLessThanOrEqual(POSTER_MAX_AREA);
    }
    expect(clampPosterDims(8000, 4000, 'height')).toEqual({ width: 4194, height: 4000 });
    expect(posterCapped(4194, 4000)).toBe(true);
    // The smallest side always fits next to the largest.
    expect(posterSideMax(POSTER_MAX_SIDE)).toBeGreaterThanOrEqual(POSTER_MIN_SIDE);
  });

  it('rows: whole, 1..8', () => {
    expect(clampRows(0)).toBe(1);
    expect(clampRows(3.4)).toBe(3);
    expect(clampRows(20)).toBe(POSTER_MAX_ROWS);
    expect(clampRows(NaN)).toBe(1);
    const o = posterOptions(form({ posterRows: 4 }), piece('x'), { dark: false, colors: 'pitch' });
    expect(o.rows).toBe(4);
  });

  it('passes size, title, transparency and the HUD', () => {
    const o = posterOptions(
      form({
        posterWidth: 2480,
        posterHeight: 3508,
        posterTitle: false,
        posterHud: ['title', 'key'],
        look: { ...DEFAULT_LOOK_FORM, transparent: true, theme: 'light' },
      }),
      piece('x'),
      { dark: true, colors: 'pitch' },
    );
    expect(o).toMatchObject({
      size: { width: 2480, height: 3508 },
      title: false,
      transparent: true,
      theme: 'light',
    });
    expect(o.look!.hud).toEqual(['key', 'title']);
  });
});

describe('remembered choices', () => {
  class Mem {
    data = new Map<string, string>();
    getItem(k: string) {
      return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.data.set(k, v);
    }
  }
  const throwing = {
    getItem(): string | null {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem(): void {
      throw new DOMException('full', 'QuotaExceededError');
    },
  };

  it('round-trips the Look and the video/poster choices under algorhythms.export', () => {
    const st = new Mem();
    const f = form({
      format: 'midi',
      bitDepth: 16,
      videoAspect: '9:16',
      videoFps: 60,
      videoCamera: 'whole',
      videoFollowAt: 60,
      videoWindow: 24,
      videoHud: ['chord', 'gaps'],
      posterFormat: 'svg',
      posterWidth: 5000,
      posterHeight: 3000,
      posterRows: 6,
      posterTitle: false,
      posterHud: ['title'],
      look: {
        ...DEFAULT_LOOK_FORM,
        theme: 'dark',
        guides: true,
        future: 'dimmed',
        futureOpacity: 0.5,
        lineWidth: 'bold',
        colours: {
          ...DEFAULT_COLOURS,
          lines: 'part',
          parts: { Melody: '#123abc' },
          background: 'gradient',
          bgFrom: '#000000',
          bgDir: 'radial',
          hud: '#eeeeee',
        },
      },
      colourSchemes: [
        { id: 'Mine', name: 'Mine', colours: { ...DEFAULT_COLOURS, playhead: '#ff0000' } },
      ],
    });
    expect(saveExportPrefs(f, st)).toBe(true);
    expect([...st.data.keys()]).toEqual([EXPORT_PREFS_KEY]);
    expect(EXPORT_PREFS_KEY).toBe('algorhythms.export');
    const back = { ...DEFAULT_EXPORT_FORM, ...loadExportPrefs(st) };
    expect(back).toEqual({ ...f, format: 'wav', bitDepth: 32 }); // WAV/MIDI choices not kept
  });

  it('saves a version; older records load their line colours into Colours', () => {
    const st = new Mem();
    const pitch = { ...DEFAULT_COLOURS, lines: 'pitch' as const };
    saveExportPrefs(form({ look: { ...DEFAULT_LOOK_FORM, colours: pitch } }), st);
    expect(JSON.parse(st.data.get(EXPORT_PREFS_KEY)!).v).toBe(EXPORT_PREFS_VERSION);
    expect(EXPORT_PREFS_VERSION).toBe(4);
    expect(loadExportPrefs(st).look!.colours.lines).toBe('pitch'); // a choice made now is kept
    // No version: 'pitch' was the old unchosen default; ink and custom were real choices.
    expect(parsePrefs({ look: { colors: 'pitch', guides: true } }).look).toEqual({
      ...DEFAULT_LOOK_FORM,
      guides: true,
    });
    const lines = (r: object) => parsePrefs(r).look!.colours;
    expect(lines({ look: { colors: 'ink', lineInk: '#336699' } })).toEqual({
      ...DEFAULT_COLOURS,
      lines: 'one',
      one: '#336699',
    });
    expect(lines({ look: { colors: 'custom' } })).toMatchObject({ lines: 'one', one: null });
    expect(lines({ v: 2, look: { colors: 'app' } }).lines).toBe('app');
    expect(lines({ v: 3, look: { colors: 'pitch' } }).lines).toBe('pitch');
    // v4: stored colours; bad values fall back field by field.
    const c = lines({ v: 4, look: { colours: { lines: 'part', hud: 'red', bg: '#AABBCC' } } });
    expect(c).toEqual({ ...DEFAULT_COLOURS, lines: 'part', bg: '#aabbcc' });
    expect(
      parsePrefs({ v: 4, colourSchemes: [{ name: ' ' }, { name: 'A', colours: {} }] }),
    ).toEqual({ colourSchemes: [{ id: 'A', name: 'A', colours: DEFAULT_COLOURS }] });
  });

  it('remembers the video quality; unknown ones are dropped', () => {
    expect(parsePrefs({ videoQuality: 'max' })).toEqual({ videoQuality: 'max' });
    expect(parsePrefs({ videoQuality: 'ultra' })).toEqual({});
  });

  it('says in one line when the audio is Opus because AAC is missing', () => {
    expect(aacNote({ ok: true, video: 'avc1.640028', audio: 'mp4a.40.2', aac: true })).toBeNull();
    expect(aacNote({ ok: false, reason: 'no' })).toBeNull();
    expect(aacNote(null)).toBeNull();
    expect(aacNote({ ok: true, video: 'avc1.640028', audio: 'opus', aac: false })).toMatch(
      /can’t encode AAC, so the audio is Opus/,
    );
  });

  it('loads an old record’s size preset, and clamps stored pixels and rows', () => {
    expect(parsePrefs({ posterSize: 'a4' })).toEqual({ posterWidth: 2480, posterHeight: 3508 });
    expect(parsePrefs({ posterSize: '1:1' })).toEqual({ posterWidth: 2160, posterHeight: 2160 });
    // Pixels win over a preset; a missing side comes from it (or 16:9).
    expect(parsePrefs({ posterSize: '1:1', posterWidth: 3000 })).toEqual({
      posterWidth: 3000,
      posterHeight: 2160,
    });
    expect(parsePrefs({ posterHeight: 1200 })).toEqual({ posterWidth: 3840, posterHeight: 1200 });
    expect(parsePrefs({ posterWidth: 9000, posterHeight: 9000 })).toEqual({
      posterWidth: 8000,
      posterHeight: 2097,
    });
    expect(parsePrefs({ posterWidth: 10, posterHeight: 'x' })).toEqual({
      posterWidth: 1000,
      posterHeight: 2160,
    });
    expect(parsePrefs({ posterRows: 0 })).toEqual({ posterRows: 1 });
    expect(parsePrefs({ posterRows: 12 })).toEqual({ posterRows: 8 });
  });

  it('works without storage, or with storage that throws', () => {
    expect(loadExportPrefs(null)).toEqual({});
    expect(saveExportPrefs(form(), null)).toBe(false);
    expect(loadExportPrefs(throwing)).toEqual({});
    expect(saveExportPrefs(form(), throwing)).toBe(false);
  });

  it('drops bad stored values field by field', () => {
    const st = new Mem();
    st.setItem(EXPORT_PREFS_KEY, '{not json');
    expect(loadExportPrefs(st)).toEqual({});
    expect(
      parsePrefs({
        videoAspect: '4:3',
        videoFps: 60,
        videoFollowAt: 200,
        videoWindow: 0.5,
        videoHud: ['nope', 'chord'],
        posterSize: 'a3',
        posterRows: 'two',
        look: { guides: 'yes', beats: true, future: 'later', lineInk: 'red', lineWidth: 'bold' },
      }),
    ).toEqual({
      videoFps: 60,
      videoFollowAt: 90,
      videoWindow: 2,
      videoHud: ['chord'],
      hudLayout: {}, // before v3: the list's default slots
      look: { ...DEFAULT_LOOK_FORM, beats: 'auto', lineWidth: 'bold' },
    });
    // Stored beats: the old booleans load as off / auto; the names as themselves.
    for (const [v, want] of [
      [false, 'off'],
      [true, 'auto'],
      ['every', 'every'],
      ['nope', 'off'],
    ] as const) {
      expect(parsePrefs({ look: { beats: v } }).look!.beats).toBe(want);
    }
    expect(parsePrefs(null)).toEqual({});
    expect(parsePrefs(3)).toEqual({});
  });
});

/**
 * The Export dialog's "Ready for YouTube" controls (PLAN.md §12): the video Preset, Loudness
 * (measured on demand in a worker), guide lines at pitches, the Opening & ending group, and the
 * Thumbnail and Copy description buttons. Little text; explanations are tooltips.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { noteName, parsePitchClass } from '../../core/scales';
import type { LoudnessMeasure } from '../../dsp/loudness';
import type { VideoSize } from '../../render/video';
import { downloadBlob } from '../download';
import {
  LOUDNESS_TARGETS,
  PITCH_GUIDES_MAX,
  THUMBNAIL_ATS,
  VIDEO_END_CARDS,
  VIDEO_FADE_MAX,
  type ExportForm,
  type LookForm,
  type VideoContext,
} from '../export-options';
import { encodeShareLink } from '../share';
import { usePlayer } from '../store';
import { formatPitch, parsePitchList } from './inspector/fields';
import { Radios, Switch } from './export-controls';
import {
  LIMIT_WARN_DB,
  SHORTS_MAX,
  VIDEO_PRESETS,
  gainText,
  lufsText,
  presetOf,
  type VideoPreset,
} from '../youtube-preset';
import { timestamp } from '../youtube-description';

type Runtime = typeof import('../export-run');

/**
 * The video Preset: YouTube / Shorts set their list of options; Custom lights up when one of
 * them is changed (it can't be chosen itself).
 */
export function PresetField({
  form,
  sizes,
  disabled,
  spanLength,
  onPreset,
}: {
  form: ExportForm;
  /** The size classes encodable at 16:9 60 fps, once known. */
  sizes?: readonly VideoSize[];
  disabled: boolean;
  /** The section's length, s (Shorts warns over SHORTS_MAX). */
  spanLength: number;
  onPreset: (p: Exclude<VideoPreset, 'custom'>) => void;
}) {
  const id = useId();
  const preset = presetOf(form, sizes);
  return (
    <>
      <Radios
        legend="Preset"
        name={`${id}-preset`}
        value={preset}
        options={VIDEO_PRESETS}
        disabled={disabled}
        testId="export-preset"
        className="preset"
        hint="YouTube: 16:9, 4K (or 1440p), 60 fps, High, −14 LUFS, title card, 10 s end card. Shorts: 9:16 1080×1920, 60 fps, High, −14 LUFS, no end card. Changing one of these shows Custom."
        isDisabled={(p) => p === 'custom'}
        onChange={(p) => {
          if (p !== 'custom') onPreset(p);
        }}
      />
      {preset === 'shorts' && spanLength > SHORTS_MAX + 1e-6 && (
        <small className="export-hint export-warn-line" role="alert" data-testid="shorts-warn">
          Shorts are at most 3 min; this is {timestamp(spanLength)}.
        </small>
      )}
    </>
  );
}

/** The Loudness display's state for one measurement key. */
interface Measured {
  key: string;
  measure?: LoudnessMeasure;
  progress?: number;
  error?: string;
}

/**
 * Loudness (WAV and video): Off / −14 / −16 LUFS. A target measures the export's render in a
 * worker (cached per piece version and section) and shows its loudness and the gain to apply,
 * with a warning when reaching it would need more than 6 dB of limiting.
 */
export function LoudnessField({
  form,
  runtime,
  disabled,
  context,
  videoAudio,
  onChange,
}: {
  form: ExportForm;
  runtime: Runtime | null;
  disabled: boolean;
  context: () => VideoContext;
  /** A video's audio codec (it sets the true-peak ceiling); absent for a WAV. */
  videoAudio?: string;
  onChange: (loudness: ExportForm['loudness']) => void;
}) {
  const id = useId();
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const [state, setState] = useState<Measured | null>(null);
  const on = form.loudness !== 'off';
  const target = useMemo(
    () => (runtime && on ? runtime.loudnessTarget({ piece, compiled }, form, context()) : null),
    [runtime, on, piece, compiled, form, context],
  );
  const key = target?.key ?? null;

  useEffect(() => {
    if (!runtime || key === null || runtime.cachedLoudness(key)) return;
    let alive = true;
    const { piece: p, compiled: c } = usePlayer.getState();
    runtime
      .measureExportLoudness({ piece: p, compiled: c }, form, context(), (progress) => {
        if (alive) setState({ key, progress });
      })
      .then(
        (measure) => alive && setState({ key, measure }),
        (e: unknown) =>
          alive && setState({ key, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
    // Measures once per key (the piece as it sounds and the span); `form` changes don't matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, key]);

  const cached = key !== null ? runtime?.cachedLoudness(key) : undefined;
  const cur: Measured | null = cached
    ? { key: key!, measure: cached }
    : state && state.key === key
      ? state
      : null;
  const plan =
    cur?.measure && on && runtime
      ? runtime.loudnessPlan(cur.measure, form.loudness as number, videoAudio)
      : null;
  const targetText = on ? lufsText(form.loudness as number) : '';
  return (
    <>
      <Radios
        legend="Loudness"
        name={`${id}-loud`}
        value={form.loudness}
        options={LOUDNESS_TARGETS}
        disabled={disabled}
        testId="export-loudness"
        hint="Off: peaks at −1 dBFS, as before. A target sets the integrated loudness (YouTube plays at about −14 LUFS) with true peaks at −1 dBTP."
        onChange={onChange}
      />
      {on && (
        <small className="export-hint" aria-live="polite" data-testid="loudness-measure">
          {cur?.error
            ? `Couldn’t measure: ${cur.error}`
            : cur?.measure && plan
              ? `Now ${lufsText(cur.measure.lufs)} · gain ${gainText(plan.gainDb)}`
              : `Measuring… ${Math.round((cur?.progress ?? 0) * 100)} %`}
        </small>
      )}
      {plan && plan.limitDb > LIMIT_WARN_DB && (
        <small
          className="export-hint export-warn-line"
          data-testid="loudness-warn"
          data-limit={plan.limitDb.toFixed(1)}
          title={`Reaching ${targetText} squashes the loudest peaks by ${plan.limitDb.toFixed(1)} dB. Glue (Sound drawer, Master) evens them out first, or choose −16 LUFS.`}
        >
          Needs {plan.limitDb.toFixed(1)} dB of limiting; try Glue.
        </small>
      )}
    </>
  );
}

/**
 * Guide lines at pitches (Look grid): chips of the notes (× removes), a field for typed note
 * names ("E4, A3"; Enter adds), quick picks of the key's tonic in the piece's range, and a switch
 * for the note names drawn beside the lines.
 */
export function PitchGuidesRow({
  form,
  disabled,
  onLook,
  aside,
}: {
  form: ExportForm;
  disabled: boolean;
  onLook: (p: Partial<LookForm>) => void;
  /** Beside the label: the details disclosure (poster workspace). */
  aside?: ReactNode;
}) {
  const id = useId();
  const compiled = usePlayer((s) => s.compiled);
  const tonic = usePlayer((s) => parsePitchClass(s.piece.key.tonic) ?? 0);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  // A quick pick turns into a chip: focus follows it.
  const picked = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (picked.current === null) return;
    group.current
      ?.querySelector<HTMLElement>(`[data-testid="look-pitch-${picked.current}"]`)
      ?.focus();
    picked.current = null;
  });
  const pg = form.look.pitchGuides ?? { pitches: [], labels: true };
  const set = (pitches: readonly number[]) =>
    onLook({ pitchGuides: { pitches: [...pitches], labels: pg.labels } });
  const add = (ps: readonly number[]) => {
    const next = [...pg.pitches];
    for (const p of ps) if (!next.includes(p)) next.push(p);
    set(next.slice(0, PITCH_GUIDES_MAX).sort((a, b) => a - b));
  };
  const picks = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of compiled.voices) {
      for (const s of v.segments) {
        lo = Math.min(lo, s.p0, s.p1);
        hi = Math.max(hi, s.p0, s.p1);
      }
    }
    const out: number[] = [];
    if (!(hi >= lo)) return out;
    for (let p = Math.ceil((lo - tonic) / 12) * 12 + tonic; p <= hi && out.length < 4; p += 12) {
      out.push(p);
    }
    return out;
  }, [compiled, tonic]);
  const commit = () => {
    if (text.trim() === '') return;
    const ps = parsePitchList(text);
    if (!ps) {
      setBad(true);
      return;
    }
    setBad(false);
    setText('');
    add(ps);
  };
  const free = picks.filter((p) => !pg.pitches.includes(p));
  const label = (
    <span
      className="look-label"
      id={`${id}-label`}
      title="Faint horizontal lines at the notes you choose."
    >
      Guide notes
    </span>
  );
  return (
    <>
      {aside ? (
        <div className="look-label-row">
          {label}
          {aside}
        </div>
      ) : (
        label
      )}
      <div
        ref={group}
        className="pitch-guides"
        role="group"
        aria-labelledby={`${id}-label`}
        data-testid="look-pitch-guides"
      >
        {pg.pitches.map((p) => (
          <button
            key={p}
            type="button"
            className="chip on"
            disabled={disabled}
            aria-label={`Remove the guide at ${formatPitch(p)}`}
            data-testid={`look-pitch-${p}`}
            onClick={() => set(pg.pitches.filter((x) => x !== p))}
          >
            {formatPitch(p)} <span aria-hidden="true">×</span>
          </button>
        ))}
        {free.map((p) => (
          <button
            key={`pick-${p}`}
            type="button"
            className="chip pick"
            disabled={disabled || pg.pitches.length >= PITCH_GUIDES_MAX}
            aria-label={`Add a guide at ${noteName(p)}`}
            title="The key’s tonic"
            data-testid={`look-pitch-pick-${p}`}
            onClick={() => {
              picked.current = p;
              add([p]);
            }}
          >
            + {noteName(p)}
          </button>
        ))}
        <input
          type="text"
          spellCheck={false}
          placeholder="E4, A3"
          value={text}
          disabled={disabled || pg.pitches.length >= PITCH_GUIDES_MAX}
          aria-label="Add guide notes"
          aria-invalid={bad}
          title="Note names (C4, F#3, Bb2) or MIDI numbers; Enter adds them."
          data-testid="look-pitch-input"
          onChange={(e) => {
            setText(e.target.value);
            setBad(false);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape' && text !== '') {
              e.preventDefault();
              e.stopPropagation();
              setText('');
              setBad(false);
            }
          }}
        />
      </div>
      {pg.pitches.length > 0 && (
        <Switch
          label="Guide note names"
          checked={pg.labels}
          disabled={disabled}
          testId="look-pitch-labels"
          onChange={(labels) => onLook({ pitchGuides: { pitches: [...pg.pitches], labels } })}
        />
      )}
    </>
  );
}

/** A 0..3 s slider (tenths) with its value beside it. */
function Seconds3({
  label,
  value,
  hint,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  value: number;
  hint: string;
  disabled: boolean;
  testId: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const text = value > 0 ? `${value.toFixed(1)} s` : 'Off';
  return (
    <>
      <label htmlFor={id} title={hint}>
        {label}
      </label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={0}
          max={VIDEO_FADE_MAX}
          step={0.1}
          value={value}
          disabled={disabled}
          aria-valuetext={text}
          data-testid={testId}
          onChange={(e) => onChange(Math.round(Number(e.target.value) * 10) / 10)}
        />
        <output htmlFor={id} data-testid={`${testId}-value`}>
          {text}
        </output>
      </div>
    </>
  );
}

/** A labelled text field in the Look grid. */
function TextRow({
  label,
  value,
  placeholder,
  hint,
  disabled,
  testId,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  disabled: boolean;
  testId: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} title={hint}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        className="look-text"
        value={value}
        placeholder={placeholder}
        maxLength={120}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
    </>
  );
}

/**
 * Opening & ending (video): fade in, lead-in, the title card (title and subtitle), fade to
 * black, the end card and its credit line. Collapsible; its row says what is on.
 */
export function BookendsGroup({
  form,
  open,
  disabled,
  onToggle,
  onPatch,
}: {
  form: ExportForm;
  open: boolean;
  disabled: boolean;
  onToggle: (open: boolean) => void;
  onPatch: (p: Partial<ExportForm>) => void;
}) {
  const id = useId();
  const pieceTitle = usePlayer((s) => s.piece.meta.title);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (panel.current) panel.current.inert = !open;
  }, [open]);
  const on: string[] = [];
  if (form.videoFadeIn > 0) on.push('fade in');
  if (form.videoLeadIn > 0) on.push('lead-in');
  if (form.videoTitleCard) on.push('title');
  if (form.videoFadeOut > 0) on.push('fade out');
  if (form.videoEndCard > 0) on.push(`end card ${form.videoEndCard} s`);
  return (
    <div className="export-group" data-testid="bookends">
      <button
        type="button"
        className="hud-row group-row"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        data-testid="bookends-button"
        onClick={() => onToggle(!open)}
      >
        <span>
          Opening &amp; ending
          <small className="group-summary">
            {on.length > 0 ? ` · ${on.join(', ')}` : ' · Off'}
          </small>
        </span>
        <span className="hud-chevron" aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={`${id}-panel`}
        className={open ? 'hud-panel open' : 'hud-panel'}
        role="group"
        aria-label="Opening and ending"
      >
        <div className="hud-inner look-grid">
          <Seconds3
            label="Fade in"
            value={form.videoFadeIn}
            hint="From black at the start."
            disabled={disabled}
            testId="vb-fade-in"
            onChange={(videoFadeIn) => onPatch({ videoFadeIn })}
          />
          <Seconds3
            label="Lead-in"
            value={form.videoLeadIn}
            hint="The opening frame held, silent, before the first sound."
            disabled={disabled}
            testId="vb-lead-in"
            onChange={(videoLeadIn) => onPatch({ videoLeadIn })}
          />
          <Switch
            label="Title card"
            checked={form.videoTitleCard}
            disabled={disabled}
            hint="The title fades in over the picture at 0.5 s, holds about 4 s and fades out."
            testId="vb-title-card"
            onChange={(videoTitleCard) => onPatch({ videoTitleCard })}
          />
          {form.videoTitleCard && (
            <>
              <TextRow
                label="Title"
                value={form.videoTitle ?? pieceTitle}
                placeholder={pieceTitle}
                disabled={disabled}
                testId="vb-title"
                onChange={(v) => onPatch({ videoTitle: v === pieceTitle ? null : v })}
              />
              <TextRow
                label="Subtitle"
                value={form.videoSubtitle}
                placeholder="Optional"
                disabled={disabled}
                testId="vb-subtitle"
                onChange={(videoSubtitle) => onPatch({ videoSubtitle })}
              />
            </>
          )}
          <Seconds3
            label="Fade to black"
            value={form.videoFadeOut}
            hint="To black at the very end."
            disabled={disabled}
            testId="vb-fade-out"
            onChange={(videoFadeOut) => onPatch({ videoFadeOut })}
          />
          <EndCardRow form={form} disabled={disabled} onPatch={onPatch} />
          {form.videoEndCard > 0 && (
            <TextRow
              label="Credit"
              value={form.videoCredit}
              placeholder="None"
              hint="Under the end card; empty for none."
              disabled={disabled}
              testId="vb-credit"
              onChange={(videoCredit) => onPatch({ videoCredit })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** End card: Off / 5 / 10 / 20 s, segments in the grid. */
function EndCardRow({
  form,
  disabled,
  onPatch,
}: {
  form: ExportForm;
  disabled: boolean;
  onPatch: (p: Partial<ExportForm>) => void;
}) {
  const id = useId();
  return (
    <>
      <span
        className="look-label"
        id={`${id}-label`}
        title="After the music, the whole piece drawn finished, held this long (room for YouTube's end screen)."
      >
        End card
      </span>
      <div
        className="seg radios look-seg"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        data-testid="vb-end-card"
        data-value={form.videoEndCard}
      >
        {VIDEO_END_CARDS.map((c) => (
          <label key={c.id} className={form.videoEndCard === c.id ? 'on' : undefined}>
            <input
              type="radio"
              name={`${id}-r`}
              value={c.id}
              checked={form.videoEndCard === c.id}
              disabled={disabled}
              onChange={() => onPatch({ videoEndCard: c.id })}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </>
  );
}

/**
 * Under the video preview: Thumbnail (a 1280×720 JPEG of this frame or the whole piece, title
 * large) and Copy description (title, facts, chapters, credit; the share link optional).
 */
export function PreviewActions({
  form,
  runtime,
  time,
  disabled,
  context,
  onPatch,
}: {
  form: ExportForm;
  runtime: Runtime | null;
  /** The preview's score time. */
  time: number;
  disabled: boolean;
  context: () => VideoContext;
  onPatch: (p: Partial<ExportForm>) => void;
}) {
  const id = useId();
  const piece = usePlayer((s) => s.piece);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [link, setLink] = useState<{ piece: unknown; link: string } | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  // The share link, made ahead so Copy writes in the click's own turn.
  useEffect(() => {
    if (!form.descriptionLink) return;
    let alive = true;
    encodeShareLink(piece).then(
      (l) => alive && setLink({ piece, link: l }),
      () => alive && setLink(null),
    );
    return () => {
      alive = false;
    };
  }, [form.descriptionLink, piece]);

  const say = (text: string) => {
    setSaid(text);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaid(''), 2500);
  };

  const thumbnail = () => {
    if (!runtime || busy) return;
    setBusy(true);
    const { piece: p, compiled } = usePlayer.getState();
    runtime
      .runThumbnail(
        { piece: p, compiled },
        form,
        context(),
        form.thumbnailAt === 'whole' ? 'whole' : time,
      )
      .then(
        (out) => {
          if (out.blob) downloadBlob(out.blob, out.name);
          say(`Saved ${out.name}`);
        },
        (e: unknown) => say(`Thumbnail failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => setBusy(false));
  };

  const copy = () => {
    if (!runtime) return;
    const { piece: p, compiled } = usePlayer.getState();
    const share = form.descriptionLink && link?.piece === p ? link.link : undefined;
    const text = runtime.descriptionOf({ piece: p, compiled }, form, context(), share);
    navigator.clipboard.writeText(text).then(
      () => say('Copied'),
      () => say('Copying was blocked by the browser'),
    );
  };

  return (
    <div className="preview-actions">
      <div className="field-row">
        <button
          type="button"
          disabled={disabled || !runtime || busy}
          title="A JPEG for YouTube's custom thumbnail (1280×720 at 16:9, under 2 MB), the title large."
          data-testid="export-thumbnail"
          onClick={thumbnail}
        >
          Thumbnail
        </button>
        <div
          className="seg radios look-seg"
          role="radiogroup"
          aria-label="Thumbnail picture"
          data-testid="thumbnail-at"
          data-value={form.thumbnailAt}
        >
          {THUMBNAIL_ATS.map((c) => (
            <label key={c.id} className={form.thumbnailAt === c.id ? 'on' : undefined}>
              <input
                type="radio"
                name={`${id}-thumb`}
                value={c.id}
                checked={form.thumbnailAt === c.id}
                disabled={disabled}
                onChange={() => onPatch({ thumbnailAt: c.id })}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="field-row">
        <button
          type="button"
          disabled={!runtime || (form.descriptionLink && link?.piece !== piece)}
          title="Copies text for YouTube's description box: title, key, tempo and length, chapters from the section labels (when YouTube accepts them) and the credit."
          data-testid="export-description"
          onClick={copy}
        >
          {said === 'Copied' ? 'Copied' : 'Copy description'}
        </button>
        <Switch
          label="With share link"
          checked={form.descriptionLink}
          hint="Adds a link that opens this piece in AlgoRhythms."
          testId="description-link"
          className="inline"
          onChange={(descriptionLink) => onPatch({ descriptionLink })}
        />
      </div>
      <div className="visually-hidden" aria-live="polite" data-testid="preview-actions-live">
        {said}
      </div>
    </div>
  );
}

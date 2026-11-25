/**
 * The poster workspace (PLAN.md §15 M14 "Entry", "Layout"): Export turns the editor into a
 * poster workspace. The score area becomes the artboard (the whole poster, drawn by the export's
 * own code); the right panel holds every poster option and ends with Export PNG / SVG; the
 * bottom panel holds the tools and the layers. "Back to music" (or Escape with nothing focused
 * or selected) returns to the editor, which stays mounted underneath, so its playhead and zoom
 * are kept.
 *
 * Slots for P3 (editing on the artboard): `SelectionPanel` (top of the right panel), the
 * artboard's overlay (beside `HudOverlay`, in the same % coordinates), `ToolRow` and
 * `LayersList`; the tool and selection live in `useWorkspace` (../poster-workspace).
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  POSTER_FORMATS,
  POSTER_SIZES,
  VIDEO_THEMES,
  posterPreset,
  sectionOf,
} from '../export-options';
import {
  cancelExport,
  closeSurface,
  openSurface,
  patch,
  patchLook,
  previewStats,
  startExport,
  useExportUi,
  useRuntime,
  videoContext,
  type Runtime,
} from './export-state';
import {
  ExportModeSwitch,
  HudOverlay,
  LookPanel,
  PosterSizeFields,
  RunStatus,
  SectionField,
  posterSummary,
} from './ExportFields';
import { Radios, Switch } from './export-controls';
import { RowsGroup } from './RowsOrganize';
import { UndoRedo } from './UndoRedo';
import { usePictures } from '../poster-picture';
import { useFocusRescue } from './focus-rescue';
import { useExportSurface, workspaceEscape } from '../export-surface';
import {
  artboardFit,
  linesText,
  posterLayers,
  useWorkspace,
  type WorkspaceTool,
} from '../poster-workspace';
import type { ExportForm } from '../export-options';
import { usePlayer } from '../store';
import './workspace.css';

/** Back to the editor; focus returns to the menu button (where Export was chosen). */
export function backToMusic(): void {
  closeSurface();
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-testid="menu-button"]')?.focus(),
  );
}

/**
 * The workspace's top bar items (in the transport): Back to music and Poster | Video. Video
 * opens the video dialog until M15.
 */
export function WorkspaceBar() {
  const surface = useExportSurface((s) => s.surface);
  const bar = useRef<HTMLDivElement>(null);
  // Opening the workspace puts focus on its mode (the first control after Back).
  useEffect(() => {
    bar.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
  }, []);
  return (
    <div className="ws-bar" role="group" aria-label="Export workspace" ref={bar}>
      <button type="button" className="ws-back" data-testid="back-to-music" onClick={backToMusic}>
        ← Back to music
      </button>
      <ExportModeSwitch
        value={surface === 'video' ? 'video' : 'poster'}
        onChange={(m) => {
          if (m === 'video') openSurface('video');
        }}
      />
    </div>
  );
}

/** P3: the selected object's style and X/Y/W/H (`useWorkspace().selected`). Nothing is selectable yet. */
function SelectionPanel() {
  return null;
}

/**
 * The artboard: the whole poster, fitted with a little padding, drawn by the export's own code
 * (`previewPosterOf`) at most once per animation frame on any change; the HUD readouts' boxes
 * over it. A transparent poster sits on a checkerboard.
 */
function Artboard({ form, runtime }: { form: ExportForm; runtime: Runtime | null }) {
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  // The app's theme and line colours feed 'Current' and 'As in the app'.
  const appView = usePlayer((s) => `${s.view.theme} ${s.view.colors}`);
  const running = useExportUi((s) => s.run.status === 'running');
  // A background picture decoded after the first draw redraws the artboard.
  const pictures = usePictures((s) => s.decoded);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const draws = useRef(0);
  const frame = useRef(0);
  const job = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      previewStats.measures++;
      const w = el.clientWidth;
      const h = el.clientHeight;
      setAvail((a) => (a.w === w && a.h === h ? a : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const px = { width: form.posterWidth, height: form.posterHeight };
  const fit = artboardFit(avail, px);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const pxW = Math.round(fit.w * dpr);
  const pxH = Math.max(1, Math.round((px.height * pxW) / px.width));

  useEffect(() => {
    if (!runtime || avail.w === 0) return;
    job.current = () => {
      const c = canvas.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      if (c.width !== pxW) c.width = pxW;
      if (c.height !== pxH) c.height = pxH;
      const t0 = performance.now();
      const place = runtime.previewPosterOf(
        g,
        { piece, compiled },
        form,
        videoContext(),
        pxW / px.width,
      );
      const prev = useExportUi.getState().hudPlace;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(place)) {
        useExportUi.setState({ hudPlace: place });
      }
      previewStats.lastMs = performance.now() - t0;
      previewStats.maxMs = Math.max(previewStats.maxMs, previewStats.lastMs);
      draws.current++;
      previewStats.draws++;
      c.dataset.draws = String(draws.current);
    };
    if (frame.current === 0) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const run = job.current;
        job.current = null;
        run?.();
      });
    }
  }, [runtime, piece, compiled, form, pxW, pxH, px.width, appView, avail.w, pictures]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  const transparent = form.look.transparent;
  const size = POSTER_SIZES.find((p) => p.id === posterPreset(form))?.label;
  const what =
    `The poster, ${size ?? `${px.width} × ${px.height}`}` +
    (form.posterRows > 1 ? `, ${form.posterRows} rows` : '') +
    (transparent ? ', transparent background' : '');

  return (
    <section className="artboard" aria-label="Artboard" data-testid="poster-artboard">
      <p className="artboard-badge" data-testid="artboard-badge">
        The whole poster · {px.width} × {px.height}
      </p>
      <div className="artboard-box" ref={box}>
        <div className="preview-stage artboard-page" style={{ width: fit.w, height: fit.h }}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={what}
            className={transparent ? 'checker' : undefined}
            data-testid="preview-canvas"
            style={{ width: fit.w, height: fit.h }}
          />
          <HudOverlay form={form} kind="poster" disabled={running} />
          {/* P3: selection, handles and text boxes go here, over the canvas. */}
        </div>
      </div>
    </section>
  );
}

/** The poster's options, in the right panel (every poster option of the old dialog). */
function PosterOptions({ form, disabled }: { form: ExportForm; disabled: boolean }) {
  const id = useId();
  return (
    <div className="ws-options" data-testid="poster-options">
      <PosterSizeFields form={form} disabled={disabled} />
      <Radios
        legend="File"
        name={`${id}-pformat`}
        value={form.posterFormat}
        options={POSTER_FORMATS}
        disabled={disabled}
        testId="export-pformat"
        onChange={(posterFormat) => patch({ posterFormat })}
      />
      <SectionField form={form} disabled={disabled} />
      <RowsGroup form={form} disabled={disabled} />
      {sectionOf(form, videoContext()) && (
        <div className="field">
          <Switch
            checked={form.posterPieceRange}
            disabled={disabled}
            testId="export-prange"
            label="Piece’s pitch range"
            onChange={(posterPieceRange) => patch({ posterPieceRange })}
          >
            <small className="hud-sample">Off: the pitch range fits the section’s lines</small>
          </Switch>
        </div>
      )}
      <Radios
        legend="Theme"
        name={`${id}-vtheme`}
        value={form.look.theme}
        options={VIDEO_THEMES}
        disabled={disabled}
        testId="export-vtheme"
        onChange={(theme) => patchLook({ theme })}
      />
      <div className="field">
        <Switch
          checked={form.posterTitle}
          disabled={disabled}
          testId="export-ptitle"
          label="Title block (name, length, key)"
          onChange={(posterTitle) => patch({ posterTitle })}
        />
      </div>
      <LookPanel form={form} kind="poster" disabled={disabled} />
    </div>
  );
}

const TOOLS: readonly { id: WorkspaceTool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'text', label: 'Text', key: 'T' },
];

const ALIGNS = [
  ['left', 'Align left', '⇤'],
  ['centre', 'Centre horizontally', '↔'],
  ['right', 'Align right', '⇥'],
  ['top', 'Align top', '⤒'],
  ['middle', 'Centre vertically', '↕'],
  ['bottom', 'Align bottom', '⤓'],
] as const;

/**
 * P3: the tools. Select is the only one for now; Text, align and snap wait for editing on the
 * artboard. Undo and Redo are the piece's (poster edits will join its undo stack).
 */
function ToolRow() {
  const tool = useWorkspace((s) => s.tool);
  return (
    <div className="ws-tools" role="group" aria-label="Tools" data-testid="poster-tools">
      <div className="seg ws-tool-seg">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tool === t.id}
            disabled={t.id !== 'select'}
            title={t.id === 'select' ? `${t.label} (${t.key})` : `${t.label}: not yet`}
            data-testid={`tool-${t.id}`}
            onClick={() => useWorkspace.setState({ tool: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="seg ws-align" role="group" aria-label="Align">
        {ALIGNS.map(([k, label, glyph]) => (
          <button
            key={k}
            type="button"
            disabled
            aria-label={label}
            title={`${label}: select something first`}
          >
            {glyph}
          </button>
        ))}
      </div>
      <Switch checked disabled testId="tool-snap" label="Snap guides" onChange={() => undefined} />
      <UndoRedo />
    </div>
  );
}

/** P3: the layers (selecting, hiding and recolouring them). For now the piece's parts and lines. */
function LayersList({ form }: { form: ExportForm }) {
  const voices = usePlayer((s) => s.piece.voices);
  const title = usePlayer((s) => s.piece.meta.title);
  const expanded = useWorkspace((s) => s.expanded);
  const layers = posterLayers({ voices });
  const toggle = (part: string) =>
    useWorkspace.setState({
      expanded: expanded.includes(part) ? expanded.filter((p) => p !== part) : [...expanded, part],
    });
  return (
    <ul className="ws-layers" aria-label="Layers" data-testid="poster-layers">
      {form.posterTitle && (
        <li className="ws-layer" data-testid="layer-title">
          <span className="ws-layer-row">
            <span className="ws-layer-name">{title || 'Untitled'}</span>
            <small>Title block</small>
          </span>
        </li>
      )}
      {layers.map((l) => {
        const open = expanded.includes(l.part);
        const listId = `layer-lines-${l.part || 'lines'}`;
        return (
          <li key={l.part} className="ws-layer" data-testid="layer-part" data-part={l.part}>
            <span className="ws-layer-row">
              <button
                type="button"
                className="ws-layer-toggle"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-label={`${open ? 'Hide' : 'Show'} the lines of ${l.label}`}
                onClick={() => toggle(l.part)}
              >
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              <span className="ws-layer-name">{l.label}</span>
              <small>
                {l.part === '' ? '' : 'part · '}
                {linesText(l.lines.length)}
              </small>
            </span>
            {open && (
              <ul id={listId} className="ws-layer-lines">
                {l.lines.map((v) => (
                  <li key={v.id} data-testid="layer-line">
                    {v.label}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The workspace, in place of the editor while the poster surface shows. */
export function PosterWorkspace() {
  const form = useExportUi((s) => s.form);
  const run = useExportUi((s) => s.run);
  const runtime = useRuntime(true);
  const root = useRef<HTMLElement>(null);
  const running = run.status === 'running';
  useFocusRescue(root, true);

  // Escape: blur a focused control, else (nothing focused or selected) back to music.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const what = workspaceEscape({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        focused: document.activeElement,
        root: root.current,
        selected: useWorkspace.getState().selected !== null,
        dialog: document.querySelector('dialog[open]') !== null,
      });
      if (!what) return;
      e.preventDefault();
      if (what === 'leave') backToMusic();
      else root.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <main
      className="poster-ws"
      ref={root}
      tabIndex={-1}
      aria-label="Poster workspace"
      data-testid="poster-workspace"
    >
      <Artboard form={form} runtime={runtime} />
      <aside className="ws-side export-panel" aria-label="Poster options">
        <SelectionPanel />
        <PosterOptions form={form} disabled={running} />
        <div className="ws-foot">
          <RunStatus run={run}>
            <p className="export-size" data-testid="export-size">
              {posterSummary(form)}
            </p>
          </RunStatus>
          <div className="dialog-actions">
            {running && (
              <button type="button" data-testid="export-cancel" onClick={cancelExport}>
                Cancel export
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={running || !runtime}
              data-testid="export-run"
              onClick={startExport}
            >
              Export {form.posterFormat.toUpperCase()}
            </button>
          </div>
        </div>
      </aside>
      <section className="ws-bottom export-panel" aria-label="Tools and layers">
        <ToolRow />
        <LayersList form={form} />
      </section>
    </main>
  );
}

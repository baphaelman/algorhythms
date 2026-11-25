/**
 * The poster workspace (PLAN.md §15 M14 "Entry", "Layout"): Export turns the editor into a
 * poster workspace. The score area becomes the artboard (the whole poster, drawn by the export's
 * own code); the right panel holds every poster option and ends with Export PNG / SVG; the
 * bottom panel holds the tools and the layers. "Back to music" (or Escape with nothing focused
 * or selected) returns to the editor, which stays mounted underneath, so its playhead and zoom
 * are kept.
 *
 * Editing on the artboard (selection, handles, text boxes, the panels' editing parts) is in
 * ./PosterEditing; the tool and selection live in `useWorkspace` (../poster-workspace). While
 * the workspace shows, the form's poster options and the piece's poster stay in step
 * (../poster-sync).
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
  patch,
  patchLook,
  previewStats,
  startExport,
  switchMode,
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
import { usePictures } from '../poster-picture';
import { useFocusRescue } from './focus-rescue';
import { useExportSurface, workspaceEscape } from '../export-surface';
import { artboardFit, useWorkspace } from '../poster-workspace';
import { selectionExists } from '../poster-select';
import {
  posterAtSavePoint,
  posterIsDefault,
  posterSaved,
  revertPoster,
  revertToSaved,
  savePoster,
} from '../poster-sync';
import { lastEntry, undo, useEditor } from '../editor/history';
import type { ExportForm } from '../export-options';
import { togglePlay, usePlayer } from '../store';
import { setDialogSpace } from '../space-key';
import {
  ArtboardOverlay,
  disarmTextTool,
  ArtboardPlayhead,
  LayersList,
  MarginsField,
  RefitHint,
  SelectionPanel,
  ToolRow,
  workspaceKey,
} from './PosterEditing';
import { GradientHandles } from './GradientHandles';
import { DetailsButton, DetailsPanel, LabelLineToggles } from './PosterDetails';
import type { DetailsId } from '../poster-details';
import './workspace.css';

/** Back to the editor; focus returns to the menu button (where Export was chosen). */
export function backToMusic(): void {
  closeSurface();
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-testid="menu-button"]')?.focus(),
  );
}

/**
 * The workspace's top bar items (in the transport): Back to music, Poster | Video (the workspace
 * switches in place) and, in Poster, Revert.
 */
export function WorkspaceBar() {
  const surface = useExportSurface((s) => s.surface);
  const bar = useRef<HTMLDivElement>(null);
  // Opening the workspace puts focus on its mode (the first control after Back).
  useEffect(() => {
    bar.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
  }, []);
  return (
    <div
      className="ws-bar"
      data-testid="ws-bar"
      role="group"
      aria-label="Export workspace"
      ref={bar}
    >
      <button type="button" className="ws-back" data-testid="back-to-music" onClick={backToMusic}>
        ← Back to music
      </button>
      <ExportModeSwitch value={surface === 'video' ? 'video' : 'poster'} onChange={switchMode} />
    </div>
  );
}

/** How long "Reverted · Undo" stays (ms), unless something else is edited first. */
const REVERTED_MS = 8000;

/**
 * Save, Revert and Full revert, always visible at the foot of the right panel (outside its
 * scrolling options). Save stores a save point in the piece; Revert returns to it (else to the
 * poster as the workspace opened); Full revert returns to the defaults, then "Reverted · Undo"
 * shows while that step is the newest. Each is one undo step.
 */
function PosterSaveBar({ disabled }: { disabled: boolean }) {
  const piece = usePlayer((s) => s.piece);
  // Re-checks the note when the history changes.
  useEditor((s) => s.undoLabel);
  const [entry, setEntry] = useState<object | null>(null);
  useEffect(() => {
    if (!entry) return;
    const t = setTimeout(() => setEntry(null), REVERTED_MS);
    return () => clearTimeout(t);
  }, [entry]);
  const shown = entry !== null && lastEntry() === entry;
  // Focus stays in the bar: on Undo once fully reverted, on Full revert after.
  const focus = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) focus.current?.focus();
    moved.current = false;
  }, [shown]);
  const saved = posterSaved(piece);
  return (
    <div
      className="ws-savebar"
      role="group"
      aria-label="Save and revert"
      data-testid="poster-savebar"
    >
      <button
        type="button"
        data-testid="poster-save"
        disabled={disabled || saved}
        title="Keep the poster as a save point (Revert returns to it)"
        onClick={() => savePoster()}
      >
        {saved ? 'Saved' : 'Save'}
      </button>
      <button
        type="button"
        data-testid="poster-revert"
        disabled={disabled || posterAtSavePoint(piece)}
        title="Back to the save point, or to the poster as you opened it (one undo step)"
        onClick={() => revertToSaved()}
      >
        Revert
      </button>
      {shown ? (
        <span className="ws-revert-note" role="status" data-testid="poster-reverted">
          <span>Reverted ·</span>
          <button
            ref={focus}
            type="button"
            data-testid="poster-revert-undo"
            onClick={() => {
              moved.current = true;
              undo();
              setEntry(null);
            }}
          >
            Undo
          </button>
        </span>
      ) : (
        <button
          ref={focus}
          type="button"
          data-testid="poster-full-revert"
          disabled={disabled || posterIsDefault(piece.poster)}
          title="Back to the default poster (one undo step)"
          onClick={() => {
            if (!revertPoster()) return;
            moved.current = true;
            setEntry(lastEntry());
          }}
        >
          Full revert
        </button>
      )}
    </div>
  );
}

/**
 * The artboard: the whole poster, fitted with a little padding, drawn by the export's own code
 * (`previewPosterOf`, from the poster's layout) at most once per animation frame on any change;
 * the editing overlay and the HUD readouts' boxes over it. A transparent poster sits on a
 * checkerboard.
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
      const { layout, hud: place } = runtime.previewPosterOf(
        g,
        { piece, compiled },
        form,
        videoContext(),
        pxW / px.width,
      );
      const ws = useWorkspace.getState();
      // A size, rows or margins change arms the Re-fit hint.
      const prevSet = ws.layout?.settings;
      const set = layout.settings;
      const moved =
        !!prevSet &&
        (prevSet.width !== set.width ||
          prevSet.height !== set.height ||
          prevSet.rows !== set.rows ||
          JSON.stringify(prevSet.margins) !== JSON.stringify(set.margins));
      const sel =
        ws.selected && selectionExists(layout, piece.poster, ws.selected) ? ws.selected : null;
      useWorkspace.setState({
        layout,
        ...(sel !== ws.selected ? { selected: sel, editing: null } : {}),
        ...(moved ? { refit: true } : {}),
      });
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
          <ArtboardOverlay width={fit.w} />
          <GradientHandles form={form} />
          <ArtboardPlayhead />
          <HudOverlay form={form} kind="poster" disabled={running} />
        </div>
      </div>
      <RefitHint />
    </section>
  );
}

/** The Look controls whose things have a style, and the details they open. */
const LOOK_DETAILS: Readonly<Record<string, DetailsId>> = {
  pulse: 'pulseMarks',
  beats: 'beatLines',
  'pitch-guides': 'pitchGuides',
  hud: 'hud',
};

function lookDetails(control: string) {
  const id = LOOK_DETAILS[control];
  return id ? { button: <DetailsButton id={id} />, panel: <DetailsPanel id={id} /> } : null;
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
      <MarginsField disabled={disabled} />
      <LabelLineToggles disabled={disabled} />
      <LookPanel form={form} kind="poster" disabled={disabled} details={lookDetails} />
    </div>
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
  // Space plays and pauses, as in the video dialog (a text field still types it).
  useEffect(() => setDialogSpace(togglePlay), []);
  useEffect(
    () => () =>
      useWorkspace.setState({ selected: null, editing: null, layout: null, guides: null }),
    [],
  );

  // Escape: blur a focused control, else (nothing focused or selected) back to music.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        if (!e.defaultPrevented && workspaceKey(e)) e.preventDefault();
        return;
      }
      // The armed Text tool goes back to Select first.
      if (!e.defaultPrevented && !document.querySelector('dialog[open]') && disarmTextTool()) {
        e.preventDefault();
        return;
      }
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
      else if (what === 'deselect') useWorkspace.setState({ selected: null, editing: null });
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
        <SelectionPanel>
          <PosterOptions form={form} disabled={running} />
        </SelectionPanel>
        <PosterSaveBar disabled={running} />
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
        <LayersList />
      </section>
    </main>
  );
}

import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { PALETTE } from '../editor/shortcuts';
import { EXPERIMENTS, ORIGINALS, SONGS } from '../examples';
import {
  canLinkFiles,
  linkToFile,
  newPieceNow,
  newVideoPieceNow,
  openMyPieces,
  saveAsFile,
} from '../persist';
import { openExample, openFile, usePlayer } from '../store';
import { openCompose } from '../compose';
import { openAudioExport, openExport } from './export-state';
import { openGenerate } from './GeneratePanel';
import { openShare } from './ShareDialog';
import { MOD_KEY } from '../platform';

/** The examples menu, in three groups (owner, 2026-11-24). */
const EXAMPLE_GROUPS = [
  { heading: 'Songs', items: SONGS },
  { heading: 'Experiments', items: EXPERIMENTS },
  { heading: 'Originals', items: ORIGINALS },
] as const;

const MOD = MOD_KEY;

/** The ⋯ menu: examples, pieces (New, My pieces, files), Generate, Export, Export audio, and help. */
export function Menu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const title = usePlayer((s) => s.piece.meta.title);

  useEffect(() => {
    if (!open) return;
    // Capture phase, so it runs before the document-level editor keys; preventDefault tells them
    // the Escape was used (it must not also clear the selection).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="menu" ref={root}>
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        accept=".json,.algorhythms.json,application/json"
        aria-label="Open a piece from a file"
        data-testid="file-input"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void openFile(file);
        }}
      />
      <button
        ref={trigger}
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="menu-button"
        onClick={() => setOpen(!open)}
      >
        Menu
      </button>
      {open && (
        <div
          className="menu-panel"
          id={panelId}
          role="group"
          aria-label="Menu"
          data-testid="menu-panel"
        >
          <p className="brand">
            <strong>AlgoRhythms</strong> <small>pitch-line music</small>
          </p>
          {EXAMPLE_GROUPS.map(({ heading, items }) => (
            <Fragment key={heading}>
              <h2>{heading}</h2>
              <ul className="examples" aria-label={heading}>
                {items.map((ex) => (
                  <li key={ex.id}>
                    <button
                      type="button"
                      data-testid={`example-${ex.id}`}
                      aria-current={ex.title === title ? 'true' : undefined}
                      onClick={() => {
                        openExample(ex.json, ex.id);
                        close();
                      }}
                    >
                      <span>{ex.title}</span>
                      <small>{ex.voices} notes</small>
                    </button>
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
          <h2>Pieces</h2>
          <ul>
            <li className="menu-new" role="group" aria-label="New">
              <span>New</span>
              <button
                type="button"
                data-testid="new-piece"
                onClick={() => {
                  close();
                  newPieceNow();
                }}
              >
                Empty
              </button>
              <button
                type="button"
                data-testid="new-video-piece"
                title="One note blooms into chords, gathers and blooms again"
                onClick={() => {
                  close();
                  newVideoPieceNow();
                }}
              >
                Like the video
              </button>
              <button
                type="button"
                data-testid="compose-piece"
                onClick={() => {
                  close();
                  openCompose();
                }}
              >
                Compose for me
              </button>
            </li>
            <li>
              <button
                type="button"
                data-testid="open-my-pieces"
                onClick={() => {
                  close();
                  openMyPieces();
                }}
              >
                My pieces…
              </button>
            </li>
            <li>
              <button
                type="button"
                data-testid="open-file"
                onClick={() => {
                  setOpen(false);
                  fileInput.current?.click();
                }}
              >
                Open file…
              </button>
            </li>
            <li>
              <button
                type="button"
                data-testid="save-file"
                onClick={() => {
                  close();
                  void saveAsFile();
                }}
              >
                Save as file…
              </button>
            </li>
            <li>
              <button
                type="button"
                data-testid="open-share"
                onClick={() => {
                  setOpen(false);
                  openShare();
                }}
              >
                Share link…
              </button>
            </li>
            {canLinkFiles() && (
              <li>
                <button
                  type="button"
                  data-testid="link-file"
                  onClick={() => {
                    close();
                    void linkToFile();
                  }}
                >
                  Link to a file…
                </button>
              </li>
            )}
            <li>
              <button
                type="button"
                data-testid="open-generate"
                onClick={() => {
                  close();
                  openGenerate();
                }}
              >
                Generate…
              </button>
            </li>
            <li>
              <button
                type="button"
                data-testid="open-export"
                onClick={() => {
                  close();
                  openExport();
                }}
              >
                Export…
              </button>
            </li>
            <li>
              <button
                type="button"
                data-testid="open-export-audio"
                onClick={() => {
                  close();
                  openAudioExport();
                }}
              >
                <span>Export audio…</span>
                <small>WAV, stems, MIDI</small>
              </button>
            </li>
          </ul>
          <h2>Help</h2>
          <dl className="shortcuts">
            <dt>
              <kbd>Space</kbd>
            </dt>
            <dd>Play or pause</dd>
            <dt>
              <kbd>←</kbd> <kbd>→</kbd>
            </dt>
            <dd>Move 5 s (Shift: 15 s)</dd>
            <dt>
              <kbd>−</kbd> <kbd>=</kbd>
            </dt>
            <dd>Widen or narrow the window</dd>
            <dt>Drag</dt>
            <dd>Pan while paused</dd>
          </dl>
          <h2>Editing</h2>
          <dl className="shortcuts" data-testid="editor-shortcuts">
            {PALETTE.filter((e) => e.key).map((e) => (
              <Fragment key={e.type}>
                <dt>
                  <kbd>{e.key}</kbd>
                </dt>
                <dd>Add a {e.name.toLowerCase()} at the pointer or the playhead</dd>
              </Fragment>
            ))}
            <dt>
              <kbd>N</kbd> + click, or double-click a line
            </dt>
            <dd>Add a note point there; drag up or down to change the note</dd>
            <dt>
              <kbd>▲</kbd> <kbd>▼</kbd>
            </dt>
            <dd>
              Move the selected note point a scale step (Shift: an octave, also selected dots)
            </dd>
            <dt>Drag a dot</dt>
            <dd>Move it in the key (Shift: by octaves; Alt: chromatic, off the grid)</dd>
            <dt>
              <kbd>Delete</kbd> <kbd>⌫</kbd>
            </dt>
            <dd>Delete the selected moments</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Clear the selection</dd>
            <dt>
              <kbd>{MOD}</kbd> <kbd>Z</kbd>
            </dt>
            <dd>Undo</dd>
            <dt>
              <kbd>⇧</kbd> <kbd>{MOD}</kbd> <kbd>Z</kbd>
            </dt>
            <dd>Redo (also Ctrl+Y)</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

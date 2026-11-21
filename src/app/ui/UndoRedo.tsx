import { redo, undo, useEditor } from '../editor/history';
import { MOD_KEY } from '../platform';

/** Undo and Redo buttons (editor only): disabled with no history; the tooltip names the entry. */
export function UndoRedo() {
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const undoLabel = useEditor((s) => s.undoLabel);
  const redoLabel = useEditor((s) => s.redoLabel);
  return (
    <div className="history" role="group" aria-label="History">
      <button
        type="button"
        data-testid="undo"
        aria-keyshortcuts="Control+Z Meta+Z"
        disabled={!canUndo}
        title={canUndo ? `Undo ${undoLabel} (${MOD_KEY}Z)` : 'Nothing to undo'}
        onClick={() => undo()}
      >
        Undo
      </button>
      <button
        type="button"
        data-testid="redo"
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
        disabled={!canRedo}
        title={canRedo ? `Redo ${redoLabel} (⇧${MOD_KEY}Z)` : 'Nothing to redo'}
        onClick={() => redo()}
      >
        Redo
      </button>
    </div>
  );
}

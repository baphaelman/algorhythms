/**
 * Opening files (PLAN.md §15 M17 "Pictures that open"): Menu → Open and a file dropped anywhere
 * on the page both go through `openFile`. A poster, thumbnail or MP4 carrying a piece opens it in
 * the Video workspace; a `.algorhythms.json` opens in the editor, as before. The palette's own
 * drags (palette-drop.ts) carry no files and are left alone.
 */

import { useExportSurface } from './export-surface';
import { openFile } from './store';
import { cancelExport, openSurface } from './ui/export-state';

/** Menu → Open's file types. */
export const OPEN_ACCEPT =
  '.json,.algorhythms.json,application/json,.png,image/png,.svg,image/svg+xml,.mp4,video/mp4,.jpg,.jpeg,image/jpeg';

/** Opens a file; one that carries a piece in a picture or video shows the Video workspace. */
export function openAnyFile(file: File): Promise<boolean> {
  return openFile(file, {
    onOpen: (media) => {
      // The old piece's workspace goes without restoring its playhead onto the new piece.
      if (useExportSurface.getState().surface !== null) {
        cancelExport();
        useExportSurface.setState({ surface: null });
      }
      if (media) openSurface('video');
    },
  });
}

const carriesFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') === true;

/** A file dropped anywhere opens (once no other target took the drop). Returns the detach. */
export function attachFileDrop(target: Window = window): () => void {
  const onOver = (e: DragEvent): void => {
    if (!carriesFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent): void => {
    if (!carriesFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) void openAnyFile(file);
  };
  target.addEventListener('dragover', onOver);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onOver);
    target.removeEventListener('drop', onDrop);
  };
}

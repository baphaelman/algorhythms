/**
 * Temporary developer switches, shown only when the URL has `?dev`. They change how the player
 * compiles; they are never part of the Piece, a saved file or a share link.
 */

import { create } from 'zustand';
import type { CompileOptions } from '../core/compiler/compile';

/** True when the page URL asks for the developer panel (`?dev`, `?dev=1`, `?x&dev`). */
export function devEnabled(
  search: string = typeof location === 'undefined' ? '' : location.search,
): boolean {
  return new URLSearchParams(search).has('dev');
}

interface DevState {
  /** Compile with `crossings: 'allow'`: voices may cross (skips the §7.2 rules). */
  allowCrossings: boolean;
}

export const useDevOptions = create<DevState>()(() => ({ allowCrossings: false }));

/** The compile options the player uses for every compile (empty unless a switch is on). */
export function compileOptions(): CompileOptions {
  return useDevOptions.getState().allowCrossings ? { crossings: 'allow' } : {};
}

/** Sets the switch. The caller recompiles (`recompileNow()`). */
export function setAllowCrossings(on: boolean): void {
  useDevOptions.setState({ allowCrossings: on });
}

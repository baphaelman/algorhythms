import type { MomentId, Seconds } from '../core/types';

/**
 * What the score loop draws for Compose for me (./compose.ts): the composer's pen (lines are drawn
 * up to it) and the moment an adjustment pass is editing (highlighted). Both empty when idle.
 */
export const composeView = {
  reveal: undefined as Seconds | undefined,
  flash: null as MomentId | null,
};

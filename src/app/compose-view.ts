import type { MomentId, Seconds } from '../core/types';

/**
 * What the score loop draws for Compose for me (./compose.ts): the composer's pen (lines are drawn
 * up to it) and the moment a detail step places (highlighted). `pen` and `detail` say where the
 * build is (NaN and false when idle), for tests. All empty when idle.
 */
export const composeView = {
  reveal: undefined as Seconds | undefined,
  flash: null as MomentId | null,
  pen: NaN as Seconds,
  detail: false,
};

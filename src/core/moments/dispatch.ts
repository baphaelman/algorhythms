/** The point-moment functions by type (§6.2): intents from the state at the moment's time. */

import type { Moment } from '../types';
import { chordMoment } from './chord';
import { mergeMoment } from './merge';
import { noteMoment } from './note';
import { pinMoment } from './pin';
import { shiftMoment } from './shift';
import { splitMoment } from './split';
import { spreadMoment } from './spread';
import type { MomentEnv, MomentPlan } from './types';
import { unisonMoment } from './unison';

/** Runs a point moment's function; null for region, key and level moments or when not applied. */
export function pointMomentPlan(m: Moment, env: MomentEnv): MomentPlan | null {
  switch (m.type) {
    case 'chord':
      return chordMoment(m, env);
    case 'unison':
      return unisonMoment(m, env);
    case 'split':
      return splitMoment(m, env);
    case 'merge':
      return mergeMoment(m, env);
    case 'shift':
      return shiftMoment(m, env);
    case 'spread':
      return spreadMoment(m, env);
    case 'note':
      return noteMoment(m, env);
    case 'pin':
      return pinMoment(m, env);
    default:
      return null;
  }
}

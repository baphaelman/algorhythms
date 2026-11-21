/**
 * The inline "move the fixed notes?" prompt under a key moment's fields (PLAN.md §6.2 `key`,
 * owner 2026-11-21). Not modal: it stays until answered or the selection changes.
 */

import type { MomentId } from '../../../core/types';
import { keyName } from '../../../render';
import { keepKeyCarry, moveKeyCarry, useKeyCarry } from '../../editor/key-carry';
import { formatTime } from './fields';
import './key-carry.css';

export function KeyCarryBanner({ keyId }: { keyId: MomentId }) {
  const prompt = useKeyCarry((s) => s.prompt);
  if (!prompt || prompt.keyId !== keyId) return null;
  const n = prompt.ids.length;
  const until = prompt.until === null ? 'the end' : formatTime(prompt.until);
  return (
    <div className="key-carry" role="status" data-testid="key-carry">
      <p>
        {n} {n === 1 ? 'moment' : 'moments'} until {until} {n === 1 ? 'uses' : 'use'} fixed notes.
        Move them to {keyName(prompt.to)}?
      </p>
      <div className="key-carry-actions">
        <button
          type="button"
          className="primary"
          data-testid="key-carry-move"
          onClick={() => moveKeyCarry()}
        >
          Move
        </button>
        <button type="button" data-testid="key-carry-keep" onClick={keepKeyCarry}>
          Keep
        </button>
      </div>
    </div>
  );
}

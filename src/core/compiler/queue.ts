/**
 * The compiler's priority queue (PLAN.md §7.1).
 *
 * Order: by time; at equal times moment events (in `moments` array order), then move starts (by
 * pool index; a voice's birth before its moves), then walk ticks (in `moments` array order).
 * Remaining ties keep insertion order, so the queue is a total order and the simulation is
 * deterministic.
 */

/** Event classes, in tie-break order. */
export const enum EventClass {
  Moment = 0,
  MoveStart = 1,
  Tick = 2,
}

/** Within a voice's move starts at one time: births first, then moves. */
export const enum MoveSub {
  Birth = 0,
  Move = 1,
}

export interface QueuedEvent {
  /** Event time. */
  t: number;
  cls: EventClass;
  /** Moment array index (moments, ticks) or pool index (move starts). */
  key: number;
  /** MoveSub for move starts; 0 otherwise. */
  sub: number;
  /** Insertion counter; set by the queue. */
  seq: number;
  /** Payload index: moment index, tick index or move/birth record, by class. */
  ref: number;
  /** Payload object for move starts. */
  obj?: unknown;
}

function before(a: QueuedEvent, b: QueuedEvent): boolean {
  if (a.t !== b.t) return a.t < b.t;
  if (a.cls !== b.cls) return a.cls < b.cls;
  if (a.key !== b.key) return a.key < b.key;
  if (a.sub !== b.sub) return a.sub < b.sub;
  return a.seq < b.seq;
}

/** A binary min-heap of events. */
export class EventQueue {
  private heap: QueuedEvent[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  push(e: Omit<QueuedEvent, 'seq'>): void {
    const ev = e as QueuedEvent;
    ev.seq = this.counter++;
    const h = this.heap;
    let i = h.length;
    h.push(ev);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(ev, h[parent])) break;
      h[i] = h[parent];
      i = parent;
    }
    h[i] = ev;
  }

  peek(): QueuedEvent | undefined {
    return this.heap[0];
  }

  pop(): QueuedEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && before(h[r], h[l]) ? r : l;
        if (!before(h[c], last)) break;
        h[i] = h[c];
        i = c;
      }
      h[i] = last;
    }
    return top;
  }
}

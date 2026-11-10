/**
 * Bounded FIFO slot queue: at most `limit` holders at once, everyone else
 * waits in arrival order. The bridge uses this to cap in-flight chat requests
 * per NaN key (the gateway enforces `max_parallel_requests` = 7 and answers
 * 429s beyond it, so we stay comfortably below with 2).
 */

export interface SlotQueue {
  acquire(): Promise<void>;
  release(): void;
  readonly inFlight: number;
  readonly waiting: number;
}

export function createSlotQueue(limit: number): SlotQueue {
  if (limit < 1) throw new Error("Slot queue limit must be at least 1");
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    },
    get inFlight() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}

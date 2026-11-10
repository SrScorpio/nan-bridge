import test from "node:test";
import assert from "node:assert/strict";
import { createSlotQueue } from "./slots.js";

test("admits up to the limit and queues the rest in FIFO order", async () => {
  const slots = createSlotQueue(2);
  const order: number[] = [];
  await slots.acquire();
  await slots.acquire();
  assert.equal(slots.inFlight, 2);
  const third = slots.acquire().then(() => order.push(3));
  const fourth = slots.acquire().then(() => order.push(4));
  assert.equal(slots.waiting, 2);
  slots.release();
  await third;
  slots.release();
  await fourth;
  assert.deepEqual(order, [3, 4]);
  assert.equal(slots.inFlight, 2);
});

test("release wakes exactly one waiter", async () => {
  const slots = createSlotQueue(1);
  await slots.acquire();
  let entered = 0;
  const waiters = [slots.acquire(), slots.acquire()].map((promise) =>
    promise.then(() => {
      entered += 1;
    }),
  );
  slots.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, 1);
  slots.release();
  await Promise.all(waiters);
  assert.equal(entered, 2);
});

test("rejects nonsensical limits", () => {
  assert.throws(() => createSlotQueue(0), /at least 1/);
});

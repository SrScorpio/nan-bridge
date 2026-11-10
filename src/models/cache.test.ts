import test from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "./cache.js";

test("serves a fresh value without reloading", async () => {
  const cache = new TTLCache<string>();
  let loads = 0;
  await cache.getOrRefresh(10_000, async () => {
    loads += 1;
    return "a";
  });
  assert.equal(await cache.getOrRefresh(10_000, async () => "b"), "a");
  assert.equal(loads, 1);
});

test("expires after maxAge and reloads", async () => {
  let now = 0;
  const cache = new TTLCache<string>(() => now);
  await cache.getOrRefresh(100, async () => "first");
  now = 500;
  assert.equal(await cache.getOrRefresh(100, async () => "second"), "second");
});

test("shares one in-flight load between concurrent callers", async () => {
  let loads = 0;
  let release: ((value: string) => void) | undefined;
  const cache = new TTLCache<string>();
  const load = () =>
    new Promise<string>((resolve) => {
      loads += 1;
      release = resolve;
    });
  const calls = [cache.getOrRefresh(60_000, load), cache.getOrRefresh(60_000, load), cache.getOrRefresh(60_000, load)];
  release!("shared");
  assert.deepEqual(await Promise.all(calls), ["shared", "shared", "shared"]);
  assert.equal(loads, 1);
});

test("keeps the last good value when a refresh fails", async () => {
  // No cached value yet: the failure surfaces.
  const cold = new TTLCache<string>();
  assert.equal(await cold.getOrRefresh(0, async () => Promise.reject(new Error("boom"))).catch(() => "threw"), "threw");
  // With a cached value, the failure falls back silently.
  const warm = new TTLCache<string>();
  await warm.getOrRefresh(60_000, async () => "good");
  assert.equal(await warm.getOrRefresh(0, async () => Promise.reject(new Error("boom"))), "good");
});

test("clear() during a refresh discards the stale result", async () => {
  let resolveOld: ((value: string) => void) | undefined;
  const cache = new TTLCache<string>();
  const old = cache.getOrRefresh(60_000, () => new Promise<string>((resolve) => (resolveOld = resolve)));
  cache.clear();
  resolveOld!("stale");
  await assert.rejects(old, /changed during refresh/);
  assert.equal(await cache.getOrRefresh(60_000, async () => "fresh"), "fresh");
});

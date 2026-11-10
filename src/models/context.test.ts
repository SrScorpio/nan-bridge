import test from "node:test";
import assert from "node:assert/strict";
import { contextSizeOptions, resolveContextCap } from "./context.js";

test("offers tiers only above the smallest step", () => {
  const options = contextSizeOptions(1_048_576);
  assert.deepEqual(
    options?.map((option) => option.label),
    ["Auto", "64K", "128K", "200K", "Maximum"],
  );
  assert.equal(options?.[1].value, 65_536);
});

test("small windows get no tier selector", () => {
  assert.equal(contextSizeOptions(32_768), undefined);
  assert.equal(contextSizeOptions(65_536), undefined);
});

test("caps only strictly smaller windows", () => {
  assert.equal(resolveContextCap(65_536, 1_048_576), 65_536);
  assert.equal(resolveContextCap(1_048_576, 1_048_576), undefined); // full window = auto
  assert.equal(resolveContextCap(0, 1_048_576), undefined);
  assert.equal(resolveContextCap(Number.NaN, 1_048_576), undefined);
  assert.equal(resolveContextCap(2_000_000, 1_048_576), undefined); // clamps to max → auto
});

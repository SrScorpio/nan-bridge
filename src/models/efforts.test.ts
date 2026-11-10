import test from "node:test";
import assert from "node:assert/strict";
import { effortForModel, effortsForModel, isEffortLevel, defaultEffortFor, clampEffort, effortDescriptionsFor } from "./efforts.js";

test("passes effort through for families without remaps", () => {
  assert.equal(effortForModel("deepseek-v4", "low"), "low");
  assert.equal(effortForModel("gemma4", "xhigh"), "xhigh");
});

test("lifts GLM's missing none level", () => {
  assert.equal(effortForModel("glm5.3-flash", "none"), "minimal");
  assert.equal(effortForModel("glm5.3-flash", "low"), "low");
});

test("clamps MiMo's extremes", () => {
  assert.equal(effortForModel("mimo-v2.6-flash", "minimal"), "low");
  assert.equal(effortForModel("mimo-v2.6-flash", "xhigh"), "max");
});

test("offers deduplicated levels per family", () => {
  assert.deepEqual(effortsForModel("glm5.3"), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortsForModel("qwen3.6")[0], "none");
});

test("validates effort strings", () => {
  assert.ok(isEffortLevel("none"));
  assert.ok(!isEffortLevel("turbo"));
});

test("clampEffort keeps supported levels and lands invalid ones on the default", () => {
  assert.equal(clampEffort("glm5.3", "high"), "high");
  assert.equal(clampEffort("gemma4", "xhigh"), "xhigh"); // gemma supports xhigh
  assert.equal(clampEffort("glm5.3", undefined), defaultEffortFor("glm5.3"));
  assert.equal(clampEffort("glm5.3", "bogus"), defaultEffortFor("glm5.3"));
});

test("effortDescriptionsFor layers model notes over generic copy", () => {
  // qwen3.6 keeps "none" in its ladder and carries a special note for minimal
  const qwen = effortDescriptionsFor("qwen3.6");
  const minimalIndex = effortsForModel("qwen3.6").indexOf("minimal");
  assert.ok(minimalIndex >= 0);
  assert.match(qwen[minimalIndex], /Turns reasoning off/);
  const glm = effortDescriptionsFor("glm5.3");
  assert.ok(glm.every((line) => line.length > 0));
  // glm remaps none→minimal, so the note must live on minimal, not none.
  assert.match(glm[effortsForModel("glm5.3").indexOf("minimal")], /never fully stop/);
  // mimo trims minimal/xhigh; its notes live on low and max.
  const mimo = effortDescriptionsFor("mimo-v2.6-flash");
  assert.match(mimo[effortsForModel("mimo-v2.6-flash").indexOf("low")], /Closest to minimal/);
  const generic = effortDescriptionsFor("unknown-model");
  assert.ok(generic.every((line) => line.length > 0));
});

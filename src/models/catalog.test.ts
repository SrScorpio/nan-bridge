import test from "node:test";
import assert from "node:assert/strict";
import { mergeCatalog, inputBudgetFor } from "./catalog.js";

test("known ids keep curated metadata and lead the picker by priority", () => {
  const entries = mergeCatalog({ data: [{ id: "qwen3.8-flash" }, { id: "glm5.3-flash" }] });
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["glm5.3-flash", "qwen3.8-flash"], // priority 30 before 40
  );
  const glm = entries[0];
  assert.equal(glm.contextTokens, 1_048_576);
  assert.equal(glm.live, true);
});

test("admits unknown chat ids after the curated ones", () => {
  const entries = mergeCatalog({ data: [{ id: "brandnew-9-flash" }, { id: "glm5.3" }] });
  assert.equal(entries[0].id, "glm5.3");
  const generic = entries.at(-1);
  assert.equal(generic?.id, "brandnew-9-flash");
  assert.equal(generic?.live, true);
  assert.match(generic?.note ?? "", /generic/);
});

test("filters non-chat families out of the picker", () => {
  const entries = mergeCatalog({
    data: [{ id: "qwen3-embedding" }, { id: "whisper-2" }, { id: "flux-2-klein" }, { id: "minimax-h3" }, { id: "gemma4" }],
  });
  const ids = entries.map((entry) => entry.id);
  for (const banned of ["qwen3-embedding", "whisper-2", "flux-2-klein", "minimax-h3"]) {
    assert.ok(!ids.includes(banned), banned);
  }
  assert.ok(ids.includes("gemma4"));
});

test("a directory without chat models falls back to the static catalog", () => {
  const entries = mergeCatalog({ data: [{ id: "kokoro" }] });
  assert.ok(entries.length >= 7);
  assert.ok(entries.every((entry) => !entry.live));
});

test("refuses malformed payloads", () => {
  assert.throws(() => mergeCatalog({}), /missing its data array/i);
  assert.throws(() => mergeCatalog("nope"), /missing its data array/i);
});

test("curated models keep real limits and lead the picker order", () => {
  const entries = mergeCatalog({ data: [
    { id: "qwen3.6" }, { id: "glm5.3" }, { id: "zzz-new-model" },
  ] });
  assert.equal(entries[0].id, "glm5.3"); // priority 10
  assert.equal(entries[1].id, "qwen3.6");
  assert.equal(entries.at(-1)?.id, "zzz-new-model"); // live-only after curated
  const glm = entries[0];
  assert.equal(glm.contextTokens, 1_048_576);
  assert.equal(glm.outputTokens, 262_144);
  assert.equal(glm.inputTokens, inputBudgetFor(glm.contextTokens, glm.outputTokens));
  assert.equal(glm.vision, true);
  const deepseek = mergeCatalog({ data: [{ id: "deepseek-v4-flash" }] })[0];
  assert.equal(deepseek.vision, true);
});

test("input budget reserves output and keeps a 90% headroom", () => {
  assert.equal(inputBudgetFor(1_048_576, 262_144), 786_432); // output reservation wins
  assert.equal(inputBudgetFor(128_000, 16_384), 111_616); // output reservation wins
  assert.equal(inputBudgetFor(10_000, 1_000), 9_000); // 90% headroom wins
});

test("qwen3.6 is labeled legacy", () => {
  const entry = mergeCatalog({ data: [{ id: "qwen3.6" }] })[0];
  assert.equal(entry.label, "Qwen 3.6 (legacy)");
});

test("static-only ids are not listed when the directory omits them", () => {
  const entries = mergeCatalog({ data: [{ id: "glm5.3-flash" }] });
  assert.deepEqual(entries.map((entry) => entry.id), ["glm5.3-flash"]);
});

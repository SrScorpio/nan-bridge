import test from "node:test";
import assert from "node:assert/strict";
import { buildToolNameMap, restoreToolName, sanitizeToolName } from "./tool-names.js";

test("sanitizes characters the gateway rejects", () => {
  assert.equal(sanitizeToolName("vscode_search-ui.ext/entry"), "vscode_search-ui_ext_entry");
  assert.equal(sanitizeToolName("mcp__server:tool"), "mcp__server_tool");
  assert.equal(sanitizeToolName("fetch"), "fetch");
  assert.equal(sanitizeToolName("a b"), "a_b");
});

test("caps length at 64", () => {
  const long = "x".repeat(80);
  assert.equal(sanitizeToolName(long).length, 64);
});

test("restores originals round-trip, collisions resolved", () => {
  const map = buildToolNameMap(["a/b", "a_b", "c:d"]);
  assert.equal(restoreToolName(map, "a_b"), "a/b");
  assert.equal(restoreToolName(map, "a_b-2"), "a_b");
  assert.equal(restoreToolName(map, "c_d"), "c:d");
  // Unknown names pass through untouched.
  assert.equal(restoreToolName(map, "zzz"), "zzz");
});

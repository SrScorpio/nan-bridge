import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "./tokens.js";

test("estimates plain strings", () => {
  assert.ok(estimateTokens("hello world") > 3);
});

test("scores images at a flat cost and text parts by length", () => {
  const parts = [
    { value: "x".repeat(100) },
    { mimeType: "image/png", data: new Uint8Array(4) },
  ];
  const score = estimateTokens({ content: parts });
  assert.ok(score > 1024);
  assert.ok(score < 1200);
});

test("ignores unknown parts", () => {
  assert.equal(estimateTokens({ content: [{}] }), 8);
});

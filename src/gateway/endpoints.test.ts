import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, userAgentFor, DEFAULT_API_BASE_URL } from "./endpoints.js";

test("normalizeBaseUrl trims slashes and falls back to the default", () => {
  assert.equal(normalizeBaseUrl("https://api.nan.builders/v1/"), "https://api.nan.builders/v1");
  assert.equal(normalizeBaseUrl("  https://api.nan.builders/v1///  "), "https://api.nan.builders/v1");
  assert.equal(normalizeBaseUrl(""), DEFAULT_API_BASE_URL);
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_API_BASE_URL);
  // Keeps interior paths and does not touch the scheme's slashes.
  assert.equal(normalizeBaseUrl("https://api.nan.builders/v1/sub"), "https://api.nan.builders/v1/sub");
});

test("userAgentFor carries the bridge brand and host version", () => {
  const agent = userAgentFor("1.1.5", "1.145.2");
  assert.equal(agent, "nan-bridge/1.1.5 VSCode/1.145.2");
});

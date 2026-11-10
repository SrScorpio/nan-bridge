import test from "node:test";
import assert from "node:assert/strict";
import { explain, httpError, ProviderError, transportError } from "./errors.js";

test("maps gateway codes to actionable messages", () => {
  const error = httpError(401, JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }));
  assert.ok(error instanceof ProviderError);
  assert.match(explain(error), /Set API Key/);
});

test("maps 429 to rate limit and keeps the Retry-After hint", () => {
  const error = httpError(429, "{}", 3_000);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.equal(error.retryAfterMs, 3_000);
});

test("surfaces the gateway's own validation text for unmapped codes", () => {
  const error = httpError(400, JSON.stringify({ error: { code: "bad_request", message: "Invalid model name passed in model=None." } }));
  assert.match(explain(error), /Invalid model name passed in model=None\./);
});

test("unwraps nested {error:{message}} payloads", () => {
  assert.equal(explain({ error: { message: "deep" } }), "deep");
  assert.equal(explain(new Error("plain")), "plain");
});

test("classifies aborts and timeouts from the transport layer", () => {
  assert.equal(transportError(new Error("x")).code, "network");
  const abort = new Error("cancelled");
  abort.name = "AbortError";
  assert.equal(transportError(abort).code, "cancelled");
});

test("bounds absurdly long gateway messages", () => {
  const long = "x".repeat(500);
  const error = httpError(400, JSON.stringify({ error: { message: long } }));
  assert.ok(error.message.length < 260);
});

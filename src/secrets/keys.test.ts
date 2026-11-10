import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile, profileFromModelId, PROFILE_PATTERN } from "./keys.js";

test("normalizeProfile trims, lowercases and defaults", () => {
  assert.equal(normalizeProfile("  Work "), "work");
  assert.equal(normalizeProfile(undefined), "default");
  assert.equal(normalizeProfile(""), "default");
  assert.throws(() => normalizeProfile("bad space"), /Invalid profile/);
  assert.throws(() => normalizeProfile("-lead"), /Invalid profile/);
});

test("profileFromModelId reads our ids and host-qualified variants", () => {
  assert.equal(profileFromModelId("default::glm5.3-flash"), "default");
  assert.equal(profileFromModelId("work::glm5.3"), "work");
  assert.equal(profileFromModelId("nan-builders:work::glm5.3"), "work");
  assert.equal(profileFromModelId("nan-builders/work::glm5.3"), "work");
  // No profile segment, or garbage in it: caller falls back.
  assert.equal(profileFromModelId("glm5.3-flash"), undefined);
  assert.equal(profileFromModelId("Bad Profile::glm5.3"), undefined);
  assert.equal(profileFromModelId("::glm5.3"), undefined);
});

test("profile pattern blocks host garbage but keeps sane ids", () => {
  assert.ok(PROFILE_PATTERN.test("a".repeat(64)));
  assert.ok(!PROFILE_PATTERN.test("a".repeat(65)));
  assert.ok(!PROFILE_PATTERN.test("has space"));
});

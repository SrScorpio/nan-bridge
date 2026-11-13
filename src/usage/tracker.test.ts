import test from "node:test";
import assert from "node:assert/strict";
import { MemoryUsageStore, UsageTracker, parseCredits, parseRemoteUsage } from "./tracker.js";

const REPORT = { promptTokens: 100, completionTokens: 20, cachedTokens: 0 };

test("accumulates requests and tokens per model", () => {
  const tracker = new UsageTracker();
  tracker.record("default", "glm5.3-flash", REPORT);
  const snapshot = tracker.record("default", "glm5.3-flash", REPORT);
  assert.equal(snapshot.totalRequests, 2);
  assert.equal(snapshot.totalTokens, 240);
  assert.equal(snapshot.models["glm5.3-flash"].requests, 2);
});

test("keeps profiles independent", () => {
  const tracker = new UsageTracker();
  tracker.record("a", "gemma4", REPORT);
  const other = tracker.snapshot("b");
  assert.equal(other.totalRequests, 0);
});

test("persists through the store and hydrates back", async () => {
  const store = new MemoryUsageStore();
  const writer = new UsageTracker(store);
  writer.record("default", "qwen3.6", REPORT);
  const reader = new UsageTracker(store);
  await reader.hydrate(["default"]);
  assert.equal(reader.snapshot("default").totalRequests, 1);
});

test("burst records keep every model when persistence serializes", async () => {
  // A store whose read takes a tick: two records in the same instant must not
  // lose either model's counters to a read-modify-write race.
  const delayed = {
    read: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return storeData;
    },
    write: async (data: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      storeData = structuredClone(data) as Record<string, unknown>;
    },
  } as never;
  let storeData: Record<string, unknown> = {};
  const tracker = new UsageTracker(delayed);
  tracker.record("default", "gemma4", REPORT);
  tracker.record("default", "qwen3.6", REPORT);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const persisted = storeData["default"] as Record<string, { requests: number }>;
  assert.equal(persisted["gemma4"].requests, 1);
  assert.equal(persisted["qwen3.6"].requests, 1);
});

test("notes remote totals without touching local counts", () => {
  const tracker = new UsageTracker();
  tracker.record("default", "gemma4", REPORT);
  tracker.noteRemote("default", {
    startDate: "2026-10-10",
    endDate: "2026-11-09",
    requests: 25_000,
    totalTokens: 4_000_000,
    byModel: [{ model: "gemma4", requests: 25_000, totalTokens: 4_000_000 }],
  });
  const snapshot = tracker.snapshot("default");
  assert.equal(snapshot.remote?.requests, 25_000);
  assert.equal(snapshot.totalRequests, 1);
});

test("parses the live usage.report shape (daily rows per model)", () => {
  const remote = parseRemoteUsage({
    object: "usage.report",
    start_date: "2026-10-10",
    end_date: "2026-11-09",
    data: [
      { date: "2026-10-11", model: "deepseek-v4-flash", prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, api_requests: 7 },
      { date: "2026-10-11", model: "glm5.3-flash", prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, api_requests: 3 },
      { date: "2026-10-12", model: "deepseek-v4-flash", prompt_tokens: 30, completion_tokens: 10, total_tokens: 40, api_requests: 5 },
    ],
  });
  assert.ok(remote);
  assert.equal(remote.startDate, "2026-10-10");
  assert.equal(remote.requests, 15);
  assert.equal(remote.byModel[0].model, "deepseek-v4-flash");
  assert.equal(remote.byModel[0].requests, 12);
  assert.equal(remote.byModel[1].requests, 3);
  assert.equal(parseRemoteUsage({ object: "usage.report", data: [] }), undefined);
});

test("aggregates the calendar-month slice with label and token order", () => {
  const remote = parseRemoteUsage({
    object: "usage.report",
    start_date: "2026-10-10",
    end_date: "2026-11-09",
    data: [
      { date: "2026-10-31", model: "glm5.3-flash", total_tokens: 1_000, api_requests: 10 },
      { date: "2026-11-01", model: "glm5.3-flash", total_tokens: 2_000_000, api_requests: 100 },
      { date: "2026-11-02", model: "gemma4", total_tokens: 500, api_requests: 4 },
      { date: "2026-11-02", model: "glm5.3-flash", total_tokens: 1_000_000, api_requests: 50 },
    ],
  });
  assert.ok(remote?.month);
  assert.equal(remote.month.label, "November 2026");
  assert.equal(remote.month.requests, 154); // 154 = 100 + 50 + 4 (October row excluded)
  assert.equal(remote.month.totalTokens, 3_000_500);
  assert.equal(remote.month.byModel[0].model, "glm5.3-flash"); // sorted by month tokens
  assert.equal(remote.month.byModel[0].totalTokens, 3_000_000);
  const noDates = parseRemoteUsage({
    object: "usage.report", end_date: "2026-11-09",
    data: [{ model: "glm5.3-flash", total_tokens: 5, api_requests: 1 }],
  });
  assert.ok(noDates); // window rows parse fine
  assert.equal(noDates.month, undefined); // nothing dated in the month yet
});

test("reads credits from rows, window totals and the billing period", () => {
  const remote = parseRemoteUsage({
    object: "usage.report",
    start_date: "2026-11-01",
    end_date: "2026-11-12",
    data: [
      { date: "2026-11-12", model: "glm5.3", api_requests: 2, total_tokens: 100, credits: 0.5 },
    ],
    // `totals` covers the whole window even when rows are paginated, so it
    // wins over what this single page aggregates.
    totals: {
      api_requests: 9,
      total_tokens: 900,
      credits: 4.5,
      by_model: [{ model: "glm5.3", api_requests: 9, total_tokens: 900, credits: 4.5 }],
    },
    credits: {
      period_start: "2026-11-16T10:00:00Z",
      period_end: "2026-12-16T10:00:00Z",
      allowance: 7000,
      used: 24.3,
      remaining: 6975.7,
      pack_credits: 0,
      pack_expires_at: null,
      frozen: false,
    },
  });
  assert.ok(remote);
  assert.equal(remote.requests, 9);
  assert.equal(remote.totalTokens, 900);
  assert.equal(remote.credits, 4.5);
  assert.equal(remote.byModel[0].credits, 4.5);
  assert.equal(remote.period?.allowance, 7000);
  assert.equal(remote.period?.remaining, 6975.7);
  assert.equal(remote.period?.packExpiresAt, undefined);
  assert.equal(remote.period?.frozen, false);
  // The month slice always comes from the rows.
  assert.equal(remote.month?.credits, 0.5);
  assert.equal(remote.month?.byModel[0].credits, 0.5);
});

test("accounts not billed in credits report no period", () => {
  const remote = parseRemoteUsage({
    object: "usage.report",
    end_date: "2026-11-12",
    data: [{ date: "2026-11-12", model: "gemma4", api_requests: 1, total_tokens: 10 }],
    credits: null,
  });
  assert.ok(remote);
  assert.equal(remote.period, undefined);
  assert.equal(remote.credits, undefined); // no row credits either
});

test("malformed credit fields are dropped instead of poisoning the sums", () => {
  const remote = parseRemoteUsage({
    object: "usage.report",
    end_date: "2026-11-12",
    data: [
      { date: "2026-11-12", model: "glm5.3", api_requests: 1, total_tokens: 10, credits: "1.2" },
      { date: "2026-11-12", model: "glm5.3", api_requests: 1, total_tokens: 10, credits: null },
      { date: "2026-11-12", model: "glm5.3", api_requests: 1, total_tokens: 10, credits: 0.5 },
    ],
    credits: { allowance: "7000", used: 1, remaining: 2, pack_credits: null, frozen: "no" },
  });
  assert.ok(remote);
  assert.equal(remote.credits, 0.5);
  assert.equal(remote.byModel[0].credits, 0.5);
  assert.equal(remote.period, undefined); // allowance not a number
});

test("frozen flag is only true for an explicit boolean", () => {
  const base = { period_start: "2026-11-16T10:00:00Z", period_end: "2026-12-16T10:00:00Z", allowance: 10, used: 1, remaining: 9 };
  assert.equal(parseCredits({ ...base, frozen: true })?.frozen, true);
  assert.equal(parseCredits({ ...base, frozen: 1 })?.frozen, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { quickPickRows, statusText, statusTooltip } from "./views.js";
import type { UsageSnapshot } from "./tracker.js";

const SNAPSHOT: UsageSnapshot = {
  models: {
    "glm5.3-flash": { requests: 1_500, promptTokens: 900, completionTokens: 100, cachedTokens: 50 },
  },
  totalRequests: 1_525,
  totalTokens: 1_015,
  remote: {
    startDate: "2026-10-10",
    endDate: "2026-11-09",
    requests: 23_934,
    totalTokens: 3_900_000,
    byModel: [
      { model: "deepseek-v4-flash", requests: 20_000, totalTokens: 3_000_000 },
      { model: "gemma4", requests: 3_934, totalTokens: 900_000 },
    ],
  },
  updatedAt: Date.UTC(2026, 10, 8, 12, 0, 0),
};

test("status bar reports gateway-side usage only", () => {
  assert.equal(statusText(SNAPSHOT), "NaN: 23.9k req · 3.9M tok");
  // Local-only usage must NOT leak into the status text.
  assert.equal(statusText({ models: {}, totalRequests: 42, totalTokens: 99 }), "NaN: usage —");
});

test("tooltip shows period, totals and per-model rows", () => {
  const text = statusTooltip(SNAPSHOT);
  assert.match(text, /23,934 requests · 3,900,000 tokens/);
  assert.match(text, /2026-10-10 → 2026-11-09/);
  assert.match(text, /deepseek-v4-flash: 20,000 req · 3,000,000 tok/);
  assert.match(text, /Updated/);
  assert.match(statusTooltip({ models: {}, totalRequests: 0, totalTokens: 0 }), /not available/);
});

test("quick pick lists the gateway total then per-model rows", () => {
  const rows = quickPickRows(SNAPSHOT);
  assert.match(rows[0].label, /Gateway total — 23,934 requests/);
  assert.match(rows[0].detail, /2026-10-10 → 2026-11-09/);
  assert.equal(rows[1].label, "$(cloud) deepseek-v4-flash");
  assert.equal(rows.length, 3); // total + 2 models
  const empty = quickPickRows({ models: {}, totalRequests: 0, totalTokens: 0 });
  assert.equal(empty.length, 1);
  assert.match(empty[0].label, /No gateway usage/);
});

test("month view: status, quota percentages and month rows", () => {
  const snapshot: UsageSnapshot = {
    models: {},
    totalRequests: 0,
    totalTokens: 0,
    remote: {
      startDate: "2026-10-10",
      endDate: "2026-11-09",
      requests: 23_934,
      totalTokens: 3_900_000_000,
      byModel: [],
      month: {
        label: "November 2026",
        requests: 9_000,
        totalTokens: 1_150_000_000,
        byModel: [
          { model: "glm5.3-flash", requests: 8_000, totalTokens: 822_000_000 },
          { model: "gemma4", requests: 1_000, totalTokens: 100_000_000 },
        ],
      },
    },
  };
  assert.equal(statusText(snapshot), "NaN: 1.2B tok this month");
  const rows = quickPickRows(snapshot);
  assert.match(rows[0].label, /This month — November 2026/);
  assert.equal(rows[0].description, "9,000 requests");
  assert.equal(rows[0].detail, "1,150,000,000 tokens");
  assert.equal(rows[1].label, "$(cloud) glm5.3-flash");
  assert.match(rows[1].detail, /41.1% of 2B allowance/);
  assert.match(rows[2].detail, /100,000,000 tokens$/); // quota-less model: no suffix
  assert.match(rows[rows.length - 1].label, /Window total/);
  assert.match(rows[rows.length - 1].detail, /2026-10-10 → 2026-11-09/);
  const tooltip = statusTooltip(snapshot);
  assert.match(tooltip, /This month \(November 2026\): 9,000 requests · 1,150,000,000 tokens/);
  assert.match(tooltip, /41.1% of 2B allowance/);
});

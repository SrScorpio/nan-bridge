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
  assert.equal(rows[2].detail, "100,000,000 tokens"); // no credits reported: no suffix
  assert.match(rows[rows.length - 1].label, /Window total/);
  assert.match(rows[rows.length - 1].detail, /2026-10-10 → 2026-11-09/);
  const tooltip = statusTooltip(snapshot);
  assert.match(tooltip, /This month \(November 2026\): 9,000 requests · 1,150,000,000 tokens/);
});

test("credit-based billing: balance leads the panel and per-model spend", () => {
  const snapshot: UsageSnapshot = {
    models: {},
    totalRequests: 0,
    totalTokens: 0,
    remote: {
      startDate: "2026-10-10",
      endDate: "2026-11-09",
      requests: 23_934,
      totalTokens: 3_900_000,
      credits: 31.4,
      byModel: [{ model: "glm5.3", requests: 20_000, totalTokens: 3_000_000, credits: 26.1 }],
      period: {
        periodStart: "2026-11-16T10:00:00Z",
        periodEnd: "2026-12-16T10:00:00Z",
        allowance: 7_000,
        used: 24.3,
        remaining: 6_975.7,
        packCredits: 120,
        packExpiresAt: "2026-12-31T00:00:00Z",
        frozen: false,
      },
      month: {
        label: "November 2026",
        requests: 9_000,
        totalTokens: 1_150_000_000,
        credits: 31.4,
        byModel: [{ model: "glm5.3", requests: 8_000, totalTokens: 822_000_000, credits: 26.1 }],
      },
    },
  };
  // Credits outrank tokens: they are what the gateway actually bills.
  assert.equal(statusText(snapshot), "NaN: 24.3/7,000 cr");
  const rows = quickPickRows(snapshot);
  assert.equal(rows[0].label, "$(credit-card) Credits — Nov 16 → Dec 16");
  assert.equal(rows[0].description, "24.3 / 7,000 used");
  assert.equal(rows[0].detail, "6,975.7 remaining · packs 120");
  assert.equal(rows[1].detail, "1,150,000,000 tokens · 31.4 credits");
  assert.equal(rows[2].detail, "822,000,000 tokens — 26.1 cr");
  assert.match(rows[rows.length - 1].detail, /· 31.4 credits$/);
  const tooltip = statusTooltip(snapshot);
  assert.match(tooltip, /NaN credits — billing period 2026-11-16 → 2026-12-16/);
  assert.match(tooltip, /24.3 of 7,000 used \(0.3%\) · 6,975.7 remaining/);
  assert.match(tooltip, /Pack credits: 120 \(expire 2026-12-31\)/);
  assert.match(tooltip, /3,900,000 tokens \(all clients on this key\) · 31.4 credits/);
  assert.doesNotMatch(tooltip, /Subscription inactive/);
});

test("frozen subscription is called out in the tooltip and the credit row", () => {
  const snapshot: UsageSnapshot = {
    models: {},
    totalRequests: 0,
    totalTokens: 0,
    remote: {
      startDate: "2026-11-10",
      endDate: "2026-11-13",
      requests: 10,
      totalTokens: 1_000,
      byModel: [],
      period: {
        periodStart: "2026-11-16T10:00:00Z",
        periodEnd: "2026-12-16T10:00:00Z",
        allowance: 0,
        used: 0,
        remaining: 0,
        packCredits: 0,
        frozen: true,
      },
    },
  };
  assert.match(statusTooltip(snapshot), /Subscription inactive/);
  assert.match(quickPickRows(snapshot)[0].detail, /subscription inactive$/);
});
